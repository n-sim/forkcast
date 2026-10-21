//! Filling days of the household meal plan from the recipe collection,
//! either manually with a scheduling strategy or with AI from a request.
//! Both return a proposal to review; applying one replaces exactly its days
//! in one transaction, and only when the person confirmed every planned
//! cooking it replaces.

use crate::{
    AiRequest, Core,
    cooking::household_history,
    error::{Error, Result},
    planning::{EditBase, cookings, edit, invalid_plan, snapshot, view_base},
    principal::Principal,
    recipes::{current_recipe, current_recipe_views, person_ratings},
};
use forkcast_recipe_domain::{
    calendar::{date_of_epoch_day, dates_between, epoch_day, valid_date, weekday},
    plan_generation::{Candidate, SchedulingStrategy, read_generated_plan, schedule},
    planning::{PlannedCooking, validate_planned_cooking},
};
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::{BTreeSet, HashMap};
use uuid::Uuid;

/// The most days one proposal may fill.
const MAX_DAYS: usize = 31;
const MAX_REQUEST_CHARS: usize = 8000;
const DAY_MS: i64 = 86_400_000;
/// How far around the period the AI sees other planned cookings.
const CONTEXT_DAYS: i64 = 28;

const PLAN_CONTRACT: &str = r#"Plan cooking for a household from its recipe collection. Return only a JSON object, without Markdown, in this structure: {"cookings":[{"recipeId":"<id of a recipe in the collection>","cookingDate":"YYYY-MM-DD","portions":2,"cookingTime":"evening"}]}.
Choose recipes only from the collection, by their id; never invent or change recipes. Use only dates of the period. Plan at least one cooking. Several cookings may share a day, and days may stay empty when the request asks for it.
portions is the total number of portions to cook for the household and must be a positive number; omit it to cook the recipe's basePortions. cookingTime is morning, midday, evening or null.
In the collection, yourRating is the requesting person's rating from 1 (worst) to 5 (best), or null when unrated. timesCooked and lastCooked describe the household's recorded cooking. plannedNearby lists cookings already planned shortly before or after the period, which this plan does not change."#;

/// Manual scheduling: one recipe for each chosen day.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ScheduleCookings {
    pub dates: Vec<String>,
    /// Portions to cook on every chosen day.
    pub portions: f64,
    /// The person's own rating a recipe needs (1–5). Without one, unrated
    /// recipes are considered too.
    #[serde(default)]
    pub minimum_rating: Option<u8>,
    pub strategy: SchedulingStrategy,
}

/// AI scheduling: a request for the period from `start_date` to `end_date`.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GenerateCookingPlan {
    pub model: String,
    pub request: String,
    pub start_date: String,
    pub end_date: String,
}

/// Planned cookings to review before applying them. Nothing is saved yet.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CookingPlanProposal {
    /// The days applying this proposal replaces.
    pub dates: Vec<String>,
    pub cookings: Vec<PlannedCooking>,
    /// The planned cookings on those days now; applying removes them.
    pub replaced: Vec<PlannedCooking>,
    pub edit_base: Option<EditBase>,
}

/// Replaces the planned cookings on `dates` with `cookings`.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ApplyCookingPlan {
    pub dates: Vec<String>,
    pub cookings: Vec<PlannedCooking>,
    /// Identities of the planned cookings the person agreed to replace.
    /// Applying fails with `conflict` if any other cooking is on those days.
    #[serde(default)]
    pub replacing: Vec<String>,
    pub edit_base: Option<EditBase>,
}

fn chosen_dates(dates: Vec<String>) -> Result<Vec<String>> {
    let dates: BTreeSet<String> = dates.into_iter().collect();
    if dates.is_empty() || dates.len() > MAX_DAYS || !dates.iter().all(|date| valid_date(date)) {
        return Err(Error::invalid(format!(
            "Choose from 1 to {MAX_DAYS} valid days to plan."
        )));
    }
    Ok(dates.into_iter().collect())
}

