//! The household meal plan and shopping list. Both live in one versioned
//! planning document so edits from several devices merge together and a
//! conflict is retained for review rather than overwritten.

use crate::{
    Core,
    changes::{Effects, Topic},
    error::{Error, Result},
    principal::Principal,
    recipes::{self},
    sync,
};
use forkcast_recipe_domain::{
    household_planning::{self, Conflict, GenerationAlias},
    planning::{PlannedCooking, validate_planned_cooking},
    recipe::RecipeDraft,
    shopping::{self, RecipeContribution, ShoppingItem},
};
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::BTreeMap;
use uuid::Uuid;

fn invalid_plan() -> Error {
    Error::invalid("Check the shared meal plan, shopping list, and referenced recipes.")
}

fn generation_aliases(
    db: &Connection,
    household: &str,
) -> Result<BTreeMap<String, GenerationAlias>> {
    let mut query = db.prepare(
        "SELECT source_id, payload FROM planning_generation_aliases WHERE household_id = ?",
    )?;
    let rows = query
        .query_map([household], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    rows.into_iter()
        .map(|(source, payload)| Ok((source, serde_json::from_str(&payload)?)))
        .collect()
}

fn persist(
    db: &Connection,
    household: &str,
    mut data: Value,
    conflicts: Vec<Conflict>,
) -> Result<Value> {
    household_planning::apply_generation_aliases(&mut data, &generation_aliases(db, household)?);
    validate_data(db, household, &data)?;
    let revision = Uuid::new_v4().to_string();
    let saved = json!({"revision": revision, "data": data, "conflicts": conflicts});
    let payload = saved.to_string();
    db.execute(
        "INSERT INTO planning_versions (id, household_id, payload) VALUES (?, ?, ?)",
        params![revision, household, payload],
    )?;
    db.execute(
        "INSERT INTO household_planning (household_id, payload) VALUES (?, ?) ON CONFLICT(household_id) DO UPDATE SET payload = excluded.payload",
        params![household, payload],
    )?;
    Ok(saved)
}

fn validate_data(db: &Connection, household: &str, data: &Value) -> Result<()> {
    household_planning::validate(data).map_err(|_| invalid_plan())?;
    for cooking in data["cookings"]
        .as_object()
        .ok_or_else(invalid_plan)?
        .values()
    {
        if !db.query_row(
            "SELECT EXISTS(SELECT 1 FROM shared_recipes WHERE id = ? AND household_id = ? AND held_back = 0)",
            params![cooking["recipeId"].as_str(), household],
            |row| row.get::<_, bool>(0),
        )? {
            return Err(invalid_plan());
        }
    }
    Ok(())
}

pub(crate) fn local_snapshot(db: &Connection, household: &str) -> Result<Value> {
    snapshot(db, household)
}

fn snapshot(db: &Connection, household: &str) -> Result<Value> {
    let payload: Option<String> = db
        .query_row(
            "SELECT payload FROM household_planning WHERE household_id = ?",
            [household],
            |row| row.get(0),
        )
        .optional()?;
    match payload {
        Some(payload) => Ok(serde_json::from_str(&payload)?),
        None => Ok(json!({"revision": null, "data": household_planning::empty(), "conflicts": []})),
    }
}

/// A device's edit of the planning document, with what it started from.
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PlanningMutation {
    pub id: String,
    pub base_revision: Option<String>,
    pub base_mutation_id: Option<String>,
    pub base_data: Option<Value>,
    pub data: Value,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PlanningChoice {
    pub conflict: Conflict,
    pub value: Value,
}

/// Merges `input` into the current document, retaining conflicts. Idempotent
/// by mutation identity.
fn merge_mutation(
    db: &Connection,
    principal: &Principal,
    input: PlanningMutation,
    effects: &mut Effects,
) -> Result<Value> {
    let household = principal.household_id();
    if input.id.trim().is_empty() {
        return Err(Error::invalid("The planning change needs an identity."));
    }
    validate_data(db, household, &input.data)?;
    if let Some(base) = &input.base_data {
        validate_data(db, household, base)?;
    }
    let payload = serde_json::to_string(&input)?;
    let previous: Option<(String, String)> = db
        .query_row(
            "SELECT household_id, payload FROM planning_mutations WHERE id = ?",
            [&input.id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    if let Some((owner, previous)) = previous {
        if owner != household || previous != payload {
            return Err(Error::conflict(
                "This planning change identity has already been used.",
            ));
        }
        return snapshot(db, household);
    }
    let current = snapshot(db, household)?;
    let base = if let Some(mutation_id) = &input.base_mutation_id {
        let payload: String = db
            .query_row(
                "SELECT payload FROM planning_mutations WHERE id = ? AND household_id = ?",
                params![mutation_id, household],
                |row| row.get(0),
            )
            .optional()?
            .ok_or_else(|| {
                Error::conflict(
                    "The preceding planning change is unavailable. Your changes have been kept.",
                )
            })?;
        serde_json::from_str::<Value>(&payload)?["data"].clone()
    } else {
        match &input.base_revision {
            None => household_planning::empty(),
            Some(revision) => {
                let payload: String = db
                    .query_row(
                        "SELECT payload FROM planning_versions WHERE id = ? AND household_id = ?",
                        params![revision, household],
                        |row| row.get(0),
                    )
                    .optional()?
                    .ok_or_else(|| {
                        Error::conflict(
                            "The planning base is unavailable. Your changes have been kept.",
                        )
                    })?;
                serde_json::from_str::<Value>(&payload)?["data"].clone()
            }
        }
    };
    // Compare exactly what the edit saw. A device's merged live contents
    // can differ from its preceding mutation's submitted contents.
    let mut expected = input.base_data.clone().unwrap_or(base);
    let mut incoming = input.data.clone();
    let aliases = generation_aliases(db, household)?;
    household_planning::apply_generation_aliases(&mut expected, &aliases);
    household_planning::apply_generation_aliases(&mut incoming, &aliases);
    let merged = household_planning::merge(&expected, &current["data"], &incoming);
    // Only an actual regeneration can join an equivalent generation.
    // A manual-item edit on an older list must retain its old epoch.
    if expected["shoppingList"]["id"] != incoming["shoppingList"]["id"]
        && let Some((source, alias)) =
            household_planning::equivalent_generation(&incoming, &merged.data)
    {
        db.execute(
            "INSERT INTO planning_generation_aliases (household_id, source_id, payload) VALUES (?, ?, ?)",
            params![household, source, serde_json::to_string(&alias)?],
        )?;
    }
    let mut conflicts: Vec<Conflict> = serde_json::from_value(current["conflicts"].clone())?;
    household_planning::retain_conflicts(
        &mut conflicts,
        merged.conflicts,
        &current["data"],
        &merged.data,
    );
    let saved = persist(db, household, merged.data, conflicts)?;
    db.execute(
        "INSERT INTO planning_mutations (id, household_id, payload) VALUES (?, ?, ?)",
        params![input.id, household, payload],
    )?;
    effects.household(principal, Topic::Planning);
    Ok(saved)
}

/// A local edit applies to the latest document inside one serialized
/// transaction, so it cannot be based on stale contents.
fn edit(
    db: &Connection,
    principal: &Principal,
    effects: &mut Effects,
    change: impl FnOnce(&mut Value, &Connection) -> Result<()>,
) -> Result<Value> {
    let household = principal.household_id();
    let current = snapshot(db, household)?;
    let base = current["data"].clone();
    let mut data = base.clone();
    change(&mut data, db)?;
    let conflicts: Vec<Conflict> = serde_json::from_value(current["conflicts"].clone())?;
    let saved = persist(db, household, data.clone(), conflicts)?;
    sync::record_planning(db, effects, principal, &base, &data)?;
    effects.household(principal, Topic::Planning);
    Ok(saved)
}

#[derive(Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ShoppingItemKind {
    Generated,
    Manual,
}

impl ShoppingItemKind {
    fn field(self) -> &'static str {
        match self {
            Self::Generated => "items",
            Self::Manual => "manualItems",
        }
    }
}

#[derive(Clone, Copy, Serialize, PartialEq, Eq, Debug)]
#[serde(rename_all = "camelCase")]
pub enum SourceStatus {
    /// The planned recipes no longer match what the list was generated from.
    Changed,
    Unchanged,
    /// An older list did not record cooking times, so only known fields match.
    Unknown,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShoppingListView {
    pub list: Value,
    pub source_status: SourceStatus,
}

fn drafts(db: &Connection, household: &str) -> Result<Vec<RecipeDraft>> {
    recipes::current_recipe_views(db, household)?
        .into_iter()
        .map(|view| serde_json::from_value(view.recipe).map_err(|_| Error::internal()))
        .collect()
}

fn cookings(data: &Value) -> Result<Vec<PlannedCooking>> {
    data["cookings"]
        .as_object()
        .ok_or_else(invalid_plan)?
        .values()
        .map(|cooking| serde_json::from_value(cooking.clone()).map_err(|_| invalid_plan()))
        .collect()
}

fn source_status(list: &Value, data: &Value, recipes: Vec<RecipeDraft>) -> Result<SourceStatus> {
    let mut contributions = list["contributions"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    let mut unknown = false;
    for contribution in &mut contributions {
        if contribution.get("cookingTime").is_none() {
            unknown = true;
            // Older lists did not capture cooking times; only compare known source fields.
            contribution["cookingTime"] = data["cookings"]
                [contribution["cookingId"].as_str().unwrap_or_default()]
            .get("cookingTime")
            .cloned()
            .unwrap_or(Value::Null);
        }
    }
    let contributions: Vec<RecipeContribution> =
        serde_json::from_value(Value::Array(contributions)).map_err(|_| invalid_plan())?;
    if shopping::shopping_source_changed(
        cookings(data)?,
        recipes,
        contributions,
        list["startDate"].as_str().unwrap_or_default(),
        list["endDate"].as_str().unwrap_or_default(),
    ) {
        Ok(SourceStatus::Changed)
    } else if unknown {
        Ok(SourceStatus::Unknown)
    } else {
        Ok(SourceStatus::Unchanged)
    }
}

fn list_mut<'a>(data: &'a mut Value, list_id: &str) -> Result<&'a mut Value> {
    if data["shoppingList"]["id"].as_str() == Some(list_id) {
        Ok(&mut data["shoppingList"])
    } else {
        Err(Error::conflict(
            "This shopping list is unavailable. Review the current list.",
        ))
    }
}

fn find_item<'a>(list: &'a mut Value, item_id: &str) -> Option<&'a mut Value> {
    let generated = list["items"].as_array().is_some_and(|items| {
        items
            .iter()
            .any(|item| item["id"].as_str() == Some(item_id))
    });
    list[if generated { "items" } else { "manualItems" }]
        .as_array_mut()?
        .iter_mut()
        .find(|item| item["id"].as_str() == Some(item_id))
}

