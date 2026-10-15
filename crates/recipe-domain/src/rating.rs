use serde::{Deserialize, Serialize};

/// A person's assessment, kept outside the shared household recipe.
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecipeRating {
    pub person_id: String,
    pub recipe_id: String,
    pub value: f64,
}

pub fn validate_recipe_rating(rating: RecipeRating) -> Result<RecipeRating, String> {
    if rating.person_id.trim().is_empty() || rating.recipe_id.trim().is_empty() {
        return Err("A recipe rating needs a person and a recipe.".to_owned());
    }
    if !rating.value.is_finite()
        || rating.value.fract() != 0.0
        || !(1.0..=5.0).contains(&rating.value)
    {
        return Err("Choose a whole-number rating from 1 to 5.".to_owned());
    }
    Ok(rating)
}