fn on_dates(cooking: &PlannedCooking, dates: &[String]) -> bool {
    dates.contains(&cooking.cooking_date)
}

fn proposal(
    db: &Connection,
    principal: &Principal,
    dates: Vec<String>,
    cookings_to_plan: Vec<PlannedCooking>,
) -> Result<CookingPlanProposal> {
    let data = snapshot(db, principal.household_id())?["data"].clone();
    let mut replaced: Vec<PlannedCooking> = cookings(&data)?
        .into_iter()
        .filter(|cooking| on_dates(cooking, &dates))
        .collect();
    replaced.sort_by(|a, b| (&a.cooking_date, &a.id).cmp(&(&b.cooking_date, &b.id)));
    Ok(CookingPlanProposal {
        dates,
        cookings: cookings_to_plan,
        replaced,
        edit_base: view_base(db, &data)?,
    })
}

/// Recorded cookings, per recipe: (count, last cooked day).
fn recorded(db: &Connection, household: &str) -> Result<HashMap<String, (u64, i64)>> {
    Ok(household_history(db, household)?
        .into_iter()
        .map(|history| {
            (
                history.recipe_id,
                (
                    history.count.max(0) as u64,
                    history.last_cooked_at.div_euclid(DAY_MS),
                ),
            )
        })
        .collect())
}

fn ratings(db: &Connection, principal: &Principal) -> Result<HashMap<String, u8>> {
    Ok(person_ratings(db, principal.person_id())?
        .into_iter()
        .filter_map(|rating| Some((rating.recipe_id, rating.value?)))
        .collect())
}

impl Core {
    /// Proposes one recipe for each chosen day, from the current recipes that
    /// meet the minimum rating, ordered by the strategy. Cookings planned on
    /// other days count as upcoming cookings unless one was recorded since.
    pub fn schedule_cookings(
        &self,
        principal: &Principal,
        input: ScheduleCookings,
    ) -> Result<CookingPlanProposal> {
        let dates = chosen_dates(input.dates)?;
        if !(input.portions.is_finite() && input.portions > 0.0) {
            return Err(Error::invalid(
                "Portions to cook must be greater than zero.",
            ));
        }
        if let Some(minimum) = input.minimum_rating {
            principal.require_personal()?;
            if !(1..=5).contains(&minimum) {
                return Err(Error::invalid("Choose a minimum rating from 1 to 5 stars."));
            }
        }
        self.read(|db| {
            let household = principal.household_id();
            let recipes = current_recipe_views(db, household)?;
            if recipes.is_empty() {
                return Err(Error::invalid(
                    "Add a recipe to your collection to schedule cooking.",
                ));
            }
            let ratings = match input.minimum_rating {
                Some(_) => ratings(db, principal)?,
                None => HashMap::new(),
            };
            let recorded = recorded(db, household)?;
            let planned = cookings(&snapshot(db, household)?["data"])?;
            let candidates: Vec<Candidate> = recipes
                .iter()
                .filter_map(|view| {
                    let id = view.recipe["id"].as_str()?;
                    if let Some(minimum) = input.minimum_rating
                        && ratings.get(id).is_none_or(|rating| *rating < minimum)
                    {
                        return None;
                    }
                    let (mut count, recorded_day) = match recorded.get(id) {
                        Some((count, day)) => (*count, Some(*day)),
                        None => (0, None),
                    };
                    let mut last_day = recorded_day;
                    for day in planned
                        .iter()
                        .filter(|cooking| cooking.recipe_id == id && !on_dates(cooking, &dates))
                        .filter_map(|cooking| epoch_day(&cooking.cooking_date))
                        // A cooking recorded on or after its planned day was this one.
                        .filter(|day| recorded_day.is_none_or(|recorded| *day > recorded))
                    {
                        count += 1;
                        last_day = Some(last_day.map_or(day, |last| last.max(day)));
                    }
                    Some(Candidate {
                        recipe_id: id.to_owned(),
                        name: view.recipe["name"].as_str().unwrap_or_default().to_owned(),
                        count,
                        last_day,
                    })
                })
                .collect();
            if candidates.is_empty() {
                return Err(Error::invalid(format!(
                    "None of your recipes has your rating of at least {} {}. Choose a lower minimum rating or rate more recipes.",
                    input.minimum_rating.unwrap_or_default(),
                    if input.minimum_rating == Some(1) { "star" } else { "stars" },
                )));
            }
            let planned = schedule(&dates, candidates, input.strategy)
                .into_iter()
                .map(|(cooking_date, recipe_id)| PlannedCooking {
                    id: Uuid::new_v4().to_string(),
                    recipe_id,
                    cooking_date,
                    portions: Some(input.portions),
                    cooking_time: None,
                })
                .collect();
            proposal(db, principal, dates, planned)
        })
    }

