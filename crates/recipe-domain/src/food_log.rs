use crate::{
    calendar::{valid_date, valid_time},
    recipe::FieldError,
};
use serde::{Deserialize, Serialize};

#[derive(Clone, Deserialize, Serialize)]
pub struct Nutrition {
    pub calories: Option<f64>,
    pub protein: Option<f64>,
    pub fat: Option<f64>,
    pub carbohydrates: Option<f64>,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManualFoodLogEntry {
    pub id: String,
    pub description: String,
    // Consumption uses the entered local calendar date and time. Reopening in
    // another timezone must not move a meal to a different day.
    pub consumed_at: String,
    pub nutrition: Nutrition,
}

pub fn validate_manual_entry(
    mut entry: ManualFoodLogEntry,
) -> Result<ManualFoodLogEntry, Vec<FieldError>> {
    let mut errors = vec![];
    for (path, value, message) in [
        ("id", entry.id.as_str(), "The entry needs an identity."),
        (
            "description",
            entry.description.as_str(),
            "Enter a food description.",
        ),
    ] {
        if value.trim().is_empty() {
            errors.push(FieldError {
                path: path.into(),
                message: message.into(),
            });
        }
    }
    if !valid_consumption_time(&entry.consumed_at) {
        errors.push(FieldError {
            path: "consumedAt".into(),
            message: "Enter a valid consumption date and time.".into(),
        });
    }
    for (path, label, value) in [
        ("calories", "Calories", entry.nutrition.calories),
        ("protein", "Protein", entry.nutrition.protein),
        ("fat", "Fat", entry.nutrition.fat),
        (
            "carbohydrates",
            "Carbohydrates",
            entry.nutrition.carbohydrates,
        ),
    ] {
        if value.is_some_and(|value| !value.is_finite() || value < 0.0) {
            errors.push(FieldError {
                path: format!("nutrition.{path}"),
                message: format!("{label} must be zero or more, or left unknown."),
            });
        }
    }
    if !errors.is_empty() {
        return Err(errors);
    }
    entry.description = entry.description.trim().to_owned();
    Ok(entry)
}

fn valid_consumption_time(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 16 && bytes[10] == b'T' && valid_date(&value[..10]) && valid_time(&value[11..])
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NutrientTotal {
    pub known_value: Option<f64>,
    pub unknown_entries: usize,
}

#[derive(Serialize)]
pub struct DailyNutrition {
    pub calories: NutrientTotal,
    pub protein: NutrientTotal,
    pub fat: NutrientTotal,
    pub carbohydrates: NutrientTotal,
}

#[derive(Serialize)]
pub struct DailyFoodLog {
    pub entries: Vec<ManualFoodLogEntry>,
    pub totals: DailyNutrition,
    pub incomplete: bool,
}

pub fn daily_manual_food_log(
    entries: Vec<ManualFoodLogEntry>,
    date: &str,
) -> Result<DailyFoodLog, String> {
    if !valid_date(date) {
        return Err("Choose a valid food log date.".into());
    }
    let mut selected = vec![];
    for entry in entries {
        let entry = validate_manual_entry(entry).map_err(
            |_| "A saved food-log entry could not be read. Your stored data has been kept.",
        )?;
        if entry.consumed_at.starts_with(date) {
            selected.push(entry);
        }
    }
    selected.sort_by(|a, b| a.consumed_at.cmp(&b.consumed_at).then(a.id.cmp(&b.id)));
    let sum = |get: fn(&Nutrition) -> Option<f64>| {
        let mut known_value = if selected.is_empty() { Some(0.0) } else { None };
        let mut unknown_entries = 0;
        for entry in &selected {
            match get(&entry.nutrition) {
                Some(value) => known_value = Some(known_value.unwrap_or(0.0) + value),
                None => unknown_entries += 1,
            }
        }
        if known_value.is_some_and(|value| !value.is_finite()) {
            return Err("Daily nutrition exceeds the calculation range.");
        }
        Ok(NutrientTotal {
            known_value,
            unknown_entries,
        })
    };
    let totals = DailyNutrition {
        calories: sum(|n| n.calories)?,
        protein: sum(|n| n.protein)?,
        fat: sum(|n| n.fat)?,
        carbohydrates: sum(|n| n.carbohydrates)?,
    };
    let incomplete = [
        &totals.calories,
        &totals.protein,
        &totals.fat,
        &totals.carbohydrates,
    ]
    .iter()
    .any(|total| total.unknown_entries > 0);
    Ok(DailyFoodLog {
        entries: selected,
        totals,
        incomplete,
    })
}
