//! Household server accounts and sessions. A standalone installation never
//! uses these; a server host authenticates a bearer token into a [`Principal`]
//! and passes that to every operation.

use crate::{
    Core,
    error::{Error, ErrorKind, Result},
    principal::{Principal, Standing},
};
use argon2::{Argon2, PasswordHash, PasswordHasher, PasswordVerifier, password_hash::SaltString};
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
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
    fn from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            id: row.get(0)?,
            household_id: row.get(1)?,
            username: row.get(2)?,
            role: row.get(3)?,
            active: row.get(4)?,
        })
    }

    fn principal(&self) -> Principal {
        Principal::new(
            self.id.clone(),
            self.household_id.clone(),
            match self.role {
                Role::Administrator => Standing::Administrator,
                Role::Member => Standing::Member,
            },
        )
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

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SetupServer {
    pub household_name: String,
    pub username: String,
    pub password: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AccountChange {
    pub active: Option<bool>,
    pub password: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerStatus {
    pub setup_required: bool,
}

/// A verified bearer session. `token_hash` identifies it for sign-out.
pub struct Authenticated {
    pub principal: Principal,
    pub token_hash: String,
}

fn username(value: &str) -> Result<String> {
    let value = value.trim().to_ascii_lowercase();
    if !(3..=32).contains(&value.len())
        || !value
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"._-".contains(&c))
    {
        return Err(Error::invalid(
            "Use a username of 3–32 letters, numbers, dots, underscores, or hyphens.",
        ));
    }
    Ok(value)
}

fn hash_password(value: &str) -> Result<String> {
    if !(12..=128).contains(&value.chars().count()) {
        return Err(Error::invalid("Use a password of 12–128 characters."));
    }
    let salt = SaltString::encode_b64(Uuid::new_v4().as_bytes()).map_err(|_| Error::internal())?;
    Argon2::default()
        .hash_password(value.as_bytes(), &salt)
        .map(|hash| hash.to_string())
        .map_err(|_| Error::internal())
}

fn verify_password(value: &str, hash: &str) -> bool {
    PasswordHash::new(hash).is_ok_and(|hash| {
        Argon2::default()
            .verify_password(value.as_bytes(), &hash)
            .is_ok()
    })
}

fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("system clock before Unix epoch")
        .as_secs() as i64
}

fn token_hash(token: &str) -> String {
    format!("{:x}", Sha256::digest(token.as_bytes()))
}

fn session(db: &Connection, account: Account) -> Result<Session> {
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

fn sign_in(db: &Connection, account: Account) -> Result<SignedIn> {
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

fn account(db: &Connection, id: &str) -> Result<Account> {
    Ok(db.query_row(
        "SELECT id, household_id, username, role, active FROM accounts WHERE id = ?",
        [id],
        Account::from_row,
    )?)
}

impl Core {
    pub fn server_status(&self) -> Result<ServerStatus> {
        self.read(|db| {
            Ok(ServerStatus {
                setup_required: !db.query_row(
                    "SELECT EXISTS(SELECT 1 FROM households)",
                    [],
                    |row| row.get::<_, bool>(0),
                )?,
            })
        })
    }

    /// Creates the household and its administrator on a fresh server database.
    pub fn setup_server(&self, input: SetupServer) -> Result<SignedIn> {
        let username = username(&input.username)?;
        let household_name = input.household_name.trim().to_owned();
        if household_name.is_empty() || household_name.chars().count() > 80 {
            return Err(Error::invalid("Use a household name of 1–80 characters."));
        }
        let hash = hash_password(&input.password)?;
        self.write(|db, _| {
            if db.query_row("SELECT EXISTS(SELECT 1 FROM households)", [], |row| {
                row.get::<_, bool>(0)
            })? {
                return Err(Error::conflict(
                    "This instance is already set up. Sign in instead.",
                ));
            }
            let household_id = Uuid::new_v4().to_string();
            db.execute(
                "INSERT INTO households (singleton, id, name) VALUES (1, ?, ?)",
                params![household_id, household_name],
            )?;
            let account = Account {
                id: Uuid::new_v4().to_string(),
                household_id,
                username,
                role: Role::Administrator,
                active: true,
            };
            insert_account(db, &account, &hash)?;
            sign_in(db, account)
        })
    }

    pub fn sign_in(&self, input: Credentials) -> Result<SignedIn> {
        let username = username(&input.username)?;
        // Serialize credential checks with resets and account disabling so an
        // in-flight login cannot revive a session using a previous password.
        self.write(|db, _| {
            db.execute(
                "DELETE FROM login_failures WHERE last_attempt <= ?",
                [now() - 60],
            )?;
            let failures: i64 = db
                .query_row(
                    "SELECT failures FROM login_failures WHERE username = ?",
                    [&username],
                    |row| row.get(0),
                )
                .optional()?
                .unwrap_or(0);
            if failures >= 5 {
                return Ok(Err(Error::new(
                    ErrorKind::RateLimited,
                    "Too many failed sign-in attempts. Try again in a minute.",
                )));
            }
            let found = db
                .query_row(
                    "SELECT id, household_id, username, role, active, password_hash FROM accounts WHERE username = ?",
                    [&username],
                    |row| Ok((Account::from_row(row)?, row.get::<_, String>(5)?)),
                )
                .optional()?;
            let valid = match &found {
                Some((account, hash)) => verify_password(&input.password, hash) && account.active,
                None => {
                    let _ = hash_password("a dummy credential for unknown accounts")?;
                    false
                }
            };
            let Some((account, _)) = found.filter(|_| valid) else {
                db.execute(
                    "INSERT INTO login_failures (username, failures, last_attempt) VALUES (?, ?, ?) ON CONFLICT(username) DO UPDATE SET failures = excluded.failures, last_attempt = excluded.last_attempt",
                    params![username, failures + 1, now()],
                )?;
                // The failure count must survive even though the sign-in fails.
                return Ok(Err(Error::new(
                    ErrorKind::Unauthenticated,
                    "Username or password is incorrect.",
                )));
            };
            db.execute("DELETE FROM login_failures WHERE username = ?", [username.as_str()])?;
            sign_in(db, account).map(Ok)
        })?
    }

    /// Turns a bearer token into the principal every operation requires.
    pub fn authenticate(&self, token: &str) -> Result<Authenticated> {
        if token.len() != 64 {
            return Err(Error::unauthenticated());
        }
        let hash = token_hash(token);
        self.read(|db| {
            let account = db
                .query_row(
                    "SELECT a.id, a.household_id, a.username, a.role, a.active FROM accounts a JOIN sessions s ON s.account_id = a.id WHERE s.token_hash = ? AND s.expires_at > ? AND a.active = 1",
                    params![hash, now()],
                    Account::from_row,
                )
                .optional()?
                .ok_or_else(Error::unauthenticated)?;
            Ok(Authenticated {
                principal: account.principal(),
                token_hash: hash,
            })
        })
    }

    pub fn session(&self, principal: &Principal) -> Result<Session> {
        self.read(|db| session(db, account(db, principal.person_id())?))
    }

    pub fn sign_out(&self, authenticated: &Authenticated) -> Result<()> {
        self.write(|db, _| {
            db.execute(
                "DELETE FROM sessions WHERE token_hash = ?",
                [&authenticated.token_hash],
            )?;
            Ok(())
        })
    }

    pub fn accounts(&self, principal: &Principal) -> Result<Vec<Account>> {
        principal.require_administrator()?;
        self.read(|db| {
            let mut query = db.prepare(
                "SELECT id, household_id, username, role, active FROM accounts WHERE household_id = ? ORDER BY username",
            )?;
            Ok(query
                .query_map([principal.household_id()], Account::from_row)?
                .collect::<std::result::Result<Vec<_>, _>>()?)
        })
    }

    pub fn create_account(&self, principal: &Principal, input: Credentials) -> Result<Account> {
        principal.require_administrator()?;
        let username = username(&input.username)?;
        let hash = hash_password(&input.password)?;
        self.write(|db, _| {
            let account = Account {
                id: Uuid::new_v4().to_string(),
                household_id: principal.household_id().to_owned(),
                username,
                role: Role::Member,
                active: true,
            };
            insert_account(db, &account, &hash)?;
            Ok(account)
        })
    }

    pub fn change_account(
        &self,
        principal: &Principal,
        id: &str,
        input: AccountChange,
    ) -> Result<Account> {
        principal.require_administrator()?;
        if input.active.is_none() && input.password.is_none() {
            return Err(Error::invalid(
                "Choose an account status or a replacement password.",
            ));
        }
        let hash = input.password.as_deref().map(hash_password).transpose()?;
        self.write(|db, _| {
            let mut account = db
                .query_row(
                    "SELECT id, household_id, username, role, active FROM accounts WHERE id = ? AND household_id = ?",
                    params![id, principal.household_id()],
                    Account::from_row,
                )
                .optional()?
                .ok_or_else(|| Error::not_found("Household account not found."))?;
            if account.role == Role::Administrator {
                return Err(Error::forbidden(
                    "The instance administrator cannot be disabled or reset here.",
                ));
            }
            if let Some(active) = input.active {
                db.execute("UPDATE accounts SET active = ? WHERE id = ?", params![active, id])?;
                account.active = active;
            }
            if let Some(hash) = hash {
                db.execute(
                    "UPDATE accounts SET password_hash = ? WHERE id = ?",
                    params![hash, id],
                )?;
            }
            if input.password.is_some() || input.active == Some(false) {
                db.execute("DELETE FROM sessions WHERE account_id = ?", [id])?;
            }
            if input.password.is_some() || input.active == Some(true) {
                db.execute(
                    "DELETE FROM login_failures WHERE username = ?",
                    [&account.username],
                )?;
            }
            Ok(account)
        })
    }
}

/// Every account is also a person, so its personal records have an owner
/// regardless of how the person signs in.
fn insert_account(db: &Connection, account: &Account, hash: &str) -> Result<()> {
    db.execute(
        "INSERT INTO accounts (id, household_id, username, password_hash, role) VALUES (?, ?, ?, ?, ?)",
        params![account.id, account.household_id, account.username, hash, account.role],
    )
    .map_err(|error| {
        if error.sqlite_error_code() == Some(rusqlite::ErrorCode::ConstraintViolation) {
            Error::conflict("That username is already in use.")
        } else {
            error.into()
        }
    })?;
    db.execute(
        "INSERT INTO people (id, household_id, kind) VALUES (?, ?, 'account')",
        params![account.id, account.household_id],
    )?;
    Ok(())
}
