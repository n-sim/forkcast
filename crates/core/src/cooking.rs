//! Cooking sessions: a person's resumable, guided preparation of a recipe as
//! captured when cooking started, and the household's cooking occurrences.
//!
//! Sessions are personal: they synchronize only between the same account's
//! devices. Each change is delivered as a progress mutation with the progress
//! it was based on; the server merges independent changes and retains
//! competing ones as a `conflict` for the person to resolve. Occurrences are
//! household records, delivered by their stable id.

use crate::{
    Core,
    changes::{Effects, Topic},
    error::{Error, Result},
    principal::{Principal, outside},
    recipes, sync,
};
use forkcast_recipe_domain::{
    cooking::{CookingAction, CookingProgress, StepTimer, update_cooking_progress},
    quantities::{DisplayUnits, calculate_recipe},
    recipe::{RecipeDraft, validate_recipe},
};
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use std::collections::HashSet;
use uuid::Uuid;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StartCooking {
    pub recipe_id: String,
    pub portions: f64,
    /// `metric`, `us`, or `original`.
    #[serde(default)]
    pub display_units: Option<String>,
    /// Unfinished sessions the person agreed to cancel. Starting fails
    /// unless this names exactly the unfinished sessions.
    #[serde(default)]
    pub cancel_session_ids: Vec<String>,
}

#[derive(Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum CookingOutcome {
    Finished,
    Canceled,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MarkCooked {
    /// Identifies this cooking event; repeating the same id is accepted
    /// without counting again.
    #[serde(default)]
    pub id: Option<String>,
    pub recipe_id: String,
    /// The person's unfinished guided session for this cook, if any. Marking
    /// it cooked and finishing it later are then one occurrence.
    #[serde(default)]
    pub session_id: Option<String>,
}

/// A recipe's household cooking history.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecipeHistory {
    pub recipe_id: String,
    pub count: i64,
    /// Milliseconds since the Unix epoch.
    pub last_cooked_at: i64,
}

/// Either the new session, or the unfinished sessions that need a decision.
#[derive(Serialize)]
pub struct BeginCooking {
    pub session: Option<Value>,
    pub conflicts: Vec<Value>,
}

/// Which progress a person keeps when two devices changed a session at once.
#[derive(Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum CookingChoice {
    /// The progress the session shows now.
    Current,
    /// The competing progress retained in its `conflict`.
    Alternative,
}

/// One synchronized change to a person's cooking session. `base` is the
/// progress the device changed; `session` carries the captured contents
/// when the change started the session.
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CookingSessionChange {
    pub id: String,
    pub session_id: String,
    #[serde(default)]
    pub base: Option<Value>,
    pub progress: Value,
    #[serde(default)]
    pub session: Option<Value>,
    /// The person explicitly resolved the session's conflict.
    #[serde(default)]
    pub resolves: bool,
}

/// One synchronized household cooking occurrence.
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CookingOccurrence {
    pub id: String,
    pub recipe_id: String,
    #[serde(default)]
    pub session_id: Option<String>,
    /// Milliseconds since the Unix epoch.
    pub cooked_at: i64,
    /// Who cooked, as the server recorded it. A device's value is ignored.
    #[serde(default)]
    pub person_id: String,
}

fn unreadable() -> Error {
    Error::internal()
}

/// Sessions still asking for the person: unfinished, or ended with a
/// competing change that has not been resolved.
const OPEN: &str = "(ended = 0 OR json_extract(payload, '$.conflict') IS NOT NULL)";

fn unfinished(db: &Connection, principal: &Principal) -> Result<Vec<Value>> {
    let mut query = db.prepare(&format!(
        "SELECT payload FROM cooking_sessions WHERE person_id = ? AND {OPEN} ORDER BY rowid"
    ))?;
    let payloads = query
        .query_map([principal.person_id()], |row| row.get::<_, String>(0))?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    payloads
        .iter()
        .map(|payload| Ok(serde_json::from_str(payload)?))
        .collect()
}

/// Marks sessions whose recipe has been archived since cooking started. They
/// remain resumable from what they captured; the notice is never stored.
fn with_archival(
    db: &Connection,
    principal: &Principal,
    mut sessions: Vec<Value>,
) -> Result<Vec<Value>> {
    let archived = recipes::archived_recipes(db, principal.household_id())?;
    for session in &mut sessions {
        let recipe = session["recipe"]["id"].as_str().unwrap_or_default();
        session["recipeArchived"] = Value::Bool(archived.contains_key(recipe));
    }
    Ok(sessions)
}

fn find_unfinished(db: &Connection, principal: &Principal, id: &str) -> Result<Value> {
    unfinished(db, principal)?
        .into_iter()
        .find(|session| session["id"] == id && !ended(session))
        .ok_or_else(|| {
            Error::not_found("This cooking session has ended or belongs to another person.")
        })
}