    /// Asks the person's AI connection for a plan of the period, chosen only
    /// from the current recipes. An invalid reply fails as a whole; nothing
    /// is saved either way.
    pub fn generate_cooking_plan(
        &self,
        principal: &Principal,
        input: GenerateCookingPlan,
    ) -> Result<CookingPlanProposal> {
        principal.require_personal()?;
        let dates =
            dates_between(&input.start_date, &input.end_date, MAX_DAYS).ok_or_else(|| {
                Error::invalid(format!(
                    "Choose a period of 1 to {MAX_DAYS} days, ending on or after its first day."
                ))
            })?;
        let request = input.request.trim();
        if request.is_empty() || request.chars().count() > MAX_REQUEST_CHARS {
            return Err(Error::invalid(format!(
                "Describe the cooking plan in up to {MAX_REQUEST_CHARS} characters."
            )));
        }
        let preferences = self.ai_preferences(principal)?;
        let (context, recipes) = self.read(|db| {
            let household = principal.household_id();
            let ratings = ratings(db, principal)?;
            let recorded = recorded(db, household)?;
            let views = current_recipe_views(db, household)?;
            let recipes: Vec<(String, f64)> = views
                .iter()
                .filter_map(|view| {
                    Some((
                        view.recipe["id"].as_str()?.to_owned(),
                        view.recipe["basePortions"].as_f64()?,
                    ))
                })
                .collect();
            let collection: Vec<Value> = views
                .iter()
                .map(|view| {
                    let recipe = &view.recipe;
                    let id = recipe["id"].as_str().unwrap_or_default();
                    let (times_cooked, last_cooked) = match recorded.get(id) {
                        Some((count, day)) => (*count, date_of_epoch_day(*day)),
                        None => (0, None),
                    };
                    json!({
                        "id": id,
                        "name": recipe["name"],
                        "label": recipe.get("label").cloned().unwrap_or(Value::Null),
                        "basePortions": recipe["basePortions"],
                        "difficulty": recipe.get("difficulty").cloned().unwrap_or(Value::Null),
                        "activeMinutes": recipe.get("activeMinutes").cloned().unwrap_or(Value::Null),
                        "totalMinutes": recipe.get("totalMinutes").cloned().unwrap_or(Value::Null),
                        "ingredients": recipe["ingredients"]
                            .as_array()
                            .into_iter()
                            .flatten()
                            .map(|ingredient| ingredient["name"].clone())
                            .collect::<Vec<_>>(),
                        "yourRating": ratings.get(id),
                        "timesCooked": times_cooked,
                        "lastCooked": last_cooked,
                    })
                })
                .collect();
            let (first, last) = (
                epoch_day(&dates[0]).ok_or_else(Error::internal)?,
                epoch_day(&dates[dates.len() - 1]).ok_or_else(Error::internal)?,
            );
            let mut nearby: Vec<PlannedCooking> = cookings(&snapshot(db, household)?["data"])?
                .into_iter()
                .filter(|cooking| {
                    epoch_day(&cooking.cooking_date).is_some_and(|day| {
                        (first - CONTEXT_DAYS..first).contains(&day)
                            || (last + 1..=last + CONTEXT_DAYS).contains(&day)
                    })
                })
                .collect();
            nearby.sort_by(|a, b| a.cooking_date.cmp(&b.cooking_date));
            let context = json!({
                "period": dates
                    .iter()
                    .map(|date| json!({"date": date, "weekday": weekday(date)}))
                    .collect::<Vec<_>>(),
                "collection": collection,
                "plannedNearby": nearby
                    .iter()
                    .map(|cooking| json!({
                        "recipeId": cooking.recipe_id,
                        "cookingDate": cooking.cooking_date,
                        "portions": cooking.portions,
                    }))
                    .collect::<Vec<_>>(),
            });
            Ok((context, recipes))
        })?;
        if recipes.is_empty() {
            return Err(Error::invalid(
                "Add recipes to your collection before generating a cooking plan.",
            ));
        }
        let text = self.ai_execute(
            principal,
            AiRequest {
                model: input.model,
                instructions: format!(
                    "{PLAN_CONTRACT}\n\nPersonal preferences:\n{}",
                    preferences.plan_prompt
                ),
                input: format!("Collection and period:\n{context}\n\nRequest:\n{request}"),
            },
        )?;
        let planned = read_generated_plan(&text, &recipes, &dates, || {
            Uuid::new_v4().to_string()
        })
        .map_err(|detail| {
            Error::invalid(format!(
                "ChatGPT returned an invalid cooking plan. {detail} Try again, perhaps with clearer instructions. Your meal plan was not changed."
            ))
        })?;
        self.read(|db| proposal(db, principal, dates, planned))
    }

