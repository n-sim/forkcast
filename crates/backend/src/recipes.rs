use crate::{
    ApiError,
    auth::{Authenticated, Scope},
    store::Store,
};
use axum::{
    Json, Router,
    extract::{DefaultBodyLimit, Path, State},
    http::StatusCode,
    routing::{get, post},
};
use base64::{Engine, engine::general_purpose::STANDARD};
use forkcast_recipe_domain::{
    nutrition::NutritionVersion,
    recipe::{RecipeDraft, validate_recipe},
};
use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
use serde::{Deserialize, Serialize};
use serde_json::Value;

pub fn routes() -> Router<Store> {
    Router::new()
        .route("/households/{id}/recipes", get(collection))
        .route(
            "/households/{id}/recipe-revisions",
            post(save_revision).layer(DefaultBodyLimit::max(15 * 1024 * 1024)),
        )
        .route(
            "/accounts/{id}/recipe-ratings",
            get(ratings).post(save_ratings),
        )
}

fn invalid() -> ApiError {
    ApiError(
        StatusCode::UNPROCESSABLE_ENTITY,
        "Check the recipe, cover photo, and retained nutrition versions.",
    )
}

fn conflict() -> ApiError {
    ApiError(
        StatusCode::CONFLICT,
        "A revision or nutrition identity cannot be replaced. Your local changes have been kept.",
    )
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Photo {
    mime: String,
    data: String,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Revision {
    id: String,
    parent_id: Option<String>,
    recipe: Value,
    nutrition_versions: Vec<NutritionVersion>,
    cover_photo: Option<Photo>,
}

impl Revision {
    fn validate(&mut self) -> Result<String, ApiError> {
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
        // Both runtimes use the shared calculation; tolerate floating-point JSON round trips.
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
        self.recipe = serde_json::to_value(recipe).map_err(|_| ApiError::internal())?;
        self.recipe["nutritionVersionId"] = Value::String(version_id);
        Ok(id)
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Collection {
    revisions: Vec<Value>,
    current: Vec<CurrentRecipe>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CurrentRecipe {
    recipe_id: String,
    revision_id: String,
    unresolved: i64,
}

async fn collection(
    State(store): State<Store>,
    auth: Authenticated,
    Path(id): Path<String>,
) -> Result<Json<Collection>, ApiError> {
    auth.require(Scope::Household(&id))?;
    store.run(move |db| {
        let transaction = db.transaction()?;
        let db = &transaction;
        let mut query = db.prepare("SELECT r.payload FROM recipe_revisions r JOIN shared_recipes s ON s.id = r.recipe_id WHERE s.household_id = ? ORDER BY r.rowid")?;
        let payloads = query.query_map([&id], |row| row.get::<_, String>(0))?.collect::<Result<Vec<_>, _>>()?;
        let revisions = payloads.iter().map(|payload| serde_json::from_str(payload).map_err(|_| ApiError::internal())).collect::<Result<Vec<_>, _>>()?;
        let mut query = db.prepare("SELECT s.id, s.current_revision, (SELECT COUNT(*) FROM recipe_revisions r WHERE r.recipe_id = s.id AND NOT EXISTS (SELECT 1 FROM recipe_revisions child WHERE child.parent_id = r.id)) FROM shared_recipes s WHERE s.household_id = ?")?;
        let current = query.query_map([id], |row| Ok(CurrentRecipe { recipe_id: row.get(0)?, revision_id: row.get(1)?, unresolved: row.get::<_, i64>(2)?.saturating_sub(1) }))?.collect::<Result<Vec<_>, _>>()?;
        Ok(Json(Collection { revisions, current }))
    }).await
}

fn require_recipe(db: &Connection, auth: &Authenticated, id: &str) -> Result<(), ApiError> {
    let owner: String = db
        .query_row(
            "SELECT household_id FROM shared_recipes WHERE id = ?",
            [id],
            |row| row.get(0),
        )
        .optional()?
        .ok_or(ApiError(StatusCode::NOT_FOUND, "Recipe not found."))?;
    auth.require(Scope::Household(&owner))
}

async fn save_revision(
    State(store): State<Store>,
    auth: Authenticated,
    Path(household): Path<String>,
    Json(mut revision): Json<Revision>,
) -> Result<StatusCode, ApiError> {
    auth.require(Scope::Household(&household))?;
    let recipe_id = revision.validate()?;
    let payload = serde_json::to_string(&revision).map_err(|_| invalid())?;
    store.run(move |db| {
        let transaction = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let owner: Option<String> = transaction.query_row("SELECT household_id FROM shared_recipes WHERE id = ?", [&recipe_id], |row| row.get(0)).optional()?;
        if let Some(owner) = owner { auth.require(Scope::Household(&owner))?; }
        let existing: Option<String> = transaction.query_row("SELECT payload FROM recipe_revisions WHERE id = ?", [&revision.id], |row| row.get(0)).optional()?;
        if let Some(existing) = existing {
            if existing != payload { return Err(conflict()); }
            return Ok(StatusCode::NO_CONTENT);
        }
        if let Some(parent) = &revision.parent_id {
            let parent_recipe: Option<String> = transaction.query_row("SELECT recipe_id FROM recipe_revisions WHERE id = ?", [parent], |row| row.get(0)).optional()?;
            if parent_recipe.as_deref() != Some(&recipe_id) { return Err(conflict()); }
        }
        transaction.execute("INSERT OR IGNORE INTO shared_recipes (id, household_id, current_revision) VALUES (?, ?, ?)", params![recipe_id, household, revision.id])?;
        for version in &revision.nutrition_versions {
            let payload = serde_json::to_string(version).map_err(|_| invalid())?;
            let existing: Option<String> = transaction.query_row("SELECT payload FROM nutrition_versions WHERE id = ?", [&version.id], |row| row.get(0)).optional()?;
            if existing.as_ref().is_some_and(|existing| existing != &payload) { return Err(conflict()); }
            transaction.execute("INSERT OR IGNORE INTO nutrition_versions (id, recipe_id, payload) VALUES (?, ?, ?)", params![version.id, recipe_id, payload])?;
        }
        transaction.execute("INSERT INTO recipe_revisions (id, recipe_id, parent_id, payload) VALUES (?, ?, ?, ?)", params![revision.id, recipe_id, revision.parent_id, payload])?;
        // Only a direct successor advances current. Competing branches remain retained leaves.
        transaction.execute("UPDATE shared_recipes SET current_revision = ? WHERE id = ? AND current_revision = ?", params![revision.id, recipe_id, revision.parent_id])?;
        transaction.commit()?;
        Ok(StatusCode::NO_CONTENT)
    }).await
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RatingChange {
    id: String,
    recipe_id: String,
    value: Option<u8>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RatingChanges {
    changes: Vec<RatingChange>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Rating {
    recipe_id: String,
    value: Option<u8>,
}

async fn ratings(
    State(store): State<Store>,
    auth: Authenticated,
    Path(id): Path<String>,
) -> Result<Json<Vec<Rating>>, ApiError> {
    auth.require(Scope::Personal(&id))?;
    store
        .run(move |db| {
            let mut query =
                db.prepare("SELECT recipe_id, value FROM recipe_ratings WHERE account_id = ?")?;
            let ratings = query
                .query_map([id], |row| {
                    Ok(Rating {
                        recipe_id: row.get(0)?,
                        value: row.get(1)?,
                    })
                })?
                .collect::<Result<Vec<_>, _>>()?;
            Ok(Json(ratings))
        })
        .await
}

async fn save_ratings(
    State(store): State<Store>,
    auth: Authenticated,
    Path(id): Path<String>,
    Json(input): Json<RatingChanges>,
) -> Result<StatusCode, ApiError> {
    auth.require(Scope::Personal(&id))?;
    store.run(move |db| {
        let transaction = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
        for change in input.changes {
            if change.id.trim().is_empty() || change.value.is_some_and(|value| !(1..=5).contains(&value)) { return Err(invalid()); }
            require_recipe(&transaction, &auth, &change.recipe_id)?;
            let payload = serde_json::to_string(&change).map_err(|_| invalid())?;
            let existing: Option<(String, String)> = transaction.query_row("SELECT account_id, payload FROM rating_mutations WHERE id = ?", [&change.id], |row| Ok((row.get(0)?, row.get(1)?))).optional()?;
            if let Some((owner, previous)) = existing {
                auth.require(Scope::Personal(&owner))?;
                if previous != payload { return Err(conflict()); }
                continue;
            }
            transaction.execute("INSERT INTO recipe_ratings (account_id, recipe_id, value) VALUES (?, ?, ?) ON CONFLICT(account_id, recipe_id) DO UPDATE SET value = excluded.value", params![id, change.recipe_id, change.value])?;
            transaction.execute("INSERT INTO rating_mutations (id, account_id, payload) VALUES (?, ?, ?)", params![change.id, id, payload])?;
        }
        transaction.commit()?;
        Ok(StatusCode::NO_CONTENT)
    }).await
}
