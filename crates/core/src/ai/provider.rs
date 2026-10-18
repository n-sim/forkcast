//! The ChatGPT provider boundary: OAuth sign-in with dynamic registration,
//! identity verification, token refresh and revocation, model discovery, and
//! streamed execution. Failures carry fixed, person-readable messages; provider
//! bodies and credentials are never forwarded.

use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use jsonwebtoken::{Algorithm, DecodingKey, Validation, decode, decode_header, jwk::JwkSet};
use rand::{RngCore, rngs::OsRng};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    io::{BufRead, BufReader, Read},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use url::Url;

pub(crate) const PRODUCTION_ISSUER: &str = "https://auth.openai.com";
const RESOURCE: &str = "https://api.openai.com/v1";
const SCOPES: &str =
    "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";
const DIRECT_SCOPE: &str = "chatgpt.tokens.use.direct";
const DYNAMIC_CLIENT: &str = "dynamic_agent_client";
const ATTEMPT_LIFETIME: Duration = Duration::from_secs(600);

pub(crate) fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn random() -> String {
    let mut bytes = [0u8; 32];
    OsRng.fill_bytes(&mut bytes);
    URL_SAFE_NO_PAD.encode(bytes)
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Tokens {
    pub access_token: String,
    pub refresh_token: String,
    pub id_token: String,
    pub scope: String,
    pub expires_at: u64,
}

/// Why a provider call failed, already phrased for a person.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Failure {
    /// The access token was refused.
    Unauthorized,
    Limited,
    /// The provider declined this request on content grounds.
    Declined,
    /// A sign-in problem; the message says what to do.
    Rejected(&'static str),
    Unavailable,
}

impl Failure {
    pub(crate) fn message(&self) -> &'static str {
        match self {
            Failure::Unauthorized => "ChatGPT needs reconnection. Connect again in Settings.",
            Failure::Limited => "ChatGPT usage is temporarily limited. Try again later.",
            Failure::Declined => {
                "ChatGPT declined this request. Adjust your instructions and try again."
            }
            Failure::Rejected(message) => message,
            Failure::Unavailable => "ChatGPT could not complete this request. Try again.",
        }
    }
}

const UNREACHABLE: &str = "ChatGPT could not be reached. Try connecting again.";
const IDENTITY: &str = "ChatGPT identity could not be verified. Try connecting again.";
const CREDENTIALS: &str = "ChatGPT returned an invalid credential response. Try connecting again.";

/// One sign-in in progress. It lives only in memory.
pub(crate) struct Attempt {
    pub state: String,
    nonce: String,
    verifier: String,
    /// The registration to reuse, when this device already holds one.
    pub client_id: Option<String>,
    /// A reconnection must return the same ChatGPT account.
    pub subject: Option<String>,
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

pub(crate) struct Connection {
    pub subject: String,
    pub email: Option<String>,
    pub tokens: Tokens,
    pub client_id: String,
}

#[derive(Deserialize)]
struct TokenResponse {
    access_token: String,
    refresh_token: Option<String>,
    id_token: Option<String>,
    token_type: String,
    expires_in: u64,
    scope: Option<String>,
}

#[derive(Deserialize)]
struct Identity {
    sub: String,
    nonce: Option<String>,
    email: Option<String>,
}

#[derive(Deserialize, Serialize)]
pub(crate) struct Model {
    pub slug: String,
    pub display_name: String,
    #[serde(default)]
    pub visibility: String,
}

pub(crate) struct Provider {
    issuer: String,
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

impl Provider {
    pub(crate) fn new(issuer: &str) -> Self {
        Self {
            issuer: issuer.to_owned(),
            short: agent(Duration::from_secs(15)),
            long: agent(Duration::from_secs(180)),
        }
    }

    // Only an isolated fixture issuer can replace the provider's API.
    fn endpoint(&self, path: &str) -> String {
        if self.issuer == PRODUCTION_ISSUER {
            format!("{RESOURCE}/{path}")
        } else {
            format!("{}/v1/{path}", self.issuer)
        }
    }

