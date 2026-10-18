//! A person's AI preferences. These are ordinary settings that synchronize
//! like other personal data; credentials and tokens are runtime secrets that
//! never pass through this module.

use crate::{
    Core,
    changes::{Effects, Topic},
    error::{Error, Result},
    principal::Principal,
    sync,
};
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::HashSet;
use uuid::Uuid;

const RECIPE_PROMPT: &str = "recipePrompt";
const RECIPE_MODEL: &str = "recipeModel";
const DEFAULT_RECIPE_PROMPT: &str =
    "Use English and metric quantities. Prefer practical home cooking.";
const MAX_PROMPT_CHARS: usize = 8000;
const MAX_MODEL_CHARS: usize = 200;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiPreferences {
    pub recipe_prompt: String,
    /// The model the person last chose for recipe generation, if any.
    pub recipe_model: Option<String>,
}

/// One synchronized preference change. Unknown keys are refused.
#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct PreferenceChange {
    pub id: String,
    pub key: String,
    pub value: Option<String>,
}

fn validate(key: &str, value: Option<&str>) -> Result<()> {
    match (key, value) {
        (RECIPE_PROMPT, Some(prompt)) if prompt.chars().count() <= MAX_PROMPT_CHARS => Ok(()),
        (RECIPE_PROMPT, _) => Err(Error::invalid(format!(
            "Use a recipe prompt of up to {MAX_PROMPT_CHARS} characters."
        ))),
        (RECIPE_MODEL, None) => Ok(()),
        (RECIPE_MODEL, Some(model))
            if !model.trim().is_empty() && model.chars().count() <= MAX_MODEL_CHARS =>
        {
            Ok(())
        }
        (RECIPE_MODEL, _) => Err(Error::invalid("Choose a valid ChatGPT model.")),
        _ => Err(Error::invalid("This app does not know that preference.")),
    }
}

fn stored(db: &Connection, person: &str, key: &str) -> Result<Option<String>> {
    Ok(db
        .query_row(
            "SELECT value FROM person_settings WHERE person_id = ? AND key = ?",
            params![person, key],
            |row| row.get(0),
        )
        .optional()?)
}

fn put(db: &Connection, person: &str, key: &str, value: Option<&str>) -> Result<()> {
    match value {
        Some(value) => db.execute(
            "INSERT INTO person_settings (person_id, key, value) VALUES (?, ?, ?) ON CONFLICT(person_id, key) DO UPDATE SET value = excluded.value",
            params![person, key, value],
        )?,
        None => db.execute(
            "DELETE FROM person_settings WHERE person_id = ? AND key = ?",
            params![person, key],
        )?,
    };
    Ok(())
}

/// Queues the person's current settings for delivery, used when adopted
/// personal records become an account's.
pub(crate) fn queue_all(
    db: &Connection,
    effects: &mut Effects,
    principal: &Principal,
) -> Result<()> {
    for key in [RECIPE_PROMPT, RECIPE_MODEL] {
        if let Some(value) = stored(db, principal.person_id(), key)? {
            let id = Uuid::new_v4().to_string();
            sync::record(
                db,
                effects,
                principal,
                "preference",
                &id,
                &json!({"id": id, "key": key, "value": value}),
            )?;
        }
    }
    Ok(())
}

/// Adopts the server's preferences unless changes are still waiting.
pub(crate) fn mirror(
    db: &Connection,
    person: &Principal,
    remote: &Value,
    pending: &HashSet<String>,
    effects: &mut Effects,
) -> Result<()> {
    for key in [RECIPE_PROMPT, RECIPE_MODEL] {
        if pending.contains(key) {
            continue;
        }
        if let Some(value) = remote[key].as_str()
            && validate(key, Some(value)).is_ok()
        {
            put(db, person.person_id(), key, Some(value))?;
        }
    }
    effects.person(person, Topic::Preferences);
    Ok(())
}

impl Core {
    pub fn ai_preferences(&self, principal: &Principal) -> Result<AiPreferences> {
        principal.require_personal()?;
        self.read(|db| {
            Ok(AiPreferences {
                recipe_prompt: stored(db, principal.person_id(), RECIPE_PROMPT)?
                    .unwrap_or_else(|| DEFAULT_RECIPE_PROMPT.to_owned()),
                recipe_model: stored(db, principal.person_id(), RECIPE_MODEL)?,
            })
        })
    }

    /// What is stored, without defaults, for synchronization.
    pub fn stored_ai_preferences(&self, principal: &Principal) -> Result<Value> {
        principal.require_personal()?;
        self.read(|db| {
            Ok(json!({
                RECIPE_PROMPT: stored(db, principal.person_id(), RECIPE_PROMPT)?,
                RECIPE_MODEL: stored(db, principal.person_id(), RECIPE_MODEL)?,
            }))
        })
    }

    fn change_preference(
        &self,
        principal: &Principal,
        key: &str,
        value: Option<&str>,
    ) -> Result<AiPreferences> {
        principal.require_personal()?;
        validate(key, value)?;
        self.write(|db, effects| {
            put(db, principal.person_id(), key, value)?;
            let id = Uuid::new_v4().to_string();
            sync::record(
                db,
                effects,
                principal,
                "preference",
                &id,
                &json!({"id": id, "key": key, "value": value}),
            )?;
            effects.person(principal, Topic::Preferences);
            Ok(())
        })?;
        self.ai_preferences(principal)
    }

    pub fn set_recipe_prompt(&self, principal: &Principal, prompt: &str) -> Result<AiPreferences> {
        self.change_preference(principal, RECIPE_PROMPT, Some(prompt))
    }

    pub fn set_recipe_model(
        &self,
        principal: &Principal,
        model: Option<&str>,
    ) -> Result<AiPreferences> {
        self.change_preference(principal, RECIPE_MODEL, model)
    }

    /// Server side of synchronization: applies a device's queued changes to
    /// the authenticated account's own preferences.
    pub fn apply_preference_changes(
        &self,
        principal: &Principal,
        changes: Vec<PreferenceChange>,
    ) -> Result<()> {
        principal.require_personal()?;
        for change in &changes {
            validate(&change.key, change.value.as_deref())?;
        }
        self.write(|db, effects| {
            for change in &changes {
                put(
                    db,
                    principal.person_id(),
                    &change.key,
                    change.value.as_deref(),
                )?;
            }
            effects.person(principal, Topic::Preferences);
            Ok(())
        })
    }
}
