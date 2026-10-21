use crate::{
    calendar::{valid_date, valid_time},
    nutrition::{Nutrition, NutritionVersion},
    recipe::FieldError,
};
use serde::{Deserialize, Serialize};

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
    entry.nutrition.validate(&mut errors);
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

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecipeFoodLogEntry {
    pub id: String,
    pub recipe_id: String,
    pub recipe_name: String,
    pub nutrition_version_id: String,
    pub consumed_at: String,
    pub portions: Option<f64>,
}

pub fn validate_recipe_entry(
    entry: RecipeFoodLogEntry,
) -> Result<RecipeFoodLogEntry, Vec<FieldError>> {
    let mut errors = vec![];
    for (path, valid, message) in [
        (
            "id",
            !entry.id.trim().is_empty(),
            "The entry needs an identity.",
        ),
        (
            "recipeId",
            !entry.recipe_id.trim().is_empty() && !entry.recipe_name.trim().is_empty(),
            "Choose a recipe from your collection.",
        ),
        (
            "nutritionVersionId",
            !entry.nutrition_version_id.trim().is_empty(),
            "The recipe needs a nutrition version.",
        ),
        (
            "consumedAt",
            valid_consumption_time(&entry.consumed_at),
            "Enter a valid consumption date and time.",
        ),
        (
            "portions",
            entry.portions.is_some_and(|n| n.is_finite() && n > 0.0),
            "Portions eaten must be greater than zero.",
        ),
    ] {
        if !valid {
            errors.push(FieldError {
                path: path.into(),
                message: message.into(),
            });
        }
    }
    if errors.is_empty() {
        Ok(entry)
    } else {
        Err(errors)
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FoodLogEntry {
    #[serde(flatten)]
    pub food: ManualFoodLogEntry,
    pub recipe_id: Option<String>,
    pub nutrition_version_id: Option<String>,
    pub portions: Option<f64>,
    /// The linked recipe has since been archived: the entry keeps its
    /// nutrition but no longer leads to the recipe.
    pub recipe_archived: bool,
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
    pub entries: Vec<FoodLogEntry>,
    pub totals: DailyNutrition,
    pub incomplete: bool,
}

pub fn daily_food_log(
    manual_entries: Vec<ManualFoodLogEntry>,
    recipe_entries: Vec<RecipeFoodLogEntry>,
    versions: Vec<NutritionVersion>,
    date: &str,
) -> Result<DailyFoodLog, String> {
    if !valid_date(date) {
        return Err("Choose a valid food log date.".into());
    }
    let mut selected = vec![];
    for entry in manual_entries {
        let entry = validate_manual_entry(entry).map_err(
            |_| "A saved food-log entry could not be read. Your stored data has been kept.",
        )?;
        if entry.consumed_at.starts_with(date) {
            selected.push(FoodLogEntry {
                food: entry,
                recipe_id: None,
                nutrition_version_id: None,
                portions: None,
                recipe_archived: false,
            });
        }
    }
    for entry in recipe_entries {
        let entry = validate_recipe_entry(entry).map_err(|_| "A saved recipe-linked food-log entry could not be read. Your stored data has been kept.")?;
        let version = versions.iter().find(|version| version.id == entry.nutrition_version_id && version.recipe_id == entry.recipe_id)
            .ok_or("A food-log entry's retained nutrition version could not be read. Your stored data has been kept.")?;
        let mut errors = vec![];
        version.per_portion.validate(&mut errors);
        if !errors.is_empty() {
            return Err("A retained nutrition version contains invalid values. Your stored data has been kept.".into());
        }
        let nutrition = version
            .per_portion
            .scale(entry.portions.unwrap_or_default())?;
        if entry.consumed_at.starts_with(date) {
            selected.push(FoodLogEntry {
                food: ManualFoodLogEntry {
                    id: entry.id,
                    description: entry.recipe_name,
                    consumed_at: entry.consumed_at,
                    nutrition,
                },
                recipe_id: Some(entry.recipe_id),
                nutrition_version_id: Some(entry.nutrition_version_id),
                portions: entry.portions,
                recipe_archived: false,
            });
        }
    }
    selected.sort_by(|a, b| {
        a.food
            .consumed_at
            .cmp(&b.food.consumed_at)
            .then(a.food.id.cmp(&b.food.id))
    });
    let sum = |get: fn(&Nutrition) -> Option<f64>| {
        let mut known_value = if selected.is_empty() { Some(0.0) } else { None };
        let mut unknown_entries = 0;
        for entry in &selected {
            match get(&entry.food.nutrition) {
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
