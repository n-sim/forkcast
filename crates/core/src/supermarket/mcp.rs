//! The Gurkerl boundary: OAuth sign-in as the MCP authorization specification
//! describes it (protected-resource and authorization-server discovery,
//! dynamic client registration, S256 PKCE, resource indicators, refresh), and
//! MCP tool discovery and calls over Streamable HTTP. Failures carry fixed,
//! person-readable messages; supermarket bodies and credentials are never
//! forwarded to the person.

use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use rand::{RngCore, rngs::OsRng};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    io::{BufRead, BufReader, Read},
    time::{Duration, Instant},
};
use url::Url;

pub(crate) const PRODUCTION_SERVER: &str = "https://mcp.gurkerl.at/mcp";
const PROTOCOL_VERSION: &str = "2025-06-18";
const ATTEMPT_LIFETIME: Duration = Duration::from_secs(600);
/// The most tools Forkcast reads from one listing.
const MAX_TOOLS: usize = 200;
/// The most text of one tool result that is kept.
const MAX_RESULT_CHARS: usize = 6000;

const UNREACHABLE: &str = "Gurkerl could not be reached. Try connecting again.";
const DISCOVERY: &str =
    "Gurkerl's sign-in service could not be verified. Try connecting again later.";
const REGISTRATION: &str = "Gurkerl did not accept Forkcast's registration. Try connecting again.";
const CREDENTIALS: &str = "Gurkerl returned an invalid sign-in response. Try connecting again.";

fn random() -> String {
    let mut bytes = [0u8; 32];
    OsRng.fill_bytes(&mut bytes);
    URL_SAFE_NO_PAD.encode(bytes)
}

fn now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Tokens {
    pub access_token: String,
    pub refresh_token: Option<String>,
    /// Seconds since the Unix epoch, when the server says.
    pub expires_at: Option<u64>,
}

impl Tokens {
    /// Still usable for at least another minute.
    pub(crate) fn fresh(&self) -> bool {
        self.expires_at.is_none_or(|expires| expires > now() + 60)
    }
}

/// The client registration a sign-in was issued to, needed to refresh.
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Registration {
    pub client_id: String,
    pub token_endpoint: String,
}

/// One sign-in in progress. It lives only in memory.
pub(crate) struct Attempt {
    pub state: String,
    verifier: String,
    redirect: String,
    pub registration: Registration,
    started: Instant,
}

impl Attempt {
    pub fn expired(&self) -> bool {
        self.started.elapsed() >= ATTEMPT_LIFETIME
    }

    pub fn deadline(&self) -> Instant {
        self.started + ATTEMPT_LIFETIME
    }
}

/// Why a supermarket call failed.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Failure {
    /// The access token was refused.
    Unauthorized,
    Unavailable,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Tool {
    pub name: String,
    pub description: String,
    pub input_schema: Value,
    #[serde(skip)]
    pub read_only: bool,
}

pub(crate) struct ToolResult {
    pub is_error: bool,
    pub text: String,
}

#[derive(Deserialize)]
struct TokenResponse {
    access_token: String,
    refresh_token: Option<String>,
    token_type: String,
    expires_in: Option<u64>,
}

pub(crate) struct Gurkerl {
    server: String,
    short: ureq::Agent,
    long: ureq::Agent,
}

fn agent(timeout: Duration) -> ureq::Agent {
    ureq::Agent::config_builder()
        .timeout_global(Some(timeout))
        .http_status_as_error(false)
        .max_redirects(0)
        .build()
        .into()
}

/// HTTPS everywhere, except the isolated loopback fixture tests use.
fn trusted(url: &Url, fixture: bool) -> bool {
    url.username().is_empty()
        && url.password().is_none()
        && url.fragment().is_none()
        && match url.scheme() {
            "https" => !fixture,
            "http" => fixture && url.host_str() == Some("127.0.0.1"),
            _ => false,
        }
}

/// RFC 8414 and RFC 9728 place well-known documents between the origin and
/// the path of the URL they describe.
fn well_known(base: &Url, document: &str) -> String {
    let path = base.path().trim_end_matches('/');
    format!(
        "{}/.well-known/{document}{path}",
        base.origin().ascii_serialization()
    )
}

impl Gurkerl {
    pub(crate) fn new(server: &str) -> Self {
        Self {
            server: server.to_owned(),
            short: agent(Duration::from_secs(15)),
            long: agent(Duration::from_secs(60)),
        }
    }

    fn fixture(&self) -> bool {
        self.server != PRODUCTION_SERVER
    }

