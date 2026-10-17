//! Synchronization of an embedded core with its household server.
//!
//! Local mutations commit together with the pending work they create (the
//! outbox). Delivery is idempotent by identity and retried on restart,
//! reconnect, resume, and explicit "Sync now". Merge and conflict decisions
//! reuse the shared revision and planning rules; the transport only moves
//! records. Pending work keeps the person and household that made it and is
//! delivered only under that person's own session.

use crate::{
    Core,
    changes::{Effects, Topic},
    error::{Error, ErrorKind, Result},
    principal::Principal,
    recipes::{self, Revision},
    remote::{PROTOCOL_VERSION, Remote},
};
use rusqlite::{Connection, OptionalExtension, params};
use serde::Serialize;
use serde_json::{Value, json};
use std::{
    collections::HashSet,
    sync::{
        Condvar, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use uuid::Uuid;

pub(crate) fn session_key(account_id: &str) -> String {
    format!("session:{account_id}")
}

#[derive(Default)]
pub(crate) struct SyncControl {
    /// Serializes synchronization runs, joins, and sign-ins.
    pub(crate) lock: Mutex<()>,
    pub(crate) syncing: AtomicBool,
    wake: Mutex<bool>,
    wake_signal: Condvar,
    stop: AtomicBool,
}

/// A change waiting for the server. It keeps the person and household that
/// made it, whatever account later signs in.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingChange {
    pub id: String,
    pub person_id: String,
    pub household_id: String,
    /// `recipeRevision`, `rating`, or `planning`.
    pub kind: String,
    pub payload: Value,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountSummary {
    pub id: String,
    pub username: Option<String>,
    pub role: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Conflicts {
    pub recipes: usize,
    pub planning: usize,
}

/// Everything the UI shows about synchronization.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncStatus {
    pub protocol: u32,
    pub bound: bool,
    pub server_url: Option<String>,
    pub remote_household_id: Option<String>,
    pub active_account: Option<AccountSummary>,
    /// A session token is held for the active account.
    pub signed_in: bool,
    pub signed_out: bool,
    pub paused: bool,
    pub syncing: bool,
    /// Changes waiting to be delivered, by every person on this device.
    pub pending: usize,
    /// Of those, changes that only another account can deliver.
    pub pending_for_other_accounts: usize,
    pub last_error: Option<String>,
    pub last_synced_at: Option<i64>,
    pub conflicts: Conflicts,
    pub pending_join: Option<crate::session::PendingJoin>,
}

pub(crate) fn is_bound(db: &Connection) -> Result<bool> {
    Ok(
        db.query_row("SELECT EXISTS(SELECT 1 FROM sync_binding)", [], |row| {
            row.get::<_, bool>(0)
        })?,
    )
}

/// Appends to the outbox when this installation is joined to a server.
pub(crate) fn record(
    db: &Connection,
    effects: &mut Effects,
    principal: &Principal,
    kind: &str,
    id: &str,
    payload: &impl Serialize,
) -> Result<()> {
    if !is_bound(db)? {
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
    effects.queued = true;
    effects.household(principal, Topic::Sync);
    Ok(())
}

/// What a new planning edit is based on: the last server revision when
/// nothing is pending, otherwise the preceding pending mutation.
pub(crate) fn planning_base(db: &Connection) -> Result<(Option<String>, Option<String>)> {
    if !is_bound(db)? {
        return Ok((None, None));
    }
    let previous: Option<String> = db
        .query_row(
            "SELECT id FROM sync_outbox WHERE kind = 'planning' ORDER BY seq DESC LIMIT 1",
            [],
            |row| row.get(0),
        )
        .optional()?;
    if previous.is_some() {
        return Ok((None, previous));
    }
    let revision: Option<String> = db
        .query_row("SELECT planning_revision FROM sync_state", [], |row| {
            row.get(0)
        })
        .optional()?
        .flatten();
    Ok((revision, None))
}

/// Queues a planning edit for delivery, with exactly the base the person saw.
pub(crate) fn record_planning(
    db: &Connection,
    effects: &mut Effects,
    principal: &Principal,
    base: &crate::planning::EditBase,
    data: &Value,
) -> Result<()> {
    if !is_bound(db)? {
        return Ok(());
    }
    let id = Uuid::new_v4().to_string();
    let mutation = json!({
        "id": id,
        "baseRevision": base.base_revision,
        "baseMutationId": base.base_mutation_id,
        "baseData": base.data,
        "data": data,
    });
    record(db, effects, principal, "planning", &id, &mutation)
}

struct Entry {
    id: String,
    person_id: String,
    kind: String,
    payload: Value,
}

fn pending_entries(db: &Connection) -> Result<Vec<Entry>> {
    let mut query =
        db.prepare("SELECT id, person_id, kind, payload FROM sync_outbox ORDER BY seq")?;
    let rows = query
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
            ))
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    rows.into_iter()
        .map(|(id, person_id, kind, payload)| {
            Ok(Entry {
                id,
                person_id,
                kind,
                payload: serde_json::from_str(&payload)?,
            })
        })
        .collect()
}

pub(crate) struct Binding {
    pub(crate) server_url: String,
    pub(crate) remote_household_id: String,
}

pub(crate) fn binding(db: &Connection) -> Result<Option<Binding>> {
    Ok(db
        .query_row(
            "SELECT server_url, remote_household_id FROM sync_binding",
            [],
            |row| {
                Ok(Binding {
                    server_url: row.get(0)?,
                    remote_household_id: row.get(1)?,
                })
            },
        )
        .optional()?)
}

pub(crate) struct State {
    pub(crate) active_account: Option<String>,
    pub(crate) signed_out: bool,
    pub(crate) paused: bool,
    pub(crate) last_error: Option<String>,
    pub(crate) last_synced_at: Option<i64>,
}

pub(crate) fn state(db: &Connection) -> Result<Option<State>> {
    Ok(db
        .query_row(
            "SELECT active_account, signed_out, paused, last_error, last_synced_at FROM sync_state",
            [],
            |row| {
                Ok(State {
                    active_account: row.get(0)?,
                    signed_out: row.get(1)?,
                    paused: row.get(2)?,
                    last_error: row.get(3)?,
                    last_synced_at: row.get(4)?,
                })
            },
        )
        .optional()?)
}

pub(crate) fn mirror_recipes(
    db: &Connection,
    household: &Principal,
    collection: &Value,
    pending_recipes: &HashSet<String>,
    effects: &mut Effects,
) -> Result<()> {
    for wire in collection["revisions"].as_array().into_iter().flatten() {
        let revision: Revision = serde_json::from_value(wire.clone()).map_err(|_| {
            Error::invalid("The server sent a recipe revision this app cannot read.")
        })?;
        let recipe_id = revision.recipe["id"]
            .as_str()
            .unwrap_or_default()
            .to_owned();
        let exists: bool = db.query_row(
            "SELECT EXISTS(SELECT 1 FROM recipe_revisions WHERE id = ?)",
            [&revision.id],
            |row| row.get(0),
        )?;
        let held_back: bool = db
            .query_row(
                "SELECT held_back FROM shared_recipes WHERE id = ?",
                [&recipe_id],
                |row| row.get(0),
            )
            .optional()?
            .unwrap_or(false);
        if exists || held_back {
            continue;
        }
        recipes::ingest_remote_revision(db, household, &revision, effects)?;
    }
    for head in collection["current"].as_array().into_iter().flatten() {
        let (Some(recipe_id), Some(revision_id)) =
            (head["recipeId"].as_str(), head["revisionId"].as_str())
        else {
            continue;
        };
        if pending_recipes.contains(recipe_id) {
            continue;
        }
        let known: bool = db.query_row(
            "SELECT EXISTS(SELECT 1 FROM recipe_revisions WHERE id = ? AND recipe_id = ?)",
            params![revision_id, recipe_id],
            |row| row.get(0),
        )?;
        let held_back: bool = db
            .query_row(
                "SELECT held_back FROM shared_recipes WHERE id = ?",
                [recipe_id],
                |row| row.get(0),
            )
            .optional()?
            .unwrap_or(false);
        if !known || held_back {
            continue;
        }
        let competing: HashSet<&str> = head["competingRevisionIds"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .collect();
        let before: String = db.query_row(
            "SELECT current_revision FROM shared_recipes WHERE id = ?",
            [recipe_id],
            |row| row.get(0),
        )?;
        db.execute(
            "UPDATE shared_recipes SET current_revision = ? WHERE id = ?",
            params![revision_id, recipe_id],
        )?;
        // Leaves the server has resolved stay retained but are no longer alternatives.
        for leaf in recipes::competing_revisions(db, recipe_id)? {
            if leaf != revision_id && !competing.contains(leaf.as_str()) {
                db.execute(
                    "INSERT OR IGNORE INTO resolved_recipe_revisions (revision_id) VALUES (?)",
                    [&leaf],
                )?;
            }
        }
        if before != revision_id {
            effects.household(household, Topic::Recipes);
        }
    }
    Ok(())
}

fn mirror_ratings(
    db: &Connection,
    person: &Principal,
    remote: &Value,
    pending: &HashSet<String>,
    effects: &mut Effects,
) -> Result<()> {
    let mut seen = HashSet::new();
    for rating in remote.as_array().into_iter().flatten() {
        let Some(recipe_id) = rating["recipeId"].as_str() else {
            continue;
        };
        seen.insert(recipe_id.to_owned());
        let known: bool = db.query_row(
            "SELECT EXISTS(SELECT 1 FROM shared_recipes WHERE id = ?)",
            [recipe_id],
            |row| row.get(0),
        )?;
        if pending.contains(recipe_id) || !known {
            continue;
        }
        db.execute(
            "INSERT INTO recipe_ratings (person_id, recipe_id, value) VALUES (?, ?, ?) ON CONFLICT(person_id, recipe_id) DO UPDATE SET value = excluded.value",
            params![person.person_id(), recipe_id, rating["value"].as_i64()],
        )?;
    }
    let local: Vec<String> = db
        .prepare("SELECT recipe_id FROM recipe_ratings WHERE person_id = ?")?
        .query_map([person.person_id()], |row| row.get(0))?
        .collect::<std::result::Result<_, _>>()?;
    for recipe_id in local {
        if !seen.contains(&recipe_id) && !pending.contains(&recipe_id) {
            db.execute(
                "DELETE FROM recipe_ratings WHERE person_id = ? AND recipe_id = ?",
                params![person.person_id(), recipe_id],
            )?;
        }
    }
    effects.person(person, Topic::Ratings);
    Ok(())
}

/// Adopts the server's planning document, unless local edits are still
/// waiting; those are re-based by delivering them first.
pub(crate) fn mirror_planning(
    db: &Connection,
    household: &Principal,
    snapshot: &Value,
    effects: &mut Effects,
) -> Result<()> {
    let waiting: bool = db.query_row(
        "SELECT EXISTS(SELECT 1 FROM sync_outbox WHERE kind = 'planning')",
        [],
        |row| row.get(0),
    )?;
    if waiting {
        return Ok(());
    }
    let payload = json!({
        "revision": snapshot["revision"],
        "data": snapshot["data"],
        "conflicts": snapshot["conflicts"],
    });
    let existing: Option<String> = db
        .query_row(
            "SELECT payload FROM household_planning WHERE household_id = ?",
            [household.household_id()],
            |row| row.get(0),
        )
        .optional()?;
    let text = payload.to_string();
    if existing.as_deref() != Some(&text) {
        db.execute(
            "INSERT INTO household_planning (household_id, payload) VALUES (?, ?) ON CONFLICT(household_id) DO UPDATE SET payload = excluded.payload",
            params![household.household_id(), text],
        )?;
        effects.household(household, Topic::Planning);
    }
    db.execute(
        "UPDATE sync_state SET planning_revision = ?",
        [snapshot["revision"].as_str()],
    )?;
    Ok(())
}

fn session_ended() -> Error {
    Error::new(
        ErrorKind::Unauthenticated,
        "Your session ended. Sign in again.",
    )
}

impl Core {
    pub fn sync_status(&self) -> Result<SyncStatus> {
        let pending_join = self.pending_join()?;
        let has_token = |account: &str| {
            self.inner
                .secrets
                .get(&session_key(account))
                .map(|token| token.is_some())
        };
        let (mut status, active) = self.read(|db| {
            let binding = binding(db)?;
            let state = state(db)?;
            let entries = pending_entries(db)?;
            let active = state.as_ref().and_then(|state| state.active_account.clone());
            let account = match &active {
                Some(id) => db
                    .query_row(
                        "SELECT account_id, username, role FROM remote_accounts WHERE account_id = ?",
                        [id],
                        |row| {
                            Ok(AccountSummary {
                                id: row.get(0)?,
                                username: row.get(1)?,
                                role: row.get(2)?,
                            })
                        },
                    )
                    .optional()?,
                None => None,
            };
            let recipe_conflicts = match &binding {
                Some(_) => {
                    let household: String = db.query_row(
                        "SELECT household_id FROM people WHERE kind = 'local'",
                        [],
                        |row| row.get(0),
                    )?;
                    recipes::current_recipe_views(db, &household)?
                        .iter()
                        .map(|view| view.unresolved)
                        .sum()
                }
                None => 0,
            };
            let planning_conflicts = match &binding {
                Some(_) => db
                    .query_row("SELECT payload FROM household_planning", [], |row| {
                        row.get::<_, String>(0)
                    })
                    .optional()?
                    .and_then(|payload| serde_json::from_str::<Value>(&payload).ok())
                    .and_then(|doc| doc["conflicts"].as_array().map(Vec::len))
                    .unwrap_or(0),
                None => 0,
            };
            let other = entries
                .iter()
                .filter(|entry| Some(&entry.person_id) != active.as_ref())
                .count();
            Ok((
                SyncStatus {
                    protocol: PROTOCOL_VERSION,
                    bound: binding.is_some(),
                    server_url: binding.as_ref().map(|b| b.server_url.clone()),
                    remote_household_id: binding.map(|b| b.remote_household_id),
                    active_account: account,
                    signed_in: false,
                    signed_out: state.as_ref().is_some_and(|s| s.signed_out),
                    paused: state.as_ref().is_some_and(|s| s.paused),
                    syncing: false,
                    pending: entries.len(),
                    pending_for_other_accounts: other,
                    last_error: state.as_ref().and_then(|s| s.last_error.clone()),
                    last_synced_at: state.and_then(|s| s.last_synced_at),
                    conflicts: Conflicts {
                        recipes: recipe_conflicts,
                        planning: planning_conflicts,
                    },
                    pending_join: None,
                },
                active,
            ))
        })?;
        status.signed_in = match &active {
            Some(id) => has_token(id)? && !status.signed_out,
            None => false,
        };
        status.syncing = self.inner.sync.syncing.load(Ordering::SeqCst);
        status.pending_join = pending_join;
        Ok(status)
    }

    /// Delivers pending work and mirrors the server's records. Failures are
    /// recorded as visible status and leave pending work in place.
    pub fn sync_now(&self) -> Result<SyncStatus> {
        let _guard = self.inner.sync.lock.lock().expect("sync lock poisoned");
        self.inner.sync.syncing.store(true, Ordering::SeqCst);
        let result = self.sync_locked();
        self.inner.sync.syncing.store(false, Ordering::SeqCst);
        let (message, delivered) = match result {
            Ok(delivered) => (None, delivered),
            Err(error) if error.kind == ErrorKind::Internal => return Err(error),
            Err(error) => (Some(error.message), false),
        };
        let now = self.now();
        self.write(|db, effects| {
            if state(db)?.is_some() {
                if let Some(message) = &message {
                    db.execute("UPDATE sync_state SET last_error = ?", [message])?;
                } else {
                    db.execute(
                        "UPDATE sync_state SET last_error = NULL, last_synced_at = ?",
                        [now],
                    )?;
                }
                let household: String = db.query_row(
                    "SELECT household_id FROM people WHERE kind = 'local'",
                    [],
                    |row| row.get(0),
                )?;
                effects.household_id(&household, Topic::Sync);
            }
            Ok(())
        })?;
        let _ = delivered;
        self.sync_status()
    }

    fn sync_locked(&self) -> Result<bool> {
        let (binding, state) = self.read(|db| Ok((binding(db)?, state(db)?)))?;
        let (Some(binding), Some(state)) = (binding, state) else {
            return Ok(false);
        };
        if state.paused || state.signed_out {
            return Ok(false);
        }
        let account = state.active_account.ok_or_else(Error::unauthenticated)?;
        let token = self
            .inner
            .secrets
            .get(&session_key(&account))?
            .ok_or_else(|| {
                Error::new(
                    ErrorKind::Unauthenticated,
                    "Sign in to synchronize. Changes stay on this device.",
                )
            })?;
        let remote = Remote::new(&binding.server_url, Some(token));
        let outcome: Result<bool> = (|| {
            remote.status()?;
            self.push(&remote, &binding, &account)?;
            self.pull(&remote, &binding, &account)?;
            Ok(true)
        })();
        match outcome {
            Err(error) if error.kind == ErrorKind::Unauthenticated => {
                self.inner.secrets.delete(&session_key(&account))?;
                Err(session_ended())
            }
            other => other,
        }
    }

    fn acting(&self, person: &str) -> Result<Principal> {
        self.read(|db| {
            let household: String = db.query_row(
                "SELECT household_id FROM people WHERE kind = 'local'",
                [],
                |row| row.get(0),
            )?;
            Ok(Principal::new(
                person.to_owned(),
                household,
                crate::principal::Standing::Member,
            ))
        })
    }

    fn push(&self, remote: &Remote, binding: &Binding, account: &str) -> Result<()> {
        let household = format!("/households/{}", binding.remote_household_id);
        loop {
            let entries = self.read(|db| {
                Ok(pending_entries(db)?
                    .into_iter()
                    .filter(|entry| entry.person_id == account)
                    .collect::<Vec<_>>())
            })?;
            let Some(first) = entries.first() else {
                return Ok(());
            };
            match first.kind.as_str() {
                "recipeRevision" => {
                    remote.call(
                        "POST",
                        &format!("{household}/recipe-revisions"),
                        Some(&first.payload),
                    )?;
                    self.acknowledge(std::slice::from_ref(&first.id))?;
                }
                "rating" => {
                    let batch: Vec<&Entry> = entries
                        .iter()
                        .take_while(|entry| entry.kind == "rating")
                        .take(100)
                        .collect();
                    let changes: Vec<&Value> = batch.iter().map(|entry| &entry.payload).collect();
                    remote.call(
                        "POST",
                        &format!("/accounts/{account}/recipe-ratings"),
                        Some(&json!({ "changes": changes })),
                    )?;
                    let ids: Vec<String> = batch.iter().map(|entry| entry.id.clone()).collect();
                    self.acknowledge(&ids)?;
                }
                "planning" => {
                    let snapshot = remote.call(
                        "POST",
                        &format!("{household}/planning"),
                        Some(&first.payload),
                    )?;
                    let person = self.acting(account)?;
                    self.write(|db, effects| {
                        db.execute("DELETE FROM sync_outbox WHERE id = ?", [&first.id])?;
                        mirror_planning(db, &person, &snapshot, effects)?;
                        effects.household(&person, Topic::Sync);
                        Ok(())
                    })?;
                }
                _ => {
                    return Err(Error::new(
                        ErrorKind::Unsupported,
                        "This device queued a change this version cannot deliver. It has been kept.",
                    ));
                }
            }
        }
    }

    fn acknowledge(&self, ids: &[String]) -> Result<()> {
        self.write(|db, effects| {
            for id in ids {
                db.execute("DELETE FROM sync_outbox WHERE id = ?", [id])?;
            }
            let household: String = db.query_row(
                "SELECT household_id FROM people WHERE kind = 'local'",
                [],
                |row| row.get(0),
            )?;
            effects.household_id(&household, Topic::Sync);
            Ok(())
        })
    }

    fn pull(&self, remote: &Remote, binding: &Binding, account: &str) -> Result<()> {
        let household = format!("/households/{}", binding.remote_household_id);
        let collection = remote.call("GET", &format!("{household}/recipes"), None)?;
        let ratings = remote.call("GET", &format!("/accounts/{account}/recipe-ratings"), None)?;
        let planning = remote.call("GET", &format!("{household}/planning"), None)?;
        let person = self.acting(account)?;
        self.write(|db, effects| {
            let pending = pending_entries(db)?;
            let pending_recipes: HashSet<String> = pending
                .iter()
                .filter(|entry| entry.kind == "recipeRevision")
                .filter_map(|entry| entry.payload["recipe"]["id"].as_str().map(str::to_owned))
                .collect();
            let pending_ratings: HashSet<String> = pending
                .iter()
                .filter(|entry| entry.kind == "rating" && entry.person_id == account)
                .filter_map(|entry| entry.payload["recipeId"].as_str().map(str::to_owned))
                .collect();
            mirror_recipes(db, &person, &collection, &pending_recipes, effects)?;
            mirror_ratings(db, &person, &ratings, &pending_ratings, effects)?;
            mirror_planning(db, &person, &planning, effects)?;
            Ok(())
        })
    }

    /// Wakes the background worker, if one is running.
    pub fn nudge_sync(&self) {
        *self.inner.sync.wake.lock().expect("wake poisoned") = true;
        self.inner.sync.wake_signal.notify_all();
    }

    /// Starts the background synchronization worker: it runs on changes, on
    /// `nudge_sync` (focus, resume, reconnect), and periodically, backing
    /// off after failures. It lives only as long as the host process, which
    /// is all an app without a permanent daemon needs.
    pub fn start_sync_worker(&self) {
        let core = self.clone();
        std::thread::Builder::new()
            .name("forkcast-sync".into())
            .spawn(move || {
                let mut failures = 0u32;
                loop {
                    let wait = Duration::from_secs(if failures == 0 {
                        20
                    } else {
                        (2u64 << failures.min(5)).min(60)
                    });
                    {
                        let sync = &core.inner.sync;
                        let mut woken = sync.wake.lock().expect("wake poisoned");
                        if !*woken {
                            woken = sync
                                .wake_signal
                                .wait_timeout(woken, wait)
                                .expect("wake poisoned")
                                .0;
                        }
                        *woken = false;
                    }
                    if core.inner.sync.stop.load(Ordering::SeqCst) {
                        return;
                    }
                    std::thread::sleep(Duration::from_millis(100));
                    match core.sync_now() {
                        Ok(status) if status.last_error.is_none() => failures = 0,
                        Ok(status) if status.signed_in => failures += 1,
                        // Nothing to retry until someone signs in again.
                        Ok(_) => failures = 0,
                        Err(_) => failures += 1,
                    }
                }
            })
            .expect("start sync worker");
    }

    pub fn stop_sync_worker(&self) {
        self.inner.sync.stop.store(true, Ordering::SeqCst);
        self.nudge_sync();
    }
}
