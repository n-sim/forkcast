#![allow(dead_code)]
//! A deterministic stand-in for ChatGPT's authorization and inference
//! services, speaking real HTTP on the loopback interface: dynamic
//! registration, PKCE, signed identity tokens and JWKS, rotating refresh
//! tokens, revocation, model listing, and streamed responses.

use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use jsonwebtoken::{Algorithm, EncodingKey, Header};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    io::{Read, Write},
    net::{TcpListener, TcpStream},
    sync::{Arc, Mutex},
    time::Duration,
};

const KEY: &str = include_str!("fixture-key.pem");
const MODULUS: &str = include_str!("fixture-key.n");

pub struct State {
    /// success, denied, nonce, signature, issuer, audience, expired, scope,
    /// exchange, revocation
    pub mode: String,
    pub expires_in: u64,
    pub refresh: String, // ok, reject, down
    pub refresh_delay_ms: u64,
    pub failure: Option<String>,
    pub reply: Value,
    codes: HashMap<String, HashMap<String, String>>,
    refresh_tokens: HashSet<String>,
    access_tokens: HashSet<String>,
    next: u32,
    pub log: Vec<String>,
    pub hosts: Vec<String>,
    /// The body of every inference request, in order.
    pub requests: Vec<Value>,
}

#[derive(Clone)]
pub struct Provider {
    pub issuer: String,
    state: Arc<Mutex<State>>,
}

struct Request {
    method: String,
    path: String,
    headers: HashMap<String, String>,
    body: String,
}

fn read_request(stream: &mut TcpStream) -> Option<Request> {
    stream.set_read_timeout(Some(Duration::from_secs(5))).ok()?;
    let mut data = Vec::new();
    let mut buffer = [0u8; 4096];
    let end = loop {
        let read = stream.read(&mut buffer).ok()?;
        if read == 0 {
            return None;
        }
        data.extend_from_slice(&buffer[..read]);
        if let Some(position) = data.windows(4).position(|window| window == b"\r\n\r\n") {
            break position + 4;
        }
    };
    let head = String::from_utf8_lossy(&data[..end]).to_string();
    let mut lines = head.lines();
    let mut first = lines.next()?.split_whitespace();
    let (method, path) = (first.next()?.to_owned(), first.next()?.to_owned());
    let headers: HashMap<String, String> = lines
        .filter_map(|line| line.split_once(':'))
        .map(|(name, value)| (name.trim().to_ascii_lowercase(), value.trim().to_owned()))
        .collect();
    let length: usize = headers
        .get("content-length")
        .and_then(|v| v.parse().ok())
        .unwrap_or(0);
    while data.len() < end + length {
        let read = stream.read(&mut buffer).ok()?;
        if read == 0 {
            break;
        }
        data.extend_from_slice(&buffer[..read]);
    }
    Some(Request {
        method,
        path,
        headers,
        body: String::from_utf8_lossy(&data[end..]).to_string(),
    })
}