    fn checked_url(&self, value: Option<&str>) -> Result<Url, &'static str> {
        value
            .and_then(|value| Url::parse(value).ok())
            .filter(|url| trusted(url, self.fixture()))
            .ok_or(DISCOVERY)
    }

    fn get_json(&self, url: &str) -> Option<Value> {
        let mut response = self.short.get(url).call().ok()?;
        if response.status().as_u16() != 200 {
            return None;
        }
        response.body_mut().read_json().ok()
    }

    /// Discovers the authorization server, registers this installation as a
    /// public client for `redirect`, and returns the address to open in the
    /// person's own browser.
    pub(crate) fn start(&self, redirect: &str) -> Result<(Attempt, String), &'static str> {
        let server = Url::parse(&self.server).map_err(|_| DISCOVERY)?;
        let resource = self
            .get_json(&well_known(&server, "oauth-protected-resource"))
            .ok_or(UNREACHABLE)?;
        // The metadata must describe this very server, so another resource's
        // tokens can never be requested on its behalf.
        if resource["resource"]
            .as_str()
            .map(|r| r.trim_end_matches('/'))
            != Some(self.server.trim_end_matches('/'))
        {
            return Err(DISCOVERY);
        }
        let issuer = self.checked_url(resource["authorization_servers"][0].as_str())?;
        let metadata = self
            .get_json(&well_known(&issuer, "oauth-authorization-server"))
            .or_else(|| self.get_json(&well_known(&issuer, "openid-configuration")))
            .ok_or(UNREACHABLE)?;
        if metadata["issuer"].as_str().map(|i| i.trim_end_matches('/'))
            != Some(issuer.as_str().trim_end_matches('/'))
            || !metadata["code_challenge_methods_supported"]
                .as_array()
                .is_some_and(|methods| methods.iter().any(|method| method == "S256"))
        {
            return Err(DISCOVERY);
        }
        let authorization = self.checked_url(metadata["authorization_endpoint"].as_str())?;
        let token_endpoint = self.checked_url(metadata["token_endpoint"].as_str())?;
        let registration = self.checked_url(metadata["registration_endpoint"].as_str())?;
        let mut response = self
            .short
            .post(registration.as_str())
            .send_json(json!({
                "client_name": "Forkcast",
                "redirect_uris": [redirect],
                "grant_types": ["authorization_code", "refresh_token"],
                "response_types": ["code"],
                "token_endpoint_auth_method": "none",
            }))
            .map_err(|_| UNREACHABLE)?;
        if !matches!(response.status().as_u16(), 200 | 201) {
            return Err(REGISTRATION);
        }
        let registered: Value = response.body_mut().read_json().map_err(|_| REGISTRATION)?;
        let client_id = registered["client_id"]
            .as_str()
            .filter(|id| !id.is_empty() && id.len() <= 512)
            .ok_or(REGISTRATION)?
            .to_owned();
        let attempt = Attempt {
            state: random(),
            verifier: random(),
            redirect: redirect.to_owned(),
            registration: Registration {
                client_id,
                token_endpoint: token_endpoint.into(),
            },
            started: Instant::now(),
        };
        let scopes = resource["scopes_supported"]
            .as_array()
            .map(|scopes| {
                scopes
                    .iter()
                    .filter_map(Value::as_str)
                    .collect::<Vec<_>>()
                    .join(" ")
            })
            .unwrap_or_default();
        let mut url = authorization;
        {
            let mut query = url.query_pairs_mut();
            query.extend_pairs([
                ("response_type", "code"),
                ("client_id", attempt.registration.client_id.as_str()),
                ("redirect_uri", redirect),
                ("state", &attempt.state),
                ("resource", &self.server),
                ("code_challenge_method", "S256"),
                (
                    "code_challenge",
                    &URL_SAFE_NO_PAD.encode(Sha256::digest(attempt.verifier.as_bytes())),
                ),
            ]);
            if !scopes.is_empty() {
                query.append_pair("scope", &scopes);
            }
        }
        Ok((attempt, url.into()))
    }

    fn token_request(
        &self,
        endpoint: &str,
        form: &[(&str, &str)],
    ) -> Result<std::result::Result<Tokens, u16>, Failure> {
        let mut response = self
            .short
            .post(endpoint)
            .send_form(form.iter().copied())
            .map_err(|_| Failure::Unavailable)?;
        let status = response.status().as_u16();
        if status != 200 {
            return Ok(Err(status));
        }
        let tokens: TokenResponse = response
            .body_mut()
            .read_json()
            .map_err(|_| Failure::Unavailable)?;
        if !tokens.token_type.eq_ignore_ascii_case("bearer") || tokens.access_token.is_empty() {
            return Err(Failure::Unavailable);
        }
        Ok(Ok(Tokens {
            access_token: tokens.access_token,
            refresh_token: tokens.refresh_token.filter(|token| !token.is_empty()),
            expires_at: tokens.expires_in.map(|seconds| now() + seconds),
        }))
    }

    pub(crate) fn exchange(&self, attempt: &Attempt, code: &str) -> Result<Tokens, &'static str> {
        match self.token_request(
            &attempt.registration.token_endpoint,
            &[
                ("grant_type", "authorization_code"),
                ("code", code),
                ("redirect_uri", &attempt.redirect),
                ("client_id", &attempt.registration.client_id),
                ("code_verifier", &attempt.verifier),
                ("resource", &self.server),
            ],
        ) {
            Ok(Ok(tokens)) => Ok(tokens),
            Ok(Err(_)) => Err(CREDENTIALS),
            Err(_) => Err(UNREACHABLE),
        }
    }

    /// `Ok(None)` when the session cannot be renewed and the person must
    /// connect again; an outage is an error and leaves the session intact.
    pub(crate) fn refresh(
        &self,
        registration: &Registration,
        tokens: &Tokens,
    ) -> Result<Option<Tokens>, Failure> {
        let Some(refresh_token) = &tokens.refresh_token else {
            return Ok(None);
        };
        match self.token_request(
            &registration.token_endpoint,
            &[
                ("grant_type", "refresh_token"),
                ("refresh_token", refresh_token),
                ("client_id", &registration.client_id),
                ("resource", &self.server),
            ],
        )? {
            Ok(mut renewed) => {
                // A server that does not rotate keeps the current refresh token.
                if renewed.refresh_token.is_none() {
                    renewed.refresh_token = tokens.refresh_token.clone();
                }
                Ok(Some(renewed))
            }
            Err(400 | 401) => Ok(None),
            Err(_) => Err(Failure::Unavailable),
        }
    }

    /// Opens an MCP session with the person's access token.
    pub(crate) fn connect(&self, access_token: &str) -> Result<Session<'_>, Failure> {
        let mut session = Session {
            gurkerl: self,
            access_token: access_token.to_owned(),
            id: None,
            next: 1,
        };
        let initialized = session.request(
            "initialize",
            json!({
                "protocolVersion": PROTOCOL_VERSION,
                "capabilities": {},
                "clientInfo": {"name": "Forkcast", "version": env!("CARGO_PKG_VERSION")},
            }),
        )?;
        if initialized.get("error").is_some() {
            return Err(Failure::Unavailable);
        }
        session.notify("notifications/initialized")?;
        Ok(session)
    }
}

