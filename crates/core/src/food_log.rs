//! A person's food log: recipe-linked entries that reference a retained
//! nutrition version, and manual entries with their own nutrition, which AI
//! can estimate from a description or a transient image.
//!
//! Entries and dated goal sets are personal: they synchronize only between
//! the same account's devices. Each change is delivered as the record before
//! and after it; the server merges independent changes field by field and
//! retains a competing change, including removing a record that was changed
//! elsewhere, as a conflict for the person to decide.

use crate::{
    AiImage, AiRequest, Core,
    changes::{Effects, Topic},
    error::{Error, Result},
    principal::{Principal, outside},
    recipes, sync,
};
use forkcast_recipe_domain::{
    calendar::valid_date,
    food_log::{
        DailyFoodLog, FoodEstimate, ManualFoodLogEntry, RecipeFoodLogEntry, daily_food_log,
        read_food_estimate, validate_manual_entry, validate_recipe_entry,
    },
    nutrition::{Nutrition, NutritionVersion},
    nutrition_goals::{NutritionGoals, applicable_goals, validate_goals},
};
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use std::collections::HashSet;
use uuid::Uuid;

const DATE_KEY: &str = "foodLogDate";
const MAX_ESTIMATE_DESCRIPTION_CHARS: usize = 2000;

const ESTIMATE_CONTRACT: &str = r#"Estimate the nutrition of food a person ate, from their description, a photo, or both. Work from the amounts described or visible; when an amount is not given, assume one typical serving and say so in the description.
Return only a JSON object, without Markdown, in this structure: {"description":"2 slices of margherita pizza (about 250 g)","calories":600,"protein":25,"fat":22,"carbohydrates":75}.
description names the food and the amount the nutrition is for, in up to 200 characters. The values are for that whole amount. Calories are in kcal; protein, fat and carbohydrates are in grams. Each value must be a nonnegative finite number; use null for a value you cannot estimate. Do not include any other fields, and never describe a recipe."#;

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

/// An AI estimate for a manual entry from a description, an image, or
/// both. The image goes to the provider with this request only.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EstimateFood {
    pub model: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub image: Option<AiImage>,
}

/// Changes to one entry. Fields left out keep their value; portions apply
/// to recipe entries, and the description and nutrition to manual entries.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EditFoodLogEntry {
    pub consumed_at: Option<String>,
    pub portions: Option<f64>,
    pub description: Option<String>,
    pub nutrition: Option<Nutrition>,
}

/// The kinds of personal record a food-log change is about.
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "camelCase")]
pub enum FoodLogRecord {
    ManualEntry,
    RecipeEntry,
    /// A goal set, keyed by its effective date.
    Goals,
}

impl FoodLogRecord {
    const ALL: [FoodLogRecord; 3] = [Self::ManualEntry, Self::RecipeEntry, Self::Goals];

    fn name(self) -> &'static str {
        match self {
            Self::ManualEntry => "manualEntry",
            Self::RecipeEntry => "recipeEntry",
            Self::Goals => "goals",
        }
    }

    fn parse(name: &str) -> Result<Self> {
        Self::ALL
            .into_iter()
            .find(|kind| kind.name() == name)
            .ok_or_else(Error::internal)
    }
}

/// One synchronized change to a person's food log. `base` is the record as
/// the device had it and `value` the record now; null means it did not exist
/// or was removed.
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FoodLogChange {
    pub id: String,
    pub kind: FoodLogRecord,
    /// The entry's id, or the goal set's effective date.
    pub key: String,
    #[serde(default)]
    pub base: Value,
    #[serde(default)]
    pub value: Value,
    /// The conflict the person explicitly decided with this change.
    #[serde(default)]
    pub resolves: Option<String>,
}

/// Which record a person keeps when two devices changed it at once.
#[derive(Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum FoodLogChoice {
    /// The record as the food log shows it now; null when it was removed.
    Current,
    /// The competing change retained in the conflict.
    Alternative,
}

