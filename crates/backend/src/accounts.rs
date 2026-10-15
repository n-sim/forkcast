use crate::{
    ApiError,
    auth::{self, Account, Authenticated, Credentials, Household, Role, Scope},
    store::Store,
};
use axum::{
    Json,
    extract::{Path, State},
    http::StatusCode,
};
use rusqlite::{OptionalExtension, TransactionBehavior, params};
use serde::Deserialize;
use uuid::Uuid;

pub async fn personal(
    Path(id): Path<String>,
    auth: Authenticated,
) -> Result<Json<Account>, ApiError> {
    auth.require(Scope::Personal(&id))?;
    Ok(Json(auth.account))
}

pub async fn household(
    State(store): State<Store>,
    Path(id): Path<String>,
    auth: Authenticated,
) -> Result<Json<Household>, ApiError> {
    auth.require(Scope::Household(&id))?;
    store
        .run(move |db| Ok(Json(auth::session(db, auth.account)?.household)))
        .await
}

pub async fn list(
    State(store): State<Store>,
    auth: Authenticated,
) -> Result<Json<Vec<Account>>, ApiError> {
    auth.require_administrator()?;
    store.run(move |db| {
        let mut query = db.prepare("SELECT id, household_id, username, role, active FROM accounts WHERE household_id = ? ORDER BY username")?;
        let accounts = query.query_map([auth.account.household_id], Account::from_row)?.collect::<Result<Vec<_>, _>>()?;
        Ok(Json(accounts))
    }).await
}

pub async fn create(
    State(store): State<Store>,
    auth: Authenticated,
    Json(input): Json<Credentials>,
) -> Result<(StatusCode, Json<Account>), ApiError> {
    auth.require_administrator()?;
    store.run(move |db| {
        let username = auth::username(&input.username)?;
        let password_hash = auth::hash_password(&input.password)?;
        let account = Account { id: Uuid::new_v4().to_string(), household_id: auth.account.household_id, username, role: Role::Member, active: true };
        db.execute("INSERT INTO accounts (id, household_id, username, password_hash, role) VALUES (?, ?, ?, ?, ?)", params![account.id, account.household_id, account.username, password_hash, account.role]).map_err(|error| {
            if error.sqlite_error_code() == Some(rusqlite::ErrorCode::ConstraintViolation) { ApiError(StatusCode::CONFLICT, "That username is already in use.") } else { error.into() }
        })?;
        Ok((StatusCode::CREATED, Json(account)))
    }).await
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AccountChange {
    active: Option<bool>,
    password: Option<String>,
}

pub async fn change(
    State(store): State<Store>,
    Path(id): Path<String>,
    auth: Authenticated,
    Json(input): Json<AccountChange>,
) -> Result<Json<Account>, ApiError> {
    auth.require_administrator()?;
    if input.active.is_none() && input.password.is_none() {
        return Err(ApiError(
            StatusCode::UNPROCESSABLE_ENTITY,
            "Choose an account status or a replacement password.",
        ));
    }
    store.run(move |db| {
        let hash = input.password.as_deref().map(auth::hash_password).transpose()?;
        let transaction = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let mut account = transaction.query_row("SELECT id, household_id, username, role, active FROM accounts WHERE id = ? AND household_id = ?", params![id, auth.account.household_id], Account::from_row).optional()?.ok_or(ApiError(StatusCode::NOT_FOUND, "Household account not found."))?;
        if account.role == Role::Administrator { return Err(ApiError(StatusCode::FORBIDDEN, "The instance administrator cannot be disabled or reset here.")); }
        if let Some(active) = input.active {
            transaction.execute("UPDATE accounts SET active = ? WHERE id = ?", params![active, id])?;
            account.active = active;
        }
        if let Some(hash) = hash {
            transaction.execute("UPDATE accounts SET password_hash = ? WHERE id = ?", params![hash, id])?;
        }
        if input.password.is_some() || input.active == Some(false) {
            transaction.execute("DELETE FROM sessions WHERE account_id = ?", [&id])?;
        }
        if input.password.is_some() || input.active == Some(true) {
            transaction.execute("DELETE FROM login_failures WHERE username = ?", [&account.username])?;
        }
        transaction.commit()?;
        Ok(Json(account))
    }).await
}
