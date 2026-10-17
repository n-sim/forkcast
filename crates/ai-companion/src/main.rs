mod execution;
mod oauth;
mod vault;

use axum::{
    Json, Router,
    extract::{Query, Request, State},
    http::{HeaderValue, Method, StatusCode, header},
    middleware::{self, Next},
    response::{Html, IntoResponse, Response},
    routing::{get, post},
};
use serde::{Deserialize, Serialize};
use std::{
    net::{Ipv4Addr, SocketAddr},
    path::PathBuf,
    sync::Arc,
    time::Duration,
};
use tokio::sync::Mutex;
use tower_http::{cors::CorsLayer, set_header::SetResponseHeaderLayer};
use uuid::Uuid;
use vault::{Record, Vault};

struct Runtime {
    vault: Vault,
    record: Record,
    pending: Option<oauth::Attempt>,
    message: Option<&'static str>,
}

#[derive(Clone)]
struct App {
    runtime: Arc<Mutex<Runtime>>,
    http: reqwest::Client,
    issuer: String,
    redirect: String,
    host: String,
    origins: Vec<HeaderValue>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ConnectionStatus {
    state: &'static str,
    email: Option<String>,
    message: Option<&'static str>,
}

impl Runtime {
    fn status(&mut self) -> ConnectionStatus {
        if self
            .pending
            .as_ref()
            .is_some_and(|attempt| attempt.expired())
        {
            self.pending = None;
            self.message = Some("ChatGPT sign-in timed out. Try connecting again.");
        }
        let state = if self.pending.is_some() {
            "authorizing"
        } else if self
            .record
            .tokens
            .as_ref()
            .is_some_and(|tokens| tokens.expires_at > oauth::now())
        {
            "connected"
        } else if self.record.client_id.is_some() || self.message.is_some() {
            "reconnect_required"
        } else {
            "unconfigured"
        };
        ConnectionStatus {
            state,
            email: self.record.email.clone(),
            message: self.message,
        }
    }
}

async fn guard(State(app): State<App>, request: Request, next: Next) -> Response {
    if request
        .headers()
        .get(header::HOST)
        .and_then(|host| host.to_str().ok())
        != Some(&app.host)
    {
        return StatusCode::FORBIDDEN.into_response();
    }
    if request.uri().path().starts_with("/api/") {
        let allowed = request
            .headers()
            .get(header::ORIGIN)
            .is_some_and(|origin| app.origins.contains(origin));
        if !allowed
            || (request.method() != Method::OPTIONS
                && request
                    .headers()
                    .get("x-forkcast-companion")
                    .and_then(|value| value.to_str().ok())
                    != Some("1"))
        {
            return StatusCode::FORBIDDEN.into_response();
        }
    }
    next.run(request).await
}

async fn status(State(app): State<App>) -> Json<ConnectionStatus> {
    Json(app.runtime.lock().await.status())
}

async fn authorize(State(app): State<App>) -> Json<serde_json::Value> {
    let mut runtime = app.runtime.lock().await;
    let (attempt, url) = oauth::Attempt::start(&app.issuer, &app.redirect, &runtime.record);
    runtime.pending = Some(attempt);
    runtime.message = None;
    Json(serde_json::json!({ "authorizationUrl": url }))
}

async fn sign_out(State(app): State<App>) -> Result<Json<ConnectionStatus>, StatusCode> {
    let mut runtime = app.runtime.lock().await;
    runtime.pending = None;
    let tokens = runtime.record.tokens.take();
    if runtime.vault.save(&runtime.record).is_err() {
        runtime.record.tokens = tokens;
        return Err(StatusCode::INTERNAL_SERVER_ERROR);
    }
    runtime.message = Some("Signed out of ChatGPT. Connect again when you want to use AI.");
    if let (Some(tokens), Some(client_id)) = (tokens, &runtime.record.client_id) {
        let mut revoked = false;
        for retry in 0..2 {
            if retry > 0 {
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
            let result = app
                .http
                .post(format!("{}/api/accounts/oauth/revoke", app.issuer))
                .timeout(Duration::from_secs(2))
                .form(&[
                    ("token", tokens.refresh_token.as_str()),
                    ("token_type_hint", "refresh_token"),
                    ("client_id", client_id.as_str()),
                ])
                .send()
                .await;
            match result {
                Ok(response) if response.status() == reqwest::StatusCode::OK => {
                    revoked = true;
                    break;
                }
                Ok(response) if !response.status().is_server_error() => break,
                _ => (),
            }
        }
        if !revoked {
            runtime.message = Some(
                "Signed out locally. Remote revocation was not confirmed. Disconnect Forkcast in ChatGPT Settings to end its remote access.",
            );
        }
    }
    Ok(Json(runtime.status()))
}

#[derive(Deserialize)]
struct Callback {
    state: Option<String>,
    code: Option<String>,
    client_id: Option<String>,
    error: Option<String>,
}

async fn complete(app: &App, callback: Callback) -> Result<(), &'static str> {
    let mut runtime = app.runtime.lock().await;
    let invalid = "ChatGPT callback could not be verified. Try connecting again.";
    // Ignore unrelated callbacks without consuming a valid pending attempt.
    let pending = runtime.pending.as_ref().ok_or(invalid)?;
    if callback.state.as_deref() != Some(&pending.state) {
        return Err(invalid);
    }
    let attempt = runtime.pending.take().ok_or(invalid)?;
    let result = async {
        if attempt.expired() { return Err("ChatGPT sign-in timed out. Try connecting again."); }
        if callback.error.is_some() { return Err("ChatGPT sign-in was cancelled or denied. Try connecting again."); }
        let client_id = attempt.issued_client(callback.client_id.as_deref())?;
        // Retain an issued registration even if code exchange fails. It must
        // not be replaced with dynamic_agent_client on the next attempt.
        runtime.record.client_id = Some(client_id.clone());
        runtime.vault.save(&runtime.record).map_err(|_| "The companion could not protect credentials. Check its storage permissions and reconnect.")?;
        let connection = oauth::exchange(&app.http, &app.issuer, &app.redirect, &attempt, &client_id, callback.code.as_deref().filter(|code| !code.is_empty()).ok_or(invalid)?).await?;
        let previous = runtime.record.tokens.take();
        let previous_subject = runtime.record.subject.clone();
        let previous_email = runtime.record.email.clone();
        runtime.record.subject = Some(connection.subject);
        runtime.record.email = connection.email;
        runtime.record.tokens = Some(connection.tokens);
        if runtime.vault.save(&runtime.record).is_err() {
            runtime.record.tokens = previous;
            runtime.record.subject = previous_subject;
            runtime.record.email = previous_email;
            return Err("The companion could not protect credentials. Check its storage permissions and reconnect.");
        }
        Ok(())
    }.await;
    runtime.message = result.as_ref().err().copied();
    result
}

async fn callback(State(app): State<App>, Query(callback): Query<Callback>) -> Response {
    match complete(&app, callback).await {
        Ok(()) => Html("<!doctype html><title>ChatGPT connected</title><h1>ChatGPT connected</h1><p>Return to Forkcast settings. You can close this window.</p>").into_response(),
        Err(_) => (StatusCode::BAD_REQUEST, Html("<!doctype html><title>ChatGPT sign-in incomplete</title><h1>ChatGPT sign-in incomplete</h1><p>Return to Forkcast settings and try connecting again.</p>")).into_response(),
    }
}

fn directory() -> Result<PathBuf, &'static str> {
    if let Some(path) = std::env::var_os("FORKCAST_AI_DIRECTORY") {
        return Ok(path.into());
    }
    let base = std::env::var_os(if cfg!(windows) {
        "LOCALAPPDATA"
    } else {
        "HOME"
    })
    .ok_or("Set FORKCAST_AI_DIRECTORY for native credential storage.")?;
    Ok(PathBuf::from(base).join(if cfg!(windows) {
        "Forkcast/ai"
    } else {
        ".config/forkcast/ai"
    }))
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let bind: SocketAddr = std::env::var("FORKCAST_AI_BIND")
        .unwrap_or_else(|_| "127.0.0.1:8788".into())
        .parse()?;
    if bind.ip() != Ipv4Addr::LOCALHOST {
        return Err("The AI companion must bind to 127.0.0.1.".into());
    }
    let issuer = if cfg!(debug_assertions) {
        std::env::var("FORKCAST_AI_TEST_ISSUER")
            .unwrap_or_else(|_| "https://auth.openai.com".into())
    } else {
        "https://auth.openai.com".into()
    };
    if issuer != "https://auth.openai.com" {
        let url = url::Url::parse(&issuer)?;
        if url.scheme() != "http"
            || url.host_str() != Some("127.0.0.1")
            || url.path() != "/"
            || url.query().is_some()
            || url.fragment().is_some()
            || !url.username().is_empty()
            || url.password().is_some()
            || std::env::var_os("FORKCAST_AI_DIRECTORY").is_none()
        {
            return Err("A debug authorization fixture requires a loopback issuer and isolated credential directory.".into());
        }
    }
    let (vault, mut record) = Vault::open(directory()?).map_err(|_| "Cannot open protected AI runtime storage. Check its permissions and that no other companion is using it.")?;
    if record.issuer.as_ref().is_some_and(|saved| saved != &issuer) {
        return Err("Credential storage belongs to a different authorization issuer.".into());
    }
    record.issuer = Some(issuer.clone());
    // The initial companion saved an unsupported custom host-ID scheme.
    // Repair only those legacy IDs, retaining the account and its credentials.
    if record.host_id.is_empty() || record.host_id.starts_with("forkcast:") {
        record.host_id = Uuid::new_v4().urn().to_string();
    }
    vault
        .save(&record)
        .map_err(|_| "Cannot protect AI runtime storage.")?;
    let origins = std::env::var("FORKCAST_AI_ALLOWED_ORIGINS")
        .unwrap_or_else(|_| "http://127.0.0.1:5173,http://127.0.0.1:4173".into())
        .split(',')
        .map(|origin| {
            let url = url::Url::parse(origin.trim())?;
            if url.origin().ascii_serialization() != origin.trim()
                || (url.scheme() != "https"
                    && !(url.scheme() == "http"
                        && matches!(url.host_str(), Some("127.0.0.1" | "localhost" | "[::1]"))))
            {
                return Err("Use exact HTTPS frontend origins, or HTTP loopback origins.".into());
            }
            Ok(origin.trim().parse::<HeaderValue>()?)
        })
        .collect::<Result<Vec<_>, Box<dyn std::error::Error>>>()?;
    // The listener is ready before an authorization URL can be requested.
    let listener = tokio::net::TcpListener::bind(bind).await?;
    let address = listener.local_addr()?;
    let app = App {
        runtime: Arc::new(Mutex::new(Runtime {
            vault,
            record,
            pending: None,
            message: None,
        })),
        http: reqwest::Client::builder()
            .timeout(Duration::from_secs(15))
            .redirect(reqwest::redirect::Policy::none())
            .build()?,
        issuer,
        redirect: format!("http://{address}/auth/callback"),
        host: address.to_string(),
        origins: origins.clone(),
    };
    let routes = Router::new()
        .route("/api/status", get(status))
        .route("/api/authorization", post(authorize))
        .route("/api/connection", axum::routing::delete(sign_out))
        .route("/api/models", get(execution::models))
        .route("/api/execute", post(execution::execute))
        .route("/auth/callback", get(callback))
        .layer(
            CorsLayer::new()
                .allow_origin(origins)
                .allow_methods([Method::GET, Method::POST, Method::DELETE])
                .allow_headers([
                    header::HeaderName::from_static("x-forkcast-companion"),
                    header::CONTENT_TYPE,
                ]),
        )
        .layer(middleware::from_fn_with_state(app.clone(), guard))
        .layer(SetResponseHeaderLayer::overriding(
            header::CACHE_CONTROL,
            HeaderValue::from_static("no-store"),
        ))
        .layer(SetResponseHeaderLayer::overriding(
            header::REFERRER_POLICY,
            HeaderValue::from_static("no-referrer"),
        ))
        .layer(SetResponseHeaderLayer::overriding(
            header::CONTENT_SECURITY_POLICY,
            HeaderValue::from_static("default-src 'none'; frame-ancestors 'none'"),
        ))
        .with_state(app);
    println!("Forkcast AI companion listening on http://{address}");
    axum::serve(listener, routes)
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await?;
    Ok(())
}