/// A record changed on two devices, waiting for the person to decide.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FoodLogConflict {
    pub id: String,
    pub kind: FoodLogRecord,
    pub key: String,
    /// The record as kept now; null when it was removed.
    pub current: Value,
    /// The competing change; null when it removed the record.
    pub alternative: Value,
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
            if serde_json::from_str::<Value>(&previous)? == serde_json::from_str::<Value>(payload)?
            {
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

fn unreadable_record() -> Error {
    Error::invalid("This food-log record could not be read.")
}

/// A stored record and its owner.
fn load(
    db: &Connection,
    principal: &Principal,
    kind: FoodLogRecord,
    key: &str,
) -> Result<Option<(String, Value)>> {
    let stored: Option<(String, String)> = match kind {
        FoodLogRecord::ManualEntry | FoodLogRecord::RecipeEntry => db
            .query_row(
                &format!("SELECT person_id, payload FROM {} WHERE id = ?", table(kind)),
                [key],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?,
        FoodLogRecord::Goals => db
            .query_row(
                "SELECT person_id, payload FROM nutrition_goals WHERE person_id = ? AND effective_from = ?",
                params![principal.person_id(), key],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?,
    };
    stored
        .map(|(owner, payload)| Ok((owner, serde_json::from_str(&payload)?)))
        .transpose()
}

fn table(kind: FoodLogRecord) -> &'static str {
    match kind {
        FoodLogRecord::ManualEntry => "manual_food_log_entries",
        FoodLogRecord::RecipeEntry => "recipe_food_log_entries",
        FoodLogRecord::Goals => "nutrition_goals",
    }
}

/// The person's own record, or null when there is none. Another person's
/// record under the same identity is refused.
fn current(
    db: &Connection,
    principal: &Principal,
    kind: FoodLogRecord,
    key: &str,
) -> Result<Value> {
    match load(db, principal, kind, key)? {
        Some((owner, _)) if owner != principal.person_id() => Err(outside()),
        Some((_, value)) => Ok(value),
        None => Ok(Value::Null),
    }
}

/// Checks a record with the shared rules and returns it in stored form.
/// A recipe entry must name a recipe of the person's household and one of
/// that recipe's retained nutrition versions.
fn check_record(
    db: &Connection,
    principal: &Principal,
    kind: FoodLogRecord,
    key: &str,
    value: &Value,
) -> Result<Value> {
    let checked = match kind {
        FoodLogRecord::ManualEntry => {
            let entry: ManualFoodLogEntry =
                serde_json::from_value(value.clone()).map_err(|_| unreadable_record())?;
            let entry = validate_manual_entry(entry).map_err(field_errors)?;
            if entry.id != key {
                return Err(unreadable_record());
            }
            serde_json::to_value(entry)?
        }
        FoodLogRecord::RecipeEntry => {
            let entry: RecipeFoodLogEntry =
                serde_json::from_value(value.clone()).map_err(|_| unreadable_record())?;
            let entry = validate_recipe_entry(entry).map_err(field_errors)?;
            if entry.id != key {
                return Err(unreadable_record());
            }
            let household: Option<String> = db
                .query_row(
                    "SELECT household_id FROM shared_recipes WHERE id = ?",
                    [&entry.recipe_id],
                    |row| row.get(0),
                )
                .optional()?;
            if household.as_deref() != Some(principal.household_id()) {
                return Err(Error::not_found(
                    "The recipe of this food-log entry is not available.",
                ));
            }
            let stored = serde_json::to_value(&entry)?;
            let version = versions(db, std::slice::from_ref(&entry.nutrition_version_id))?;
            let day = entry.consumed_at[..10].to_owned();
            daily_food_log(vec![], vec![entry], version, &day).map_err(Error::invalid)?;
            stored
        }
        FoodLogRecord::Goals => {
            let goals: NutritionGoals =
                serde_json::from_value(value.clone()).map_err(|_| unreadable_record())?;
            let goals = validate_goals(goals).map_err(|errors| {
                Error::invalid("Check the nutrition goals before saving.")
                    .with_fields(serde_json::to_value(errors).unwrap_or(Value::Null))
            })?;
            if goals.effective_from != key {
                return Err(unreadable_record());
            }
            serde_json::to_value(goals)?
        }
    };
    Ok(checked)
}

/// Stores the person's record, or removes it when `value` is null. The
/// value must already be checked.
fn put(
    db: &Connection,
    principal: &Principal,
    kind: FoodLogRecord,
    key: &str,
    value: &Value,
) -> Result<()> {
    let person = principal.person_id();
    if value.is_null() {
        match kind {
            FoodLogRecord::Goals => db.execute(
                "DELETE FROM nutrition_goals WHERE person_id = ? AND effective_from = ?",
                params![person, key],
            )?,
            _ => db.execute(
                &format!("DELETE FROM {} WHERE id = ? AND person_id = ?", table(kind)),
                params![key, person],
            )?,
        };
        return Ok(());
    }
    let payload = value.to_string();
    let consumed_on = value["consumedAt"].as_str().map(|at| &at[..10]);
    match kind {
        FoodLogRecord::ManualEntry => db.execute(
            "INSERT INTO manual_food_log_entries (id, person_id, consumed_on, payload) VALUES (?, ?, ?, ?)
             ON CONFLICT(id) DO UPDATE SET consumed_on = excluded.consumed_on, payload = excluded.payload",
            params![key, person, consumed_on, payload],
        )?,
        FoodLogRecord::RecipeEntry => db.execute(
            "INSERT INTO recipe_food_log_entries (id, person_id, recipe_id, nutrition_version_id, consumed_on, payload) VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT(id) DO UPDATE SET recipe_id = excluded.recipe_id, nutrition_version_id = excluded.nutrition_version_id,
                 consumed_on = excluded.consumed_on, payload = excluded.payload",
            params![
                key,
                person,
                value["recipeId"].as_str(),
                value["nutritionVersionId"].as_str(),
                consumed_on,
                payload
            ],
        )?,
        FoodLogRecord::Goals => db.execute(
            "INSERT INTO nutrition_goals (person_id, effective_from, payload) VALUES (?, ?, ?)
             ON CONFLICT(person_id, effective_from) DO UPDATE SET payload = excluded.payload",
            params![person, key, payload],
        )?,
    };
    Ok(())
}

/// Three-way merge of a record. Changes to different fields (and to
/// different nutrients within one) combine and identical changes agree;
/// competing changes to one field, a record created twice differently, or
/// removing a record that was changed on the other side return `None` so
/// both are kept for the person to decide.
fn merge_record(base: &Value, ours: &Value, theirs: &Value) -> Option<Value> {
    if ours == theirs || theirs == base {
        return Some(ours.clone());
    }
    if ours == base {
        return Some(theirs.clone());
    }
    let (Value::Object(base), Value::Object(ours), Value::Object(theirs)) = (base, ours, theirs)
    else {
        return None;
    };
    let mut keys: Vec<&String> = base
        .keys()
        .chain(ours.keys())
        .chain(theirs.keys())
        .collect();
    keys.sort();
    keys.dedup();
    let mut merged = Map::new();
    for key in keys {
        let field = |side: &Map<String, Value>| side.get(key).cloned().unwrap_or(Value::Null);
        merged.insert(
            key.clone(),
            merge_record(&field(base), &field(ours), &field(theirs))?,
        );
    }
    Some(Value::Object(merged))
}

/// Recipes kept on this device when it joined never reach the household,
/// and neither do the entries that log them.
fn held_back(db: &Connection, kind: FoodLogRecord, records: [&Value; 2]) -> Result<bool> {
    if kind != FoodLogRecord::RecipeEntry {
        return Ok(false);
    }
    for record in records {
        if let Some(recipe) = record["recipeId"].as_str() {
            let held: bool = db
                .query_row(
                    "SELECT held_back FROM shared_recipes WHERE id = ?",
                    [recipe],
                    |row| row.get(0),
                )
                .optional()?
                .unwrap_or(true);
            if held {
                return Ok(true);
            }
        }
    }
    Ok(false)
}

/// Queues a change for the person's other devices.
fn queue(
    db: &Connection,
    effects: &mut Effects,
    principal: &Principal,
    kind: FoodLogRecord,
    key: &str,
    (base, value): (&Value, &Value),
    resolves: Option<&str>,
) -> Result<()> {
    if (base == value && resolves.is_none()) || held_back(db, kind, [base, value])? {
        return Ok(());
    }
    let id = Uuid::new_v4().to_string();
    let change = FoodLogChange {
        id: id.clone(),
        kind,
        key: key.to_owned(),
        base: base.clone(),
        value: value.clone(),
        resolves: resolves.map(str::to_owned),
    };
    sync::record(db, effects, principal, "foodLog", &id, &change)
}

/// Replaces the person's record (null removes it) and queues the change.
fn change_record(
    db: &Connection,
    effects: &mut Effects,
    principal: &Principal,
    kind: FoodLogRecord,
    key: &str,
    value: &Value,
) -> Result<()> {
    let base = current(db, principal, kind, key)?;
    put(db, principal, kind, key, value)?;
    queue(db, effects, principal, kind, key, (&base, value), None)?;
    effects.person(principal, Topic::FoodLog);
    Ok(())
}

/// The person's records of one kind, by key.
fn records(
    db: &Connection,
    principal: &Principal,
    kind: FoodLogRecord,
) -> Result<Vec<(String, Value)>> {
    let key = match kind {
        FoodLogRecord::Goals => "effective_from",
        _ => "id",
    };
    let mut query = db.prepare(&format!(
        "SELECT {key}, payload FROM {} WHERE person_id = ? ORDER BY rowid",
        table(kind)
    ))?;
    let rows = query
        .query_map([principal.person_id()], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    rows.into_iter()
        .map(|(key, payload)| Ok((key, serde_json::from_str(&payload)?)))
        .collect()
}

fn conflicts(db: &Connection, principal: &Principal) -> Result<Vec<FoodLogConflict>> {
    let mut query = db.prepare(
        "SELECT id, kind, key, alternative FROM food_log_conflicts WHERE person_id = ? ORDER BY rowid",
    )?;
    let rows = query
        .query_map([principal.person_id()], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, Option<String>>(3)?,
            ))
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    rows.into_iter()
        .map(|(id, kind, key, alternative)| {
            let kind = FoodLogRecord::parse(&kind)?;
            Ok(FoodLogConflict {
                current: current(db, principal, kind, &key)?,
                alternative: match alternative {
                    Some(text) => serde_json::from_str(&text)?,
                    None => Value::Null,
                },
                id,
                kind,
                key,
            })
        })
        .collect()
}

/// Retains `alternative` as the record's competing change; a newer one
/// replaces an older one.
fn keep_conflict(
    db: &Connection,
    principal: &Principal,
    id: &str,
    kind: FoodLogRecord,
    key: &str,
    alternative: &Value,
) -> Result<()> {
    db.execute(
        "DELETE FROM food_log_conflicts WHERE person_id = ? AND kind = ? AND key = ?",
        params![principal.person_id(), kind.name(), key],
    )?;
    db.execute(
        "INSERT INTO food_log_conflicts (id, person_id, kind, key, alternative) VALUES (?, ?, ?, ?, ?)",
        params![
            id,
            principal.person_id(),
            kind.name(),
            key,
            (!alternative.is_null()).then(|| alternative.to_string())
        ],
    )?;
    Ok(())
}

/// Queues, when a device joins a household with its personal records, the
/// food log and goals for the account's other devices.
pub(crate) fn queue_for_join(
    db: &Connection,
    effects: &mut Effects,
    member: &Principal,
) -> Result<()> {
    for kind in FoodLogRecord::ALL {
        for (key, value) in records(db, member, kind)? {
            queue(
                db,
                effects,
                member,
                kind,
                &key,
                (&Value::Null, &value),
                None,
            )?;
        }
    }
    Ok(())
}

/// Adopts the account's food log from the server, except records with
/// changes still waiting here; they are merged on the server first.
/// Entries of recipes that never left this device stay.
pub(crate) fn mirror(
    db: &Connection,
    person: &Principal,
    snapshot: &Value,
    pending: &HashSet<(FoodLogRecord, String)>,
    resolving: &HashSet<String>,
    effects: &mut Effects,
) -> Result<()> {
    let mut changed = false;
    for kind in FoodLogRecord::ALL {
        let field = match kind {
            FoodLogRecord::ManualEntry => "manualEntries",
            FoodLogRecord::RecipeEntry => "recipeEntries",
            FoodLogRecord::Goals => "goals",
        };
        let key_field = match kind {
            FoodLogRecord::Goals => "effectiveFrom",
            _ => "id",
        };
        let mut seen = HashSet::new();
        for remote in snapshot[field].as_array().into_iter().flatten() {
            let Some(key) = remote[key_field].as_str() else {
                continue;
            };
            seen.insert(key.to_owned());
            if pending.contains(&(kind, key.to_owned())) {
                continue;
            }
            let local = match load(db, person, kind, key)? {
                Some((owner, _)) if owner != person.person_id() => continue,
                Some((_, local)) => local,
                None => Value::Null,
            };
            // A record this device cannot check (such as an entry of a
            // recipe it does not have yet) waits for a later pass.
            let Ok(remote) = check_record(db, person, kind, key, remote) else {
                continue;
            };
            if remote != local {
                put(db, person, kind, key, &remote)?;
                changed = true;
            }
        }
        for (key, local) in records(db, person, kind)? {
            if seen.contains(&key)
                || pending.contains(&(kind, key.clone()))
                || held_back(db, kind, [&local, &Value::Null])?
            {
                continue;
            }
            put(db, person, kind, &key, &Value::Null)?;
            changed = true;
        }
    }
    let before: Vec<(String, Option<String>)> = db
        .prepare("SELECT id, alternative FROM food_log_conflicts WHERE person_id = ? ORDER BY id")?
        .query_map([person.person_id()], |row| Ok((row.get(0)?, row.get(1)?)))?
        .collect::<std::result::Result<_, _>>()?;
    db.execute(
        "DELETE FROM food_log_conflicts WHERE person_id = ?",
        [person.person_id()],
    )?;
    for conflict in snapshot["conflicts"].as_array().into_iter().flatten() {
        let (Some(id), Some(kind), Some(key)) = (
            conflict["id"].as_str(),
            conflict["kind"].as_str(),
            conflict["key"].as_str(),
        ) else {
            continue;
        };
        let Ok(kind) = FoodLogRecord::parse(kind) else {
            continue;
        };
        if resolving.contains(id) {
            continue;
        }
        keep_conflict(db, person, id, kind, key, &conflict["alternative"])?;
    }
    let after: Vec<(String, Option<String>)> = db
        .prepare("SELECT id, alternative FROM food_log_conflicts WHERE person_id = ? ORDER BY id")?
        .query_map([person.person_id()], |row| Ok((row.get(0)?, row.get(1)?)))?
        .collect::<std::result::Result<_, _>>()?;
    if changed || before != after {
        effects.person(person, Topic::FoodLog);
    }
    Ok(())
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
            change_record(
                db,
                effects,
                principal,
                FoodLogRecord::Goals,
                &goals.effective_from,
                &serde_json::to_value(&goals)?,
            )
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
            if current(db, principal, FoodLogRecord::Goals, effective_from)?.is_null() {
                return Err(Error::not_found("These nutrition goals no longer exist."));
            }
            change_record(
                db,
                effects,
                principal,
                FoodLogRecord::Goals,
                effective_from,
                &Value::Null,
            )
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
                    Error::not_found(
                        "This recipe is no longer available, so the entry keeps its nutrition.",
                    )
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
            change_record(
                db,
                effects,
                principal,
                FoodLogRecord::RecipeEntry,
                entry_id,
                &serde_json::to_value(&entry)?,
            )?;
            Ok(true)
        })
    }

    /// Asks the person's AI connection to estimate food from a description,
    /// an image, or both. Returns a suggestion for a manual entry and stores
    /// nothing: not the estimate, and never the image.
    pub fn estimate_food(
        &self,
        principal: &Principal,
        input: EstimateFood,
    ) -> Result<FoodEstimate> {
        principal.require_personal()?;
        let description = input
            .description
            .as_deref()
            .map(str::trim)
            .filter(|description| !description.is_empty());
        if description.is_none() && input.image.is_none() {
            return Err(Error::invalid(
                "Describe the food or add a photo to estimate its nutrition.",
            ));
        }
        if description.is_some_and(|text| text.chars().count() > MAX_ESTIMATE_DESCRIPTION_CHARS) {
            return Err(Error::invalid(format!(
                "Describe the food in up to {MAX_ESTIMATE_DESCRIPTION_CHARS} characters."
            )));
        }
        let text = self.ai_execute(
            principal,
            AiRequest {
                model: input.model,
                instructions: ESTIMATE_CONTRACT.to_owned(),
                input: match (description, &input.image) {
                    (Some(description), None) => format!("Food eaten:\n{description}"),
                    (Some(description), Some(_)) => {
                        format!("Food eaten, shown in the attached photo:\n{description}")
                    }
                    (None, _) => "Food eaten: shown in the attached photo.".to_owned(),
                },
                image: input.image,
            },
        )?;
        read_food_estimate(&text).map_err(|detail| {
            Error::invalid(format!(
                "ChatGPT returned an invalid nutrition estimate. {detail} Try again, or enter nutrition manually. Nothing was logged."
            ))
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
            if !already_stored(
                db,
                principal,
                "manual_food_log_entries",
                &entry.id,
                &payload,
            )? {
                change_record(
                    db,
                    effects,
                    principal,
                    FoodLogRecord::ManualEntry,
                    &entry.id,
                    &serde_json::to_value(&entry)?,
                )?;
            }
            remember_date(db, principal, &entry.consumed_at)?;
            effects.person(principal, Topic::FoodLog);
            Ok(())
        })
    }
}