impl Core {
    /// Server entry point: the planning document, its revision, and any
    /// retained conflicts.
    pub fn planning_snapshot(&self, principal: &Principal) -> Result<Value> {
        self.read(|db| snapshot(db, principal.household_id()))
    }

    /// Server entry point: merges a device's edit into the household document.
    pub fn submit_planning(&self, principal: &Principal, input: PlanningMutation) -> Result<Value> {
        self.write(|db, effects| merge_mutation(db, principal, input, effects))
    }

    /// Resolves one retained conflict by choosing one of its values.
    pub fn resolve_planning_conflict(
        &self,
        principal: &Principal,
        input: PlanningChoice,
    ) -> Result<Value> {
        self.write(|db, effects| {
            let household = principal.household_id();
            let current = snapshot(db, household)?;
            let mut conflicts: Vec<Conflict> =
                serde_json::from_value(current["conflicts"].clone())?;
            let index = conflicts
                .iter()
                .position(|conflict| *conflict == input.conflict)
                .filter(|_| input.conflict.values.contains(&input.value))
                .ok_or_else(|| {
                    Error::conflict(
                        "The competing changes changed. Review the latest alternatives.",
                    )
                })?;
            let data =
                household_planning::choose(&current["data"], &input.conflict.path, &input.value)
                    .ok_or_else(|| {
                        Error::conflict("The record changed. Review the latest alternatives.")
                    })?;
            conflicts.remove(index);
            let saved = persist(db, household, data, conflicts)?;
            effects.household(principal, Topic::Planning);
            Ok(saved)
        })
    }

