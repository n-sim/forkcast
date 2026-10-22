#![allow(dead_code)]
//! A deterministic stand-in for Gurkerl's MCP server and its authorization
//! server, speaking real HTTP on the loopback interface: protected-resource
//! and authorization-server metadata, dynamic client registration, PKCE,
//! rotating refresh tokens, and MCP over Streamable HTTP with a product
//! catalog, order history, and a cart. It never places an order; a checkout
//! call is recorded so tests can prove Forkcast never makes one.

use super::provider::{Request, form, get, read_request};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    io::Write,
    net::{TcpListener, TcpStream},
    sync::{Arc, Mutex},
};

#[derive(Clone, Debug, PartialEq)]
pub struct CartLine {
    pub product_id: String,
    pub quantity: u64,
}

pub struct State {
    /// success or denied
    pub mode: String,
    pub expires_in: u64,
    /// Set when the MCP server should stop answering tool calls.
    pub down: bool,
    pub cart: Vec<CartLine>,
    /// Every tool call, as "name arguments".
    pub calls: Vec<String>,
    /// Redirect URIs of registered clients, by client id.
    clients: HashMap<String, String>,
    codes: HashMap<String, HashMap<String, String>>,
    access_tokens: HashSet<String>,
    refresh_tokens: HashSet<String>,
    next: u32,
    pub log: Vec<String>,
}

#[derive(Clone)]
pub struct Gurkerl {
    pub base: String,
    /// The MCP endpoint, as Forkcast is configured with it.
    pub server: String,
    state: Arc<Mutex<State>>,
}

