//! The core's client for a household server. Every request carries the
//! synchronization protocol version; a server speaking another version is a
//! visible failure that leaves pending work untouched.

use crate::error::{Error, ErrorKind, Result};
use crate::tls::{CERTIFICATE_CHANGED, PinnedConnector};
use serde_json::Value;
use std::time::Duration;
use ureq::unversioned::{
    resolver::DefaultResolver,
    transport::{Connector, TcpConnector},
};

/// The synchronization contract version both sides must share. Bump it for
/// any change to wire formats or merge rules that older peers cannot handle.
pub const PROTOCOL_VERSION: u32 = 2;
pub(crate) const PROTOCOL_HEADER: &str = "x-forkcast-protocol";

pub(crate) struct Remote {
    base: String,
    pinned: bool,
    token: Option<String>,
    agent: ureq::Agent,
}

/// Accepts HTTPS, or HTTP on loopback, without credentials, query, or fragment.
pub(crate) fn server_url(value: &str) -> Result<String> {
    let invalid = || {
        Error::invalid(
            "Use HTTPS for your backend, or HTTP on localhost. Omit credentials, query strings, and fragments.",
        )
    };
    let value = value.trim();
    let (scheme, rest) = value
        .split_once("://")
        .ok_or_else(|| Error::invalid("Enter a full backend URL."))?;
    let authority = rest.split('/').next().unwrap_or_default();
    let host = if authority.starts_with('[') {
        authority
            .split(']')
            .next()
            .map_or(authority, |h| &authority[..=h.len()])
    } else {
        authority.split(':').next().unwrap_or_default()
    };
    let loopback = matches!(host, "localhost" | "127.0.0.1" | "[::1]");
    if authority.is_empty()
        || authority.contains('@')
        || value.contains('?')
        || value.contains('#')
        || !(scheme == "https" || (scheme == "http" && loopback))
    {
        return Err(invalid());
    }
    Ok(value.trim_end_matches('/').to_owned())
}

impl Remote {
    /// `certificate` is the confirmed fingerprint of a server's own
    /// certificate; without one the server needs a publicly trusted one.
    pub(crate) fn new(base: &str, certificate: Option<&str>, token: Option<String>) -> Self {
        Self::with_timeout(base, certificate, token, Duration::from_secs(8))
    }

    /// For requests that legitimately take long, such as AI execution.
    pub(crate) fn with_timeout(
        base: &str,
        certificate: Option<&str>,
        token: Option<String>,
        timeout: Duration,
    ) -> Self {
        let config = ureq::Agent::config_builder()
            .timeout_global(Some(timeout))
            .http_status_as_error(false)
            .max_redirects(0);
        let agent = match certificate {
            // A household server on the local network: no proxy, and only
            // the confirmed certificate.
            Some(fingerprint) => ureq::Agent::with_parts(
                config.proxy(None).build(),
                TcpConnector::default().chain(PinnedConnector::new(fingerprint)),
                DefaultResolver::default(),
            ),
            None => config.build().into(),
        };
        Self {
            base: base.to_owned(),
            pinned: certificate.is_some(),
            token,
            agent,
        }
    }

    /// `body` is sent as JSON. Success returns the parsed JSON body, or `Null`
    /// when empty.
    pub(crate) fn call(&self, method: &str, path: &str, body: Option<&Value>) -> Result<Value> {
        let url = format!("{}/api{path}", self.base);
        let protocol = PROTOCOL_VERSION.to_string();
        let mut response = match (method, body) {
            ("GET", _) => self.with(self.agent.get(&url), &protocol).call(),
            ("DELETE", _) => self.with(self.agent.delete(&url), &protocol).call(),
            ("POST", Some(body)) => self.with(self.agent.post(&url), &protocol).send_json(body),
            ("POST", None) => self.with(self.agent.post(&url), &protocol).send_empty(),
            ("PATCH", Some(body)) => self.with(self.agent.patch(&url), &protocol).send_json(body),
            _ => return Err(Error::internal()),
        }
        .map_err(|error| match error {
            ureq::Error::Tls(CERTIFICATE_CHANGED) => Error::new(
                ErrorKind::Unavailable,
                "The server presented a different certificate than the one you confirmed, so nothing was sent. If its certificate was replaced on purpose, check and confirm the new one under Settings → Backend & accounts.",
            ),
            _ => Error::new(
                ErrorKind::Unavailable,
                if self.pinned {
                    "Backend unavailable. Check the URL and network, then try again."
                } else {
                    "Backend unavailable. Check the URL, network, and allowed frontend origin, then try again."
                },
            ),
        })?;
        let status = response.status().as_u16();
        let text = response.body_mut().read_to_string().unwrap_or_default();
        let value: Value = if text.trim().is_empty() {
            Value::Null
        } else {
            serde_json::from_str(&text).unwrap_or(Value::Null)
        };
        if (200..300).contains(&status) {
            return Ok(value);
        }
        let message = value["message"]
            .as_str()
            .unwrap_or("The backend could not complete this request.")
            .to_owned();
        let kind = match status {
            401 => ErrorKind::Unauthenticated,
            403 => ErrorKind::Forbidden,
            404 => ErrorKind::NotFound,
            409 => ErrorKind::Conflict,
            412 => ErrorKind::ConnectionRequired,
            422 => ErrorKind::Invalid,
            426 => ErrorKind::ProtocolMismatch,
            429 => ErrorKind::RateLimited,
            _ => ErrorKind::Internal,
        };
        Err(Error::new(kind, message))
    }

    fn with<B>(&self, request: ureq::RequestBuilder<B>, protocol: &str) -> ureq::RequestBuilder<B> {
        let request = request.header(PROTOCOL_HEADER, protocol);
        match &self.token {
            Some(token) => request.header("Authorization", format!("Bearer {token}")),
            None => request,
        }
    }

    /// Confirms this is a Forkcast server speaking our protocol version.
    pub(crate) fn status(&self) -> Result<bool> {
        let status = self.call("GET", "/status", None)?;
        let setup_required = status["setupRequired"]
            .as_bool()
            .ok_or_else(|| Error::invalid("This URL is not a Forkcast backend."))?;
        match status["protocol"].as_u64() {
            Some(version) if version == u64::from(PROTOCOL_VERSION) => Ok(setup_required),
            other => Err(Error::new(
                ErrorKind::ProtocolMismatch,
                format!(
                    "This server speaks synchronization protocol {} but this app needs {PROTOCOL_VERSION}. Update the server or the app. Your changes stay on this device.",
                    other.map_or_else(|| "none".to_owned(), |v| v.to_string())
                ),
            )),
        }
    }
}
