use crate::vault::{Record, Tokens};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use jsonwebtoken::{Algorithm, DecodingKey, Validation, decode, decode_header, jwk::JwkSet};
use rand::{RngCore, rngs::OsRng};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use url::Url;

pub const RESOURCE: &str = "https://api.openai.com/v1";
pub const SCOPES: &str =
    "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";
const DYNAMIC_CLIENT: &str = "dynamic_agent_client";

pub fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

pub fn random() -> String {
    let mut bytes = [0u8; 32];
    OsRng.fill_bytes(&mut bytes);
    URL_SAFE_NO_PAD.encode(bytes)
}

pub struct Attempt {
    pub state: String,
    nonce: String,
    verifier: String,
    pub client_id: Option<String>,
    pub subject: Option<String>,
    pub started: Instant,
}

impl Attempt {
    pub fn expired(&self) -> bool {
        self.started.elapsed() >= Duration::from_secs(600)
    }

    pub fn start(issuer: &str, redirect: &str, record: &Record) -> (Self, String) {
        let attempt = Self {
            state: random(),
            nonce: random(),
            verifier: random(),
            client_id: record.client_id.clone(),
            subject: record.subject.clone(),
            started: Instant::now(),
        };
        let mut url =
            Url::parse(&format!("{issuer}/api/accounts/authorize")).expect("validated issuer");
        {
            let mut query = url.query_pairs_mut();
            query.extend_pairs([
                (
                    "client_id",
                    attempt.client_id.as_deref().unwrap_or(DYNAMIC_CLIENT),
                ),
                ("ext_agent_host_id", &record.host_id),
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
            // Login hints are optional. Omit ID-token hints to keep every
            // credential out of browser-facing companion response bodies.
        }
        (attempt, url.into())
    }

    pub fn issued_client(&self, returned: Option<&str>) -> Result<String, &'static str> {
        match (&self.client_id, returned) {
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
}

#[derive(Deserialize)]
struct TokenResponse {
    access_token: String,
    refresh_token: String,
    id_token: String,
    token_type: String,
    expires_in: u64,
    scope: String,
}

#[derive(Deserialize)]
struct Identity {
    sub: String,
    nonce: String,
    email: Option<String>,
}

pub struct Connection {
    pub subject: String,
    pub email: Option<String>,
    pub tokens: Tokens,
}

pub async fn exchange(
    http: &reqwest::Client,
    issuer: &str,
    redirect: &str,
    attempt: &Attempt,
    client_id: &str,
    code: &str,
) -> Result<Connection, &'static str> {
    let response = http
        .post(format!("{issuer}/api/accounts/oauth/token"))
        .form(&[
            ("grant_type", "authorization_code"),
            ("client_id", client_id),
            ("code", code),
            ("code_verifier", &attempt.verifier),
            ("redirect_uri", redirect),
            ("resource", RESOURCE),
        ])
        .send()
        .await
        .map_err(|_| "ChatGPT could not be reached. Try connecting again.")?;
    let token: TokenResponse = response
        .error_for_status()
        .map_err(|_| "ChatGPT sign-in could not be completed. Try connecting again.")?
        .json()
        .await
        .map_err(|_| "ChatGPT returned an invalid credential response. Try connecting again.")?;
    let keys: JwkSet = http
        .get(format!("{issuer}/.well-known/jwks.json"))
        .send()
        .await
        .map_err(|_| "ChatGPT identity could not be verified. Try connecting again.")?
        .error_for_status()
        .map_err(|_| "ChatGPT identity could not be verified. Try connecting again.")?
        .json()
        .await
        .map_err(|_| "ChatGPT identity could not be verified. Try connecting again.")?;
    let invalid = "ChatGPT identity could not be verified. Try connecting again.";
    let header = decode_header(&token.id_token).map_err(|_| invalid)?;
    if header.alg != Algorithm::RS256 {
        return Err(invalid);
    }
    let key = keys
        .find(header.kid.as_deref().ok_or(invalid)?)
        .ok_or(invalid)?;
    let mut validation = Validation::new(Algorithm::RS256);
    validation.set_issuer(&[issuer]);
    validation.set_audience(&[client_id]);
    validation.set_required_spec_claims(&["sub", "exp", "iat", "iss", "aud"]);
    validation.leeway = 5;
    let identity = decode::<Identity>(
        &token.id_token,
        &DecodingKey::from_jwk(key).map_err(|_| invalid)?,
        &validation,
    )
    .map_err(|_| invalid)?
    .claims;
    if identity.nonce != attempt.nonce
        || identity.sub.is_empty()
        || attempt
            .subject
            .as_ref()
            .is_some_and(|subject| subject != &identity.sub)
    {
        return Err(invalid);
    }
    if !token
        .scope
        .split_whitespace()
        .any(|scope| scope == "chatgpt.tokens.use.direct")
    {
        return Err(
            "ChatGPT plan usage was not enabled. Reconnect and allow Forkcast to use your ChatGPT plan.",
        );
    }
    if !token.token_type.eq_ignore_ascii_case("Bearer")
        || token.access_token.is_empty()
        || token.refresh_token.is_empty()
        || token.expires_in == 0
        || token.expires_in > 86400
    {
        return Err("ChatGPT returned an invalid credential response. Try connecting again.");
    }
    Ok(Connection {
        subject: identity.sub,
        email: identity.email,
        tokens: Tokens {
            access_token: token.access_token,
            refresh_token: token.refresh_token,
            id_token: token.id_token,
            scope: token.scope,
            expires_at: now() + token.expires_in,
        },
    })
}