/// One MCP session over Streamable HTTP.
pub(crate) struct Session<'a> {
    gurkerl: &'a Gurkerl,
    access_token: String,
    id: Option<String>,
    next: u64,
}

impl Session<'_> {
    fn post(&self, body: &Value) -> Result<ureq::http::Response<ureq::Body>, Failure> {
        let mut request = self
            .gurkerl
            .long
            .post(&self.gurkerl.server)
            .header("Authorization", format!("Bearer {}", self.access_token))
            .header("Accept", "application/json, text/event-stream")
            .header("MCP-Protocol-Version", PROTOCOL_VERSION);
        if let Some(id) = &self.id {
            request = request.header("Mcp-Session-Id", id);
        }
        let response = request.send_json(body).map_err(|_| Failure::Unavailable)?;
        match response.status().as_u16() {
            200..=299 => Ok(response),
            401 | 403 => Err(Failure::Unauthorized),
            _ => Err(Failure::Unavailable),
        }
    }

    fn notify(&self, method: &str) -> Result<(), Failure> {
        self.post(&json!({"jsonrpc": "2.0", "method": method}))
            .map(|_| ())
    }

    /// Sends one request and returns its JSON-RPC response object, whether
    /// the server answers with JSON or an event stream.
    fn request(&mut self, method: &str, params: Value) -> Result<Value, Failure> {
        let id = self.next;
        self.next += 1;
        let mut response = self.post(&json!({
            "jsonrpc": "2.0", "id": id, "method": method, "params": params,
        }))?;
        if let Some(session) = response
            .headers()
            .get("mcp-session-id")
            .and_then(|value| value.to_str().ok())
        {
            self.id = Some(session.to_owned());
        }
        let streamed = response
            .headers()
            .get("content-type")
            .and_then(|value| value.to_str().ok())
            .is_some_and(|value| value.starts_with("text/event-stream"));
        let matches = |message: &Value| {
            message["id"].as_u64() == Some(id)
                && (message.get("result").is_some() || message.get("error").is_some())
        };
        if !streamed {
            let message: Value = response
                .body_mut()
                .with_config()
                .limit(4_000_000)
                .read_json()
                .map_err(|_| Failure::Unavailable)?;
            return if matches(&message) {
                Ok(message)
            } else {
                Err(Failure::Unavailable)
            };
        }
        let mut reader = BufReader::new(response.body_mut().as_reader().take(4_000_000));
        let mut data = String::new();
        let mut line = String::new();
        loop {
            line.clear();
            if reader
                .read_line(&mut line)
                .map_err(|_| Failure::Unavailable)?
                == 0
            {
                return Err(Failure::Unavailable);
            }
            let text = line.trim_end_matches(['\r', '\n']);
            if text.is_empty() {
                if !data.is_empty() {
                    if let Ok(message) = serde_json::from_str::<Value>(&data)
                        && matches(&message)
                    {
                        return Ok(message);
                    }
                    data.clear();
                }
            } else if let Some(value) = text.strip_prefix("data:") {
                data.push_str(value.trim_start_matches(' '));
            }
        }
    }

    /// Every tool the server offers, across pages.
    pub(crate) fn tools(&mut self) -> Result<Vec<Tool>, Failure> {
        let mut tools = Vec::new();
        let mut cursor: Option<String> = None;
        loop {
            let params = match &cursor {
                Some(cursor) => json!({"cursor": cursor}),
                None => json!({}),
            };
            let message = self.request("tools/list", params)?;
            let result = &message["result"];
            for tool in result["tools"].as_array().ok_or(Failure::Unavailable)? {
                let Some(name) = tool["name"].as_str().filter(|name| name.len() <= 128) else {
                    continue;
                };
                tools.push(Tool {
                    name: name.to_owned(),
                    description: tool["description"]
                        .as_str()
                        .unwrap_or("")
                        .chars()
                        .take(1000)
                        .collect(),
                    input_schema: tool["inputSchema"].clone(),
                    read_only: tool["annotations"]["readOnlyHint"] == true,
                });
            }
            cursor = result["nextCursor"].as_str().map(str::to_owned);
            if cursor.is_none() || tools.len() >= MAX_TOOLS {
                tools.truncate(MAX_TOOLS);
                return Ok(tools);
            }
        }
    }

    /// Calls a tool. A tool or protocol error is a result to report, not a
    /// transport failure.
    pub(crate) fn call(&mut self, name: &str, arguments: &Value) -> Result<ToolResult, Failure> {
        let message = self.request("tools/call", json!({"name": name, "arguments": arguments}))?;
        if let Some(error) = message.get("error") {
            return Ok(ToolResult {
                is_error: true,
                text: error["message"]
                    .as_str()
                    .unwrap_or("The tool call failed.")
                    .chars()
                    .take(MAX_RESULT_CHARS)
                    .collect(),
            });
        }
        let result = &message["result"];
        let mut text: String = result["content"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|part| part["text"].as_str())
            .collect::<Vec<_>>()
            .join("\n");
        if text.is_empty() && !result["structuredContent"].is_null() {
            text = result["structuredContent"].to_string();
        }
        Ok(ToolResult {
            is_error: result["isError"] == true,
            text: text.chars().take(MAX_RESULT_CHARS).collect(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn well_known_documents_sit_between_origin_and_path() {
        let server = Url::parse("https://mcp.gurkerl.at/mcp").unwrap();
        assert_eq!(
            well_known(&server, "oauth-protected-resource"),
            "https://mcp.gurkerl.at/.well-known/oauth-protected-resource/mcp"
        );
        let issuer = Url::parse("https://identity.gurkerl.at").unwrap();
        assert_eq!(
            well_known(&issuer, "oauth-authorization-server"),
            "https://identity.gurkerl.at/.well-known/oauth-authorization-server"
        );
    }

    #[test]
    fn only_https_or_the_loopback_fixture_is_trusted() {
        let parse = |url: &str| Url::parse(url).unwrap();
        assert!(trusted(&parse("https://identity.gurkerl.at/x"), false));
        assert!(!trusted(&parse("http://identity.gurkerl.at/x"), false));
        assert!(!trusted(&parse("http://127.0.0.1:9/x"), false));
        assert!(trusted(&parse("http://127.0.0.1:9/x"), true));
        assert!(!trusted(&parse("https://identity.gurkerl.at/x"), true));
        assert!(!trusted(
            &parse("https://user@identity.gurkerl.at/x"),
            false
        ));
    }
}
