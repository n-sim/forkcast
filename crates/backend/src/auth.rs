use crate::{ApiError, store::Store};
use argon2::{Argon2, PasswordHash, PasswordHasher, PasswordVerifier, password_hash::SaltString};
use axum::{
    extract::FromRequestParts,
    http::{StatusCode, request::Parts},
};
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::time::{SystemTime, UNIX_EPOCH};
use uuid::Uuid;

#[derive(Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    Administrator,
    Member,
}

impl rusqlite::types::FromSql for Role {
    fn column_result(value: rusqlite::types::ValueRef<'_>) -> rusqlite::types::FromSqlResult<Self> {
        match value.as_str()? {
            "administrator" => Ok(Self::Administrator),
            "member" => Ok(Self::Member),
            _ => Err(rusqlite::types::FromSqlError::InvalidType),
        }
    }
}

impl rusqlite::ToSql for Role {
    fn to_sql(&self) -> rusqlite::Result<rusqlite::types::ToSqlOutput<'_>> {
        Ok(match self {
            Self::Administrator => "administrator",
            Self::Member => "member",
        }
        .into())
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Account {
    pub id: String,
    pub household_id: String,
    pub username: String,
    pub role: Role,
    pub active: bool,
}

impl Account {
    pub fn from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            id: row.get(0)?,
            household_id: row.get(1)?,
            username: row.get(2)?,
            role: row.get(3)?,
            active: row.get(4)?,
        })
    }
}

#[derive(Serialize)]
pub struct Household {
    pub id: String,
    pub name: String,
}

#[derive(Serialize)]
pub struct Session {
    pub account: Account,
    pub household: Household,
}

#[derive(Serialize)]
pub struct SignedIn {
    pub token: String,
    #[serde(flatten)]
    pub session: Session,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Credentials {
    pub username: String,
    pub password: String,
}

pub fn username(value: &str) -> Result<String, ApiError> {
    let value = value.trim().to_ascii_lowercase();
    if !(3..=32).contains(&value.len())
        || !value
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"._-".contains(&c))
    {
        return Err(ApiError(
            StatusCode::UNPROCESSABLE_ENTITY,
            "Use a username of 3–32 letters, numbers, dots, underscores, or hyphens.",
        ));
    }
    Ok(value)
}

pub fn hash_password(value: &str) -> Result<String, ApiError> {
    if !(12..=128).contains(&value.chars().count()) {
        return Err(ApiError(
            StatusCode::UNPROCESSABLE_ENTITY,
            "Use a password of 12–128 characters.",
        ));
    }
    let salt =
        SaltString::encode_b64(Uuid::new_v4().as_bytes()).map_err(|_| ApiError::internal())?;
    Argon2::default()
        .hash_password(value.as_bytes(), &salt)
        .map(|hash| hash.to_string())
        .map_err(|_| ApiError::internal())
}

pub fn verify_password(value: &str, hash: &str) -> bool {
    PasswordHash::new(hash).is_ok_and(|hash| {
        Argon2::default()
            .verify_password(value.as_bytes(), &hash)
            .is_ok()
    })
}

pub fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("system clock before Unix epoch")
        .as_secs() as i64
}

pub fn token_hash(token: &str) -> String {
    format!("{:x}", Sha256::digest(token.as_bytes()))
}

pub fn session(db: &Connection, account: Account) -> Result<Session, ApiError> {
    let household = db.query_row(
        "SELECT id, name FROM households WHERE id = ?",
        [&account.household_id],
        |row| {
            Ok(Household {
                id: row.get(0)?,
                name: row.get(1)?,
            })
        },
    )?;
    Ok(Session { account, household })
}

pub fn sign_in(db: &Connection, account: Account) -> Result<SignedIn, ApiError> {
    let token = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
    db.execute("DELETE FROM sessions WHERE expires_at <= ?", [now()])?;
    db.execute(
        "INSERT INTO sessions (token_hash, account_id, expires_at) VALUES (?, ?, ?)",
        params![token_hash(&token), account.id, now() + 30 * 24 * 60 * 60],
    )?;
    Ok(SignedIn {
        token,
        session: session(db, account)?,
    })
}

pub struct Authenticated {
    pub account: Account,
    pub token_hash: String,
}

// Future synchronized records must authorize their stored owner using this
// boundary. Administrator privileges manage accounts, not personal records.
pub enum Scope<'a> {
    Personal(&'a str),
    Household(&'a str),
}

impl Authenticated {
    pub fn require_administrator(&self) -> Result<(), ApiError> {
        if self.account.role == Role::Administrator {
            Ok(())
        } else {
            Err(ApiError(
                StatusCode::FORBIDDEN,
                "Only the administrator can manage household accounts.",
            ))
        }
    }

    pub fn require(&self, scope: Scope<'_>) -> Result<(), ApiError> {
        let allowed = match scope {
            Scope::Personal(id) => id == self.account.id,
            Scope::Household(id) => id == self.account.household_id,
        };
        if allowed {
            Ok(())
        } else {
            Err(ApiError(
                StatusCode::FORBIDDEN,
                "This record is outside your account or household.",
            ))
        }
    }
}

impl FromRequestParts<Store> for Authenticated {
    type Rejection = ApiError;

    async fn from_request_parts(parts: &mut Parts, store: &Store) -> Result<Self, Self::Rejection> {
        let token = parts
            .headers
            .get("authorization")
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.strip_prefix("Bearer "))
            .filter(|token| token.len() == 64)
            .ok_or_else(ApiError::unauthorized)?;
        let token_hash = token_hash(token);
        store.run(move |db| {
            let account = db.query_row(
                "SELECT a.id, a.household_id, a.username, a.role, a.active FROM accounts a JOIN sessions s ON s.account_id = a.id WHERE s.token_hash = ? AND s.expires_at > ? AND a.active = 1",
                params![token_hash, now()], Account::from_row,
            ).optional()?.ok_or_else(ApiError::unauthorized)?;
            Ok(Self { account, token_hash })
        }).await
    }
}
