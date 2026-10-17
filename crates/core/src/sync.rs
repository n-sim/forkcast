//! Durable pending synchronization state. A standalone installation that has
//! joined a server records each local change to shared or rated data in the
//! same transaction as the change itself, so neither can exist without the
//! other. The transport that delivers them belongs to the synchronization
//! work; this module only guarantees nothing is lost or re-attributed.

use crate::{
    Core,
    changes::Topic,
    error::{Error, Result},
    principal::{Principal, Standing},
};
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct JoinServer {
    pub server_url: String,
    pub remote_household_id: String,
    pub remote_account_id: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncBinding {
    pub server_url: String,
    pub remote_household_id: String,
    pub remote_account_id: String,
}

/// A change waiting for the server. It keeps the person and household that
/// made it, whatever account later signs in or out.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingChange {
    pub id: String,
    pub person_id: String,
    pub household_id: String,
    /// `recipeRevision` (a [`crate::Revision`]), `rating`
    /// (a [`crate::RatingChange`]), or `planning` (`{id, baseData, data}`).
    pub kind: String,
    pub payload: Value,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncState {
    pub binding: Option<SyncBinding>,
    pub pending: Vec<PendingChange>,
}

/// Appends to the outbox when this installation is joined to a server.
pub(crate) fn record(
    db: &Connection,
    principal: &Principal,
    kind: &str,
    id: &str,
    payload: &impl Serialize,
) -> Result<()> {
    if !db.query_row("SELECT EXISTS(SELECT 1 FROM sync_binding)", [], |row| {
        row.get::<_, bool>(0)
    })? {
        return Ok(());
    }
    db.execute(
        "INSERT INTO sync_outbox (id, person_id, household_id, kind, payload) VALUES (?, ?, ?, ?, ?)",
        params![
            id,
            principal.person_id(),
            principal.household_id(),
            kind,
            serde_json::to_string(payload)?
        ],
    )?;
    Ok(())
}

impl Core {
    /// Associates this standalone profile with one household on one server.
    /// Rejoining the same household is a no-op; another household needs a
    /// separate local profile.
    pub fn join_server(&self, principal: &Principal, input: JoinServer) -> Result<SyncState> {
        if principal.standing() != Standing::Local {
            return Err(Error::forbidden(
                "Only a standalone profile can join a household server.",
            ));
        }
        if input.server_url.trim().is_empty()
            || input.remote_household_id.trim().is_empty()
            || input.remote_account_id.trim().is_empty()
        {
            return Err(Error::invalid("Enter the server, household, and account."));
        }
        self.write(|db, effects| {
            let existing: Option<(String, String)> = db
                .query_row(
                    "SELECT server_url, remote_household_id FROM sync_binding",
                    [],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .optional()?;
            match existing {
                Some((url, household))
                    if url == input.server_url && household == input.remote_household_id => {}
                Some(_) => {
                    return Err(Error::conflict(
                        "This profile is linked to another household. Use a separate local profile for another household.",
                    ));
                }
                None => {
                    db.execute(
                        "INSERT INTO sync_binding (singleton, server_url, remote_household_id, remote_account_id, person_id) VALUES (1, ?, ?, ?, ?)",
                        params![
                            input.server_url,
                            input.remote_household_id,
                            input.remote_account_id,
                            principal.person_id()
                        ],
                    )?;
                }
            }
            effects.household(principal, Topic::Sync);
            sync_state(db, principal)
        })
    }

    pub fn sync_state(&self, principal: &Principal) -> Result<SyncState> {
        self.read(|db| sync_state(db, principal))
    }

    /// Removes changes the server has confirmed. Unknown ids are ignored so a
    /// retried acknowledgement is harmless.
    pub fn acknowledge_sync(&self, principal: &Principal, ids: &[String]) -> Result<SyncState> {
        self.write(|db, effects| {
            for id in ids {
                db.execute(
                    "DELETE FROM sync_outbox WHERE id = ? AND household_id = ?",
                    params![id, principal.household_id()],
                )?;
            }
            effects.household(principal, Topic::Sync);
            sync_state(db, principal)
        })
    }
}

fn sync_state(db: &Connection, principal: &Principal) -> Result<SyncState> {
    let binding = db
        .query_row(
            "SELECT server_url, remote_household_id, remote_account_id FROM sync_binding",
            [],
            |row| {
                Ok(SyncBinding {
                    server_url: row.get(0)?,
                    remote_household_id: row.get(1)?,
                    remote_account_id: row.get(2)?,
                })
            },
        )
        .optional()?;
    let mut query = db.prepare(
        "SELECT id, person_id, household_id, kind, payload FROM sync_outbox WHERE household_id = ? ORDER BY seq",
    )?;
    let rows = query
        .query_map([principal.household_id()], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
            ))
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    let pending = rows
        .into_iter()
        .map(|(id, person_id, household_id, kind, payload)| {
            Ok(PendingChange {
                id,
                person_id,
                household_id,
                kind,
                payload: serde_json::from_str(&payload)?,
            })
        })
        .collect::<Result<Vec<_>>>()?;
    Ok(SyncState { binding, pending })
}
