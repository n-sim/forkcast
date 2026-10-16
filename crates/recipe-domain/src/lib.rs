pub mod calendar;
pub mod cooking;
pub mod food_log;
pub mod nutrition;
pub mod planning;
pub mod quantities;
pub mod rating;
pub mod recipe;
pub mod shopping;

use serde::Serialize;
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub fn validate_shopping_item(value: JsValue) -> Result<JsValue, JsValue> {
    let item = shopping::validate_shopping_item(serde_wasm_bindgen::from_value(value)?)
        .map_err(|error| JsValue::from_str(&error))?;
    Ok(serde_wasm_bindgen::to_value(&item)?)
}

#[wasm_bindgen]
pub fn generate_shopping_requirements(
    cookings: JsValue,
    recipes: JsValue,
    start_date: &str,
    end_date: &str,
) -> Result<JsValue, JsValue> {
    let requirements = shopping::generate_shopping_requirements(
        serde_wasm_bindgen::from_value(cookings)?,
        serde_wasm_bindgen::from_value(recipes)?,
        start_date,
        end_date,
    )
    .map_err(|error| JsValue::from_str(&error))?;
    Ok(serde_wasm_bindgen::to_value(&requirements)?)
}

#[wasm_bindgen]
pub fn recipe_nutrition(value: JsValue) -> Result<JsValue, JsValue> {
    let draft = serde_wasm_bindgen::from_value(value)?;
    let recipe = recipe::validate_recipe(draft)
        .map_err(|_| JsValue::from_str("Check the recipe nutrition and base portions."))?;
    let per_portion = recipe
        .nutrition
        .scale(1.0 / recipe.base_portions)
        .map_err(|error| JsValue::from_str(&error))?;
    let serializer = serde_wasm_bindgen::Serializer::new().serialize_missing_as_null(true);
    Ok(per_portion.serialize(&serializer)?)
}

#[wasm_bindgen]
pub fn recipe_nutrition_change(value: JsValue, previous: JsValue) -> Result<JsValue, JsValue> {
    let draft = serde_wasm_bindgen::from_value(value)?;
    let previous: Option<recipe::RecipeDraft> = serde_wasm_bindgen::from_value(previous)?;
    let invalid = || JsValue::from_str("Check the recipe nutrition and base portions.");
    let recipe = recipe::validate_recipe(draft).map_err(|_| invalid())?;
    let previous = previous
        .map(recipe::validate_recipe)
        .transpose()
        .map_err(|_| invalid())?;
    let change = nutrition::recipe_nutrition_change(recipe, previous)
        .map_err(|error| JsValue::from_str(&error))?;
    let serializer = serde_wasm_bindgen::Serializer::new().serialize_missing_as_null(true);
    Ok(change.serialize(&serializer)?)
}

#[derive(Serialize)]
struct PlannedCookingValidation {
    cooking: Option<planning::PlannedCooking>,
    errors: Vec<recipe::FieldError>,
}

#[wasm_bindgen]
pub fn validate_planned_cooking(value: JsValue) -> Result<JsValue, JsValue> {
    let cooking = serde_wasm_bindgen::from_value(value)?;
    let result = match planning::validate_planned_cooking(cooking) {
        Ok(cooking) => PlannedCookingValidation {
            cooking: Some(cooking),
            errors: vec![],
        },
        Err(errors) => PlannedCookingValidation {
            cooking: None,
            errors,
        },
    };
    let serializer = serde_wasm_bindgen::Serializer::new().serialize_missing_as_null(true);
    Ok(result.serialize(&serializer)?)
}

#[derive(Serialize)]
struct ManualEntryValidation {
    entry: Option<food_log::ManualFoodLogEntry>,
    errors: Vec<recipe::FieldError>,
}

#[derive(Serialize)]
struct RecipeEntryValidation {
    entry: Option<food_log::RecipeFoodLogEntry>,
    errors: Vec<recipe::FieldError>,
}

#[wasm_bindgen]
pub fn validate_recipe_food_log_entry(value: JsValue) -> Result<JsValue, JsValue> {
    let entry = serde_wasm_bindgen::from_value(value)?;
    let result = match food_log::validate_recipe_entry(entry) {
        Ok(entry) => RecipeEntryValidation {
            entry: Some(entry),
            errors: vec![],
        },
        Err(errors) => RecipeEntryValidation {
            entry: None,
            errors,
        },
    };
    let serializer = serde_wasm_bindgen::Serializer::new().serialize_missing_as_null(true);
    Ok(result.serialize(&serializer)?)
}