fn respond(stream: &mut TcpStream, status: u16, content_type: &str, body: &str) {
    let _ = write!(
        stream,
        "HTTP/1.1 {status} X\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
}

fn form(body: &str) -> HashMap<String, String> {
    url::form_urlencoded::parse(body.as_bytes())
        .into_owned()
        .collect()
}

impl Provider {
    pub fn start() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let issuer = format!("http://{}", listener.local_addr().unwrap());
        let provider = Self {
            issuer,
            state: Arc::new(Mutex::new(State {
                mode: "success".into(),
                expires_in: 3600,
                refresh: "ok".into(),
                refresh_delay_ms: 0,
                failure: None,
                reply: json!({"name": "Tomato soup"}),
                codes: HashMap::new(),
                refresh_tokens: HashSet::new(),
                access_tokens: HashSet::new(),
                next: 0,
                log: Vec::new(),
                hosts: Vec::new(),
                requests: Vec::new(),
            })),
        };
        let serving = provider.clone();
        std::thread::spawn(move || {
            for stream in listener.incoming().flatten() {
                let provider = serving.clone();
                std::thread::spawn(move || provider.handle(stream));
            }
        });
        provider
    }

    pub fn with<T>(&self, change: impl FnOnce(&mut State) -> T) -> T {
        change(&mut self.state.lock().unwrap())
    }

    pub fn mode(&self, mode: &str) {
        self.with(|s| s.mode = mode.to_owned());
    }

    pub fn log(&self) -> Vec<String> {
        self.with(|s| s.log.clone())
    }

    pub fn count(&self, prefix: &str) -> usize {
        self.with(|s| s.log.iter().filter(|l| l.starts_with(prefix)).count())
    }

    fn token_claims(&self, mode: &str, nonce: &str, client_id: &str) -> Value {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs();
        json!({
            "iss": if mode == "issuer" { "https://attacker.invalid".to_owned() } else { self.issuer.clone() },
            "aud": if mode == "audience" { "oaiapp_other" } else { client_id },
            "sub": "fixture-person",
            "email": "cook@example.test",
            "iat": now,
            "exp": if mode == "expired" { now - 3600 } else { now + 3600 },
            "nonce": if mode == "nonce" { "wrong-nonce" } else { nonce },
        })
    }

    /// Plays the person's browser: validates the authorization request and
    /// returns the callback address the provider would redirect to.
    pub fn callback_for(&self, authorization_url: &str) -> String {
        let url = url::Url::parse(authorization_url).unwrap();
        assert_eq!(url.path(), "/api/accounts/authorize");
        assert_eq!(
            format!("{}://{}", url.scheme(), url.authority()),
            self.issuer
        );
        let params: HashMap<String, String> = url.query_pairs().into_owned().collect();
        let host = params["ext_agent_host_id"].clone();
        assert!(host.starts_with("urn:uuid:"), "host id {host}");
        assert_eq!(params["code_challenge_method"], "S256");
        assert!(params["redirect_uri"].starts_with("http://127.0.0.1:"));
        let code = format!("code-{}", self.with(|s| s.codes.len() + 1));
        let mut callback = url::Url::parse(&params["redirect_uri"]).unwrap();
        callback
            .query_pairs_mut()
            .append_pair("state", &params["state"]);
        let denied = self.with(|s| {
            s.hosts.push(host);
            s.log.push("authorize".into());
            s.codes.insert(code.clone(), params.clone());
            s.mode == "denied"
        });
        if denied {
            callback
                .query_pairs_mut()
                .append_pair("error", "access_denied");
        } else {
            callback.query_pairs_mut().append_pair("code", &code);
            if params["client_id"] == "dynamic_agent_client" {
                callback
                    .query_pairs_mut()
                    .append_pair("client_id", "oaiapp_fixture");
            }
        }
        callback.into()
    }

    /// The whole browser step: approve, then follow the redirect to the
    /// app's loopback listener. Returns that listener's status and page.
    pub fn sign_in(&self, authorization_url: &str) -> (u16, String) {
        let callback = url::Url::parse(&self.callback_for(authorization_url)).unwrap();
        get(&callback)
    }

    fn handle(&self, mut stream: TcpStream) {
        let Some(request) = read_request(&mut stream) else {
            return;
        };
        let path = request.path.split('?').next().unwrap_or("").to_owned();
        match (request.method.as_str(), path.as_str()) {
            ("GET", "/.well-known/jwks.json") => {
                let jwk = json!({"kty": "RSA", "alg": "RS256", "use": "sig", "kid": "fixture", "n": MODULUS.trim(), "e": "AQAB"});
                respond(
                    &mut stream,
                    200,
                    "application/json",
                    &json!({"keys": [jwk]}).to_string(),
                );
            }
            ("POST", "/api/accounts/oauth/token") => self.token(&mut stream, &request),
            ("POST", "/api/accounts/oauth/revoke") => {
                let fields = form(&request.body);
                let failing = self.with(|s| {
                    s.log.push(format!("revoke {}", fields["token"]));
                    s.mode == "revocation"
                });
                respond(
                    &mut stream,
                    if failing { 503 } else { 200 },
                    "application/json",
                    "{}",
                );
            }
            ("GET", "/v1/models") => {
                if !self.authorized(&request) {
                    return respond(&mut stream, 401, "application/json", "{}");
                }
                respond(
                    &mut stream,
                    200,
                    "application/json",
                    &json!({"models": [
                        {"slug": "fixture-recipe", "display_name": "Fixture recipe model", "visibility": "list"},
                        {"slug": "hidden", "display_name": "Hidden", "visibility": "hide"},
                    ]})
                    .to_string(),
                );
            }
            ("POST", "/v1/responses") => self.responses(&mut stream, &request),
            _ => respond(&mut stream, 404, "application/json", "{}"),
        }
    }

    fn bearer(request: &Request) -> String {
        request
            .headers
            .get("authorization")
            .and_then(|v| v.strip_prefix("Bearer "))
            .unwrap_or_default()
            .to_owned()
    }

    fn authorized(&self, request: &Request) -> bool {
        let token = Self::bearer(request);
        self.with(|s| {
            s.log.push(format!("use {token}"));
            s.access_tokens.contains(&token)
        })
    }

    fn token(&self, stream: &mut TcpStream, request: &Request) {
        let fields = form(&request.body);
        let grant = fields.get("grant_type").cloned().unwrap_or_default();
        if grant == "refresh_token" {
            let (delay, mode) = self.with(|s| {
                s.log.push(format!("refresh {}", fields["refresh_token"]));
                (s.refresh_delay_ms, s.refresh.clone())
            });
            std::thread::sleep(Duration::from_millis(delay));
            if mode == "down" {
                return respond(stream, 503, "application/json", "{}");
            }
            let granted = self.with(|s| {
                if mode == "ok" && s.refresh_tokens.remove(&fields["refresh_token"]) {
                    s.next += 1;
                    let (access, refresh) = (
                        format!("SECRET_ACCESS_{}", s.next),
                        format!("SECRET_REFRESH_{}", s.next),
                    );
                    s.access_tokens.insert(access.clone());
                    s.refresh_tokens.insert(refresh.clone());
                    Some((access, refresh, s.expires_in))
                } else {
                    None
                }
            });
            return match granted {
                Some((access, refresh, expires_in)) => respond(
                    stream,
                    200,
                    "application/json",
                    &json!({"access_token": access, "refresh_token": refresh, "token_type": "Bearer", "expires_in": expires_in}).to_string(),
                ),
                None => respond(stream, 400, "application/json", &json!({"error": "invalid_grant"}).to_string()),
            };
        }
        let code = fields.get("code").cloned().unwrap_or_default();
        let (params, mode, expires_in) = self.with(|s| {
            s.log.push("exchange".into());
            (s.codes.remove(&code), s.mode.clone(), s.expires_in)
        });
        let valid = params.as_ref().is_some_and(|params| {
            mode != "exchange"
                && fields.get("client_id").map(String::as_str) == Some("oaiapp_fixture")
                && fields.get("redirect_uri") == params.get("redirect_uri")
                && fields.get("resource").map(String::as_str) == Some("https://api.openai.com/v1")
                && URL_SAFE_NO_PAD.encode(Sha256::digest(
                    fields.get("code_verifier").cloned().unwrap_or_default(),
                )) == params["code_challenge"]
        });
        if !valid {
            return respond(stream, 400, "application/json", &json!({"error": "invalid_grant", "error_description": "DO_NOT_EXPOSE_PROVIDER_ERRORS"}).to_string());
        }
        let params = params.unwrap();
        let claims = self.token_claims(&mode, &params["nonce"], "oaiapp_fixture");
        let mut id_token = jsonwebtoken::encode(
            &{
                let mut header = Header::new(Algorithm::RS256);
                header.kid = Some("fixture".into());
                header
            },
            &claims,
            &EncodingKey::from_rsa_pem(KEY.as_bytes()).unwrap(),
        )
        .unwrap();
        if mode == "signature" {
            let cut = id_token.len() - 8;
            id_token.replace_range(cut.., "AAAAAAAA");
        }
        let (access, refresh) = self.with(|s| {
            s.next += 1;
            let (access, refresh) = (
                format!("SECRET_ACCESS_{}", s.next),
                format!("SECRET_REFRESH_{}", s.next),
            );
            s.access_tokens.insert(access.clone());
            s.refresh_tokens.insert(refresh.clone());
            (access, refresh)
        });
        respond(
            stream,
            200,
            "application/json",
            &json!({
                "access_token": access, "refresh_token": refresh, "id_token": id_token,
                "token_type": "Bearer", "expires_in": expires_in,
                "scope": if mode == "scope" { "openid email profile".to_owned() } else { params["scope"].clone() },
            })
            .to_string(),
        );
    }

    fn responses(&self, stream: &mut TcpStream, request: &Request) {
        let body: Value = serde_json::from_str(&request.body).unwrap_or_default();
        if !self.authorized(request) {
            return respond(stream, 401, "application/json", "{}");
        }
        assert_eq!(body["store"], false);
        assert_eq!(body["stream"], true);
        let (failure, reply) = self.with(|s| {
            s.log.push(format!(
                "inference {}",
                body["model"].as_str().unwrap_or("")
            ));
            s.requests.push(body.clone());
            (s.failure.clone(), s.reply.clone())
        });
        match failure.as_deref() {
            Some("limited") => {
                return respond(
                    stream,
                    429,
                    "application/json",
                    r#"{"error":{"message":"DO_NOT_EXPOSE_PROVIDER_ERRORS"}}"#,
                );
            }
            Some("unauthorized") => return respond(stream, 401, "application/json", "{}"),
            Some("http") => return respond(stream, 503, "application/json", "{}"),
            _ => (),
        }
        // A string reply is the model's raw text; anything else is sent as JSON.
        let text = reply
            .as_str()
            .map_or_else(|| reply.to_string(), str::to_owned);
        let middle = text
            .char_indices()
            .nth(text.chars().count() / 2)
            .map_or(0, |(i, _)| i);
        let delta = |part: &str| {
            format!(
                "data: {}\r\n\r\n",
                json!({"type": "response.output_text.delta", "delta": part})
            )
        };
        let mut events = delta(&text[..middle]) + &delta(&text[middle..]);
        match failure.as_deref() {
            Some("interrupted") => {}
            Some("failed") => events += "data: {\"type\":\"response.failed\"}\n\n",
            Some("malformed") => events += "data: invalid-json\n\n",
            Some("refusal") => {
                events += &format!(
                    "data: {}\n\n",
                    json!({"type": "response.refusal.delta", "delta": "No."})
                );
            }
            _ => {
                events += &format!(
                    "data: {}\n\n",
                    json!({"type": "response.completed", "response": {"status": "completed", "output": []}})
                );
            }
        }
        respond(stream, 200, "text/event-stream", &events);
    }
}

