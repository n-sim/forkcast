mod accounts;
mod auth;
mod planning;
mod recipes;
mod store;

use auth::{Account, Authenticated, Credentials, Role, SignedIn};
use axum::{
    Json, Router,
    extract::{DefaultBodyLimit, State},
    http::{HeaderValue, Method, StatusCode, header},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use rusqlite::{OptionalExtension, TransactionBehavior, params};
use serde::{Deserialize, Serialize};
use store::Store;
use tower_http::{cors::CorsLayer, set_header::SetResponseHeaderLayer};
use uuid::Uuid;

#[derive(Debug)]
pub struct ApiError(StatusCode, &'static str);

impl ApiError {
    fn internal() -> Self {
        Self(
            StatusCode::INTERNAL_SERVER_ERROR,
            "The backend could not complete this request.",
        )
    }
    fn unauthorized() -> Self {
        Self(StatusCode::UNAUTHORIZED, "Sign in to your backend account.")
    }
}

impl From<rusqlite::Error> for ApiError {
    fn from(error: rusqlite::Error) -> Self {
        eprintln!("Database operation failed: {error}");
        Self::internal()
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        #[derive(Serialize)]
        struct Error {
            message: &'static str,
        }
        (self.0, Json(Error { message: self.1 })).into_response()
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Status {
    setup_required: bool,
}

async fn status(State(store): State<Store>) -> Result<Json<Status>, ApiError> {
    store
        .run(|db| {
            Ok(Json(Status {
                setup_required: !db.query_row(
                    "SELECT EXISTS(SELECT 1 FROM households)",
                    [],
                    |row| row.get::<_, bool>(0),
                )?,
            }))
        })
        .await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Setup {
    household_name: String,
    username: String,
    password: String,
}

async fn setup(
    State(store): State<Store>,
    Json(input): Json<Setup>,
) -> Result<(StatusCode, Json<SignedIn>), ApiError> {
    store.run(move |db| {
        let username = auth::username(&input.username)?;
        let household_name = input.household_name.trim();
        if household_name.is_empty() || household_name.chars().count() > 80 {
            return Err(ApiError(StatusCode::UNPROCESSABLE_ENTITY, "Use a household name of 1–80 characters."));
        }
        let hash = auth::hash_password(&input.password)?;
        let transaction = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
        if transaction.query_row("SELECT EXISTS(SELECT 1 FROM households)", [], |row| row.get::<_, bool>(0))? {
            return Err(ApiError(StatusCode::CONFLICT, "This instance is already set up. Sign in instead."));
        }
        let household_id = Uuid::new_v4().to_string();
        transaction.execute("INSERT INTO households (singleton, id, name) VALUES (1, ?, ?)", params![household_id, household_name])?;
        let account = Account { id: Uuid::new_v4().to_string(), household_id, username, role: Role::Administrator, active: true };
        transaction.execute("INSERT INTO accounts (id, household_id, username, password_hash, role) VALUES (?, ?, ?, ?, ?)", params![account.id, account.household_id, account.username, hash, account.role])?;
        let signed_in = auth::sign_in(&transaction, account)?;
        transaction.commit()?;
        Ok((StatusCode::CREATED, Json(signed_in)))
    }).await
}

async fn login(
    State(store): State<Store>,
    Json(input): Json<Credentials>,
) -> Result<Json<SignedIn>, ApiError> {
    store.run(move |db| {
        let username = auth::username(&input.username)?;
        // Serialize credential checks with resets and account disabling so an
        // in-flight login cannot revive a session using a previous password.
        let transaction = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
        transaction.execute("DELETE FROM login_failures WHERE last_attempt <= ?", [auth::now() - 60])?;
        let failures: i64 = transaction.query_row("SELECT failures FROM login_failures WHERE username = ?", [&username], |row| row.get(0)).optional()?.unwrap_or(0);
        if failures >= 5 {
            return Err(ApiError(StatusCode::TOO_MANY_REQUESTS, "Too many failed sign-in attempts. Try again in a minute."));
        }
        let found = transaction.query_row("SELECT id, household_id, username, role, active, password_hash FROM accounts WHERE username = ?", [&username], |row| Ok((Account::from_row(row)?, row.get::<_, String>(5)?))).optional()?;
        let valid = match &found {
            Some((account, hash)) => auth::verify_password(&input.password, hash) && account.active,
            None => { let _ = auth::hash_password("a dummy credential for unknown accounts")?; false }
        };
        if !valid {
            transaction.execute("INSERT INTO login_failures (username, failures, last_attempt) VALUES (?, ?, ?) ON CONFLICT(username) DO UPDATE SET failures = excluded.failures, last_attempt = excluded.last_attempt", params![username, failures + 1, auth::now()])?;
            transaction.commit()?;
            return Err(ApiError(StatusCode::UNAUTHORIZED, "Username or password is incorrect."));
        }
        let (account, _) = found.ok_or_else(ApiError::unauthorized)?;
        transaction.execute("DELETE FROM login_failures WHERE username = ?", [username])?;
        let signed_in = auth::sign_in(&transaction, account)?;
        transaction.commit()?;
        Ok(Json(signed_in))
    }).await
}

async fn current_session(
    State(store): State<Store>,
    auth: Authenticated,
) -> Result<Json<auth::Session>, ApiError> {
    store
        .run(move |db| Ok(Json(auth::session(db, auth.account)?)))
        .await
}

async fn logout(State(store): State<Store>, auth: Authenticated) -> Result<StatusCode, ApiError> {
    store
        .run(move |db| {
            db.execute(
                "DELETE FROM sessions WHERE token_hash = ?",
                [auth.token_hash],
            )?;
            Ok(StatusCode::NO_CONTENT)
        })
        .await
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let bind = std::env::var("FORKCAST_BIND").unwrap_or_else(|_| "127.0.0.1:8787".into());
    let path = std::env::var("FORKCAST_DATABASE").unwrap_or_else(|_| "forkcast.sqlite3".into());
    let store = Store::open(path.into())
        .map_err(|error| format!("Cannot open backend database: {error:?}"))?;
    let origins = std::env::var("FORKCAST_ALLOWED_ORIGINS")
        .unwrap_or_else(|_| "http://127.0.0.1:5173,http://127.0.0.1:4173".into())
        .split(',')
        .map(|origin| origin.trim().parse::<HeaderValue>())
        .collect::<Result<Vec<_>, _>>()?;
    let app = Router::new()
        .route("/api/status", get(status))
        .route("/api/setup", post(setup))
        .route("/api/login", post(login))
        .route("/api/session", get(current_session).delete(logout))
        .route("/api/accounts", get(accounts::list).post(accounts::create))
        .route(
            "/api/accounts/{id}",
            get(accounts::personal).patch(accounts::change),
        )
        .route("/api/households/{id}", get(accounts::household))
        .nest("/api", recipes::routes())
        .nest("/api", planning::routes())
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
        .with_state(store);
    let listener = tokio::net::TcpListener::bind(bind).await?;
    println!(
        "Forkcast backend listening on http://{}",
        listener.local_addr()?
    );
    axum::serve(listener, app)
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await?;
    Ok(())
}