    /// The household meal plan, ordered by day, time, then identity.
    pub fn meal_plan(&self, principal: &Principal) -> Result<Vec<PlannedCooking>> {
        self.read(|db| {
            let mut plan = cookings(&snapshot(db, principal.household_id())?["data"])?;
            plan.sort_by(|a, b| {
                (&a.cooking_date, &a.cooking_time, &a.id).cmp(&(
                    &b.cooking_date,
                    &b.cooking_time,
                    &b.id,
                ))
            });
            Ok(plan)
        })
    }

    /// Schedules (or reschedules) a recipe from the household collection.
    pub fn plan_cooking(
        &self,
        principal: &Principal,
        cooking: PlannedCooking,
    ) -> Result<PlannedCooking> {
        let cooking = validate_planned_cooking(cooking).map_err(|errors| {
            Error::invalid("Check the planned cooking before saving.")
                .with_fields(serde_json::to_value(errors).unwrap_or(Value::Null))
        })?;
        self.write(|db, effects| {
            edit(db, principal, effects, |data, db| {
                if recipes::current_recipe(db, principal.household_id(), &cooking.recipe_id)?
                    .is_none()
                {
                    return Err(Error::invalid(
                        "Choose a current recipe for your household meal plan.",
                    ));
                }
                data["cookings"][&cooking.id] = serde_json::to_value(&cooking)?;
                Ok(())
            })?;
            Ok(cooking)
        })
    }