    pub(crate) fn start(
        &self,
        host_id: &str,
        redirect: &str,
        client_id: Option<&str>,
        subject: Option<&str>,
    ) -> (Attempt, String) {
        let attempt = Attempt {
            state: random(),
            nonce: random(),
            verifier: random(),
            client_id: client_id.map(str::to_owned),
            subject: subject.map(str::to_owned),
            started: Instant::now(),
        };
        let mut url = Url::parse(&format!("{}/api/accounts/authorize", self.issuer))
            .expect("validated issuer");
        {
            let mut query = url.query_pairs_mut();
            query.extend_pairs([
                (
                    "client_id",
                    attempt.client_id.as_deref().unwrap_or(DYNAMIC_CLIENT),
                ),
                ("ext_agent_host_id", host_id),
                ("response_type", "code"),
                ("redirect_uri", redirect),
                ("scope", SCOPES),
                ("resource", RESOURCE),
                ("state", &attempt.state),
                ("nonce", &attempt.nonce),
                ("code_challenge_method", "S256"),
                (
                    "code_challenge",
                    &URL_SAFE_NO_PAD.encode(Sha256::digest(attempt.verifier.as_bytes())),
                ),
            ]);
            if attempt.client_id.is_none() {
                query.append_pair("agent_name_hint", "Forkcast");
            }
        }
        (attempt, url.into())
    }

    /// The registration an issued callback names. A stored registration is
    /// never replaced by the dynamic placeholder, even after a failed exchange.
    pub(crate) fn issued_client(
        attempt: &Attempt,
        returned: Option<&str>,
    ) -> Result<String, &'static str> {
        match (&attempt.client_id, returned) {
            (Some(expected), Some(actual)) if expected != actual => {
                Err("ChatGPT returned a different registration. Try connecting again.")
            }
            (Some(expected), _) => Ok(expected.clone()),
            (None, Some(actual)) if actual.starts_with("oaiapp_") && actual.len() <= 256 => {
                Ok(actual.to_owned())
            }
            _ => Err("ChatGPT registration was incomplete. Try connecting again."),
        }
    }

    fn token_request(&self, form: &[(&str, &str)]) -> Result<TokenResponse, u16> {
        let mut response = self
            .short
            .post(&format!("{}/api/accounts/oauth/token", self.issuer))
            .send_form(form.iter().copied())
            .map_err(|_| 0u16)?;
        let status = response.status().as_u16();
        if status != 200 {
            return Err(status);
        }
        response.body_mut().read_json().map_err(|_| 1u16)
    }

    pub(crate) fn exchange(
        &self,
        redirect: &str,
        attempt: &Attempt,
        client_id: &str,
        code: &str,
    ) -> Result<Connection, &'static str> {
        let token = self
            .token_request(&[
                ("grant_type", "authorization_code"),
                ("client_id", client_id),
                ("code", code),
                ("code_verifier", &attempt.verifier),
                ("redirect_uri", redirect),
                ("resource", RESOURCE),
            ])
            .map_err(|status| match status {
                0 => UNREACHABLE,
                1 => CREDENTIALS,
                _ => "ChatGPT sign-in could not be completed. Try connecting again.",
            })?;
        let id_token = token.id_token.clone().ok_or(CREDENTIALS)?;
        let refresh_token = token.refresh_token.clone().ok_or(CREDENTIALS)?;
        let scope = token.scope.clone().unwrap_or_default();
        let identity = self.verify_identity(&id_token, client_id)?;
        if identity.nonce.as_deref() != Some(&attempt.nonce)
            || identity.sub.is_empty()
            || attempt
                .subject
                .as_ref()
                .is_some_and(|subject| subject != &identity.sub)
        {
            return Err(IDENTITY);
        }
        if !scope.split_whitespace().any(|s| s == DIRECT_SCOPE) {
            return Err(
                "ChatGPT plan usage was not enabled. Reconnect and allow Forkcast to use your ChatGPT plan.",
            );
        }
        if !token.token_type.eq_ignore_ascii_case("Bearer")
            || token.access_token.is_empty()
            || refresh_token.is_empty()
            || token.expires_in == 0
            || token.expires_in > 86_400
        {
            return Err(CREDENTIALS);
        }
        Ok(Connection {
            subject: identity.sub,
            email: identity.email,
            client_id: client_id.to_owned(),
            tokens: Tokens {
                access_token: token.access_token,
                refresh_token,
                id_token,
                scope,
                expires_at: now() + token.expires_in,
            },
        })
    }