/// A plain loopback GET, as the person's browser follows a redirect.
pub fn get(url: &url::Url) -> (u16, String) {
    let mut stream =
        TcpStream::connect((url.host_str().unwrap(), url.port().unwrap())).expect("listener");
    let target = format!("{}?{}", url.path(), url.query().unwrap_or(""));
    write!(
        stream,
        "GET {target} HTTP/1.1\r\nHost: {}\r\nConnection: close\r\n\r\n",
        url.authority()
    )
    .unwrap();
    let mut reply = String::new();
    stream.read_to_string(&mut reply).unwrap();
    let status = reply[9..12].parse().unwrap();
    let body = reply.split("\r\n\r\n").nth(1).unwrap_or("").to_owned();
    (status, body)
}

/// A minimal JSON client for the household server, as a browser would call it.
pub fn api(method: &str, url: &str, token: Option<&str>, body: Option<&Value>) -> (u16, Value) {
    let url = url::Url::parse(url).unwrap();
    let mut stream =
        TcpStream::connect((url.host_str().unwrap(), url.port().unwrap())).expect("server");
    let payload = body.map(Value::to_string).unwrap_or_default();
    write!(
        stream,
        "{method} {} HTTP/1.1\r\nHost: {}\r\nConnection: close\r\nContent-Type: application/json\r\n{}Content-Length: {}\r\n\r\n{payload}",
        url.path(),
        url.authority(),
        token.map(|t| format!("Authorization: Bearer {t}\r\n")).unwrap_or_default(),
        payload.len()
    )
    .unwrap();
    let mut reply = String::new();
    stream.read_to_string(&mut reply).unwrap();
    let status = reply[9..12].parse().unwrap();
    let text = reply.split("\r\n\r\n").nth(1).unwrap_or("");
    (status, serde_json::from_str(text).unwrap_or(Value::Null))
}
