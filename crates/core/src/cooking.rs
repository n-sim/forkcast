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
use rusqlite::{Connection, params};
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

impl Core {
    /// The person's unfinished cooking sessions.
    pub fn cooking_sessions(&self, principal: &Principal) -> Result<Vec<Value>> {
        self.read(|db| unfinished(db, principal))
    }

    /// Captures the recipe as it is now and starts a session at its first step.
    pub fn start_cooking(
        &self,
        principal: &Principal,
        input: StartCooking,
    ) -> Result<BeginCooking> {
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
                    conflicts: existing,
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
            Ok(session)
        })
    }

    /// Finishes (only from the last step) or cancels the session.
    pub fn end_cooking(
        &self,
        principal: &Principal,
        session_id: &str,
        outcome: CookingOutcome,
    ) -> Result<()> {
        self.write(|db, effects| {
            let mut session = find_unfinished(db, principal, session_id)?;
            let action = match outcome {
                CookingOutcome::Finished => json!({"type": "finish"}),
                CookingOutcome::Canceled => json!({"type": "cancel"}),
            };
            progress(&mut session, action, self.now())?;
            store(db, &session)?;
            effects.person(principal, Topic::CookingSessions);
            Ok(())
        })
    }
}