    pub fn remove_planned_cooking(&self, principal: &Principal, id: &str) -> Result<()> {
        self.write(|db, effects| {
            edit(db, principal, effects, |data, _| {
                if let Some(cookings) = data["cookings"].as_object_mut() {
                    cookings.remove(id);
                }
                Ok(())
            })
            .map(|_| ())
        })
    }

    /// The current shopping list with whether its sources have changed.
    pub fn shopping_list(&self, principal: &Principal) -> Result<Option<ShoppingListView>> {
        self.read(|db| {
            let data = snapshot(db, principal.household_id())?["data"].clone();
            if data["shoppingList"].is_null() {
                return Ok(None);
            }
            let status = source_status(
                &data["shoppingList"],
                &data,
                drafts(db, principal.household_id())?,
            )?;
            Ok(Some(ShoppingListView {
                list: data["shoppingList"].clone(),
                source_status: status,
            }))
        })
    }

    /// Generates a list from the planned cookings in the period. Manual items
    /// carry over unchecked. `replacing_list_id` must name the list the person
    /// reviewed, so a list changed elsewhere is never replaced unseen.
    pub fn generate_shopping_list(
        &self,
        principal: &Principal,
        start_date: &str,
        end_date: &str,
        replacing_list_id: Option<&str>,
    ) -> Result<ShoppingListView> {
        self.write(|db, effects| {
            let generated_at = self.now();
            edit(db, principal, effects, |data, db| {
                if data["shoppingList"]["id"].as_str() != replacing_list_id {
                    return Err(Error::conflict(
                        "Your shopping list changed in another tab. Review it before replacing it.",
                    ));
                }
                let requirements = shopping::generate_shopping_requirements(
                    cookings(data)?,
                    drafts(db, principal.household_id())?,
                    start_date,
                    end_date,
                )
                .map_err(Error::invalid)?;
                let mut requirements = serde_json::to_value(requirements)?;
                for item in requirements["items"].as_array_mut().into_iter().flatten() {
                    item["id"] = Value::String(Uuid::new_v4().to_string());
                }
                let manual: Vec<Value> = data["shoppingList"]["manualItems"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .cloned()
                    .map(|mut item| {
                        item["checked"] = Value::Bool(false);
                        item
                    })
                    .collect();
                data["shoppingList"] = json!({
                    "id": Uuid::new_v4().to_string(),
                    "startDate": start_date,
                    "endDate": end_date,
                    "generatedAt": generated_at,
                    "items": requirements["items"],
                    "contributions": requirements["contributions"],
                    "manualItems": manual,
                });
                Ok(())
            })?;
            let data = snapshot(db, principal.household_id())?["data"].clone();
            Ok(ShoppingListView {
                source_status: source_status(
                    &data["shoppingList"],
                    &data,
                    drafts(db, principal.household_id())?,
                )?,
                list: data["shoppingList"].clone(),
            })
        })
    }

    fn change_list(
        &self,
        principal: &Principal,
        list_id: &str,
        change: impl FnOnce(&mut Value) -> Result<()>,
    ) -> Result<ShoppingListView> {
        self.write(|db, effects| {
            edit(db, principal, effects, |data, _| {
                change(list_mut(data, list_id)?)
            })?;
            let data = snapshot(db, principal.household_id())?["data"].clone();
            Ok(ShoppingListView {
                source_status: source_status(
                    &data["shoppingList"],
                    &data,
                    drafts(db, principal.household_id())?,
                )?,
                list: data["shoppingList"].clone(),
            })
        })
    }

    /// Changes a generated or manual item's quantity, or adds a manual item.
    pub fn save_shopping_item(
        &self,
        principal: &Principal,
        list_id: &str,
        kind: ShoppingItemKind,
        item: ShoppingItem,
    ) -> Result<ShoppingListView> {
        let item = shopping::validate_shopping_item(item).map_err(Error::invalid)?;
        self.change_list(principal, list_id, |list| {
            let items = list[kind.field()]
                .as_array_mut()
                .ok_or_else(Error::internal)?;
            if let Some(current) = items.iter_mut().find(|current| current["id"] == item.id) {
                current["quantity"] = json!(item.quantity);
            } else if kind == ShoppingItemKind::Manual {
                let mut item = serde_json::to_value(&item)?;
                item["checked"] = Value::Bool(false);
                items.push(item);
            } else {
                return Err(Error::conflict(
                    "This generated item has been removed. Review the current list.",
                ));
            }
            Ok(())
        })
    }

    pub fn remove_shopping_item(
        &self,
        principal: &Principal,
        list_id: &str,
        kind: ShoppingItemKind,
        item_id: &str,
    ) -> Result<ShoppingListView> {
        self.change_list(principal, list_id, |list| {
            if let Some(items) = list[kind.field()].as_array_mut() {
                items.retain(|item| item["id"].as_str() != Some(item_id));
            }
            Ok(())
        })
    }

    pub fn check_shopping_item(
        &self,
        principal: &Principal,
        list_id: &str,
        item_id: &str,
        checked: bool,
    ) -> Result<ShoppingListView> {
        self.change_list(principal, list_id, |list| {
            let item = find_item(list, item_id).ok_or_else(|| {
                Error::conflict("This item has been removed. Review the current list.")
            })?;
            item["checked"] = Value::Bool(checked);
            Ok(())
        })
    }

    pub fn complete_shopping_list(
        &self,
        principal: &Principal,
        list_id: &str,
    ) -> Result<ShoppingListView> {
        self.change_list(principal, list_id, |list| {
            list["completed"] = Value::Bool(true);
            Ok(())
        })
    }
}
