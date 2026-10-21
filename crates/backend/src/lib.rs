//! The household server's HTTP adapter. It translates requests into calls on
//! the shared [`forkcast_core::Core`] and core results back into responses;
//! all rules, validation, and storage live in the core.

pub mod tls;

use axum::{
    Json, Router,
    extract::{DefaultBodyLimit, FromRequestParts, Path, Request, State},
    http::{HeaderValue, Method, StatusCode, header, request::Parts},
    middleware::{self, Next},
    response::{
        IntoResponse, Response,
        sse::{Event, Sse},
    },
    routing::{get, post},
};
use forkcast_core::{
    AccountChange, Authenticated, Core, CredentialTransfer, Credentials, CurrentChoice, Error,
    ErrorKind, Operation, PROTOCOL_VERSION, PlanningChoice, PlanningMutation, PreferenceChange,
    Principal, RatingChange, Revision, SetupServer,
};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{convert::Infallible, path::PathBuf, time::Duration};
use tokio_stream::wrappers::ReceiverStream;
use tower_http::{
    cors::CorsLayer,
    services::{ServeDir, ServeFile},
    set_header::SetResponseHeaderLayer,
};

pub struct ApiError(Error);

impl From<Error> for ApiError {
    fn from(error: Error) -> Self {
        Self(error)
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let status = match self.0.kind {
            ErrorKind::Unauthenticated => StatusCode::UNAUTHORIZED,
            ErrorKind::Forbidden => StatusCode::FORBIDDEN,
            ErrorKind::NotFound => StatusCode::NOT_FOUND,
            ErrorKind::Conflict => StatusCode::CONFLICT,
            ErrorKind::Invalid => StatusCode::UNPROCESSABLE_ENTITY,
            ErrorKind::RateLimited => StatusCode::TOO_MANY_REQUESTS,
            ErrorKind::ProtocolMismatch => StatusCode::UPGRADE_REQUIRED,
            ErrorKind::ConnectionRequired => StatusCode::PRECONDITION_FAILED,
            ErrorKind::Unavailable => StatusCode::SERVICE_UNAVAILABLE,
            ErrorKind::Unsupported | ErrorKind::Internal => StatusCode::INTERNAL_SERVER_ERROR,
        };
        let mut body = json!({"message": self.0.message});
        if let Some(fields) = self.0.fields {
            body["fields"] = fields;
        }
        (status, Json(body)).into_response()
    }
}

type ApiResult<T> = Result<T, ApiError>;

/// SQLite and password hashing run off the async HTTP executor.
async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, Error> + Send + 'static,
) -> ApiResult<T> {
    tokio::task::spawn_blocking(work)
        .await
        .map_err(|error| {
            eprintln!("Backend worker failed: {error}");
            ApiError(Error::internal())
        })?
        .map_err(ApiError)
}

/// The verified bearer session of a request.
struct Auth(Authenticated);

impl Auth {
    fn principal(&self) -> Principal {
        self.0.principal.clone()
    }
}

impl FromRequestParts<Core> for Auth {
    type Rejection = ApiError;

    async fn from_request_parts(parts: &mut Parts, core: &Core) -> Result<Self, ApiError> {
        let token = parts
            .headers
            .get("authorization")
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.strip_prefix("Bearer "))
            .ok_or_else(|| ApiError(Error::unauthenticated()))?
            .to_owned();
        let core = core.clone();
        blocking(move || core.authenticate(&token)).await.map(Auth)
    }
}

async fn status(State(core): State<Core>) -> ApiResult<Json<forkcast_core::ServerStatus>> {
    Ok(Json(blocking(move || core.server_status()).await?))
}

async fn setup(
    State(core): State<Core>,
    Json(input): Json<SetupServer>,
) -> ApiResult<(StatusCode, Json<forkcast_core::SignedIn>)> {
    Ok((
        StatusCode::CREATED,
        Json(blocking(move || core.setup_server(input)).await?),
    ))
}

async fn login(
    State(core): State<Core>,
    Json(input): Json<Credentials>,
) -> ApiResult<Json<forkcast_core::SignedIn>> {
    Ok(Json(blocking(move || core.sign_in(input)).await?))
}