fn respond(stream: &mut TcpStream, status: u16, headers: &[(&str, &str)], body: &str) {
    let extra: String = headers
        .iter()
        .map(|(name, value)| format!("{name}: {value}\r\n"))
        .collect();
    let _ = write!(
        stream,
        "HTTP/1.1 {status} X\r\n{extra}Content-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
}

const JSON: (&str, &str) = ("Content-Type", "application/json");

fn catalog() -> Vec<Value> {
    vec![
        json!({"productId": "p-pasta-500", "name": "Barilla Spaghetti 500 g", "price": 2.49}),
        json!({"productId": "p-pasta-cheap", "name": "Clever Spaghetti 500 g", "price": 0.99}),
        json!({"productId": "p-coffee", "name": "Gurkerl Bio Kaffee 250 g", "price": 6.99}),
        json!({"productId": "p-oil", "name": "Olivenöl 750 ml", "price": 8.49}),
    ]
}

impl Gurkerl {
    pub fn start() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let gurkerl = Self {
            server: format!("{base}/mcp"),
            base,
            state: Arc::new(Mutex::new(State {
                mode: "success".into(),
                expires_in: 3600,
                down: false,
                cart: Vec::new(),
                calls: Vec::new(),
                clients: HashMap::new(),
                codes: HashMap::new(),
                access_tokens: HashSet::new(),
                refresh_tokens: HashSet::new(),
                next: 0,
                log: Vec::new(),
            })),
        };
        let serving = gurkerl.clone();
        std::thread::spawn(move || {
            for stream in listener.incoming().flatten() {
                let gurkerl = serving.clone();
                std::thread::spawn(move || gurkerl.handle(stream));
            }
        });
        gurkerl
    }

    pub fn with<T>(&self, change: impl FnOnce(&mut State) -> T) -> T {
        change(&mut self.state.lock().unwrap())
    }

    pub fn cart(&self) -> Vec<CartLine> {
        self.with(|s| s.cart.clone())
    }

    pub fn calls(&self) -> Vec<String> {
        self.with(|s| s.calls.clone())
    }

    /// Refuses every access token issued so far, as when they expire early.
    pub fn expire_access(&self) {
        self.with(|s| s.access_tokens.clear());
    }

    pub fn refreshes(&self) -> usize {
        self.with(|s| s.log.iter().filter(|line| *line == "refresh").count())
    }

    /// Ends every session, as Gurkerl does when it revokes access.
    pub fn revoke_all(&self) {
        self.with(|s| {
            s.access_tokens.clear();
            s.refresh_tokens.clear();
        });
    }

    /// Plays the person's browser: approves the authorization request and
    /// follows the redirect to the app's loopback listener.
    pub fn sign_in(&self, authorization_url: &str) -> (u16, String) {
        let url = url::Url::parse(authorization_url).unwrap();
        assert_eq!(url.path(), "/authorize");
        assert_eq!(format!("{}://{}", url.scheme(), url.authority()), self.base);
        let params: HashMap<String, String> = url.query_pairs().into_owned().collect();
        assert_eq!(params["response_type"], "code");
        assert_eq!(params["code_challenge_method"], "S256");
        assert_eq!(params["resource"], self.server);
        assert_eq!(params["scope"], "openid email");
        let registered = self.with(|s| s.clients.get(&params["client_id"]).cloned());
        assert_eq!(registered.as_deref(), Some(params["redirect_uri"].as_str()));
        let mut callback = url::Url::parse(&params["redirect_uri"]).unwrap();
        callback
            .query_pairs_mut()
            .append_pair("state", &params["state"]);
        let denied = self.with(|s| {
            s.log.push("authorize".into());
            s.mode == "denied"
        });
        if denied {
            callback
                .query_pairs_mut()
                .append_pair("error", "access_denied");
        } else {
            let code = format!("code-{}", self.with(|s| s.codes.len() + 1));
            self.with(|s| s.codes.insert(code.clone(), params.clone()));
            callback.query_pairs_mut().append_pair("code", &code);
        }
        get(&callback)
    }

    fn issue(&self) -> Value {
        self.with(|s| {
            s.next += 1;
            let access = format!("GURKERL_SECRET_ACCESS_{}", s.next);
            let refresh = format!("GURKERL_SECRET_REFRESH_{}", s.next);
            s.access_tokens.insert(access.clone());
            s.refresh_tokens.insert(refresh.clone());
            json!({"access_token": access, "refresh_token": refresh, "token_type": "Bearer", "expires_in": s.expires_in})
        })
    }

    fn handle(&self, mut stream: TcpStream) {
        let Some(request) = read_request(&mut stream) else {
            return;
        };
        let path = request.path.split('?').next().unwrap_or("").to_owned();
        let base = &self.base;
        match (request.method.as_str(), path.as_str()) {
            ("GET", "/.well-known/oauth-protected-resource/mcp") => respond(
                &mut stream,
                200,
                &[JSON],
                &json!({
                    "resource": self.server, "authorization_servers": [base],
                    "scopes_supported": ["openid", "email"], "bearer_methods_supported": ["header"],
                })
                .to_string(),
            ),
            ("GET", "/.well-known/oauth-authorization-server") => respond(
                &mut stream,
                200,
                &[JSON],
                &json!({
                    "issuer": base,
                    "authorization_endpoint": format!("{base}/authorize"),
                    "token_endpoint": format!("{base}/token"),
                    "registration_endpoint": format!("{base}/register"),
                    "code_challenge_methods_supported": ["S256"],
                    "grant_types_supported": ["authorization_code", "refresh_token"],
                })
                .to_string(),
            ),
            ("POST", "/register") => {
                let body: Value = serde_json::from_str(&request.body).unwrap_or_default();
                assert_eq!(body["token_endpoint_auth_method"], "none");
                let redirect = body["redirect_uris"][0].as_str().unwrap().to_owned();
                assert!(redirect.starts_with("http://127.0.0.1:"), "{redirect}");
                let client = self.with(|s| {
                    let client = format!("gurkerl-client-{}", s.clients.len() + 1);
                    s.clients.insert(client.clone(), redirect);
                    s.log.push("register".into());
                    client
                });
                respond(
                    &mut stream,
                    201,
                    &[JSON],
                    &json!({"client_id": client}).to_string(),
                );
            }
            ("POST", "/token") => self.token(&mut stream, &request),
            ("POST", "/mcp") => self.mcp(&mut stream, &request),
            _ => respond(&mut stream, 404, &[JSON], "{}"),
        }
    }

    fn token(&self, stream: &mut TcpStream, request: &Request) {
        let fields = form(&request.body);
        assert_eq!(fields["resource"], self.server);
        if fields["grant_type"] == "refresh_token" {
            let renewed = self.with(|s| {
                s.log.push("refresh".into());
                s.refresh_tokens.remove(&fields["refresh_token"])
            });
            if !renewed {
                return respond(stream, 400, &[JSON], r#"{"error":"invalid_grant"}"#);
            }
            return respond(stream, 200, &[JSON], &self.issue().to_string());
        }
        let params = self.with(|s| s.codes.remove(&fields["code"]));
        let valid = params.is_some_and(|params| {
            fields["client_id"] == params["client_id"]
                && fields["redirect_uri"] == params["redirect_uri"]
                && URL_SAFE_NO_PAD.encode(Sha256::digest(fields["code_verifier"].as_bytes()))
                    == params["code_challenge"]
        });
        if !valid {
            return respond(stream, 400, &[JSON], r#"{"error":"invalid_grant"}"#);
        }
        respond(stream, 200, &[JSON], &self.issue().to_string());
    }

    fn mcp(&self, stream: &mut TcpStream, request: &Request) {
        let token = request
            .headers
            .get("authorization")
            .and_then(|value| value.strip_prefix("Bearer "))
            .unwrap_or_default()
            .to_owned();
        if !self.with(|s| s.access_tokens.contains(&token)) {
            let challenge = format!(
                "Bearer error=\"invalid_token\", resource_metadata=\"{}/.well-known/oauth-protected-resource/mcp\"",
                self.base
            );
            return respond(
                stream,
                401,
                &[JSON, ("WWW-Authenticate", &challenge)],
                r#"{"error":"invalid_token"}"#,
            );
        }
        let message: Value = serde_json::from_str(&request.body).unwrap();
        let method = message["method"].as_str().unwrap_or_default();
        let id = message["id"].clone();
        if id.is_null() {
            return respond(stream, 202, &[], "");
        }
        if method != "initialize" {
            assert_eq!(
                request.headers.get("mcp-session-id").map(String::as_str),
                Some("fixture-session")
            );
        }
        let result = match method {
            "initialize" => json!({
                "protocolVersion": "2025-06-18", "capabilities": {"tools": {}},
                "serverInfo": {"name": "gurkerl-fixture", "version": "1"},
            }),
            "tools/list" => json!({"tools": [
                {"name": "search_products", "description": "Search the Gurkerl catalog.",
                 "inputSchema": {"type": "object", "properties": {"query": {"type": "string"}}, "required": ["query"]},
                 "annotations": {"readOnlyHint": true}},
                {"name": "get_purchase_history", "description": "Products the customer bought before.",
                 "inputSchema": {"type": "object", "properties": {}}},
                {"name": "add_to_cart", "description": "Add a product to the cart.",
                 "inputSchema": {"type": "object", "properties": {"productId": {"type": "string"}, "quantity": {"type": "integer"}}, "required": ["productId", "quantity"]}},
                {"name": "remove_from_cart", "description": "Remove a product from the cart.",
                 "inputSchema": {"type": "object", "properties": {"productId": {"type": "string"}}}},
                {"name": "checkout", "description": "Place the order and pay.",
                 "inputSchema": {"type": "object", "properties": {}}},
            ]}),
            "tools/call" => {
                if self.with(|s| s.down) {
                    return respond(stream, 503, &[JSON], "{}");
                }
                self.tool(&message["params"])
            }
            _ => {
                return respond(
                    stream,
                    200,
                    &[JSON],
                    &json!({"jsonrpc": "2.0", "id": id, "error": {"code": -32601, "message": "Unknown method"}}).to_string(),
                );
            }
        };
        let reply = json!({"jsonrpc": "2.0", "id": id, "result": result}).to_string();
        // Tool calls answer as an event stream, the rest as plain JSON, as
        // Streamable HTTP servers may do either.
        if method == "tools/call" {
            respond(
                stream,
                200,
                &[
                    ("Content-Type", "text/event-stream"),
                    ("Mcp-Session-Id", "fixture-session"),
                ],
                &format!(
                    "event: message\ndata: {}\n\nevent: message\ndata: {reply}\n\n",
                    json!({"jsonrpc": "2.0", "method": "notifications/progress", "params": {}})
                ),
            );
        } else {
            respond(
                stream,
                200,
                &[JSON, ("Mcp-Session-Id", "fixture-session")],
                &reply,
            );
        }
    }

    fn tool(&self, params: &Value) -> Value {
        let name = params["name"].as_str().unwrap_or_default().to_owned();
        let arguments = params["arguments"].clone();
        self.with(|s| s.calls.push(format!("{name} {arguments}")));
        let text = |value: Value| json!({"content": [{"type": "text", "text": value.to_string()}]});
        match name.as_str() {
            "search_products" => {
                let query = arguments["query"].as_str().unwrap_or("").to_lowercase();
                text(json!(
                    catalog()
                        .into_iter()
                        .filter(|product| product["name"]
                            .as_str()
                            .unwrap()
                            .to_lowercase()
                            .contains(&query))
                        .collect::<Vec<_>>()
                ))
            }
            "get_purchase_history" => text(json!([{"productId": "p-pasta-500"}])),
            "add_to_cart" => {
                let product = arguments["productId"].as_str().unwrap_or_default();
                let quantity = arguments["quantity"].as_u64().unwrap_or(0);
                if !catalog().iter().any(|p| p["productId"] == product) || quantity == 0 {
                    return json!({"isError": true, "content": [{"type": "text", "text": "Product is sold out."}]});
                }
                self.with(|s| {
                    s.cart.push(CartLine {
                        product_id: product.to_owned(),
                        quantity,
                    })
                });
                text(json!({"added": product, "quantity": quantity}))
            }
            other => {
                json!({"isError": true, "content": [{"type": "text", "text": format!("{other} is not available in the fixture.")}]})
            }
        }
    }
}
