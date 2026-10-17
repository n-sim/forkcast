//! Import of an explicit browser-profile transfer (format version 1).
//!
//! A native app cannot reach the old browser's IndexedDB, so the old origin
//! exports a transfer file and the installed core imports it here. The file
//! carries application data only: never session tokens or AI credentials. The
//! import validates everything first, applies in one transaction, keeps every
//! identifier, and is harmless to repeat. The source is never modified.

use crate::{
    Core,
    changes::Topic,
    error::{Error, Result},
    principal::{Principal, Standing},
    recipes::{Revision, insert_revision},
};
use forkcast_recipe_domain::{
    food_log::{
        ManualFoodLogEntry, RecipeFoodLogEntry, validate_manual_entry, validate_recipe_entry,
    },
    nutrition::NutritionVersion,
    planning::validate_planned_cooking,
    recipe::{RecipeDraft, validate_recipe},
};
use rusqlite::{Connection, OptionalExtension, params};
use serde::Serialize;
use serde_json::{Map, Value, json};
use std::collections::{BTreeMap, HashMap, HashSet};
use uuid::Uuid;

pub const FORMAT: &str = "forkcast-browser-transfer";
pub const VERSION: u64 = 1;

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportReport {
    /// The same export had already been imported; nothing changed.
    pub already_applied: bool,
    pub recipes: usize,
    pub revisions: usize,
    pub nutrition_versions: usize,
    pub photos: usize,
    pub ratings: usize,
    pub planned_cookings: usize,
    pub shopping_list: bool,
    pub cooking_sessions: usize,
    pub food_log_entries: usize,
    pub ai_prompts: usize,
    pub pending_changes: usize,
    /// The browser profile's person id became this profile's person id.
    pub person_identity_preserved: bool,
    /// The browser profile had joined a household; sign in again to resume.
    pub sign_in_required: bool,
    /// Things this version cannot carry over, stated rather than dropped silently.
    pub notes: Vec<String>,
}

fn problem(problems: &mut Vec<String>, message: impl Into<String>) {
    if problems.len() < 20 {
        problems.push(message.into());
    }
}

fn text<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value
        .get(key)?
        .as_str()
        .filter(|text| !text.trim().is_empty())
}

fn records<'a>(transfer: &'a Value, key: &str) -> Vec<&'a Value> {
    transfer[key]
        .as_array()
        .map(|list| list.iter().collect())
        .unwrap_or_default()
}

fn photo(value: &Value) -> Option<crate::Photo> {
    serde_json::from_value(value.clone()).ok()
}

struct Prepared {
    revisions: Vec<Revision>,
    pending_revisions: HashSet<String>,
    heads: BTreeMap<String, String>,
    versions: Vec<NutritionVersion>,
}

