//! A person's AI preferences. These are ordinary settings; credentials and
//! tokens are runtime secrets that never pass through this module.

use crate::{
    Core,
    changes::Topic,
    error::{Error, Result},
    principal::Principal,
};
use rusqlite::{OptionalExtension, params};
use serde::Serialize;

const RECIPE_PROMPT: &str = "recipePrompt";
const DEFAULT_RECIPE_PROMPT: &str =
    "Use English and metric quantities. Prefer practical home cooking.";
const MAX_PROMPT_CHARS: usize = 8000;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiPreferences {
    pub recipe_prompt: String,
}

impl Core {
    pub fn ai_preferences(&self, principal: &Principal) -> Result<AiPreferences> {
        self.read(|db| {
            let stored: Option<String> = db
                .query_row(
                    "SELECT value FROM person_settings WHERE person_id = ? AND key = ?",
                    params![principal.person_id(), RECIPE_PROMPT],
                    |row| row.get(0),
                )
                .optional()?;
            Ok(AiPreferences {
                recipe_prompt: stored.unwrap_or_else(|| DEFAULT_RECIPE_PROMPT.to_owned()),
            })
        })
    }

    pub fn set_recipe_prompt(&self, principal: &Principal, prompt: &str) -> Result<AiPreferences> {
        if prompt.chars().count() > MAX_PROMPT_CHARS {
            return Err(Error::invalid(format!(
                "Use a recipe prompt of up to {MAX_PROMPT_CHARS} characters."
            )));
        }
        self.write(|db, effects| {
            db.execute(
                "INSERT INTO person_settings (person_id, key, value) VALUES (?, ?, ?) ON CONFLICT(person_id, key) DO UPDATE SET value = excluded.value",
                params![principal.person_id(), RECIPE_PROMPT, prompt],
            )?;
            effects.person(principal, Topic::Preferences);
            Ok(AiPreferences {
                recipe_prompt: prompt.to_owned(),
            })
        })
    }
}
