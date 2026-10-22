//! Filling a period of the meal plan from the recipe collection: manual
//! scheduling strategies, and reading a plan an AI generated.

use crate::{
    calendar::{epoch_day, valid_cooking_time},
    planning::{PlannedCooking, validate_planned_cooking},
};
use serde::{Deserialize, Serialize};
use std::cmp::Ordering;

/// How manual scheduling orders the recipes it may choose.
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum SchedulingStrategy {
    /// Recipes never cooked first, then those whose last cooking is oldest.
    LastCookedLongestAgo,
    /// Recipes cooked the fewest times first.
    LeastOftenCooked,
}

/// A recipe manual scheduling may choose, with its household cooking record.
pub struct Candidate {
    pub recipe_id: String,
    pub name: String,
    /// Recorded cookings plus cookings still planned outside the period.
    pub count: u64,
    /// The latest recorded or planned cooking, in days since 1970-01-01.
    pub last_day: Option<i64>,
}

fn compare(a: &Candidate, b: &Candidate, strategy: SchedulingStrategy) -> Ordering {
    let recency = a.last_day.cmp(&b.last_day);
    let frequency = a.count.cmp(&b.count);
    match strategy {
        SchedulingStrategy::LastCookedLongestAgo => recency.then(frequency),
        SchedulingStrategy::LeastOftenCooked => frequency.then(recency),
    }
    .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    .then_with(|| a.recipe_id.cmp(&b.recipe_id))
}

/// Chooses one recipe for each date, in date order. A chosen recipe counts
/// as cooked on its date before the next date is filled, so recipes rotate
/// when there are fewer of them than dates. Returns `(date, recipe_id)`.
pub fn schedule(
    dates: &[String],
    mut candidates: Vec<Candidate>,
    strategy: SchedulingStrategy,
) -> Vec<(String, String)> {
    let mut dates: Vec<&String> = dates.iter().collect();
    dates.sort();
    let mut chosen = Vec::with_capacity(dates.len());
    for date in dates {
        let Some(day) = epoch_day(date) else {
            continue;
        };
        let Some(best) = candidates.iter_mut().min_by(|a, b| compare(a, b, strategy)) else {
            break;
        };
        chosen.push((date.clone(), best.recipe_id.clone()));
        best.count += 1;
        best.last_day = Some(best.last_day.map_or(day, |last| last.max(day)));
    }
    chosen
}

/// The most cookings a generated plan may hold per day of its period.
pub const MAX_GENERATED_COOKINGS_PER_DAY: usize = 6;

#[derive(Deserialize)]
struct GeneratedPlan {
    cookings: Vec<GeneratedCooking>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GeneratedCooking {
    recipe_id: String,
    cooking_date: String,
    #[serde(default)]
    portions: Option<f64>,
    #[serde(default)]
    cooking_time: Option<String>,
}

/// Reads an AI reply as planned cookings: each names a recipe from
/// `recipes` (`(id, base portions)`), a date from `dates`, positive portions
/// (the recipe's base yield when omitted), and an optional part of the day.
/// Anything else rejects the whole reply, so a plan is never applied in part.
pub fn read_generated_plan(
    text: &str,
    recipes: &[(String, f64)],
    dates: &[String],
    mut new_id: impl FnMut() -> String,
) -> Result<Vec<PlannedCooking>, String> {
    let plan: GeneratedPlan = serde_json::from_str(crate::unfenced(text))
        .map_err(|_| "The reply was not a cooking plan in the requested format.".to_owned())?;
    if plan.cookings.is_empty() {
        return Err("The reply did not plan any cooking.".to_owned());
    }
    if plan.cookings.len() > dates.len() * MAX_GENERATED_COOKINGS_PER_DAY {
        return Err("The reply planned more cookings than the period can hold.".to_owned());
    }
    plan.cookings
        .into_iter()
        .map(|cooking| {
            let base = recipes
                .iter()
                .find(|(id, _)| *id == cooking.recipe_id)
                .map(|(_, base)| *base)
                .ok_or("The reply chose a recipe that is not in your collection.")?;
            if !dates.contains(&cooking.cooking_date) {
                return Err("The reply planned cooking outside the selected period.".to_owned());
            }
            let cooking_time = cooking.cooking_time.filter(|time| !time.is_empty());
            if cooking_time
                .as_deref()
                .is_some_and(|time| !valid_cooking_time(time))
            {
                return Err(
                    "The reply used a cooking time other than morning, midday or evening."
                        .to_owned(),
                );
            }
            validate_planned_cooking(PlannedCooking {
                id: new_id(),
                recipe_id: cooking.recipe_id,
                cooking_date: cooking.cooking_date,
                portions: Some(cooking.portions.unwrap_or(base)),
                cooking_time,
            })
            .map_err(|_| "The reply planned an invalid number of portions.".to_owned())
        })
        .collect()
}