impl Core {
    /// Changes when an entry was eaten, its portions (recipe entries), or
    /// its description and nutrition (manual entries). A recipe entry keeps
    /// its retained nutrition version.
    pub fn edit_food_log_entry(
        &self,
        principal: &Principal,
        entry_id: &str,
        edit: EditFoodLogEntry,
    ) -> Result<()> {
        principal.require_personal()?;
        self.write(|db, effects| {
            let (kind, mut entry) = find_entry(db, principal, entry_id)?;
            if let Some(consumed_at) = edit.consumed_at {
                entry["consumedAt"] = json!(consumed_at);
            }
            match kind {
                FoodLogRecord::RecipeEntry => {
                    if edit.description.is_some() || edit.nutrition.is_some() {
                        return Err(Error::invalid(
                            "A recipe entry keeps the recipe's name and nutrition. Change its portions instead.",
                        ));
                    }
                    if let Some(portions) = edit.portions {
                        entry["portions"] = json!(portions);
                    }
                }
                _ => {
                    if edit.portions.is_some() {
                        return Err(Error::invalid("A manual entry has no portions."));
                    }
                    if let Some(description) = edit.description {
                        entry["description"] = json!(description);
                    }
                    if let Some(nutrition) = edit.nutrition {
                        entry["nutrition"] = serde_json::to_value(nutrition)?;
                    }
                }
            }
            let entry = check_record(db, principal, kind, entry_id, &entry)?;
            change_record(db, effects, principal, kind, entry_id, &entry)?;
            if let Some(consumed_at) = entry["consumedAt"].as_str() {
                remember_date(db, principal, consumed_at)?;
            }
            Ok(())
        })
    }

