//! Household recipes with retained revisions and nutrition versions, cover
//! photos, and personal ratings.

use crate::{
    Core,
    changes::{Effects, Topic},
    error::{Error, Result},
    principal::{Principal, outside},
    sync,
};
use base64::{Engine, engine::general_purpose::STANDARD};
use forkcast_recipe_domain::{
    nutrition::{self, NutritionVersion},
    rating::{self, RecipeRating},
    recipe::{RecipeDraft, validate_recipe},
};
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use uuid::Uuid;

fn invalid() -> Error {
    Error::invalid("Check the recipe, cover photo, and retained nutrition versions.")
}

fn conflict() -> Error {
    Error::conflict(
        "A revision or nutrition identity cannot be replaced. Your local changes have been kept.",
    )
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Photo {
    pub mime: String,
    pub data: String,
}

/// One immutable edit of a recipe. The wire form accepted from a device
/// during synchronization is also the form retained in storage.
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Revision {
    pub id: String,
    pub parent_id: Option<String>,
    pub recipe: Value,
    pub nutrition_versions: Vec<NutritionVersion>,
    pub cover_photo: Option<Photo>,
}

impl Revision {
    /// The revision with its recipe normalized by the shared validation.
    pub(crate) fn validated(mut self) -> Result<Self> {
        self.validate()?;
        Ok(self)
    }

    /// Returns the recipe id after normalizing the recipe through the shared
    /// domain validation.
    fn validate(&mut self) -> Result<String> {
        if self.id.trim().is_empty() {
            return Err(invalid());
        }
        let draft: RecipeDraft =
            serde_json::from_value(self.recipe.clone()).map_err(|_| invalid())?;
        let recipe = validate_recipe(draft).map_err(|_| invalid())?;
        let version_id = self
            .recipe
            .get("nutritionVersionId")
            .and_then(Value::as_str)
            .ok_or_else(invalid)?
            .to_owned();
        let expected = recipe
            .nutrition
            .scale(1.0 / recipe.base_portions)
            .map_err(|_| invalid())?;
        let current = self
            .nutrition_versions
            .iter()
            .find(|version| version.id == version_id)
            .ok_or_else(invalid)?;
        // Hosts share the calculation; tolerate floating-point JSON round trips.
        for (a, b) in [
            (current.per_portion.calories, expected.calories),
            (current.per_portion.protein, expected.protein),
            (current.per_portion.fat, expected.fat),
            (current.per_portion.carbohydrates, expected.carbohydrates),
        ] {
            match (a, b) {
                (None, None) => {}
                (Some(a), Some(b)) if (a - b).abs() <= 1e-9 * a.abs().max(b.abs()).max(1.0) => {}
                _ => return Err(invalid()),
            }
        }
        let mut ids = std::collections::HashSet::new();
        for version in &self.nutrition_versions {
            let mut errors = Vec::new();
            version.per_portion.validate(&mut errors);
            if version.id.trim().is_empty()
                || version.recipe_id != recipe.id
                || !ids.insert(&version.id)
                || !errors.is_empty()
            {
                return Err(invalid());
            }
        }
        if let Some(photo) = &self.cover_photo {
            let bytes = STANDARD.decode(&photo.data).map_err(|_| invalid())?;
            let recognizable = match photo.mime.as_str() {
                "image/png" => bytes.starts_with(b"\x89PNG\r\n\x1a\n"),
                "image/jpeg" => bytes.starts_with(b"\xff\xd8\xff"),
                "image/webp" => bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP"),
                _ => false,
            };
            if bytes.len() > 10 * 1024 * 1024 || !recognizable {
                return Err(invalid());
            }
        }
        let id = recipe.id.clone();
        self.recipe = serde_json::to_value(recipe).map_err(|_| Error::internal())?;
        self.recipe["nutritionVersionId"] = Value::String(version_id);
        Ok(id)
    }
}

/// The current state of one recipe as the household sees it.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecipeView {
    /// The validated recipe plus its `nutritionVersionId`.
    pub recipe: Value,
    pub cover_photo: Option<Photo>,
    pub revision_id: String,
    /// Competing edits awaiting review; zero when there is nothing to choose.
    pub unresolved: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedRecipe {
    pub saved_revision_id: String,
    pub current: RecipeView,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SaveRecipe {
    pub recipe: Value,
    /// The revision the edit started from. Omit to continue from the current
    /// revision; a stale base retains the edit as a competing alternative.
    pub base_revision_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SetCoverPhoto {
    pub recipe_id: String,
    pub cover_photo: Option<Photo>,
    pub base_revision_id: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Collection {
    pub revisions: Vec<Value>,
    pub current: Vec<CurrentRecipe>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CurrentRecipe {
    recipe_id: String,
    revision_id: String,
    unresolved: i64,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    competing_revision_ids: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CurrentChoice {
    pub revision_id: String,
    pub expected_revision_ids: Vec<String>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RatingChange {
    pub id: String,
    pub recipe_id: String,
    pub value: Option<u8>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Rating {
    pub recipe_id: String,
    pub value: Option<u8>,
}

pub(crate) fn competing_revisions(db: &Connection, recipe_id: &str) -> Result<Vec<String>> {
    let mut query = db.prepare(
        "SELECT r.id FROM recipe_revisions r WHERE r.recipe_id = ?
         AND NOT EXISTS (SELECT 1 FROM recipe_revisions child WHERE child.parent_id = r.id)
         AND NOT EXISTS (SELECT 1 FROM resolved_recipe_revisions resolved WHERE resolved.revision_id = r.id)
         ORDER BY r.id",
    )?;
    Ok(query
        .query_map([recipe_id], |row| row.get(0))?
        .collect::<std::result::Result<Vec<_>, _>>()?)
}

fn require_recipe(db: &Connection, principal: &Principal, id: &str) -> Result<()> {
    let owner: String = db
        .query_row(
            "SELECT household_id FROM shared_recipes WHERE id = ?",
            [id],
            |row| row.get(0),
        )
        .optional()?
        .ok_or_else(|| Error::not_found("Recipe not found."))?;
    principal.require_household(&owner)
}

fn revision_payload(db: &Connection, id: &str) -> Result<Option<(String, Revision)>> {
    db.query_row(
        "SELECT recipe_id, payload FROM recipe_revisions WHERE id = ?",
        [id],
        |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
    )
    .optional()?
    .map(|(recipe_id, payload)| Ok((recipe_id, serde_json::from_str(&payload)?)))
    .transpose()
}

pub(crate) fn current_recipe_views(db: &Connection, household: &str) -> Result<Vec<RecipeView>> {
    let mut query = db.prepare(
        "SELECT s.id, s.current_revision, r.payload FROM shared_recipes s
         JOIN recipe_revisions r ON r.id = s.current_revision
         WHERE s.household_id = ? AND s.held_back = 0 ORDER BY s.rowid",
    )?;
    let rows = query
        .query_map([household], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    rows.into_iter()
        .map(|(recipe_id, revision_id, payload)| {
            let revision: Revision = serde_json::from_str(&payload)?;
            Ok(RecipeView {
                recipe: revision.recipe,
                cover_photo: revision.cover_photo,
                revision_id,
                unresolved: competing_revisions(db, &recipe_id)?.len().saturating_sub(1),
            })
        })
        .collect()
}

pub(crate) fn current_recipe(
    db: &Connection,
    household: &str,
    recipe_id: &str,
) -> Result<Option<RecipeView>> {
    Ok(current_recipe_views(db, household)?
        .into_iter()
        .find(|view| view.recipe["id"] == recipe_id))
}

/// Shared by device synchronization and local saves, so both enforce the same
/// ownership, identity, and branching rules. Returns whether it stored anything.
pub(crate) fn insert_revision(
    db: &Connection,
    principal: &Principal,
    revision: &Revision,
    recipe_id: &str,
    payload: &str,
    effects: &mut Effects,
) -> Result<bool> {
    let owner: Option<String> = db
        .query_row(
            "SELECT household_id FROM shared_recipes WHERE id = ?",
            [recipe_id],
            |row| row.get(0),
        )
        .optional()?;
    if let Some(owner) = owner {
        principal.require_household(&owner)?;
    }
    let existing: Option<String> = db
        .query_row(
            "SELECT payload FROM recipe_revisions WHERE id = ?",
            [&revision.id],
            |row| row.get(0),
        )
        .optional()?;
    if let Some(existing) = existing {
        if existing != payload {
            return Err(conflict());
        }
        return Ok(false);
    }
    if let Some(parent) = &revision.parent_id {
        let parent_recipe: Option<String> = db
            .query_row(
                "SELECT recipe_id FROM recipe_revisions WHERE id = ?",
                [parent],
                |row| row.get(0),
            )
            .optional()?;
        if parent_recipe.as_deref() != Some(recipe_id) {
            return Err(conflict());
        }
    }
    db.execute(
        "INSERT OR IGNORE INTO shared_recipes (id, household_id, current_revision) VALUES (?, ?, ?)",
        params![recipe_id, principal.household_id(), revision.id],
    )?;
    for version in &revision.nutrition_versions {
        let payload = serde_json::to_string(version).map_err(|_| invalid())?;
        let existing: Option<String> = db
            .query_row(
                "SELECT payload FROM nutrition_versions WHERE id = ?",
                [&version.id],
                |row| row.get(0),
            )
            .optional()?;
        if existing
            .as_ref()
            .is_some_and(|existing| existing != &payload)
        {
            return Err(conflict());
        }
        db.execute(
            "INSERT OR IGNORE INTO nutrition_versions (id, recipe_id, payload) VALUES (?, ?, ?)",
            params![version.id, recipe_id, payload],
        )?;
    }
    db.execute(
        "INSERT INTO recipe_revisions (id, recipe_id, parent_id, payload) VALUES (?, ?, ?, ?)",
        params![revision.id, recipe_id, revision.parent_id, payload],
    )?;
    // Only a direct successor advances current. Competing branches remain retained leaves.
    db.execute(
        "UPDATE shared_recipes SET current_revision = ? WHERE id = ? AND current_revision = ?",
        params![revision.id, recipe_id, revision.parent_id],
    )?;
    effects.household(principal, Topic::Recipes);
    Ok(true)
}

/// Stores a revision received from the household server.
pub(crate) fn ingest_remote_revision(
    db: &Connection,
    principal: &Principal,
    revision: &Revision,
    effects: &mut Effects,
) -> Result<()> {
    let mut revision = Revision {
        id: revision.id.clone(),
        parent_id: revision.parent_id.clone(),
        recipe: revision.recipe.clone(),
        nutrition_versions: revision
            .nutrition_versions
            .iter()
            .map(|version| NutritionVersion {
                id: version.id.clone(),
                recipe_id: version.recipe_id.clone(),
                per_portion: version.per_portion.clone(),
            })
            .collect(),
        cover_photo: revision.cover_photo.clone(),
    };
    let recipe_id = revision.validate()?;
    let payload = serde_json::to_string(&revision).map_err(|_| invalid())?;
    insert_revision(db, principal, &revision, &recipe_id, &payload, effects).map(|_| ())
}

enum PhotoChoice {
    Keep,
    Set(Option<Photo>),
}

/// The revision a local edit continues from, authorized for `principal`.
fn parent_of(
    db: &Connection,
    principal: &Principal,
    recipe_id: &str,
    base: Option<&str>,
) -> Result<Option<Revision>> {
    let head: Option<(String, String)> = db
        .query_row(
            "SELECT household_id, current_revision FROM shared_recipes WHERE id = ?",
            [recipe_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    let wanted = match (&head, base) {
        (Some((owner, _)), _) if owner != principal.household_id() => return Err(outside()),
        (_, Some(base)) => Some(base.to_owned()),
        (Some((_, current)), None) => Some(current.clone()),
        (None, None) => None,
    };
    let Some(wanted) = wanted else {
        return Ok(None);
    };
    match revision_payload(db, &wanted)? {
        Some((owner, revision)) if owner == recipe_id => Ok(Some(revision)),
        _ => Err(conflict()),
    }
}

fn append_revision(
    db: &Connection,
    principal: &Principal,
    effects: &mut Effects,
    parent: Option<&Revision>,
    mut recipe: Value,
    versions: Vec<NutritionVersion>,
    photo: PhotoChoice,
) -> Result<SavedRecipe> {
    let mut revision = Revision {
        id: Uuid::new_v4().to_string(),
        parent_id: parent.map(|parent| parent.id.clone()),
        cover_photo: match photo {
            PhotoChoice::Keep => parent.and_then(|parent| parent.cover_photo.clone()),
            PhotoChoice::Set(photo) => photo,
        },
        nutrition_versions: versions,
        recipe: std::mem::take(&mut recipe),
    };
    let recipe_id = revision.validate()?;
    let payload = serde_json::to_string(&revision).map_err(|_| invalid())?;
    insert_revision(db, principal, &revision, &recipe_id, &payload, effects)?;
    sync::record(
        db,
        effects,
        principal,
        "recipeRevision",
        &revision.id,
        &revision,
    )?;
    let current =
        current_recipe(db, principal.household_id(), &recipe_id)?.ok_or_else(Error::internal)?;
    Ok(SavedRecipe {
        saved_revision_id: revision.id,
        current,
    })
}

fn retained_versions(db: &Connection, recipe_id: &str) -> Result<Vec<NutritionVersion>> {
    let mut query =
        db.prepare("SELECT payload FROM nutrition_versions WHERE recipe_id = ? ORDER BY rowid")?;
    let payloads = query
        .query_map([recipe_id], |row| row.get::<_, String>(0))?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    payloads
        .iter()
        .map(|payload| Ok(serde_json::from_str(payload)?))
        .collect()
}

impl Core {
    /// Current recipes with cover photos, for display and planning.
    pub fn recipes(&self, principal: &Principal) -> Result<Vec<RecipeView>> {
        self.read(|db| current_recipe_views(db, principal.household_id()))
    }

    /// Every retained revision plus the current head of each recipe, for
    /// synchronization and conflict review.
    pub fn recipe_collection(&self, principal: &Principal) -> Result<Collection> {
        self.read(|db| {
            let mut query = db.prepare(
                "SELECT r.payload FROM recipe_revisions r JOIN shared_recipes s ON s.id = r.recipe_id WHERE s.household_id = ? AND s.held_back = 0 ORDER BY r.rowid",
            )?;
            let payloads = query
                .query_map([principal.household_id()], |row| row.get::<_, String>(0))?
                .collect::<std::result::Result<Vec<_>, _>>()?;
            let revisions = payloads
                .iter()
                .map(|payload| Ok(serde_json::from_str(payload)?))
                .collect::<Result<Vec<Value>>>()?;
            let mut query =
                db.prepare("SELECT id, current_revision FROM shared_recipes WHERE household_id = ? AND held_back = 0")?;
            let recipes = query
                .query_map([principal.household_id()], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                })?
                .collect::<std::result::Result<Vec<_>, _>>()?;
            let current = recipes
                .into_iter()
                .map(|(recipe_id, revision_id)| {
                    let mut competing_revision_ids = competing_revisions(db, &recipe_id)?;
                    let unresolved = competing_revision_ids.len().saturating_sub(1) as i64;
                    if unresolved == 0 {
                        competing_revision_ids.clear();
                    }
                    Ok(CurrentRecipe {
                        recipe_id,
                        revision_id,
                        unresolved,
                        competing_revision_ids,
                    })
                })
                .collect::<Result<Vec<_>>>()?;
            Ok(Collection { revisions, current })
        })
    }

    /// Server entry point: stores a revision created on another device. The
    /// revision is idempotent by identity and never replaces an existing one.
    pub fn ingest_recipe_revision(
        &self,
        principal: &Principal,
        mut revision: Revision,
    ) -> Result<()> {
        let recipe_id = revision.validate()?;
        let payload = serde_json::to_string(&revision).map_err(|_| invalid())?;
        self.write(|db, effects| {
            insert_revision(db, principal, &revision, &recipe_id, &payload, effects).map(|_| ())
        })
    }

    /// Saves an edit as a new revision. Nutrition changes mint a new retained
    /// nutrition version; unchanged nutrition keeps the existing one.
    pub fn save_recipe(&self, principal: &Principal, input: SaveRecipe) -> Result<SavedRecipe> {
        let draft: RecipeDraft = serde_json::from_value(input.recipe)
            .map_err(|_| Error::invalid("Check the recipe before saving."))?;
        let recipe = validate_recipe(draft).map_err(|errors| {
            Error::invalid("Check the recipe before saving.")
                .with_fields(serde_json::to_value(errors).unwrap_or(Value::Null))
        })?;
        let recipe_id = recipe.id.clone();
        let value = serde_json::to_value(&recipe).map_err(|_| Error::internal())?;
        self.write(|db, effects| {
            let parent = parent_of(db, principal, &recipe_id, input.base_revision_id.as_deref())?;
            let previous_version = parent
                .as_ref()
                .and_then(|parent| parent.recipe.get("nutritionVersionId")?.as_str())
                .map(str::to_owned);
            let previous = parent
                .as_ref()
                .map(|parent| {
                    let draft: RecipeDraft = serde_json::from_value(parent.recipe.clone())?;
                    validate_recipe(draft).map_err(|_| Error::internal())
                })
                .transpose()?;
            let change =
                nutrition::recipe_nutrition_change(recipe, previous).map_err(Error::invalid)?;
            let mut versions = retained_versions(db, &recipe_id)?;
            let version_id = match previous_version {
                Some(id) if !change.changed => id,
                _ => {
                    let id = Uuid::new_v4().to_string();
                    versions.push(NutritionVersion {
                        id: id.clone(),
                        recipe_id: recipe_id.clone(),
                        per_portion: change.per_portion,
                    });
                    id
                }
            };
            let mut value = value;
            value["nutritionVersionId"] = Value::String(version_id);
            let saved = append_revision(
                db,
                principal,
                effects,
                parent.as_ref(),
                value,
                versions,
                PhotoChoice::Keep,
            )?;
            Ok(saved)
        })
    }

    /// Adds, replaces, or removes the cover photo as a new revision of an
    /// otherwise unchanged recipe.
    pub fn set_recipe_cover_photo(
        &self,
        principal: &Principal,
        input: SetCoverPhoto,
    ) -> Result<SavedRecipe> {
        self.write(|db, effects| {
            let parent = parent_of(
                db,
                principal,
                &input.recipe_id,
                input.base_revision_id.as_deref(),
            )?
            .ok_or_else(|| Error::not_found("Recipe not found."))?;
            let versions = retained_versions(db, &input.recipe_id)?;
            append_revision(
                db,
                principal,
                effects,
                Some(&parent),
                parent.recipe.clone(),
                versions,
                PhotoChoice::Set(input.cover_photo),
            )
        })
    }

    /// Chooses among competing edits after review. Every alternative stays retained.
    pub fn choose_current_recipe(
        &self,
        principal: &Principal,
        recipe_id: &str,
        mut choice: CurrentChoice,
    ) -> Result<()> {
        self.write(|db, effects| {
            require_recipe(db, principal, recipe_id)?;
            let alternatives = competing_revisions(db, recipe_id)?;
            choice.expected_revision_ids.sort();
            if alternatives.len() < 2
                || alternatives != choice.expected_revision_ids
                || !alternatives.contains(&choice.revision_id)
            {
                return Err(Error::conflict(
                    "The competing recipe edits have changed. Review the latest alternatives and choose again.",
                ));
            }
            // Retain the payloads and nutrition identities. Only the reviewed competing
            // tips are dismissed; a later edit on either branch can conflict again.
            for revision_id in &alternatives {
                if revision_id != &choice.revision_id {
                    db.execute(
                        "INSERT INTO resolved_recipe_revisions (revision_id) VALUES (?)",
                        [revision_id],
                    )?;
                }
            }
            db.execute(
                "UPDATE shared_recipes SET current_revision = ? WHERE id = ?",
                params![choice.revision_id, recipe_id],
            )?;
            effects.household(principal, Topic::Recipes);
            Ok(())
        })
    }

    /// Every rating row of the person, including cleared ones.
    pub fn ratings(&self, principal: &Principal) -> Result<Vec<Rating>> {
        principal.require_personal()?;
        self.read(|db| {
            let mut query =
                db.prepare("SELECT recipe_id, value FROM recipe_ratings WHERE person_id = ?")?;
            Ok(query
                .query_map([principal.person_id()], |row| {
                    Ok(Rating {
                        recipe_id: row.get(0)?,
                        value: row.get(1)?,
                    })
                })?
                .collect::<std::result::Result<Vec<_>, _>>()?)
        })
    }

    /// Sets or clears the person's rating of a household recipe.
    pub fn rate_recipe(
        &self,
        principal: &Principal,
        recipe_id: &str,
        value: Option<u8>,
    ) -> Result<()> {
        principal.require_personal()?;
        if let Some(value) = value {
            rating::validate_recipe_rating(RecipeRating {
                person_id: principal.person_id().to_owned(),
                recipe_id: recipe_id.to_owned(),
                value: f64::from(value),
            })
            .map_err(Error::invalid)?;
        }
        self.write(|db, effects| {
            require_recipe(db, principal, recipe_id)?;
            db.execute(
                "INSERT INTO recipe_ratings (person_id, recipe_id, value) VALUES (?, ?, ?) ON CONFLICT(person_id, recipe_id) DO UPDATE SET value = excluded.value",
                params![principal.person_id(), recipe_id, value],
            )?;
            let change = RatingChange {
                id: Uuid::new_v4().to_string(),
                recipe_id: recipe_id.to_owned(),
                value,
            };
            sync::record(db, effects, principal, "rating", &change.id, &change)?;
            effects.person(principal, Topic::Ratings);
            Ok(())
        })
    }

    /// Server entry point: applies rating changes from another device,
    /// idempotent by change identity.
    pub fn apply_rating_changes(
        &self,
        principal: &Principal,
        changes: Vec<RatingChange>,
    ) -> Result<()> {
        self.write(|db, effects| {
            for change in changes {
                if change.id.trim().is_empty()
                    || change.value.is_some_and(|value| !(1..=5).contains(&value))
                {
                    return Err(invalid());
                }
                require_recipe(db, principal, &change.recipe_id)?;
                let payload = serde_json::to_string(&change).map_err(|_| invalid())?;
                let existing: Option<(String, String)> = db
                    .query_row(
                        "SELECT person_id, payload FROM rating_mutations WHERE id = ?",
                        [&change.id],
                        |row| Ok((row.get(0)?, row.get(1)?)),
                    )
                    .optional()?;
                if let Some((owner, previous)) = existing {
                    principal.require_person(&owner)?;
                    if previous != payload {
                        return Err(conflict());
                    }
                    continue;
                }
                db.execute(
                    "INSERT INTO recipe_ratings (person_id, recipe_id, value) VALUES (?, ?, ?) ON CONFLICT(person_id, recipe_id) DO UPDATE SET value = excluded.value",
                    params![principal.person_id(), change.recipe_id, change.value],
                )?;
                db.execute(
                    "INSERT INTO rating_mutations (id, person_id, payload) VALUES (?, ?, ?)",
                    params![change.id, principal.person_id(), payload],
                )?;
            }
            effects.person(principal, Topic::Ratings);
            Ok(())
        })
    }
}