/// What synchronizes of a session once it has started.
fn progress_of(session: &Value) -> Value {
    json!({
        "currentStep": session["currentStep"],
        "timers": match &session["timers"] {
            Value::Object(timers) => Value::Object(timers.clone()),
            _ => json!({}),
        },
        "completedAt": session.get("completedAt").cloned().unwrap_or(Value::Null),
        "canceledAt": session.get("canceledAt").cloned().unwrap_or(Value::Null),
    })
}

fn set_progress(session: &mut Value, progress: &Value) {
    for key in ["currentStep", "timers", "completedAt", "canceledAt"] {
        session[key] = progress[key].clone();
    }
}

/// Checks progress against the session's captured steps.
fn check_progress(session: &Value, progress: &Value, now: i64) -> Result<()> {
    let time =
        |key: &str| progress[key].is_null() || progress[key].as_f64().is_some_and(f64::is_finite);
    let readable = progress["currentStep"]
        .as_u64()
        .is_some_and(|step| (step as usize) < step_count(session))
        && time("completedAt")
        && time("canceledAt")
        && (progress["completedAt"].is_null() || progress["canceledAt"].is_null());
    if !readable {
        return Err(Error::invalid("This cooking progress could not be read."));
    }
    check_timers(session, &progress["timers"], now)
}

fn check_timers(session: &Value, timers: &Value, now: i64) -> Result<()> {
    let steps: Vec<&str> = session["recipe"]["steps"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|step| step["id"].as_str())
        .collect();
    let entries = timers
        .as_object()
        .ok_or_else(|| Error::invalid("Step timers could not be read."))?;
    for (step_id, timer) in entries {
        let timer: StepTimer = serde_json::from_value(timer.clone())
            .map_err(|_| Error::invalid("This step timer could not be read."))?;
        timer.remaining(now as f64).map_err(Error::invalid)?;
        if !steps.contains(&step_id.as_str()) {
            return Err(Error::invalid(
                "A step timer names a step outside this recipe.",
            ));
        }
    }
    Ok(())
}

/// Three-way merge of session progress. Changes to different fields (the
/// step, each step's timer, the outcome) combine; competing changes to the
/// same field, or finishing on one side while cooking continued on the
/// other, return `None` so both are kept for the person to decide.
fn merge_progress(base: &Value, ours: &Value, theirs: &Value) -> Option<Value> {
    fn pick(base: &Value, ours: &Value, theirs: &Value) -> Option<Value> {
        if theirs == base || ours == theirs {
            Some(ours.clone())
        } else if ours == base {
            Some(theirs.clone())
        } else {
            None
        }
    }
    let outcome = |progress: &Value| json!([progress["completedAt"], progress["canceledAt"]]);
    let continued = |progress: &Value| {
        progress["currentStep"] != base["currentStep"] || progress["timers"] != base["timers"]
    };
    if !ended(base)
        && ((ended(ours) && !ended(theirs) && continued(theirs))
            || (ended(theirs) && !ended(ours) && continued(ours)))
    {
        return None;
    }
    let step = pick(
        &base["currentStep"],
        &ours["currentStep"],
        &theirs["currentStep"],
    )?;
    let [completed, canceled] = match pick(&outcome(base), &outcome(ours), &outcome(theirs))? {
        Value::Array(pair) => <[Value; 2]>::try_from(pair).ok()?,
        _ => return None,
    };
    let mut keys: Vec<&String> = [base, ours, theirs]
        .iter()
        .filter_map(|progress| progress["timers"].as_object())
        .flat_map(Map::keys)
        .collect();
    keys.sort();
    keys.dedup();
    let mut timers = Map::new();
    for key in keys {
        let timer = pick(
            &base["timers"][key],
            &ours["timers"][key],
            &theirs["timers"][key],
        )?;
        if !timer.is_null() {
            timers.insert(key.clone(), timer);
        }
    }
    Some(json!({
        "currentStep": step,
        "timers": timers,
        "completedAt": completed,
        "canceledAt": canceled,
    }))
}

/// Queues a session change for the person's other devices.
fn queue_session(
    db: &Connection,
    effects: &mut Effects,
    principal: &Principal,
    base: Option<&Value>,
    session: &Value,
    created: bool,
    resolves: bool,
) -> Result<()> {
    let id = Uuid::new_v4().to_string();
    let mut captured = session.clone();
    if let Some(fields) = captured.as_object_mut() {
        fields.remove("conflict");
        fields.remove("recipeArchived");
    }
    let change = CookingSessionChange {
        id: id.clone(),
        session_id: session["id"].as_str().ok_or_else(unreadable)?.to_owned(),
        base: base.cloned(),
        progress: progress_of(session),
        session: created.then_some(captured),
        resolves,
    };
    sync::record(db, effects, principal, "cookingSession", &id, &change)
}