/// Builds validated revisions for every recipe, synthesizing a root revision
/// for recipes saved before revisions were recorded.
fn prepare_recipes(transfer: &Value, problems: &mut Vec<String>) -> Prepared {
    let mut versions_by_recipe: HashMap<String, Vec<NutritionVersion>> = HashMap::new();
    let mut versions = Vec::new();
    for version in records(transfer, "nutritionVersions") {
        match serde_json::from_value::<NutritionVersion>(version.clone()) {
            Ok(version) => {
                let mut errors = Vec::new();
                version.per_portion.validate(&mut errors);
                if version.id.trim().is_empty() || !errors.is_empty() {
                    problem(
                        problems,
                        format!("Nutrition version {} has invalid values.", version.id),
                    );
                    continue;
                }
                let copy = NutritionVersion {
                    id: version.id.clone(),
                    recipe_id: version.recipe_id.clone(),
                    per_portion: version.per_portion.clone(),
                };
                versions_by_recipe
                    .entry(version.recipe_id.clone())
                    .or_default()
                    .push(version);
                versions.push(copy);
            }
            Err(_) => problem(problems, "A nutrition version could not be read."),
        }
    }
    let photos: HashMap<&str, &Value> = records(transfer, "coverPhotos")
        .into_iter()
        .filter_map(|entry| Some((text(entry, "recipeId")?, entry)))
        .collect();
    let mut revisions = Vec::new();
    let mut pending_revisions = HashSet::new();
    let mut seen = HashSet::new();
    let mut recorded_recipes = HashSet::new();
    for wire in records(transfer, "recipeRevisions") {
        let Some(id) = text(wire, "id") else {
            problem(problems, "A recipe revision has no identity.");
            continue;
        };
        if !seen.insert(id.to_owned()) {
            problem(problems, format!("Recipe revision {id} appears twice."));
            continue;
        }
        let revision = Revision {
            id: id.to_owned(),
            parent_id: text(wire, "parentId").map(str::to_owned),
            recipe: wire["recipe"].clone(),
            nutrition_versions: wire["nutritionVersions"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|version| serde_json::from_value(version.clone()).ok())
                .collect(),
            cover_photo: photo(&wire["coverPhoto"]),
        };
        if let Some(recipe_id) = revision.recipe["id"].as_str() {
            recorded_recipes.insert(recipe_id.to_owned());
        }
        if wire["pending"].as_bool().unwrap_or(false) {
            pending_revisions.insert(id.to_owned());
        }
        revisions.push(revision);
    }
    let mut heads = BTreeMap::new();
    for recipe in records(transfer, "recipes") {
        let Some(recipe_id) = text(recipe, "id") else {
            problem(problems, "A recipe has no identity.");
            continue;
        };
        let head = text(recipe, "syncRevisionId")
            .filter(|id| seen.contains(*id))
            .map(str::to_owned);
        let head = match head {
            Some(head) => head,
            None => {
                // Recipes saved before revisions were recorded, or whose live
                // copy is ahead of its recorded revisions, get a revision now.
                let id = Uuid::new_v4().to_string();
                let parent = revisions
                    .iter()
                    .rev()
                    .find(|revision| revision.recipe["id"] == recipe_id)
                    .map(|revision| revision.id.clone());
                revisions.push(Revision {
                    id: id.clone(),
                    parent_id: parent,
                    recipe: recipe.clone(),
                    nutrition_versions: versions_by_recipe
                        .get(recipe_id)
                        .into_iter()
                        .flatten()
                        .map(|version| NutritionVersion {
                            id: version.id.clone(),
                            recipe_id: version.recipe_id.clone(),
                            per_portion: version.per_portion.clone(),
                        })
                        .collect(),
                    cover_photo: photos.get(recipe_id).and_then(|entry| photo(entry)),
                });
                seen.insert(id.clone());
                if recorded_recipes.contains(recipe_id) {
                    pending_revisions.insert(id.clone());
                }
                id
            }
        };
        heads.insert(recipe_id.to_owned(), head);
    }
    Prepared {
        revisions,
        pending_revisions,
        heads,
        versions,
    }
}

/// Parents before children.
fn ordered(mut revisions: Vec<Revision>, problems: &mut Vec<String>) -> Vec<Revision> {
    let mut placed: HashSet<String> = HashSet::new();
    let mut result = Vec::new();
    while !revisions.is_empty() {
        let before = revisions.len();
        let (ready, waiting): (Vec<_>, Vec<_>) = revisions.into_iter().partition(|revision| {
            revision
                .parent_id
                .as_ref()
                .is_none_or(|parent| placed.contains(parent))
        });
        for revision in ready {
            placed.insert(revision.id.clone());
            result.push(revision);
        }
        revisions = waiting;
        if revisions.len() == before {
            for revision in &revisions {
                problem(
                    problems,
                    format!(
                        "Recipe revision {} refers to a missing earlier revision.",
                        revision.id
                    ),
                );
            }
            break;
        }
    }
    result
}