    fn verify_identity(&self, id_token: &str, client_id: &str) -> Result<Identity, &'static str> {
        let mut response = self
            .short
            .get(&format!("{}/.well-known/jwks.json", self.issuer))
            .call()
            .map_err(|_| IDENTITY)?;
        if response.status().as_u16() != 200 {
            return Err(IDENTITY);
        }
        let keys: JwkSet = response.body_mut().read_json().map_err(|_| IDENTITY)?;
        let header = decode_header(id_token).map_err(|_| IDENTITY)?;
        if header.alg != Algorithm::RS256 {
            return Err(IDENTITY);
        }
        let key = keys
            .find(header.kid.as_deref().ok_or(IDENTITY)?)
            .ok_or(IDENTITY)?;
        let mut validation = Validation::new(Algorithm::RS256);
        validation.set_issuer(&[&self.issuer]);
        validation.set_audience(&[client_id]);
        validation.set_required_spec_claims(&["sub", "exp", "iat", "iss", "aud"]);
        validation.leeway = 5;
        decode::<Identity>(
            id_token,
            &DecodingKey::from_jwk(key).map_err(|_| IDENTITY)?,
            &validation,
        )
        .map(|data| data.claims)
        .map_err(|_| IDENTITY)
    }

    /// Exchanges the refresh token for a new session. The provider rotates
    /// refresh tokens, so the caller must persist the result before using it.
    /// `Ok(None)` means the provider refused: the session is gone.
    pub(crate) fn refresh(
        &self,
        client_id: &str,
        tokens: &Tokens,
    ) -> Result<Option<Tokens>, Failure> {
        match self.token_request(&[
            ("grant_type", "refresh_token"),
            ("client_id", client_id),
            ("refresh_token", &tokens.refresh_token),
            ("resource", RESOURCE),
        ]) {
            Ok(token) => {
                if token.access_token.is_empty()
                    || !token.token_type.eq_ignore_ascii_case("Bearer")
                    || token.expires_in == 0
                    || token.expires_in > 86_400
                {
                    return Err(Failure::Unavailable);
                }
                Ok(Some(Tokens {
                    access_token: token.access_token,
                    refresh_token: token
                        .refresh_token
                        .filter(|t| !t.is_empty())
                        .unwrap_or_else(|| tokens.refresh_token.clone()),
                    id_token: token.id_token.unwrap_or_else(|| tokens.id_token.clone()),
                    scope: token.scope.unwrap_or_else(|| tokens.scope.clone()),
                    expires_at: now() + token.expires_in,
                }))
            }
            Err(400 | 401 | 403) => Ok(None),
            Err(_) => Err(Failure::Unavailable),
        }
    }

    /// Whether the provider confirmed the revocation.
    pub(crate) fn revoke(&self, client_id: &str, refresh_token: &str) -> bool {
        for retry in 0..2 {
            if retry > 0 {
                std::thread::sleep(Duration::from_millis(100));
            }
            let result = self
                .short
                .post(&format!("{}/api/accounts/oauth/revoke", self.issuer))
                .send_form([
                    ("token", refresh_token),
                    ("token_type_hint", "refresh_token"),
                    ("client_id", client_id),
                ]);
            match result {
                Ok(response) if response.status().as_u16() == 200 => return true,
                Ok(response) if response.status().as_u16() < 500 => return false,
                _ => (),
            }
        }
        false
    }

    fn checked(
        response: ureq::http::Response<ureq::Body>,
    ) -> Result<ureq::http::Response<ureq::Body>, Failure> {
        match response.status().as_u16() {
            200..=299 => Ok(response),
            401 => Err(Failure::Unauthorized),
            429 => Err(Failure::Limited),
            _ => Err(Failure::Unavailable),
        }
    }

    pub(crate) fn models(&self, access_token: &str) -> Result<Vec<Model>, Failure> {
        let response = self
            .short
            .get(&self.endpoint("models"))
            .header("Authorization", format!("Bearer {access_token}"))
            .call()
            .map_err(|_| Failure::Unavailable)?;
        let mut response = Self::checked(response)?;
        let mut body: Value = response
            .body_mut()
            .read_json()
            .map_err(|_| Failure::Unavailable)?;
        let models: Vec<Model> =
            serde_json::from_value(body["models"].take()).map_err(|_| Failure::Unavailable)?;
        Ok(models
            .into_iter()
            .filter(|model| model.visibility == "list")
            .collect())
    }

    /// Runs one streamed response and returns its text, accepted only after
    /// the provider confirms completion.
    pub(crate) fn execute(
        &self,
        access_token: &str,
        model: &str,
        instructions: &str,
        input: &str,
    ) -> Result<String, Failure> {
        let response = self
            .long
            .post(&self.endpoint("responses"))
            .header("Authorization", format!("Bearer {access_token}"))
            .send_json(json!({
                "model": model,
                "instructions": instructions,
                "input": [{ "role": "user", "content": input }],
                "store": false,
                "stream": true,
            }))
            .map_err(|_| Failure::Unavailable)?;
        let mut response = Self::checked(response)?;
        let mut reader = BufReader::new(response.body_mut().as_reader().take(2_000_000));
        let mut data = String::new();
        let mut streamed = String::new();
        let mut line = Vec::new();
        loop {
            line.clear();
            if reader
                .read_until(b'\n', &mut line)
                .map_err(|_| Failure::Unavailable)?
                == 0
            {
                return Err(Failure::Unavailable);
            }
            let text = std::str::from_utf8(&line)
                .map_err(|_| Failure::Unavailable)?
                .trim_end_matches(['\r', '\n']);
            if text.is_empty() && !data.is_empty() {
                let event: Value = serde_json::from_str(&data).map_err(|_| Failure::Unavailable)?;
                data.clear();
                match event["type"].as_str() {
                    Some("response.output_text.delta") => {
                        streamed.push_str(event["delta"].as_str().ok_or(Failure::Unavailable)?);
                    }
                    Some("response.refusal.delta" | "response.refusal.done") => {
                        return Err(Failure::Declined);
                    }
                    Some("response.completed") => return completed(&event, streamed),
                    Some("response.failed" | "response.incomplete" | "error") => {
                        return Err(Failure::Unavailable);
                    }
                    _ => (),
                }
            } else if let Some(value) = text.strip_prefix("data:") {
                data.push_str(value.trim_start_matches(' '));
                data.push('\n');
            }
        }
    }
}

fn completed(event: &Value, mut streamed: String) -> Result<String, Failure> {
    if event["response"]["status"] != "completed" {
        return Err(Failure::Unavailable);
    }
    let mut text = String::new();
    for item in event["response"]["output"]
        .as_array()
        .ok_or(Failure::Unavailable)?
    {
        if item["type"] != "message" {
            continue;
        }
        for content in item["content"].as_array().ok_or(Failure::Unavailable)? {
            if content["type"] == "refusal" {
                return Err(Failure::Declined);
            }
            if content["type"] == "output_text" {
                text.push_str(content["text"].as_str().ok_or(Failure::Unavailable)?);
            }
        }
    }
    // Subscription inference may leave output empty in the terminal snapshot.
    if text.is_empty() {
        text = std::mem::take(&mut streamed);
    }
    if text.trim().is_empty() {
        return Err(Failure::Rejected(
            "ChatGPT completed the request without any text. Try again or select another model.",
        ));
    }
    Ok(text)
}