    /// Removes one entry from the person's food log.
    pub fn remove_food_log_entry(&self, principal: &Principal, entry_id: &str) -> Result<()> {
        principal.require_personal()?;
        self.write(|db, effects| {
            let (kind, _) = find_entry(db, principal, entry_id)?;
            change_record(db, effects, principal, kind, entry_id, &Value::Null)
        })
    }

    /// Records changed on two devices that wait for the person.
    pub fn food_log_conflicts(&self, principal: &Principal) -> Result<Vec<FoodLogConflict>> {
        principal.require_personal()?;
        self.read(|db| conflicts(db, principal))
    }

    /// Keeps one side of a record changed on two devices: the record as
    /// shown now, or the competing change (which may remove it).
    pub fn resolve_food_log_conflict(
        &self,
        principal: &Principal,
        conflict_id: &str,
        keep: FoodLogChoice,
    ) -> Result<()> {
        principal.require_personal()?;
        self.write(|db, effects| {
            let conflict = conflicts(db, principal)?
                .into_iter()
                .find(|conflict| conflict.id == conflict_id)
                .ok_or_else(|| {
                    Error::conflict("This food-log change has nothing left to decide.")
                })?;
            let chosen = match keep {
                FoodLogChoice::Current => conflict.current.clone(),
                FoodLogChoice::Alternative if conflict.alternative.is_null() => Value::Null,
                FoodLogChoice::Alternative => check_record(
                    db,
                    principal,
                    conflict.kind,
                    &conflict.key,
                    &conflict.alternative,
                )?,
            };
            put(db, principal, conflict.kind, &conflict.key, &chosen)?;
            db.execute(
                "DELETE FROM food_log_conflicts WHERE id = ? AND person_id = ?",
                params![conflict_id, principal.person_id()],
            )?;
            queue(
                db,
                effects,
                principal,
                conflict.kind,
                &conflict.key,
                (&conflict.current, &chosen),
                Some(conflict_id),
            )?;
            effects.person(principal, Topic::FoodLog);
            Ok(())
        })
    }