#[wasm_bindgen]
pub fn validate_manual_food_log_entry(value: JsValue) -> Result<JsValue, JsValue> {
    let entry = serde_wasm_bindgen::from_value(value)?;
    let result = match food_log::validate_manual_entry(entry) {
        Ok(entry) => ManualEntryValidation {
            entry: Some(entry),
            errors: vec![],
        },
        Err(errors) => ManualEntryValidation {
            entry: None,
            errors,
        },
    };
    let serializer = serde_wasm_bindgen::Serializer::new().serialize_missing_as_null(true);
    Ok(result.serialize(&serializer)?)
}

#[wasm_bindgen]
pub fn daily_food_log(
    manual_entries: JsValue,
    recipe_entries: JsValue,
    versions: JsValue,
    date: &str,
) -> Result<JsValue, JsValue> {
    let manual_entries = serde_wasm_bindgen::from_value(manual_entries)?;
    let recipe_entries = serde_wasm_bindgen::from_value(recipe_entries)?;
    let versions = serde_wasm_bindgen::from_value(versions)?;
    let result = food_log::daily_food_log(manual_entries, recipe_entries, versions, date)
        .map_err(|error| JsValue::from_str(&error))?;
    let serializer = serde_wasm_bindgen::Serializer::new()
        .serialize_missing_as_null(true)
        .serialize_maps_as_objects(true);
    Ok(result.serialize(&serializer)?)
}

#[wasm_bindgen]
pub fn update_cooking_progress(
    value: JsValue,
    action: JsValue,
    step_count: usize,
    now: f64,
) -> Result<JsValue, JsValue> {
    let progress = serde_wasm_bindgen::from_value(value)?;
    let action = serde_wasm_bindgen::from_value(action)?;
    let progress = cooking::update_cooking_progress(progress, action, step_count, now)
        .map_err(|error| JsValue::from_str(&error))?;
    let serializer = serde_wasm_bindgen::Serializer::new().serialize_missing_as_null(true);
    Ok(progress.serialize(&serializer)?)
}

#[wasm_bindgen]
pub fn update_step_timer(timer: JsValue, action: JsValue, now: f64) -> Result<JsValue, JsValue> {
    let timer = serde_wasm_bindgen::from_value(timer)?;
    let action = serde_wasm_bindgen::from_value(action)?;
    let timer = cooking::update_step_timer(timer, action, now)
        .map_err(|error| JsValue::from_str(&error))?;
    let serializer = serde_wasm_bindgen::Serializer::new().serialize_missing_as_null(true);
    Ok(timer.serialize(&serializer)?)
}

#[wasm_bindgen]
pub fn step_timer_remaining(timer: JsValue, now: f64) -> Result<f64, JsValue> {
    let timer: cooking::StepTimer = serde_wasm_bindgen::from_value(timer)?;
    timer
        .remaining(now)
        .map_err(|error| JsValue::from_str(&error))
}

#[derive(Serialize)]
struct ValidationResult {
    recipe: Option<recipe::Recipe>,
    errors: Vec<recipe::FieldError>,
}

#[wasm_bindgen]
pub fn validate_recipe(draft: JsValue) -> Result<JsValue, JsValue> {
    let draft = serde_wasm_bindgen::from_value(draft)?;
    let result = match recipe::validate_recipe(draft) {
        Ok(recipe) => ValidationResult {
            recipe: Some(recipe),
            errors: vec![],
        },
        Err(errors) => ValidationResult {
            recipe: None,
            errors,
        },
    };
    let serializer = serde_wasm_bindgen::Serializer::new().serialize_missing_as_null(true);
    Ok(result.serialize(&serializer)?)
}

#[wasm_bindgen]
pub fn validate_recipe_rating(value: JsValue) -> Result<JsValue, JsValue> {
    let rating = serde_wasm_bindgen::from_value(value)?;
    let rating =
        rating::validate_recipe_rating(rating).map_err(|error| JsValue::from_str(&error))?;
    Ok(serde_wasm_bindgen::to_value(&rating)?)
}

#[wasm_bindgen]
pub fn calculate_recipe(
    value: JsValue,
    portions: f64,
    preference: JsValue,
) -> Result<JsValue, JsValue> {
    let draft = serde_wasm_bindgen::from_value(value)?;
    let recipe = recipe::validate_recipe(draft)
        .map_err(|_| JsValue::from_str("The recipe contains invalid quantities or allocations."))?;
    let preference = serde_wasm_bindgen::from_value(preference)?;
    let result = quantities::calculate_recipe(&recipe, portions, preference)
        .map_err(|error| JsValue::from_str(&error))?;
    Ok(serde_wasm_bindgen::to_value(&result)?)
}