async fn current_session(
    State(core): State<Core>,
    auth: Auth,
) -> ApiResult<Json<forkcast_core::Session>> {
    Ok(Json(
        blocking(move || core.session(&auth.principal())).await?,
    ))
}

async fn logout(State(core): State<Core>, auth: Auth) -> ApiResult<StatusCode> {
    blocking(move || core.sign_out(&auth.0)).await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn personal_account(
    State(core): State<Core>,
    Path(id): Path<String>,
    auth: Auth,
) -> ApiResult<Json<forkcast_core::Account>> {
    blocking(move || {
        let principal = auth.principal();
        principal.require_person(&id)?;
        Ok(Json(core.session(&principal)?.account))
    })
    .await
}

async fn household(
    State(core): State<Core>,
    Path(id): Path<String>,
    auth: Auth,
) -> ApiResult<Json<forkcast_core::Household>> {
    blocking(move || {
        let principal = auth.principal();
        principal.require_household(&id)?;
        Ok(Json(core.session(&principal)?.household))
    })
    .await
}

async fn list_accounts(
    State(core): State<Core>,
    auth: Auth,
) -> ApiResult<Json<Vec<forkcast_core::Account>>> {
    Ok(Json(
        blocking(move || core.accounts(&auth.principal())).await?,
    ))
}

async fn create_account(
    State(core): State<Core>,
    auth: Auth,
    Json(input): Json<Credentials>,
) -> ApiResult<(StatusCode, Json<forkcast_core::Account>)> {
    Ok((
        StatusCode::CREATED,
        Json(blocking(move || core.create_account(&auth.principal(), input)).await?),
    ))
}

async fn change_account(
    State(core): State<Core>,
    Path(id): Path<String>,
    auth: Auth,
    Json(input): Json<AccountChange>,
) -> ApiResult<Json<forkcast_core::Account>> {
    Ok(Json(
        blocking(move || core.change_account(&auth.principal(), &id, input)).await?,
    ))
}

async fn recipe_collection(
    State(core): State<Core>,
    auth: Auth,
    Path(id): Path<String>,
) -> ApiResult<Json<forkcast_core::Collection>> {
    blocking(move || {
        let principal = auth.principal();
        principal.require_household(&id)?;
        Ok(Json(core.recipe_collection(&principal)?))
    })
    .await
}

async fn choose_current(
    State(core): State<Core>,
    auth: Auth,
    Path((household, recipe_id)): Path<(String, String)>,
    Json(choice): Json<CurrentChoice>,
) -> ApiResult<StatusCode> {
    blocking(move || {
        let principal = auth.principal();
        principal.require_household(&household)?;
        core.choose_current_recipe(&principal, &recipe_id, choice)
    })
    .await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn save_revision(
    State(core): State<Core>,
    auth: Auth,
    Path(household): Path<String>,
    Json(revision): Json<Revision>,
) -> ApiResult<StatusCode> {
    blocking(move || {
        let principal = auth.principal();
        principal.require_household(&household)?;
        core.ingest_recipe_revision(&principal, revision)
    })
    .await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn ratings(
    State(core): State<Core>,
    auth: Auth,
    Path(id): Path<String>,
) -> ApiResult<Json<Vec<forkcast_core::Rating>>> {
    blocking(move || {
        let principal = auth.principal();
        principal.require_person(&id)?;
        Ok(Json(core.ratings(&principal)?))
    })
    .await
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RatingChanges {
    changes: Vec<RatingChange>,
}

async fn save_ratings(
    State(core): State<Core>,
    auth: Auth,
    Path(id): Path<String>,
    Json(input): Json<RatingChanges>,
) -> ApiResult<StatusCode> {
    blocking(move || {
        let principal = auth.principal();
        principal.require_person(&id)?;
        core.apply_rating_changes(&principal, input.changes)
    })
    .await?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PreferenceChanges {
    changes: Vec<PreferenceChange>,
}

async fn ai_preferences(
    State(core): State<Core>,
    auth: Auth,
    Path(id): Path<String>,
) -> ApiResult<Json<Value>> {
    blocking(move || {
        let principal = auth.principal();
        principal.require_person(&id)?;
        Ok(Json(core.stored_ai_preferences(&principal)?))
    })
    .await
}

async fn save_ai_preferences(
    State(core): State<Core>,
    auth: Auth,
    Path(id): Path<String>,
    Json(input): Json<PreferenceChanges>,
) -> ApiResult<StatusCode> {
    blocking(move || {
        let principal = auth.principal();
        principal.require_person(&id)?;
        core.apply_preference_changes(&principal, input.changes)
    })
    .await?;
    Ok(StatusCode::NO_CONTENT)
}

/// The server's own provider identity, which a session must be issued to
/// before the server will accept it.
async fn ai_host(State(core): State<Core>, auth: Auth) -> ApiResult<Json<Value>> {
    let host = blocking(move || core.ai_host(&auth.principal())).await?;
    Ok(Json(json!({ "hostId": host })))
}

/// Imports a session for the authenticated account. The reply is only an
/// acknowledgement; no credential is ever returned.
async fn ai_import(
    State(core): State<Core>,
    auth: Auth,
    Path(transfer): Path<String>,
    Json(input): Json<Value>,
) -> ApiResult<Json<forkcast_core::TransferAck>> {
    // Parsed by hand so a malformed body never echoes credential fragments.
    let input: CredentialTransfer = serde_json::from_value(input).map_err(|_| {
        ApiError(Error::invalid(
            "The ChatGPT transfer was not in the expected format.",
        ))
    })?;
    Ok(Json(
        blocking(move || core.ai_import_transfer(&auth.principal(), &transfer, input)).await?,
    ))
}

async fn ai_cancel_import(
    State(core): State<Core>,
    auth: Auth,
    Path(transfer): Path<String>,
) -> ApiResult<Json<forkcast_core::TransferAck>> {
    Ok(Json(
        blocking(move || core.ai_cancel_import(&auth.principal(), &transfer)).await?,
    ))
}

async fn planning(
    State(core): State<Core>,
    auth: Auth,
    Path(id): Path<String>,
) -> ApiResult<Json<Value>> {
    blocking(move || {
        let principal = auth.principal();
        principal.require_household(&id)?;
        Ok(Json(core.planning_snapshot(&principal)?))
    })
    .await
}

async fn save_planning(
    State(core): State<Core>,
    auth: Auth,
    Path(household): Path<String>,
    Json(input): Json<PlanningMutation>,
) -> ApiResult<Json<Value>> {
    blocking(move || {
        let principal = auth.principal();
        principal.require_household(&household)?;
        Ok(Json(core.submit_planning(&principal, input)?))
    })
    .await
}

async fn resolve_planning(
    State(core): State<Core>,
    auth: Auth,
    Path(household): Path<String>,
    Json(input): Json<PlanningChoice>,
) -> ApiResult<Json<Value>> {
    blocking(move || {
        let principal = auth.principal();
        principal.require_household(&household)?;
        Ok(Json(core.resolve_planning_conflict(&principal, input)?))
    })
    .await
}

/// The same operation contract a native bridge exposes, for browser clients
/// of a household server.
async fn operation(
    State(core): State<Core>,
    auth: Auth,
    Json(operation): Json<Operation>,
) -> ApiResult<Json<Value>> {
    Ok(Json(
        blocking(move || core.execute(&auth.principal(), operation)).await?,
    ))
}

/// Server-sent events: one `change` event per committed change visible to
/// the signed-in person, with a comment every 15 seconds to keep the
/// connection open.
async fn changes(
    State(core): State<Core>,
    auth: Auth,
) -> Sse<ReceiverStream<Result<Event, Infallible>>> {
    let (sender, receiver) = tokio::sync::mpsc::channel(32);
    let subscription = core.subscribe(&auth.principal());
    tokio::task::spawn_blocking(move || {
        loop {
            let event = match subscription.next_timeout(Duration::from_secs(15)) {
                Some(change) => Event::default().event("change").json_data(&change),
                None => Ok(Event::default().comment("keep-alive")),
            };
            let Ok(event) = event else { continue };
            if sender.blocking_send(Ok(event)).is_err() {
                break;
            }
        }
    });
    Sse::new(ReceiverStream::new(receiver))
}

/// Refuses clients that declare a different synchronization protocol, before
/// they can send anything the server would misread. Browser clients served
/// by this server and tools that declare nothing are always compatible.
async fn require_protocol(request: Request, next: Next) -> Response {
    let declared = request
        .headers()
        .get(PROTOCOL_HEADER)
        .and_then(|value| value.to_str().ok())
        .map(str::to_owned);
    let mut response = match declared {
        Some(version) if version != PROTOCOL_VERSION.to_string() => ApiError(Error::new(
            ErrorKind::ProtocolMismatch,
            format!(
                "This server speaks synchronization protocol {PROTOCOL_VERSION}, but the app sent {version}. Update the app or the server. Your changes stay on this device."
            ),
        ))
        .into_response(),
        _ => next.run(request).await,
    };
    response.headers_mut().insert(
        PROTOCOL_HEADER,
        HeaderValue::from_str(&PROTOCOL_VERSION.to_string()).expect("numeric header"),
    );
    response
}

const PROTOCOL_HEADER: &str = "x-forkcast-protocol";

/// The complete HTTP surface. `origins` are the frontend origins allowed to
/// call it from a browser; `frontend`, when set, is a built frontend served
/// by this same server.
pub fn router(core: Core, origins: Vec<HeaderValue>, frontend: Option<PathBuf>) -> Router {
    const MEBIBYTE: usize = 1024 * 1024;
    let mut app = Router::new()
        .route("/api/status", get(status))
        .route("/api/setup", post(setup))
        .route("/api/login", post(login))
        .route("/api/session", get(current_session).delete(logout))
        .route("/api/accounts", get(list_accounts).post(create_account))
        .route(
            "/api/accounts/{id}",
            get(personal_account).patch(change_account),
        )
        .route("/api/households/{id}", get(household))
        .route("/api/households/{id}/recipes", get(recipe_collection))
        .route(
            "/api/households/{id}/recipes/{recipe_id}/current",
            post(choose_current),
        )
        .route(
            "/api/households/{id}/recipe-revisions",
            post(save_revision).layer(DefaultBodyLimit::max(15 * MEBIBYTE)),
        )
        .route(
            "/api/accounts/{id}/recipe-ratings",
            get(ratings).post(save_ratings),
        )
        .route(
            "/api/accounts/{id}/ai-preferences",
            get(ai_preferences).post(save_ai_preferences),
        )
        .route("/api/ai/host", get(ai_host))
        .route(
            "/api/ai/transfers/{transfer}",
            post(ai_import)
                .delete(ai_cancel_import)
                .layer(DefaultBodyLimit::max(64 * 1024)),
        )
        .route(
            "/api/households/{id}/planning/resolve",
            post(resolve_planning).layer(DefaultBodyLimit::max(16 * MEBIBYTE)),
        )
        .route(
            "/api/households/{id}/planning",
            get(planning)
                .post(save_planning)
                .layer(DefaultBodyLimit::max(4 * MEBIBYTE)),
        )
        .route(
            "/api/operations",
            post(operation).layer(DefaultBodyLimit::max(16 * MEBIBYTE)),
        )
        .route("/api/changes", get(changes));
    if let Some(directory) = frontend {
        app = app.fallback_service(
            ServeDir::new(&directory)
                .not_found_service(ServeFile::new(directory.join("index.html"))),
        );
    }
    app.layer(middleware::from_fn(require_protocol))
        .layer(DefaultBodyLimit::max(16 * 1024))
        .layer(SetResponseHeaderLayer::overriding(
            header::CACHE_CONTROL,
            HeaderValue::from_static("no-store"),
        ))
        .layer(
            CorsLayer::new()
                .allow_origin(origins)
                .allow_methods([Method::GET, Method::POST, Method::PATCH, Method::DELETE])
                .allow_headers([header::AUTHORIZATION, header::CONTENT_TYPE]),
        )
        .with_state(core)
}