fn step_count(session: &Value) -> usize {
    session["recipe"]["steps"].as_array().map_or(0, Vec::len)
}

/// Applies a progress action through the shared domain rules.
fn progress(session: &mut Value, action: Value, now: i64) -> Result<()> {
    let current: CookingProgress = serde_json::from_value(json!({
        "currentStep": session["currentStep"],
        "completedAt": session.get("completedAt").cloned().unwrap_or(Value::Null),
        "canceledAt": session.get("canceledAt").cloned().unwrap_or(Value::Null),
    }))
    .map_err(|_| unreadable())?;
    let action: CookingAction = serde_json::from_value(action).map_err(|_| unreadable())?;
    let next = update_cooking_progress(current, action, step_count(session), now as f64)
        .map_err(Error::invalid)?;
    let next = serde_json::to_value(next)?;
    for key in ["currentStep", "completedAt", "canceledAt"] {
        session[key] = next[key].clone();
    }
    Ok(())
}

fn ended(session: &Value) -> bool {
    ["completedAt", "canceledAt"]
        .into_iter()
        .any(|key| !session[key].is_null())
}

fn store(db: &Connection, session: &Value) -> Result<()> {
    db.execute(
        "UPDATE cooking_sessions SET payload = ?, ended = ? WHERE id = ?",
        params![session.to_string(), ended(session), session["id"].as_str()],
    )?;
    Ok(())
}

fn history_of(db: &Connection, principal: &Principal, recipe_id: &str) -> Result<RecipeHistory> {
    let (count, last): (i64, Option<i64>) = db.query_row(
        "SELECT COUNT(*), MAX(cooked_at) FROM cooking_occurrences WHERE household_id = ? AND recipe_id = ?",
        params![principal.household_id(), recipe_id],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )?;
    Ok(RecipeHistory {
        recipe_id: recipe_id.to_owned(),
        count,
        last_cooked_at: last.unwrap_or(0),
    })
}

