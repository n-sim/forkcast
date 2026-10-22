//! The household meal plan and shopping list. Both live in one versioned
//! planning document so edits from several devices merge together and a
//! conflict is retained for review rather than overwritten.

use crate::{
    AiRequest, Core,
    changes::{Effects, Topic},
    error::{Error, Result},
    principal::Principal,
    recipes::{self},
    sync,
};
use forkcast_recipe_domain::{
    calendar::cooking_time_rank,
    household_planning::{self, Conflict, GenerationAlias},
    ingredient_conversion::{
        self, ConversionOffer, EstimatedDimension, IngredientConversion, read_conversion_estimate,
    },
    planning::{PlannedCooking, validate_planned_cooking},
    recipe::RecipeDraft,
    shopping::{self, RecipeContribution, ShoppingItem},
};
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::BTreeMap;
use uuid::Uuid;

pub(crate) fn invalid_plan() -> Error {
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

/// Removes planned cookings of archived recipes dated on or after the day
/// they were archived, with any conflicts retained about them. Every replica
/// applies this one rule whenever it saves the plan, so a cooking planned
/// elsewhere before the archival arrived is withdrawn as the plan
/// synchronizes, and earlier cookings stay as they were.
fn withdraw(
    db: &Connection,
    household: &str,
    data: &mut Value,
    conflicts: &mut Vec<Conflict>,
) -> Result<usize> {
    let archived = recipes::archived_recipes(db, household)?;
    let Some(cookings) = data["cookings"].as_object_mut() else {
        return Ok(0);
    };
    let withdrawn: Vec<String> = cookings
        .iter()
        .filter(|(_, cooking)| {
            let since = cooking["recipeId"]
                .as_str()
                .and_then(|recipe| archived.get(recipe));
            let date = cooking["cookingDate"].as_str();
            matches!((since, date), (Some(since), Some(date)) if date >= since.as_str())
        })
        .map(|(id, _)| id.clone())
        .collect();
    for id in &withdrawn {
        cookings.remove(id);
    }
    conflicts.retain(|conflict| {
        !(conflict.path.first().map(String::as_str) == Some("cookings")
            && conflict
                .path
                .get(1)
                .is_some_and(|id| withdrawn.contains(id)))
    });
    Ok(withdrawn.len())
}

/// Applies the archival rule to the stored plan after a recipe's current
/// revision changed. Returns how many planned cookings were removed.
pub(crate) fn withdraw_archived(
    db: &Connection,
    principal: &Principal,
    effects: &mut Effects,
) -> Result<usize> {
    let household = principal.household_id();
    let current = snapshot(db, household)?;
    let mut data = current["data"].clone();
    let mut conflicts: Vec<Conflict> = serde_json::from_value(current["conflicts"].clone())?;
    let removed = withdraw(db, household, &mut data, &mut conflicts)?;
    if removed > 0 {
        persist(db, household, data, conflicts)?;
        effects.household(principal, Topic::Planning);
    }
    Ok(removed)
}

fn persist(
    db: &Connection,
    household: &str,
    mut data: Value,
    mut conflicts: Vec<Conflict>,
) -> Result<Value> {
    household_planning::apply_generation_aliases(&mut data, &generation_aliases(db, household)?);
    withdraw(db, household, &mut data, &mut conflicts)?;
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

pub(crate) fn snapshot(db: &Connection, household: &str) -> Result<Value> {
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

/// What a view of the plan was based on. An edit made from that view is
/// merged with anything that changed since, and retained for review when the
/// same field changed differently, instead of silently overwriting it.
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EditBase {
    pub base_revision: Option<String>,
    pub base_mutation_id: Option<String>,
    pub data: Value,
}

fn current_base(db: &Connection, data: &Value) -> Result<EditBase> {
    let (base_revision, base_mutation_id) = sync::planning_base(db)?;
    Ok(EditBase {
        base_revision,
        base_mutation_id,
        data: data.clone(),
    })
}

/// Only a profile that synchronizes needs to remember what a view was based
/// on; a standalone profile always edits the latest plan.
pub(crate) fn view_base(db: &Connection, data: &Value) -> Result<Option<EditBase>> {
    if sync::is_bound(db)? {
        current_base(db, data).map(Some)
    } else {
        Ok(None)
    }
}

/// Applies a change to the plan inside one serialized transaction. `change`
/// edits a copy of the base the person saw and also sees the latest data.
pub(crate) fn edit(
    db: &Connection,
    principal: &Principal,
    effects: &mut Effects,
    base: Option<EditBase>,
    change: impl FnOnce(&mut Value, &Value, &Connection) -> Result<()>,
) -> Result<Value> {
    let household = principal.household_id();
    let current = snapshot(db, household)?;
    let bound = sync::is_bound(db)?;
    let base = match base.filter(|_| bound) {
        Some(base) => base,
        None => current_base(db, &current["data"])?,
    };
    let mut incoming = base.data.clone();
    change(&mut incoming, &current["data"], db)?;
    let live = if bound {
        household_planning::merge(&base.data, &current["data"], &incoming).data
    } else {
        incoming.clone()
    };
    let conflicts: Vec<Conflict> = serde_json::from_value(current["conflicts"].clone())?;
    let saved = persist(db, household, live, conflicts)?;
    sync::record_planning(db, effects, principal, &base, &incoming)?;
    effects.household(principal, Topic::Planning);
    Ok(saved)
}

const MAX_CONVERSION_NAME_CHARS: usize = 200;

const CONVERSION_CONTRACT: &str = r#"Estimate how much a food ingredient weighs, so a shopping list can add an amount measured by volume or by count to an amount measured by mass.
Return only a JSON object, without Markdown, in this structure: {"grams":91,"note":"Olive oil is about 0.91 g/ml."}.
grams is the mass in grams of the reference amount named in the request, a positive finite number for a typical form of the ingredient. note states the assumption in up to 200 characters, or is null. Do not include any other fields."#;

/// An AI estimate of an ingredient's mass for one reference amount.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EstimateConversion {
    pub model: String,
    pub name: String,
    pub dimension: EstimatedDimension,
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
    /// Contributing recipes archived since the list was generated. Their
    /// contributions and the reviewed items stay as they are.
    pub archived_recipe_ids: Vec<String>,
    /// Generated items that need an accepted estimate before they can combine
    /// with the same ingredient measured another way.
    pub conversion_offers: Vec<ConversionOffer>,
    pub edit_base: Option<EditBase>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MealPlanView {
    pub cookings: Vec<PlannedCooking>,
    /// Names of archived recipes the remaining (earlier) cookings refer to.
    pub archived_recipes: BTreeMap<String, String>,
    pub edit_base: Option<EditBase>,
}

fn drafts(db: &Connection, household: &str) -> Result<Vec<RecipeDraft>> {
    recipes::current_recipe_views(db, household)?
        .into_iter()
        .map(|view| serde_json::from_value(view.recipe).map_err(|_| Error::internal()))
        .collect()
}

pub(crate) fn cookings(data: &Value) -> Result<Vec<PlannedCooking>> {
    data["cookings"]
        .as_object()
        .ok_or_else(invalid_plan)?
        .values()
        .map(|cooking| serde_json::from_value(cooking.clone()).map_err(|_| invalid_plan()))
        .collect()
}

/// The planned cookings a new shopping list draws on: earlier cookings of an
/// archived recipe stay in the plan but contribute nothing new.
fn shopping_sources(db: &Connection, household: &str, data: &Value) -> Result<Vec<PlannedCooking>> {
    let archived = recipes::archived_recipes(db, household)?;
    Ok(cookings(data)?
        .into_iter()
        .filter(|cooking| !archived.contains_key(&cooking.recipe_id))
        .collect())
}

fn source_status(
    list: &Value,
    data: &Value,
    sources: Vec<PlannedCooking>,
    recipes: Vec<RecipeDraft>,
) -> Result<SourceStatus> {
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
        sources,
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

    /// The household meal plan, ordered by day, time, then identity, with the
    /// base an edit made from this view should name.
    pub fn meal_plan(&self, principal: &Principal) -> Result<MealPlanView> {
        self.read(|db| {
            let data = snapshot(db, principal.household_id())?["data"].clone();
            let mut plan = cookings(&data)?;
            plan.sort_by(|a, b| {
                (
                    &a.cooking_date,
                    cooking_time_rank(a.cooking_time.as_deref()),
                    &a.id,
                )
                    .cmp(&(
                        &b.cooking_date,
                        cooking_time_rank(b.cooking_time.as_deref()),
                        &b.id,
                    ))
            });
            let mut archived_recipes =
                recipes::archived_recipe_names(db, principal.household_id())?;
            archived_recipes.retain(|id, _| plan.iter().any(|cooking| &cooking.recipe_id == id));
            Ok(MealPlanView {
                cookings: plan,
                archived_recipes,
                edit_base: view_base(db, &data)?,
            })
        })
    }

    /// Schedules (or reschedules) a recipe from the household collection.
    pub fn plan_cooking(
        &self,
        principal: &Principal,
        cooking: PlannedCooking,
        base: Option<EditBase>,
    ) -> Result<PlannedCooking> {
        let cooking = validate_planned_cooking(cooking).map_err(|errors| {
            Error::invalid("Check the planned cooking before saving.")
                .with_fields(serde_json::to_value(errors).unwrap_or(Value::Null))
        })?;
        self.write(|db, effects| {
            edit(db, principal, effects, base, |data, _, db| {
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

    pub fn remove_planned_cooking(
        &self,
        principal: &Principal,
        id: &str,
        base: Option<EditBase>,
    ) -> Result<()> {
        self.write(|db, effects| {
            edit(db, principal, effects, base, |data, _, _| {
                if let Some(cookings) = data["cookings"].as_object_mut() {
                    cookings.remove(id);
                }
                Ok(())
            })
            .map(|_| ())
        })
    }

    fn shopping_view(
        &self,
        db: &Connection,
        principal: &Principal,
    ) -> Result<Option<ShoppingListView>> {
        let household = principal.household_id();
        let data = snapshot(db, household)?["data"].clone();
        if data["shoppingList"].is_null() {
            return Ok(None);
        }
        let status = source_status(
            &data["shoppingList"],
            &data,
            shopping_sources(db, household, &data)?,
            drafts(db, household)?,
        )?;
        let archived = recipes::archived_recipes(db, household)?;
        let mut archived_recipe_ids: Vec<String> = data["shoppingList"]["contributions"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|contribution| contribution["recipeId"].as_str())
            .filter(|recipe| archived.contains_key(*recipe))
            .map(str::to_owned)
            .collect();
        archived_recipe_ids.sort();
        archived_recipe_ids.dedup();
        Ok(Some(ShoppingListView {
            list: data["shoppingList"].clone(),
            source_status: status,
            archived_recipe_ids,
            conversion_offers: ingredient_conversion::conversion_offers(&data["shoppingList"]),
            edit_base: view_base(db, &data)?,
        }))
    }

    /// The current shopping list with whether its sources have changed.
    pub fn shopping_list(&self, principal: &Principal) -> Result<Option<ShoppingListView>> {
        self.read(|db| self.shopping_view(db, principal))
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
        base: Option<EditBase>,
    ) -> Result<ShoppingListView> {
        self.write(|db, effects| {
            let generated_at = self.now();
            edit(db, principal, effects, base, |data, current, db| {
                if current["shoppingList"]["id"].as_str() != replacing_list_id {
                    return Err(Error::conflict(
                        "Your shopping list changed in another tab. Review it before replacing it.",
                    ));
                }
                let requirements = shopping::generate_shopping_requirements(
                    shopping_sources(db, principal.household_id(), current)?,
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
            self.shopping_view(db, principal)?
                .ok_or_else(Error::internal)
        })
    }

    fn change_list(
        &self,
        principal: &Principal,
        list_id: &str,
        base: Option<EditBase>,
        change: impl FnOnce(&mut Value) -> Result<()>,
    ) -> Result<ShoppingListView> {
        self.write(|db, effects| {
            edit(db, principal, effects, base, |data, _, _| {
                change(list_mut(data, list_id)?)
            })?;
            self.shopping_view(db, principal)?
                .ok_or_else(Error::internal)
        })
    }

    /// Changes a generated or manual item's quantity, or adds a manual item.
    pub fn save_shopping_item(
        &self,
        principal: &Principal,
        list_id: &str,
        kind: ShoppingItemKind,
        item: ShoppingItem,
        base: Option<EditBase>,
    ) -> Result<ShoppingListView> {
        let item = shopping::validate_shopping_item(item).map_err(Error::invalid)?;
        self.change_list(principal, list_id, base, |list| {
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
        base: Option<EditBase>,
    ) -> Result<ShoppingListView> {
        self.change_list(principal, list_id, base, |list| {
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
        base: Option<EditBase>,
    ) -> Result<ShoppingListView> {
        self.change_list(principal, list_id, base, |list| {
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
        base: Option<EditBase>,
    ) -> Result<ShoppingListView> {
        self.change_list(principal, list_id, base, |list| {
            list["completed"] = Value::Bool(true);
            Ok(())
        })
    }

    /// Asks the person's AI connection how much an ingredient weighs, as a
    /// suggestion to review. Stores nothing and changes no quantity: only
    /// [`Core::accept_ingredient_conversion`] applies an estimate.
    pub fn estimate_ingredient_conversion(
        &self,
        principal: &Principal,
        input: EstimateConversion,
    ) -> Result<IngredientConversion> {
        principal.require_personal()?;
        let name = input.name.trim();
        if name.is_empty() || name.chars().count() > MAX_CONVERSION_NAME_CHARS {
            return Err(Error::invalid("Name the ingredient to convert."));
        }
        let reference = match input.dimension {
            EstimatedDimension::Volume => "100 millilitres",
            EstimatedDimension::Count => "1 piece (one whole item)",
        };
        let text = self.ai_execute(
            principal,
            AiRequest {
                model: input.model,
                instructions: CONVERSION_CONTRACT.to_owned(),
                input: format!("Ingredient: {name}\nReference amount: {reference}"),
                image: None,
            },
        )?;
        read_conversion_estimate(&text, name, input.dimension).map_err(|detail| {
            Error::invalid(format!(
                "ChatGPT returned an invalid conversion estimate. {detail} Try again. Your shopping list was not changed."
            ))
        })
    }

    /// Applies an estimate the person accepted: the item measured by volume
    /// or count becomes grams and combines with the ingredient's mass.
    pub fn accept_ingredient_conversion(
        &self,
        principal: &Principal,
        list_id: &str,
        conversion: IngredientConversion,
        base: Option<EditBase>,
    ) -> Result<ShoppingListView> {
        self.change_list(principal, list_id, base, |list| {
            ingredient_conversion::accept_conversion(list, conversion, &Uuid::new_v4().to_string())
                .map_err(Error::invalid)
        })
    }

    /// Records that the person declined an estimate. The quantities stay
    /// separate, as they do when no AI connection exists.
    pub fn decline_ingredient_conversion(
        &self,
        principal: &Principal,
        list_id: &str,
        name: &str,
        dimension: EstimatedDimension,
        base: Option<EditBase>,
    ) -> Result<ShoppingListView> {
        self.change_list(principal, list_id, base, |list| {
            ingredient_conversion::decline_conversion(
                list,
                name,
                dimension,
                &Uuid::new_v4().to_string(),
            )
            .map_err(Error::invalid)
        })
    }
}