    /// Replaces every planned cooking on `dates` with `cookings`, in one
    /// transaction that also queues the change for synchronization. Other
    /// days are untouched. Fails with `conflict`, changing nothing, when a
    /// cooking on those days is not one the person agreed to replace.
    pub fn apply_cooking_plan(
        &self,
        principal: &Principal,
        input: ApplyCookingPlan,
    ) -> Result<Vec<PlannedCooking>> {
        let dates = chosen_dates(input.dates)?;
        let mut planned = Vec::with_capacity(input.cookings.len());
        let mut ids = BTreeSet::new();
        for cooking in input.cookings {
            let cooking = validate_planned_cooking(cooking).map_err(|errors| {
                Error::invalid("Check the planned cookings before applying them.")
                    .with_fields(serde_json::to_value(errors).unwrap_or(Value::Null))
            })?;
            if !on_dates(&cooking, &dates) {
                return Err(Error::invalid(
                    "Planned cookings must be on the days being planned.",
                ));
            }
            if !ids.insert(cooking.id.clone()) {
                return Err(Error::invalid(
                    "Each planned cooking needs its own identity.",
                ));
            }
            planned.push(cooking);
        }
        let replacing: BTreeSet<String> = input.replacing.into_iter().collect();
        self.write(|db, effects| {
            let household = principal.household_id();
            edit(db, principal, effects, input.edit_base, |data, current, db| {
                for cooking in cookings(current)? {
                    if on_dates(&cooking, &dates) && !replacing.contains(&cooking.id) {
                        return Err(Error::conflict(
                            "The meal plan for these days changed. Review it again before replacing it.",
                        ));
                    }
                    if ids.contains(&cooking.id) && !on_dates(&cooking, &dates) {
                        return Err(Error::invalid(
                            "Each planned cooking needs its own identity.",
                        ));
                    }
                }
                for cooking in &planned {
                    if current_recipe(db, household, &cooking.recipe_id)?.is_none() {
                        return Err(Error::invalid(
                            "Choose current recipes for your household meal plan.",
                        ));
                    }
                }
                let existing = data["cookings"].as_object_mut().ok_or_else(invalid_plan)?;
                existing.retain(|_, cooking| {
                    !cooking["cookingDate"]
                        .as_str()
                        .is_some_and(|date| dates.iter().any(|chosen| chosen == date))
                });
                for cooking in &planned {
                    existing.insert(cooking.id.clone(), serde_json::to_value(cooking)?);
                }
                Ok(())
            })?;
            Ok(planned)
        })
    }
}
