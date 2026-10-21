//! Cooking sessions: a person's resumable, guided preparation of a recipe as
//! captured when cooking started.

use crate::{
    Core,
    changes::Topic,
    error::{Error, Result},
    principal::Principal,
    recipes,
};
use forkcast_recipe_domain::{
    cooking::{CookingAction, CookingProgress, StepTimer, update_cooking_progress},
    quantities::{DisplayUnits, calculate_recipe},
    recipe::{RecipeDraft, validate_recipe},
};
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
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

fn unreadable() -> Error {
    Error::internal()
}

fn unfinished(db: &Connection, principal: &Principal) -> Result<Vec<Value>> {
    let mut query = db.prepare(
        "SELECT payload FROM cooking_sessions WHERE person_id = ? AND ended = 0 ORDER BY rowid",
    )?;
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
        .find(|session| session["id"] == id)
        .ok_or_else(|| {
            Error::not_found("This cooking session has ended or belongs to another person.")
        })
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

/// Records the occurrence for `session_id` unless this cooking event is
/// already recorded, by its id or by its session.
fn record_occurrence(
    db: &Connection,
    effects: &mut crate::changes::Effects,
    principal: &Principal,
    id: &str,
    recipe_id: &str,
    session_id: Option<&str>,
    now: i64,
) -> Result<()> {
    let inserted = db.execute(
        "INSERT OR IGNORE INTO cooking_occurrences (id, household_id, recipe_id, person_id, session_id, cooked_at)
         VALUES (?, ?, ?, ?, ?, ?)",
        params![
            id,
            principal.household_id(),
            recipe_id,
            principal.person_id(),
            session_id,
            now
        ],
    )?;
    if inserted == 0 {
        let owner: Option<(String, String)> = db
            .query_row(
                "SELECT household_id, recipe_id FROM cooking_occurrences WHERE id = ?",
                [id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        if let Some((household, recipe)) = owner {
            principal.require_household(&household)?;
            if recipe != recipe_id {
                return Err(Error::conflict(
                    "This cooking record belongs to a different recipe.",
                ));
            }
        }
        return Ok(());
    }
    effects.household(principal, Topic::CookingHistory);
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
                progress(&mut previous, json!({"type": "cancel"}), self.now())?;
                store(db, &previous)?;
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
            let steps: Vec<&str> = session["recipe"]["steps"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|step| step["id"].as_str())
                .collect();
            let now = self.now();
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
            progress(&mut session, json!({"type": "step", "step": step}), now)?;
            session["timers"] = timers;
            store(db, &session)?;
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
            progress(&mut session, action, self.now())?;
            store(db, &session)?;
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
