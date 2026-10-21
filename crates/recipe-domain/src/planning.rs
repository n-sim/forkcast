use crate::{
    calendar::{valid_cooking_time, valid_date},
    recipe::FieldError,
};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PlannedCooking {
    pub id: String,
    pub recipe_id: String,
    // A cooking day is a local calendar date, independent of consumption.
    pub cooking_date: String,
    pub portions: Option<f64>,
    pub cooking_time: Option<String>,
}

pub fn validate_planned_cooking(
    mut cooking: PlannedCooking,
) -> Result<PlannedCooking, Vec<FieldError>> {
    let mut errors = vec![];
    for (path, valid, message) in [
        (
            "id",
            !cooking.id.trim().is_empty(),
            "The planned cooking needs an identity.",
        ),
        (
            "recipeId",
            !cooking.recipe_id.trim().is_empty(),
            "Choose a recipe from your collection.",
        ),
        (
            "cookingDate",
            valid_date(&cooking.cooking_date),
            "Enter a valid cooking date.",
        ),
        (
            "portions",
            cooking.portions.is_some_and(|n| n.is_finite() && n > 0.0),
            "Portions to cook must be greater than zero.",
        ),
        (
            "cookingTime",
            cooking
                .cooking_time
                .as_ref()
                .is_none_or(|time| time.is_empty() || valid_cooking_time(time)),
            "Choose morning, midday or evening, or leave the cooking time blank.",
        ),
    ] {
        if !valid {
            errors.push(FieldError {
                path: path.into(),
                message: message.into(),
            });
        }
    }
    if !errors.is_empty() {
        return Err(errors);
    }
    cooking.cooking_time = cooking.cooking_time.filter(|time| !time.is_empty());
    Ok(cooking)
}