fn newest_list(rows: &[&Value], selected: Option<&str>) -> Option<Value> {
    let list = rows
        .iter()
        .find(|row| selected.is_some_and(|id| row["id"] == id))
        .or_else(|| {
            rows.iter().max_by(|a, b| {
                a["generatedAt"]
                    .as_f64()
                    .partial_cmp(&b["generatedAt"].as_f64())
                    .unwrap_or(std::cmp::Ordering::Equal)
                    .then_with(|| b["id"].as_str().cmp(&a["id"].as_str()))
            })
        })?;
    let mut list = (*list).clone();
    if let Some(object) = list.as_object_mut() {
        object.remove("personId");
        object.remove("householdId");
    }
    Some(list)
}

fn ensure_person(
    db: &Connection,
    known: &mut HashSet<String>,
    household: &str,
    id: &str,
) -> Result<()> {
    if known.insert(id.to_owned()) {
        db.execute(
            "INSERT OR IGNORE INTO people (id, household_id, kind) VALUES (?, ?, 'account')",
            params![id, household],
        )?;
        db.execute(
            "INSERT OR IGNORE INTO remote_accounts (account_id, username, role) VALUES (?, NULL, 'member')",
            [id],
        )?;
    }
    Ok(())
}

impl Core {
    /// Validates and applies a browser-profile transfer, atomically.
    pub fn import_legacy(&self, transfer: Value) -> Result<ImportReport> {
        let mut problems = Vec::new();
        if transfer["format"] != FORMAT {
            return Err(Error::invalid(
                "This file is not a Forkcast browser transfer. Export one from the old browser profile first.",
            ));
        }
        if transfer["version"].as_u64() != Some(VERSION) {
            return Err(Error::new(
                crate::ErrorKind::Unsupported,
                "This transfer was made by a different version of Forkcast. Use the matching export tool, or update this app. Nothing was imported.",
            ));
        }
        let export_id = text(&transfer, "exportId")
            .ok_or_else(|| Error::invalid("This transfer has no export identity."))?
            .to_owned();
        let source_person = text(&transfer, "localPersonId").map(str::to_owned);
        let backend = transfer["backend"].clone();
        let binding = transfer["settings"]["recipeSyncBinding"].clone();
        let planning_sync = transfer["settings"]["planningSync"].clone();
        let account_id = backend["accountId"].as_str().map(str::to_owned);
        let bound = binding["url"].is_string() && binding["householdId"].is_string();
        if bound && account_id.is_none() {
            problem(
                &mut problems,
                "The transfer is linked to a household but names no account.",
            );
        }
        if transfer.to_string().contains("\"token\"") && backend.get("token").is_some() {
            return Err(Error::invalid(
                "This transfer contains a session token. Transfers carry application data only; export again with the current tool.",
            ));
        }

        let prepared = prepare_recipes(&transfer, &mut problems);
        let revisions = ordered(prepared.revisions, &mut problems);
        let mut validated = Vec::new();
        for revision in revisions {
            let name = revision.recipe["name"]
                .as_str()
                .unwrap_or("A recipe")
                .to_owned();
            // The shared validation checks the whole file before anything is applied.
            match revision.validated() {
                Ok(valid) => validated.push(valid),
                Err(error) => problem(&mut problems, format!("{name}: {}", error.message)),
            }
        }
        let recipe_ids: HashSet<String> = validated
            .iter()
            .filter_map(|revision| revision.recipe["id"].as_str().map(str::to_owned))
            .collect();

        for cooking in records(&transfer, "plannedCookings") {
            match serde_json::from_value(cooking.clone()) {
                Ok(parsed) => {
                    if validate_planned_cooking(parsed).is_err() {
                        problem(&mut problems, "A planned cooking has invalid values.");
                    } else if !cooking["recipeId"]
                        .as_str()
                        .is_some_and(|id| recipe_ids.contains(id))
                    {
                        problem(
                            &mut problems,
                            "A planned cooking refers to a recipe that is not in the transfer.",
                        );
                    }
                }
                Err(_) => problem(&mut problems, "A planned cooking could not be read."),
            }
        }
        for entry in records(&transfer, "manualFoodLogEntries") {
            let valid = serde_json::from_value::<ManualFoodLogEntry>(entry.clone())
                .is_ok_and(|parsed| validate_manual_entry(parsed).is_ok());
            if !valid {
                problem(&mut problems, "A manual food-log entry has invalid values.");
            }
        }
        for entry in records(&transfer, "recipeFoodLogEntries") {
            let valid = serde_json::from_value::<RecipeFoodLogEntry>(entry.clone())
                .is_ok_and(|parsed| validate_recipe_entry(parsed).is_ok());
            let version = text(entry, "nutritionVersionId").unwrap_or_default();
            if !valid {
                problem(&mut problems, "A recipe food-log entry has invalid values.");
            } else if !prepared.versions.iter().any(|known| known.id == version) {
                problem(
                    &mut problems,
                    "A food-log entry refers to nutrition that is not in the transfer.",
                );
            }
        }
        for session in records(&transfer, "cookingSessions") {
            let steps = session["recipe"]["steps"].as_array().map_or(0, Vec::len);
            let draft: Option<RecipeDraft> = serde_json::from_value(session["recipe"].clone()).ok();
            if text(session, "id").is_none()
                || steps == 0
                || draft.is_none_or(|draft| validate_recipe(draft).is_err())
            {
                problem(&mut problems, "A cooking session cannot be read.");
            }
        }
        for rating in records(&transfer, "ratings") {
            let value = rating["value"].as_i64();
            if text(rating, "recipeId").is_none()
                || text(rating, "personId").is_none()
                || !value.is_some_and(|value| (1..=5).contains(&value))
            {
                problem(&mut problems, "A recipe rating has invalid values.");
            }
        }
        if !problems.is_empty() {
            return Err(Error::invalid(format!(
                "The transfer was not imported, and nothing was changed. {}",
                problems.join(" ")
            )));
        }

        let now = self.now();
        // A first launch has no local person yet; a server database refuses.
        self.standalone()?;
        let report = self.write(|db, effects| {
            let already: bool = db.query_row(
                "SELECT EXISTS(SELECT 1 FROM legacy_imports WHERE id = ?)",
                [&export_id],
                |row| row.get(0),
            )?;
            if already {
                return Ok(ImportReport {
                    already_applied: true,
                    ..ImportReport::default()
                });
            }
            let (local, household): (String, String) = db
                .query_row(
                    "SELECT id, household_id FROM people WHERE kind = 'local'",
                    [],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .optional()?
                .ok_or_else(|| Error::forbidden("This database is not an installed profile."))?;
            if bound && crate::sync::is_bound(db)? {
                return Err(Error::conflict(
                    "This profile is already linked to a household. Import into a fresh profile.",
                ));
            }
            let pristine: bool = db.query_row(
                "SELECT NOT EXISTS(SELECT 1 FROM shared_recipes) AND NOT EXISTS(SELECT 1 FROM recipe_ratings) AND NOT EXISTS(SELECT 1 FROM cooking_sessions) AND NOT EXISTS(SELECT 1 FROM manual_food_log_entries) AND NOT EXISTS(SELECT 1 FROM recipe_food_log_entries) AND NOT EXISTS(SELECT 1 FROM household_planning)",
                [],
                |row| row.get(0),
            )?;
            let mut report = ImportReport::default();
            let mut local_person = local.clone();
            if let Some(source) = &source_person
                && pristine
                && *source != local
            {
                db.execute("UPDATE people SET id = ? WHERE kind = 'local'", [source])?;
                local_person = source.clone();
                report.person_identity_preserved = true;
            } else if source_person.as_deref() == Some(local.as_str()) {
                report.person_identity_preserved = true;
            }
            let owner = Principal::new(local_person.clone(), household.clone(), Standing::Local);

            // People: the browser's local person, the linked account, and any
            // other accounts that left personal records in this browser.
            let mut known: HashSet<String> = HashSet::from([local_person.clone()]);
            let map_person = |id: &str| -> String {
                if Some(id) == source_person.as_deref() {
                    local_person.clone()
                } else {
                    id.to_owned()
                }
            };

            // Recipes with their retained revisions, versions, and photos.
            let validated_revisions = validated;
            for revision in &validated_revisions {
                let recipe_id = revision.recipe["id"].as_str().unwrap_or_default().to_owned();
                let payload = serde_json::to_string(revision)?;
                if insert_revision(db, &owner, revision, &recipe_id, &payload, effects)? {
                    report.revisions += 1;
                }
            }
            for version in &prepared.versions {
                let payload = serde_json::to_string(version)?;
                db.execute(
                    "INSERT OR IGNORE INTO nutrition_versions (id, recipe_id, payload) VALUES (?, ?, ?)",
                    params![version.id, version.recipe_id, payload],
                )?;
                report.nutrition_versions += 1;
            }
            let mut leaves_by_recipe: HashMap<String, Vec<String>> = HashMap::new();
            for (recipe_id, head) in &prepared.heads {
                db.execute(
                    "UPDATE shared_recipes SET current_revision = ? WHERE id = ?",
                    params![head, recipe_id],
                )?;
                leaves_by_recipe.insert(recipe_id.clone(), crate::recipes::competing_revisions(db, recipe_id)?);
                report.recipes += 1;
            }
            report.photos = validated_revisions.iter().filter(|r| r.cover_photo.is_some()).count();
            // Alternatives the browser had already resolved stay resolved.
            let competing: HashMap<&str, HashSet<&str>> = transfer["settings"]["recipeSyncCurrent"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|head| {
                    Some((
                        head["recipeId"].as_str()?,
                        head["competingRevisionIds"]
                            .as_array()?
                            .iter()
                            .filter_map(Value::as_str)
                            .collect(),
                    ))
                })
                .collect();
            if bound {
                for (recipe_id, leaves) in &leaves_by_recipe {
                    let head = &prepared.heads[recipe_id];
                    let open = competing.get(recipe_id.as_str());
                    for leaf in leaves {
                        if leaf != head && !open.is_some_and(|open| open.contains(leaf.as_str())) {
                            db.execute(
                                "INSERT OR IGNORE INTO resolved_recipe_revisions (revision_id) VALUES (?)",
                                [leaf],
                            )?;
                        }
                    }
                }
            }

            // Household link, if the browser had one. Tokens are not in the
            // transfer, so the account must sign in again.
            let author = account_id.clone().unwrap_or_else(|| local_person.clone());
            if bound {
                let account = account_id.clone().unwrap_or_default();
                ensure_person(db, &mut known, &household, &account)?;
                db.execute(
                    "INSERT INTO sync_binding (singleton, server_url, remote_household_id) VALUES (1, ?, ?)",
                    params![binding["url"].as_str(), binding["householdId"].as_str()],
                )?;
                db.execute(
                    "INSERT INTO sync_state (singleton, active_account, signed_out, paused, planning_revision) VALUES (1, ?, 1, 0, ?)",
                    params![account, planning_sync["snapshot"]["revision"].as_str()],
                )?;
                report.sign_in_required = true;
                for revision in &validated_revisions {
                    if prepared.pending_revisions.contains(&revision.id) {
                        db.execute(
                            "INSERT OR IGNORE INTO sync_outbox (id, person_id, household_id, kind, payload) VALUES (?, ?, ?, 'recipeRevision', ?)",
                            params![revision.id, author, household, serde_json::to_string(revision)?],
                        )?;
                        report.pending_changes += 1;
                    }
                }
                for change in records(&transfer, "ratingChanges") {
                    let (Some(id), Some(recipe_id)) = (text(change, "id"), text(change, "recipeId")) else {
                        continue;
                    };
                    db.execute(
                        "INSERT OR IGNORE INTO sync_outbox (id, person_id, household_id, kind, payload) VALUES (?, ?, ?, 'rating', ?)",
                        params![id, map_person(text(change, "personId").unwrap_or(&author)), household,
                            json!({"id": id, "recipeId": recipe_id, "value": change["value"]}).to_string()],
                    )?;
                    report.pending_changes += 1;
                }
                for mutation in planning_sync["pending"].as_array().into_iter().flatten() {
                    if let Some(id) = text(mutation, "id") {
                        db.execute(
                            "INSERT OR IGNORE INTO sync_outbox (id, person_id, household_id, kind, payload) VALUES (?, ?, ?, 'planning', ?)",
                            params![id, author, household, mutation.to_string()],
                        )?;
                        report.pending_changes += 1;
                    }
                }
            }

            // Planning and the current shopping list, from this profile's scope.
            let scope_key = if bound { "householdId" } else { "personId" };
            let scope_id = if bound {
                binding["householdId"].as_str().unwrap_or_default().to_owned()
            } else {
                source_person.clone().unwrap_or_default()
            };
            let mut cookings = Map::new();
            for cooking in records(&transfer, "plannedCookings") {
                if cooking[scope_key] == scope_id.as_str() || (!bound && cooking[scope_key].is_null()) {
                    let mut cooking = cooking.clone();
                    if let Some(object) = cooking.as_object_mut() {
                        object.remove("personId");
                        object.remove("householdId");
                    }
                    cookings.insert(cooking["id"].as_str().unwrap_or_default().to_owned(), cooking);
                }
            }
            let lists: Vec<&Value> = records(&transfer, "shoppingLists")
                .into_iter()
                .filter(|list| list[scope_key] == scope_id.as_str() || (!bound && list[scope_key].is_null()))
                .collect();
            let selected = transfer["settings"]["shoppingListIds"][&scope_id].as_str();
            let list = newest_list(&lists, selected);
            report.planned_cookings = cookings.len();
            report.shopping_list = list.is_some();
            if lists.len() > 1 {
                report.notes.push(format!(
                    "{} older shopping lists were not carried over; the app shows only the current list.",
                    lists.len() - 1
                ));
            }
            let revision = if bound {
                planning_sync["snapshot"]["revision"].clone()
            } else {
                json!(Uuid::new_v4().to_string())
            };
            let conflicts = if bound {
                planning_sync["snapshot"]["conflicts"].clone()
            } else {
                json!([])
            };
            if !cookings.is_empty() || list.is_some() || bound {
                let document = json!({
                    "revision": revision,
                    "data": {"cookings": cookings, "shoppingList": list.unwrap_or(Value::Null)},
                    "conflicts": if conflicts.is_array() { conflicts } else { json!([]) },
                });
                crate::planning::store_imported_document(db, &household, &document)?;
            }

            // Personal records.
            let mut unfinished: HashSet<String> = HashSet::new();
            let mut sessions: Vec<&Value> = records(&transfer, "cookingSessions");
            sessions.sort_by(|a, b| {
                a["completedAt"].is_null().cmp(&b["completedAt"].is_null())
            });
            for session in sessions {
                let person = map_person(text(session, "personId").unwrap_or(&local_person));
                ensure_person(db, &mut known, &household, &person)?;
                let mut session = session.clone();
                if let Some(object) = session.as_object_mut() {
                    object.remove("personId");
                    for key in ["completedAt", "canceledAt"] {
                        object.entry(key).or_insert(Value::Null);
                    }
                }
                let mut ended = !session["completedAt"].is_null() || !session["canceledAt"].is_null();
                if !ended && !unfinished.insert(person.clone()) {
                    session["canceledAt"] = json!(now);
                    ended = true;
                    report
                        .notes
                        .push("An extra unfinished cooking session was imported as canceled.".to_owned());
                }
                let changed = db.execute(
                    "INSERT OR IGNORE INTO cooking_sessions (id, person_id, ended, payload) VALUES (?, ?, ?, ?)",
                    params![session["id"].as_str(), person, ended, session.to_string()],
                )?;
                report.cooking_sessions += changed;
            }
            for entry in records(&transfer, "manualFoodLogEntries") {
                let person = map_person(text(entry, "personId").unwrap_or(&local_person));
                ensure_person(db, &mut known, &household, &person)?;
                let mut entry = entry.clone();
                if let Some(object) = entry.as_object_mut() {
                    object.remove("personId");
                }
                let parsed: ManualFoodLogEntry = serde_json::from_value(entry)?;
                let parsed = validate_manual_entry(parsed).map_err(|_| Error::internal())?;
                report.food_log_entries += db.execute(
                    "INSERT OR IGNORE INTO manual_food_log_entries (id, person_id, consumed_on, payload) VALUES (?, ?, ?, ?)",
                    params![parsed.id, person, &parsed.consumed_at[..10], serde_json::to_string(&parsed)?],
                )?;
            }
            for entry in records(&transfer, "recipeFoodLogEntries") {
                let person = map_person(text(entry, "personId").unwrap_or(&local_person));
                ensure_person(db, &mut known, &household, &person)?;
                let mut entry = entry.clone();
                if let Some(object) = entry.as_object_mut() {
                    object.remove("personId");
                }
                let parsed: RecipeFoodLogEntry = serde_json::from_value(entry)?;
                let parsed = validate_recipe_entry(parsed).map_err(|_| Error::internal())?;
                report.food_log_entries += db.execute(
                    "INSERT OR IGNORE INTO recipe_food_log_entries (id, person_id, recipe_id, nutrition_version_id, consumed_on, payload) VALUES (?, ?, ?, ?, ?, ?)",
                    params![
                        parsed.id,
                        person,
                        parsed.recipe_id,
                        parsed.nutrition_version_id,
                        &parsed.consumed_at[..10],
                        serde_json::to_string(&parsed)?
                    ],
                )?;
            }
            if let Some(dates) = transfer["settings"]["foodLogDates"].as_object() {
                for (person, date) in dates {
                    if let Some(date) = date.as_str() {
                        let person = map_person(person);
                        ensure_person(db, &mut known, &household, &person)?;
                        db.execute(
                            "INSERT OR IGNORE INTO person_settings (person_id, key, value) VALUES (?, 'foodLogDate', ?)",
                            params![person, date],
                        )?;
                    }
                }
            }
            for rating in records(&transfer, "ratings") {
                let person = map_person(text(rating, "personId").unwrap_or(&local_person));
                ensure_person(db, &mut known, &household, &person)?;
                report.ratings += db.execute(
                    "INSERT OR IGNORE INTO recipe_ratings (person_id, recipe_id, value) VALUES (?, ?, ?)",
                    params![person, text(rating, "recipeId"), rating["value"].as_i64()],
                )?;
            }
            if let Some(prompts) = transfer["aiPrompts"].as_object() {
                for (owner, prompt) in prompts {
                    let Some(prompt) = prompt.as_str() else { continue };
                    let person = if owner == "standalone" {
                        Some(local_person.clone())
                    } else {
                        owner.rsplit(':').next().filter(|id| known.contains(*id)).map(str::to_owned)
                    };
                    match person {
                        Some(person) => {
                            report.ai_prompts += db.execute(
                                "INSERT OR IGNORE INTO person_settings (person_id, key, value) VALUES (?, 'recipePrompt', ?)",
                                params![person, prompt],
                            )?;
                        }
                        None => report.notes.push(format!("An AI prompt for {owner} had no matching person and was not carried over.")),
                    }
                }
            }
            db.execute(
                "INSERT INTO legacy_imports (id, applied_at) VALUES (?, ?)",
                params![export_id, now],
            )?;
            effects.household(&owner, Topic::Recipes);
            effects.household(&owner, Topic::Planning);
            effects.household(&owner, Topic::Sync);
            effects.person(&owner, Topic::Ratings);
            effects.person(&owner, Topic::FoodLog);
            effects.person(&owner, Topic::CookingSessions);
            effects.person(&owner, Topic::Preferences);
            Ok(report)
        })?;
        Ok(report)
    }
}
