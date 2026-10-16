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
use forkcast_recipe_domain::household_planning::{self, Conflict, GenerationAlias};
use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::BTreeMap;
use uuid::Uuid;

fn generation_aliases(
    db: &Connection,
    household: &str,
) -> Result<BTreeMap<String, GenerationAlias>, ApiError> {
    let mut query = db.prepare(
        "SELECT source_id, payload FROM planning_generation_aliases WHERE household_id = ?",
    )?;
    let rows = query
        .query_map([household], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    rows.into_iter()
        .map(|(source, payload)| {
            Ok((
                source,
                serde_json::from_str(&payload).map_err(|_| ApiError::internal())?,
            ))
        })
        .collect()
}

pub fn routes() -> Router<Store> {
    Router::new()
        .route(
            "/households/{id}/planning/resolve",
            post(resolve).layer(DefaultBodyLimit::max(16 * 1024 * 1024)),
        )
        .route(
            "/households/{id}/planning",
            get(load)
                .post(save)
                .layer(DefaultBodyLimit::max(4 * 1024 * 1024)),
        )
}

fn persist(
    db: &Connection,
    household: &str,
    mut data: Value,
    conflicts: Vec<Conflict>,
) -> Result<Value, ApiError> {
    household_planning::apply_generation_aliases(&mut data, &generation_aliases(db, household)?);
    validate_data(db, household, &data)?;
    let revision = Uuid::new_v4().to_string();
    let saved = json!({"revision": revision, "data": data, "conflicts": conflicts});
    let payload = saved.to_string();
    db.execute(
        "INSERT INTO planning_versions (id, household_id, payload) VALUES (?, ?, ?)",
        params![revision, household, payload],
    )?;
    db.execute("INSERT INTO household_planning (household_id, payload) VALUES (?, ?) ON CONFLICT(household_id) DO UPDATE SET payload = excluded.payload", params![household, payload])?;
    Ok(saved)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Choice {
    conflict: Conflict,
    value: Value,
}

async fn resolve(
    State(store): State<Store>,
    auth: Authenticated,
    Path(household): Path<String>,
    Json(input): Json<Choice>,
) -> Result<Json<Value>, ApiError> {
    auth.require(Scope::Household(&household))?;
    store
        .run(move |db| {
            let transaction = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let current = snapshot(&transaction, &household)?;
            let mut conflicts: Vec<Conflict> = serde_json::from_value(current["conflicts"].clone())
                .map_err(|_| ApiError::internal())?;
            let index = conflicts
                .iter()
                .position(|conflict| *conflict == input.conflict)
                .filter(|_| input.conflict.values.contains(&input.value))
                .ok_or(ApiError(
                    StatusCode::CONFLICT,
                    "The competing changes changed. Review the latest alternatives.",
                ))?;
            let data =
                household_planning::choose(&current["data"], &input.conflict.path, &input.value)
                    .ok_or(ApiError(
                        StatusCode::CONFLICT,
                        "The record changed. Review the latest alternatives.",
                    ))?;
            conflicts.remove(index);
            let saved = persist(&transaction, &household, data, conflicts)?;
            transaction.commit()?;
            Ok(Json(saved))
        })
        .await
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Mutation {
    id: String,
    base_revision: Option<String>,
    base_mutation_id: Option<String>,
    base_data: Option<Value>,
    data: Value,
}

fn validate_data(db: &Connection, household: &str, data: &Value) -> Result<(), ApiError> {
    let invalid = || {
        ApiError(
            StatusCode::UNPROCESSABLE_ENTITY,
            "Check the shared meal plan, shopping list, and referenced recipes.",
        )
    };
    household_planning::validate(data).map_err(|_| invalid())?;
    for cooking in data["cookings"].as_object().ok_or_else(invalid)?.values() {
        if !db.query_row(
            "SELECT EXISTS(SELECT 1 FROM shared_recipes WHERE id = ? AND household_id = ?)",
            params![cooking["recipeId"].as_str(), household],
            |row| row.get::<_, bool>(0),
        )? {
            return Err(invalid());
        }
    }
    Ok(())
}

fn snapshot(db: &Connection, household: &str) -> Result<Value, ApiError> {
    let payload: Option<String> = db
        .query_row(
            "SELECT payload FROM household_planning WHERE household_id = ?",
            [household],
            |row| row.get(0),
        )
        .optional()?;
    payload.map(|payload| serde_json::from_str(&payload).map_err(|_| ApiError::internal()))
        .unwrap_or_else(|| Ok(json!({"revision": null, "data": {"cookings": {}, "shoppingList": null}, "conflicts": []})))
}

async fn load(
    State(store): State<Store>,
    auth: Authenticated,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    auth.require(Scope::Household(&id))?;
    store.run(move |db| Ok(Json(snapshot(db, &id)?))).await
}

async fn save(
    State(store): State<Store>,
    auth: Authenticated,
    Path(household): Path<String>,
    Json(input): Json<Mutation>,
) -> Result<Json<Value>, ApiError> {
    auth.require(Scope::Household(&household))?;
    store.run(move |db| {
        let transaction = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
        if input.id.trim().is_empty() { return Err(ApiError(StatusCode::UNPROCESSABLE_ENTITY, "The planning change needs an identity.")); }
        validate_data(&transaction, &household, &input.data)?;
        if let Some(base) = &input.base_data {
            validate_data(&transaction, &household, base)?;
        }
        let payload = serde_json::to_string(&input).map_err(|_| ApiError::internal())?;
        let previous: Option<(String, String)> = transaction.query_row(
            "SELECT household_id, payload FROM planning_mutations WHERE id = ?", [&input.id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        ).optional()?;
        if let Some((owner, previous)) = previous {
            if owner != household || previous != payload {
                return Err(ApiError(StatusCode::CONFLICT, "This planning change identity has already been used."));
            }
            return Ok(Json(snapshot(&transaction, &household)?));
        }
        let current = snapshot(&transaction, &household)?;
        let base = if let Some(mutation_id) = &input.base_mutation_id {
            let payload: String = transaction.query_row(
                "SELECT payload FROM planning_mutations WHERE id = ? AND household_id = ?",
                params![mutation_id, household], |row| row.get(0),
            ).optional()?.ok_or(ApiError(StatusCode::CONFLICT, "The preceding planning change is unavailable. Your changes have been kept."))?;
            serde_json::from_str::<Value>(&payload).map_err(|_| ApiError::internal())?["data"].clone()
        } else { match &input.base_revision {
            None => household_planning::empty(),
            Some(revision) => {
                let payload: String = transaction.query_row(
                    "SELECT payload FROM planning_versions WHERE id = ? AND household_id = ?",
                    params![revision, household], |row| row.get(0),
                ).optional()?.ok_or(ApiError(StatusCode::CONFLICT, "The planning base is unavailable. Your changes have been kept."))?;
                serde_json::from_str::<Value>(&payload).map_err(|_| ApiError::internal())?["data"].clone()
            }
        }};
        // Compare exactly what the edit saw. A device's merged live contents
        // can differ from its preceding mutation's submitted contents.
        let mut expected = input.base_data.clone().unwrap_or(base);
        let mut incoming = input.data.clone();
        let aliases = generation_aliases(&transaction, &household)?;
        household_planning::apply_generation_aliases(&mut expected, &aliases);
        household_planning::apply_generation_aliases(&mut incoming, &aliases);
        let merged = household_planning::merge(&expected, &current["data"], &incoming);
        // Only an actual regeneration can join an equivalent generation.
        // A manual-item edit on an older list must retain its old epoch.
        if expected["shoppingList"]["id"] != incoming["shoppingList"]["id"]
            && let Some((source, alias)) = household_planning::equivalent_generation(&incoming, &merged.data) {
            let payload = serde_json::to_string(&alias).map_err(|_| ApiError::internal())?;
            transaction.execute("INSERT INTO planning_generation_aliases (household_id, source_id, payload) VALUES (?, ?, ?)", params![household, source, payload])?;
        }
        let mut conflicts: Vec<Conflict> = serde_json::from_value(current["conflicts"].clone()).map_err(|_| ApiError::internal())?;
        household_planning::retain_conflicts(&mut conflicts, merged.conflicts, &current["data"], &merged.data);
        let saved = persist(&transaction, &household, merged.data, conflicts)?;
        transaction.execute("INSERT INTO planning_mutations (id, household_id, payload) VALUES (?, ?, ?)", params![input.id, household, payload])?;
        transaction.commit()?;
        Ok(Json(saved))
    }).await
}
