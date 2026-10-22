//! A person's food log: recipe-linked entries that reference a retained
//! nutrition version, and manual entries with their own nutrition.

use crate::{
    Core,
    changes::{Effects, Topic},
    error::{Error, Result},
    principal::Principal,
    recipes,
};
use forkcast_recipe_domain::{
    calendar::valid_date,
    food_log::{
        DailyFoodLog, ManualFoodLogEntry, RecipeFoodLogEntry, daily_food_log,
        validate_manual_entry, validate_recipe_entry,
    },
    nutrition::{Nutrition, NutritionVersion},
    nutrition_goals::{NutritionGoals, applicable_goals, validate_goals},
};
use rusqlite::{Connection, OptionalExtension, params};
use serde::Deserialize;
use serde_json::Value;
use uuid::Uuid;

const DATE_KEY: &str = "foodLogDate";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LogRecipeFood {
    /// Supply an identity to make a retried request harmless.
    pub id: Option<String>,
    pub recipe_id: String,
    pub nutrition_version_id: String,
    /// Local calendar date and time, `YYYY-MM-DDTHH:MM`.
    pub consumed_at: String,
    pub portions: Option<f64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LogManualFood {
    pub id: Option<String>,
    pub description: String,
    pub consumed_at: String,
    pub nutrition: Nutrition,
}

fn field_errors(errors: impl serde::Serialize) -> Error {
    Error::invalid("Check the food-log entry before saving.")
        .with_fields(serde_json::to_value(errors).unwrap_or(Value::Null))
}

fn remember_date(db: &Connection, principal: &Principal, consumed_at: &str) -> Result<()> {
    set_date(db, principal, &consumed_at[..10])
}

fn set_date(db: &Connection, principal: &Principal, date: &str) -> Result<()> {
    db.execute(
        "INSERT INTO person_settings (person_id, key, value) VALUES (?, ?, ?) ON CONFLICT(person_id, key) DO UPDATE SET value = excluded.value",
        params![principal.person_id(), DATE_KEY, date],
    )?;
    Ok(())
}

/// Whether an identical entry is already stored, making this a harmless retry.
fn already_stored(
    db: &Connection,
    principal: &Principal,
    table: &str,
    id: &str,
    payload: &str,
) -> Result<bool> {
    let existing: Option<(String, String)> = db
        .query_row(
            &format!("SELECT person_id, payload FROM {table} WHERE id = ?"),
            [id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    match existing {
        None => Ok(false),
        Some((owner, previous)) => {
            principal.require_person(&owner)?;
            if previous == payload {
                Ok(true)
            } else {
                Err(Error::conflict("This food-log entry already exists."))
            }
        }
    }
}

fn versions(db: &Connection, ids: &[String]) -> Result<Vec<NutritionVersion>> {
    ids.iter()
        .filter_map(|id| {
            db.query_row(
                "SELECT payload FROM nutrition_versions WHERE id = ?",
                [id],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(Error::from)
            .transpose()
        })
        .map(|payload| Ok(serde_json::from_str(&payload?)?))
        .collect()
}

fn entries<T: serde::de::DeserializeOwned>(
    db: &Connection,
    principal: &Principal,
    table: &str,
    date: &str,
) -> Result<Vec<T>> {
    let mut query = db.prepare(&format!(
        "SELECT payload FROM {table} WHERE person_id = ? AND consumed_on = ? ORDER BY rowid"
    ))?;
    let payloads = query
        .query_map(params![principal.person_id(), date], |row| {
            row.get::<_, String>(0)
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    payloads
        .iter()
        .map(|payload| Ok(serde_json::from_str(payload)?))
        .collect()
}

fn goals(db: &Connection, principal: &Principal) -> Result<Vec<NutritionGoals>> {
    let mut query = db.prepare(
        "SELECT payload FROM nutrition_goals WHERE person_id = ? ORDER BY effective_from DESC",
    )?;
    let payloads = query
        .query_map([principal.person_id()], |row| row.get::<_, String>(0))?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    payloads
        .iter()
        .map(|payload| Ok(serde_json::from_str(payload)?))
        .collect()
}

impl Core {
    /// The day's entries and nutrition totals, computed by the shared domain
    /// rules from the nutrition versions each entry retained.
    pub fn food_log(&self, principal: &Principal, date: &str) -> Result<DailyFoodLog> {
        principal.require_personal()?;
        if !valid_date(date) {
            return Err(Error::invalid("Choose a valid food log date."));
        }
        self.read(|db| {
            let manual: Vec<ManualFoodLogEntry> =
                entries(db, principal, "manual_food_log_entries", date)?;
            let recipe: Vec<RecipeFoodLogEntry> =
                entries(db, principal, "recipe_food_log_entries", date)?;
            let ids: Vec<String> = recipe
                .iter()
                .map(|entry| entry.nutrition_version_id.clone())
                .collect();
            let history = goals(db, principal)?;
            let mut log = daily_food_log(manual, recipe, versions(db, &ids)?, date)
                .map_err(Error::invalid)?
                .with_goals(applicable_goals(&history, date));
            // Entries keep their retained nutrition; an archived recipe is
            // named but no longer reachable from them.
            let archived = recipes::archived_recipes(db, principal.household_id())?;
            for entry in &mut log.entries {
                entry.recipe_archived = entry
                    .recipe_id
                    .as_ref()
                    .is_some_and(|recipe| archived.contains_key(recipe));
            }
            Ok(log)
        })
    }

    /// Every goal set the person has kept, newest effective date first.
    pub fn nutrition_goals(&self, principal: &Principal) -> Result<Vec<NutritionGoals>> {
        principal.require_personal()?;
        self.read(|db| goals(db, principal))
    }

    /// Sets the goals that apply from their effective date until the next
    /// set. Setting goals again for the same date replaces that set only;
    /// earlier days keep the goals that applied to them.
    pub fn set_nutrition_goals(&self, principal: &Principal, input: NutritionGoals) -> Result<()> {
        principal.require_personal()?;
        let goals = validate_goals(input).map_err(|errors| {
            Error::invalid("Check the nutrition goals before saving.")
                .with_fields(serde_json::to_value(errors).unwrap_or(Value::Null))
        })?;
        self.write(|db, effects| {
            db.execute(
                "INSERT INTO nutrition_goals (person_id, effective_from, payload) VALUES (?, ?, ?) ON CONFLICT(person_id, effective_from) DO UPDATE SET payload = excluded.payload",
                params![
                    principal.person_id(),
                    goals.effective_from,
                    serde_json::to_string(&goals)?
                ],
            )?;
            effects.person(principal, Topic::FoodLog);
            Ok(())
        })
    }

    /// Removes the goal set starting on `effective_from`; the previous set,
    /// if any, then applies until the next one.
    pub fn remove_nutrition_goals(
        &self,
        principal: &Principal,
        effective_from: &str,
    ) -> Result<()> {
        principal.require_personal()?;
        self.write(|db, effects| {
            let removed = db.execute(
                "DELETE FROM nutrition_goals WHERE person_id = ? AND effective_from = ?",
                params![principal.person_id(), effective_from],
            )?;
            if removed == 0 {
                return Err(Error::not_found("These nutrition goals no longer exist."));
            }
            effects.person(principal, Topic::FoodLog);
            Ok(())
        })
    }

    pub fn food_log_date(&self, principal: &Principal) -> Result<Option<String>> {
        principal.require_personal()?;
        self.read(|db| {
            Ok(db
                .query_row(
                    "SELECT value FROM person_settings WHERE person_id = ? AND key = ?",
                    params![principal.person_id(), DATE_KEY],
                    |row| row.get(0),
                )
                .optional()?)
        })
    }

    pub fn set_food_log_date(&self, principal: &Principal, date: &str) -> Result<()> {
        principal.require_personal()?;
        if !valid_date(date) {
            return Err(Error::invalid("Choose a valid food log date."));
        }
        self.write(|db, effects| {
            set_date(db, principal, date)?;
            effects.person(principal, Topic::FoodLog);
            Ok(())
        })
    }

    /// Logs portions of a household recipe against one of its retained
    /// nutrition versions; later recipe edits never change the entry.
    pub fn log_recipe_food(&self, principal: &Principal, input: LogRecipeFood) -> Result<()> {
        principal.require_personal()?;
        self.write(|db, effects| {
            let view = recipes::current_recipe(db, principal.household_id(), &input.recipe_id)?
                .ok_or_else(|| {
                    Error::not_found("This recipe is no longer available for logging.")
                })?;
            let entry = validate_recipe_entry(RecipeFoodLogEntry {
                id: input.id.unwrap_or_else(|| Uuid::new_v4().to_string()),
                recipe_id: input.recipe_id,
                recipe_name: view.recipe["name"].as_str().unwrap_or_default().to_owned(),
                nutrition_version_id: input.nutrition_version_id,
                consumed_at: input.consumed_at,
                portions: input.portions,
            })
            .map_err(field_errors)?;
            // Resolve through the shared calculation before saving, including
            // range checks and the version's relationship to this recipe.
            let probe: RecipeFoodLogEntry = serde_json::from_value(serde_json::to_value(&entry)?)?;
            daily_food_log(
                vec![],
                vec![probe],
                versions(db, std::slice::from_ref(&entry.nutrition_version_id))?,
                &entry.consumed_at[..10],
            )
            .map_err(Error::invalid)?;
            save(db, principal, effects, &entry)
        })
    }

    /// Points one recipe entry at its recipe's current nutrition version, at
    /// the person's explicit request. Other entries keep their references.
    /// Returns whether the entry changed; an entry already on the current
    /// version is left as it is.
    pub fn use_current_food_nutrition(
        &self,
        principal: &Principal,
        entry_id: &str,
    ) -> Result<bool> {
        principal.require_personal()?;
        self.write(|db, effects| {
            let stored: Option<(String, String)> = db
                .query_row(
                    "SELECT person_id, payload FROM recipe_food_log_entries WHERE id = ?",
                    [entry_id],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .optional()?;
            let (owner, payload) =
                stored.ok_or_else(|| Error::not_found("This food-log entry no longer exists."))?;
            principal.require_person(&owner)?;
            let mut entry: RecipeFoodLogEntry = serde_json::from_str(&payload)?;
            let view = recipes::current_recipe(db, principal.household_id(), &entry.recipe_id)?
                .ok_or_else(|| {
                    Error::not_found("This recipe is no longer available, so the entry keeps its nutrition.")
                })?;
            let current = view.recipe["nutritionVersionId"]
                .as_str()
                .ok_or_else(Error::internal)?
                .to_owned();
            if entry.nutrition_version_id == current {
                return Ok(false);
            }
            entry.nutrition_version_id = current;
            // The shared calculation must accept the new reference.
            let probe: RecipeFoodLogEntry = serde_json::from_str(&serde_json::to_string(&entry)?)?;
            daily_food_log(
                vec![],
                vec![probe],
                versions(db, std::slice::from_ref(&entry.nutrition_version_id))?,
                &entry.consumed_at[..10],
            )
            .map_err(Error::invalid)?;
            db.execute(
                "UPDATE recipe_food_log_entries SET nutrition_version_id = ?, payload = ? WHERE id = ?",
                params![entry.nutrition_version_id, serde_json::to_string(&entry)?, entry.id],
            )?;
            effects.person(principal, Topic::FoodLog);
            Ok(true)
        })
    }

    pub fn log_manual_food(&self, principal: &Principal, input: LogManualFood) -> Result<()> {
        principal.require_personal()?;
        let entry = validate_manual_entry(ManualFoodLogEntry {
            id: input.id.unwrap_or_else(|| Uuid::new_v4().to_string()),
            description: input.description,
            consumed_at: input.consumed_at,
            nutrition: input.nutrition,
        })
        .map_err(field_errors)?;
        self.write(|db, effects| {
            let payload = serde_json::to_string(&entry)?;
            if !already_stored(db, principal, "manual_food_log_entries", &entry.id, &payload)? {
                db.execute(
                    "INSERT INTO manual_food_log_entries (id, person_id, consumed_on, payload) VALUES (?, ?, ?, ?)",
                    params![entry.id, principal.person_id(), &entry.consumed_at[..10], payload],
                )?;
            }
            remember_date(db, principal, &entry.consumed_at)?;
            effects.person(principal, Topic::FoodLog);
            Ok(())
        })
    }
}

fn save(
    db: &Connection,
    principal: &Principal,
    effects: &mut Effects,
    entry: &RecipeFoodLogEntry,
) -> Result<()> {
    let payload = serde_json::to_string(entry)?;
    if !already_stored(
        db,
        principal,
        "recipe_food_log_entries",
        &entry.id,
        &payload,
    )? {
        db.execute(
            "INSERT INTO recipe_food_log_entries (id, person_id, recipe_id, nutrition_version_id, consumed_on, payload) VALUES (?, ?, ?, ?, ?, ?)",
            params![
                entry.id,
                principal.person_id(),
                entry.recipe_id,
                entry.nutrition_version_id,
                &entry.consumed_at[..10],
                payload
            ],
        )?;
    }
    remember_date(db, principal, &entry.consumed_at)?;
    effects.person(principal, Topic::FoodLog);
    Ok(())
}