    /// Server side of synchronization: the account's whole food log, goal
    /// history, and the changes still waiting for a decision.
    pub fn food_log_snapshot(&self, principal: &Principal) -> Result<Value> {
        principal.require_personal()?;
        self.read(|db| {
            let all = |kind| -> Result<Vec<Value>> {
                Ok(records(db, principal, kind)?
                    .into_iter()
                    .map(|(_, value)| value)
                    .collect())
            };
            Ok(json!({
                "manualEntries": all(FoodLogRecord::ManualEntry)?,
                "recipeEntries": all(FoodLogRecord::RecipeEntry)?,
                "goals": all(FoodLogRecord::Goals)?,
                "conflicts": conflicts(db, principal)?
                    .into_iter()
                    .map(|conflict| json!({
                        "id": conflict.id,
                        "kind": conflict.kind,
                        "key": conflict.key,
                        "alternative": conflict.alternative,
                    }))
                    .collect::<Vec<_>>(),
            }))
        })
    }

    /// Server side of synchronization: merges a device's queued food-log
    /// changes into the authenticated account's own records. Another
    /// person's record is refused whatever the request says, and every
    /// record is checked with the shared rules before it is kept.
    pub fn apply_food_log_changes(
        &self,
        principal: &Principal,
        changes: Vec<FoodLogChange>,
    ) -> Result<()> {
        principal.require_personal()?;
        self.write(|db, effects| {
            for change in changes {
                if Uuid::parse_str(&change.id).is_err() {
                    return Err(Error::invalid("The food-log change id could not be read."));
                }
                let applied: Option<String> = db
                    .query_row(
                        "SELECT person_id FROM food_log_mutations WHERE id = ?",
                        [&change.id],
                        |row| row.get(0),
                    )
                    .optional()?;
                if let Some(owner) = applied {
                    principal.require_person(&owner)?;
                    continue;
                }
                let ours = current(db, principal, change.kind, &change.key)?;
                let theirs = match &change.value {
                    Value::Null => Value::Null,
                    value => check_record(db, principal, change.kind, &change.key, value)?,
                };
                match merge_record(&change.base, &ours, &theirs) {
                    Some(merged) => {
                        if merged != ours {
                            let merged = match &merged {
                                Value::Null => Value::Null,
                                value => {
                                    check_record(db, principal, change.kind, &change.key, value)?
                                }
                            };
                            put(db, principal, change.kind, &change.key, &merged)?;
                        }
                        if let Some(resolved) = &change.resolves {
                            db.execute(
                                "DELETE FROM food_log_conflicts WHERE id = ? AND person_id = ?",
                                params![resolved, principal.person_id()],
                            )?;
                        }
                    }
                    None => {
                        keep_conflict(db, principal, &change.id, change.kind, &change.key, &theirs)?
                    }
                }
                db.execute(
                    "INSERT INTO food_log_mutations (id, person_id) VALUES (?, ?)",
                    params![change.id, principal.person_id()],
                )?;
            }
            effects.person(principal, Topic::FoodLog);
            Ok(())
        })
    }
}

/// The person's entry with this id, and which kind it is.
fn find_entry(
    db: &Connection,
    principal: &Principal,
    entry_id: &str,
) -> Result<(FoodLogRecord, Value)> {
    for kind in [FoodLogRecord::ManualEntry, FoodLogRecord::RecipeEntry] {
        let entry = current(db, principal, kind, entry_id)?;
        if !entry.is_null() {
            return Ok((kind, entry));
        }
    }
    Err(Error::not_found("This food-log entry no longer exists."))
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
        change_record(
            db,
            effects,
            principal,
            FoodLogRecord::RecipeEntry,
            &entry.id,
            &serde_json::to_value(entry)?,
        )?;
    }
    remember_date(db, principal, &entry.consumed_at)?;
    effects.person(principal, Topic::FoodLog);
    Ok(())
}