/// Inserts an occurrence unless this cooking event is already recorded, by
/// its id or by its session. Returns whether it was new.
fn insert_occurrence(
    db: &Connection,
    household: &str,
    person: &str,
    occurrence: &CookingOccurrence,
) -> Result<bool> {
    let inserted = db.execute(
        "INSERT OR IGNORE INTO cooking_occurrences (id, household_id, recipe_id, person_id, session_id, cooked_at)
         VALUES (?, ?, ?, ?, ?, ?)",
        params![
            occurrence.id,
            household,
            occurrence.recipe_id,
            person,
            occurrence.session_id,
            occurrence.cooked_at
        ],
    )?;
    if inserted == 0 {
        let owner: Option<(String, String)> = db
            .query_row(
                "SELECT household_id, recipe_id FROM cooking_occurrences WHERE id = ?",
                [&occurrence.id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        if let Some((owner, recipe)) = owner {
            if owner != household {
                return Err(outside());
            }
            if recipe != occurrence.recipe_id {
                return Err(Error::conflict(
                    "This cooking record belongs to a different recipe.",
                ));
            }
        }
    }
    Ok(inserted > 0)
}

/// Records the occurrence for `session_id` unless this cooking event is
/// already recorded, and queues it for the household.
fn record_occurrence(
    db: &Connection,
    effects: &mut Effects,
    principal: &Principal,
    id: &str,
    recipe_id: &str,
    session_id: Option<&str>,
    now: i64,
) -> Result<()> {
    let occurrence = CookingOccurrence {
        id: id.to_owned(),
        recipe_id: recipe_id.to_owned(),
        session_id: session_id.map(str::to_owned),
        cooked_at: now,
        person_id: String::new(),
    };
    if insert_occurrence(
        db,
        principal.household_id(),
        principal.person_id(),
        &occurrence,
    )? {
        queue_occurrence(db, effects, principal, &occurrence)?;
        effects.household(principal, Topic::CookingHistory);
    }
    Ok(())
}

/// Recipes kept on this device when it joined never reach the household,
/// and neither does their cooking.
fn queue_occurrence(
    db: &Connection,
    effects: &mut Effects,
    principal: &Principal,
    occurrence: &CookingOccurrence,
) -> Result<()> {
    let held_back: bool = db
        .query_row(
            "SELECT held_back FROM shared_recipes WHERE id = ?",
            [&occurrence.recipe_id],
            |row| row.get(0),
        )
        .optional()?
        .unwrap_or(true);
    if held_back {
        return Ok(());
    }
    sync::record(
        db,
        effects,
        principal,
        "cookingOccurrence",
        &occurrence.id,
        occurrence,
    )
}

/// Queues, when a device joins a household, the cooking of the recipes it
/// contributed, and (when personal records were adopted) the account's
/// unfinished sessions.
pub(crate) fn queue_for_join(
    db: &Connection,
    effects: &mut Effects,
    member: &Principal,
    contributed: &HashSet<String>,
    adopt_personal: bool,
) -> Result<()> {
    let occurrences: Vec<CookingOccurrence> = db
        .prepare(
            "SELECT id, recipe_id, session_id, cooked_at FROM cooking_occurrences
             WHERE household_id = ? ORDER BY cooked_at, id",
        )?
        .query_map([member.household_id()], |row| {
            Ok(CookingOccurrence {
                id: row.get(0)?,
                recipe_id: row.get(1)?,
                session_id: row.get(2)?,
                cooked_at: row.get(3)?,
                person_id: String::new(),
            })
        })?
        .collect::<std::result::Result<_, _>>()?;
    for occurrence in occurrences {
        if contributed.contains(&occurrence.recipe_id) {
            queue_occurrence(db, effects, member, &occurrence)?;
        }
    }
    if adopt_personal {
        let sessions: Vec<String> = db
            .prepare(
                "SELECT payload FROM cooking_sessions WHERE person_id = ? AND ended = 0 ORDER BY rowid",
            )?
            .query_map([member.person_id()], |row| row.get(0))?
            .collect::<std::result::Result<_, _>>()?;
        for payload in sessions {
            let session: Value = serde_json::from_str(&payload)?;
            if contributed.contains(session["recipe"]["id"].as_str().unwrap_or_default()) {
                queue_session(db, effects, member, None, &session, true, false)?;
            }
        }
    }
    Ok(())
}

/// Adopts the account's sessions from the server, except those with changes
/// still waiting here; they are merged on the server first.
pub(crate) fn mirror_sessions(
    db: &Connection,
    person: &Principal,
    snapshot: &Value,
    pending: &HashSet<String>,
    effects: &mut Effects,
) -> Result<()> {
    let mut changed = false;
    let owner = |id: &str| -> Result<Option<(String, String)>> {
        Ok(db
            .query_row(
                "SELECT person_id, payload FROM cooking_sessions WHERE id = ?",
                [id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?)
    };
    for session in snapshot["sessions"].as_array().into_iter().flatten() {
        let Some(id) = session["id"].as_str() else {
            continue;
        };
        if pending.contains(id) || step_count(session) == 0 {
            continue;
        }
        let text = session.to_string();
        match owner(id)? {
            Some((owner, _)) if owner != person.person_id() => continue,
            Some((_, payload)) if payload == text => continue,
            Some(_) => store(db, session)?,
            None => {
                db.execute(
                    "INSERT INTO cooking_sessions (id, person_id, ended, payload) VALUES (?, ?, ?, ?)",
                    params![id, person.person_id(), ended(session), text],
                )?;
            }
        }
        changed = true;
    }
    for summary in snapshot["ended"].as_array().into_iter().flatten() {
        let Some(id) = summary["id"].as_str() else {
            continue;
        };
        if pending.contains(id) {
            continue;
        }
        let Some((owner, payload)) = owner(id)? else {
            continue;
        };
        if owner != person.person_id() {
            continue;
        }
        let mut session: Value = serde_json::from_str(&payload)?;
        let before = session.clone();
        session["completedAt"] = summary["completedAt"].clone();
        session["canceledAt"] = summary["canceledAt"].clone();
        if let Some(fields) = session.as_object_mut() {
            fields.remove("conflict");
        }
        if session != before && ended(&session) {
            store(db, &session)?;
            changed = true;
        }
    }
    if changed {
        effects.person(person, Topic::CookingSessions);
    }
    Ok(())
}

/// Adds the household's occurrences from the server. A local occurrence of
/// the same guided session under another id, already delivered, gives way
/// to the server's so every device counts that cook once.
pub(crate) fn mirror_occurrences(
    db: &Connection,
    household: &Principal,
    remote: &Value,
    pending: &HashSet<String>,
    effects: &mut Effects,
) -> Result<()> {
    let mut changed = false;
    for wire in remote.as_array().into_iter().flatten() {
        let Ok(mut occurrence) = serde_json::from_value::<CookingOccurrence>(json!({
            "id": wire["id"],
            "recipeId": wire["recipeId"],
            "sessionId": wire["sessionId"],
            "cookedAt": wire["cookedAt"],
        })) else {
            continue;
        };
        occurrence.person_id = wire["personId"].as_str().unwrap_or_default().to_owned();
        let known: bool = db.query_row(
            "SELECT EXISTS(SELECT 1 FROM shared_recipes WHERE id = ? AND household_id = ?)",
            params![occurrence.recipe_id, household.household_id()],
            |row| row.get(0),
        )?;
        let exists: bool = db.query_row(
            "SELECT EXISTS(SELECT 1 FROM cooking_occurrences WHERE id = ?)",
            [&occurrence.id],
            |row| row.get(0),
        )?;
        if !known || exists || occurrence.person_id.is_empty() {
            continue;
        }
        if let Some(session) = &occurrence.session_id {
            let local: Option<String> = db
                .query_row(
                    "SELECT id FROM cooking_occurrences WHERE session_id = ?",
                    [session],
                    |row| row.get(0),
                )
                .optional()?;
            match local {
                Some(local) if pending.contains(&local) => continue,
                Some(local) => {
                    db.execute("DELETE FROM cooking_occurrences WHERE id = ?", [local])?;
                }
                None => {}
            }
        }
        db.execute(
            "INSERT OR IGNORE INTO people (id, household_id, kind) VALUES (?, ?, 'account')",
            params![occurrence.person_id, household.household_id()],
        )?;
        let person = occurrence.person_id.clone();
        changed |= insert_occurrence(db, household.household_id(), &person, &occurrence)?;
    }
    if changed {
        effects.household(household, Topic::CookingHistory);
    }
    Ok(())
}

pub(crate) fn household_history(db: &Connection, household: &str) -> Result<Vec<RecipeHistory>> {
    let mut query = db.prepare(
        "SELECT recipe_id, COUNT(*), MAX(cooked_at) FROM cooking_occurrences
         WHERE household_id = ? GROUP BY recipe_id ORDER BY recipe_id",
    )?;
    let rows = query
        .query_map([household], |row| {
            Ok(RecipeHistory {
                recipe_id: row.get(0)?,
                count: row.get(1)?,
                last_cooked_at: row.get(2)?,
            })
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    Ok(rows)
}

impl Core {
    /// Cooking count and last-cooked time for every household recipe that
    /// has been cooked.
    pub fn cooking_history(&self, principal: &Principal) -> Result<Vec<RecipeHistory>> {
        self.read(|db| household_history(db, principal.household_id()))
    }

    /// Records one cooking occurrence of a household recipe outside guided
    /// cooking, and returns the recipe's updated history. No food-log entry is
    /// created and no remaining portions are tracked.
    pub fn mark_cooked(&self, principal: &Principal, input: MarkCooked) -> Result<RecipeHistory> {
        principal.require_personal()?;
        let id = match &input.id {
            Some(id) if Uuid::parse_str(id).is_ok() => id.clone(),
            Some(_) => return Err(Error::invalid("The cooking record id could not be read.")),
            None => Uuid::new_v4().to_string(),
        };
        self.write(|db, effects| {
            let owner: String = db
                .query_row(
                    "SELECT household_id FROM shared_recipes WHERE id = ?",
                    [&input.recipe_id],
                    |row| row.get(0),
                )
                .optional()?
                .ok_or_else(|| Error::not_found("Recipe not found."))?;
            principal.require_household(&owner)?;
            // Only cooking already underway may still record an archived recipe.
            if input.session_id.is_none()
                && recipes::archived_recipes(db, principal.household_id())?
                    .contains_key(&input.recipe_id)
            {
                return Err(Error::not_found("This recipe has been archived."));
            }
            if let Some(session_id) = &input.session_id {
                // The session may already have finished; its recipe must match.
                let recipe: Option<String> = db
                    .query_row(
                        "SELECT json_extract(payload, '$.recipe.id') FROM cooking_sessions
                         WHERE id = ? AND person_id = ?",
                        params![session_id, principal.person_id()],
                        |row| row.get(0),
                    )
                    .optional()?;
                match recipe {
                    Some(recipe) if recipe == input.recipe_id => {}
                    _ => {
                        return Err(Error::not_found(
                            "This cooking session belongs to another recipe or person.",
                        ));
                    }
                }
                let existing: Option<String> = db
                    .query_row(
                        "SELECT id FROM cooking_occurrences WHERE session_id = ?",
                        [session_id],
                        |row| row.get(0),
                    )
                    .optional()?;
                if existing.is_none() {
                    record_occurrence(
                        db,
                        effects,
                        principal,
                        &id,
                        &input.recipe_id,
                        Some(session_id),
                        self.now(),
                    )?;
                }
            } else {
                record_occurrence(
                    db,
                    effects,
                    principal,
                    &id,
                    &input.recipe_id,
                    None,
                    self.now(),
                )?;
            }
            history_of(db, principal, &input.recipe_id)
        })
    }

    /// The person's unfinished cooking sessions.
    pub fn cooking_sessions(&self, principal: &Principal) -> Result<Vec<Value>> {
        principal.require_personal()?;
        self.read(|db| with_archival(db, principal, unfinished(db, principal)?))
    }

    /// Captures the recipe as it is now and starts a session at its first step.
    pub fn start_cooking(
        &self,
        principal: &Principal,
        input: StartCooking,
    ) -> Result<BeginCooking> {
        principal.require_personal()?;
        let units: DisplayUnits = match &input.display_units {
            Some(units) => serde_json::from_value(Value::String(units.clone()))
                .map_err(|_| Error::invalid("Choose metric, US, or original units."))?,
            None => DisplayUnits::Original,
        };
        self.write(|db, effects| {
            let view = recipes::current_recipe(db, principal.household_id(), &input.recipe_id)?
                .ok_or_else(|| {
                    Error::not_found("This recipe is no longer available for cooking.")
                })?;
            let draft: RecipeDraft =
                serde_json::from_value(view.recipe.clone()).map_err(|_| unreadable())?;
            let recipe = validate_recipe(draft).map_err(|_| unreadable())?;
            calculate_recipe(&recipe, input.portions, units).map_err(Error::invalid)?;
            let existing = unfinished(db, principal)?;
            let mut named = input.cancel_session_ids.clone();
            named.sort();
            let mut found: Vec<String> = existing
                .iter()
                .filter_map(|session| session["id"].as_str().map(str::to_owned))
                .collect();
            found.sort();
            if !existing.is_empty() && named != found {
                return Ok(BeginCooking {
                    session: None,
                    conflicts: with_archival(db, principal, existing)?,
                });
            }
            for mut previous in existing {
                let base = progress_of(&previous);
                // An ended session awaiting a decision keeps how it ended.
                let resolves = previous.get("conflict").is_some();
                if let Some(fields) = previous.as_object_mut() {
                    fields.remove("conflict");
                }
                if !ended(&previous) {
                    progress(&mut previous, json!({"type": "cancel"}), self.now())?;
                }
                store(db, &previous)?;
                queue_session(
                    db,
                    effects,
                    principal,
                    Some(&base),
                    &previous,
                    false,
                    resolves,
                )?;
            }
            let session = json!({
                "id": Uuid::new_v4().to_string(),
                "recipe": view.recipe,
                "portions": input.portions,
                "displayUnits": input.display_units,
                "currentStep": 0,
                "completedAt": null,
                "canceledAt": null,
                "timers": {},
            });
            db.execute(
                "INSERT INTO cooking_sessions (id, person_id, ended, payload) VALUES (?, ?, 0, ?)",
                params![
                    session["id"].as_str(),
                    principal.person_id(),
                    session.to_string()
                ],
            )?;
            queue_session(db, effects, principal, None, &session, true, false)?;
            effects.person(principal, Topic::CookingSessions);
            Ok(BeginCooking {
                session: Some(session),
                conflicts: vec![],
            })
        })
    }

    /// Records the current step and the step timers.
    pub fn save_cooking_progress(
        &self,
        principal: &Principal,
        session_id: &str,
        step: usize,
        timers: Value,
    ) -> Result<Value> {
        principal.require_personal()?;
        self.write(|db, effects| {
            let mut session = find_unfinished(db, principal, session_id)?;
            let now = self.now();
            check_timers(&session, &timers, now)?;
            let base = progress_of(&session);
            progress(&mut session, json!({"type": "step", "step": step}), now)?;
            session["timers"] = timers;
            store(db, &session)?;
            if progress_of(&session) != base {
                queue_session(db, effects, principal, Some(&base), &session, false, false)?;
            }
            effects.person(principal, Topic::CookingSessions);
            Ok(with_archival(db, principal, vec![session])?.remove(0))
        })
    }

    /// Finishes (only from the last step) or cancels the session.
    pub fn end_cooking(
        &self,
        principal: &Principal,
        session_id: &str,
        outcome: CookingOutcome,
    ) -> Result<()> {
        principal.require_personal()?;
        self.write(|db, effects| {
            let mut session = match find_unfinished(db, principal, session_id) {
                Ok(session) => session,
                // Retrying a completion that already committed is accepted
                // and counts nothing more.
                Err(error) if outcome == CookingOutcome::Finished => {
                    return if finished_by(db, principal, session_id)? {
                        Ok(())
                    } else {
                        Err(error)
                    };
                }
                Err(error) => return Err(error),
            };
            let action = match outcome {
                CookingOutcome::Finished => json!({"type": "finish"}),
                CookingOutcome::Canceled => json!({"type": "cancel"}),
            };
            let base = progress_of(&session);
            progress(&mut session, action, self.now())?;
            store(db, &session)?;
            queue_session(db, effects, principal, Some(&base), &session, false, false)?;
            if outcome == CookingOutcome::Finished {
                let recipe = session["recipe"]["id"].as_str().ok_or_else(unreadable)?;
                record_occurrence(
                    db,
                    effects,
                    principal,
                    &Uuid::new_v4().to_string(),
                    recipe,
                    Some(session_id),
                    self.now(),
                )?;
            }
            effects.person(principal, Topic::CookingSessions);
            Ok(())
        })
    }
}

impl Core {
    /// Keeps one of a session's competing progress changes. Choosing an
    /// unfinished progress over a finished one is the only way a session
    /// continues after finishing; its cook is still counted once.
    pub fn resolve_cooking_session(
        &self,
        principal: &Principal,
        session_id: &str,
        keep: CookingChoice,
    ) -> Result<Value> {
        principal.require_personal()?;
        self.write(|db, effects| {
            let mut session = unfinished(db, principal)?
                .into_iter()
                .find(|session| session["id"] == session_id)
                .ok_or_else(|| {
                    Error::not_found("This cooking session has ended or belongs to another person.")
                })?;
            let Some(conflict) = session.get("conflict").cloned() else {
                return Err(Error::conflict(
                    "This cooking session has nothing left to decide.",
                ));
            };
            let base = progress_of(&session);
            let chosen = match keep {
                CookingChoice::Current => base.clone(),
                CookingChoice::Alternative => progress_of(&conflict["progress"]),
            };
            check_progress(&session, &chosen, self.now())?;
            set_progress(&mut session, &chosen);
            if let Some(fields) = session.as_object_mut() {
                fields.remove("conflict");
            }
            store(db, &session)?;
            queue_session(db, effects, principal, Some(&base), &session, false, true)?;
            if !chosen["completedAt"].is_null() {
                let recipe = session["recipe"]["id"].as_str().ok_or_else(unreadable)?;
                let recorded: bool = db.query_row(
                    "SELECT EXISTS(SELECT 1 FROM cooking_occurrences WHERE session_id = ?)",
                    [session_id],
                    |row| row.get(0),
                )?;
                if !recorded {
                    record_occurrence(
                        db,
                        effects,
                        principal,
                        &Uuid::new_v4().to_string(),
                        recipe,
                        Some(session_id),
                        self.now(),
                    )?;
                }
            }
            effects.person(principal, Topic::CookingSessions);
            Ok(with_archival(db, principal, vec![session])?.remove(0))
        })
    }

    /// Server side of synchronization: the account's sessions that still ask
    /// for it, in full, and how every other session of the account ended.
    pub fn cooking_session_snapshot(&self, principal: &Principal) -> Result<Value> {
        principal.require_personal()?;
        self.read(|db| {
            let sessions = unfinished(db, principal)?;
            let ended: Vec<Value> = db
                .prepare(&format!(
                    "SELECT id, json_extract(payload, '$.completedAt'), json_extract(payload, '$.canceledAt')
                     FROM cooking_sessions WHERE person_id = ? AND NOT {OPEN} ORDER BY rowid"
                ))?
                .query_map([principal.person_id()], |row| {
                    Ok(json!({
                        "id": row.get::<_, String>(0)?,
                        "completedAt": row.get::<_, Option<f64>>(1)?,
                        "canceledAt": row.get::<_, Option<f64>>(2)?,
                    }))
                })?
                .collect::<std::result::Result<_, _>>()?;
            Ok(json!({ "sessions": sessions, "ended": ended }))
        })
    }

    /// Server side of synchronization: merges a device's queued session
    /// changes into the authenticated account's own sessions. A session of
    /// another person is refused whatever the request says.
    pub fn apply_cooking_session_changes(
        &self,
        principal: &Principal,
        changes: Vec<CookingSessionChange>,
    ) -> Result<()> {
        principal.require_personal()?;
        let now = self.now();
        self.write(|db, effects| {
            for change in changes {
                if Uuid::parse_str(&change.id).is_err() {
                    return Err(Error::invalid("The cooking change id could not be read."));
                }
                let applied: Option<String> = db
                    .query_row(
                        "SELECT person_id FROM cooking_session_mutations WHERE id = ?",
                        [&change.id],
                        |row| row.get(0),
                    )
                    .optional()?;
                if let Some(owner) = applied {
                    principal.require_person(&owner)?;
                    continue;
                }
                let stored: Option<(String, String)> = db
                    .query_row(
                        "SELECT person_id, payload FROM cooking_sessions WHERE id = ?",
                        [&change.session_id],
                        |row| Ok((row.get(0)?, row.get(1)?)),
                    )
                    .optional()?;
                let theirs = progress_of(&change.progress);
                match stored {
                    Some((owner, _)) if owner != principal.person_id() => return Err(outside()),
                    Some((_, payload)) => {
                        let mut session: Value = serde_json::from_str(&payload)?;
                        check_progress(&session, &theirs, now)?;
                        let ours = progress_of(&session);
                        let base = match &change.base {
                            Some(base) => progress_of(base),
                            None => theirs.clone(),
                        };
                        match merge_progress(&base, &ours, &theirs) {
                            Some(merged) => {
                                set_progress(&mut session, &merged);
                                if change.resolves
                                    && let Some(fields) = session.as_object_mut()
                                {
                                    fields.remove("conflict");
                                }
                            }
                            None => {
                                session["conflict"] = json!({
                                    "id": change.id,
                                    "progress": theirs,
                                });
                            }
                        }
                        store(db, &session)?;
                    }
                    None => {
                        // Only the change that started a session carries
                        // what it captured; anything else has nothing to apply to.
                        let Some(mut session) = change.session else {
                            continue;
                        };
                        if session["id"] != change.session_id.as_str() || !session.is_object() {
                            return Err(Error::invalid("This cooking session could not be read."));
                        }
                        let draft: RecipeDraft = serde_json::from_value(session["recipe"].clone())
                            .map_err(|_| Error::invalid("This cooking session could not be read."))?;
                        validate_recipe(draft)
                            .map_err(|_| Error::invalid("This cooking session could not be read."))?;
                        check_progress(&session, &theirs, now)?;
                        set_progress(&mut session, &theirs);
                        if let Some(fields) = session.as_object_mut() {
                            fields.remove("conflict");
                            fields.remove("recipeArchived");
                        }
                        db.execute(
                            "INSERT INTO cooking_sessions (id, person_id, ended, payload) VALUES (?, ?, ?, ?)",
                            params![
                                change.session_id,
                                principal.person_id(),
                                ended(&session),
                                session.to_string()
                            ],
                        )?;
                    }
                }
                db.execute(
                    "INSERT INTO cooking_session_mutations (id, person_id) VALUES (?, ?)",
                    params![change.id, principal.person_id()],
                )?;
            }
            effects.person(principal, Topic::CookingSessions);
            Ok(())
        })
    }

    /// Server side of synchronization: every household cooking occurrence.
    pub fn cooking_occurrences(&self, principal: &Principal) -> Result<Vec<CookingOccurrence>> {
        self.read(|db| {
            Ok(db
                .prepare(
                    "SELECT id, recipe_id, session_id, cooked_at, person_id FROM cooking_occurrences
                     WHERE household_id = ? ORDER BY cooked_at, id",
                )?
                .query_map([principal.household_id()], |row| {
                    Ok(CookingOccurrence {
                        id: row.get(0)?,
                        recipe_id: row.get(1)?,
                        session_id: row.get(2)?,
                        cooked_at: row.get(3)?,
                        person_id: row.get(4)?,
                    })
                })?
                .collect::<std::result::Result<_, _>>()?)
        })
    }

    /// Server side of synchronization: records a device's occurrences for
    /// the household, each once by its id and once per guided session,
    /// however often it is delivered.
    pub fn apply_cooking_occurrences(
        &self,
        principal: &Principal,
        occurrences: Vec<CookingOccurrence>,
    ) -> Result<()> {
        principal.require_personal()?;
        self.write(|db, effects| {
            for occurrence in occurrences {
                if Uuid::parse_str(&occurrence.id).is_err() || occurrence.cooked_at <= 0 {
                    return Err(Error::invalid("The cooking record could not be read."));
                }
                let owner: String = db
                    .query_row(
                        "SELECT household_id FROM shared_recipes WHERE id = ?",
                        [&occurrence.recipe_id],
                        |row| row.get(0),
                    )
                    .optional()?
                    .ok_or_else(|| Error::not_found("Recipe not found."))?;
                principal.require_household(&owner)?;
                if let Some(session) = &occurrence.session_id {
                    let cook: Option<String> = db
                        .query_row(
                            "SELECT person_id FROM cooking_sessions WHERE id = ?",
                            [session],
                            |row| row.get(0),
                        )
                        .optional()?;
                    if cook.is_some_and(|cook| cook != principal.person_id()) {
                        return Err(outside());
                    }
                }
                if insert_occurrence(
                    db,
                    principal.household_id(),
                    principal.person_id(),
                    &occurrence,
                )? {
                    effects.household(principal, Topic::CookingHistory);
                }
            }
            Ok(())
        })
    }
}

/// Whether this person's session already ended as finished.
fn finished_by(db: &Connection, principal: &Principal, session_id: &str) -> Result<bool> {
    let completed: Option<bool> = db
        .query_row(
            "SELECT json_extract(payload, '$.completedAt') IS NOT NULL FROM cooking_sessions
             WHERE id = ? AND person_id = ? AND ended = 1",
            params![session_id, principal.person_id()],
            |row| row.get(0),
        )
        .optional()?;
    Ok(completed.unwrap_or(false))
}
