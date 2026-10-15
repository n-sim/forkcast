use crate::recipe::FieldError;
use serde::{Deserialize, Serialize};

#[derive(Clone, Default, Deserialize, PartialEq, Serialize)]
pub struct Nutrition {
    pub calories: Option<f64>,
    pub protein: Option<f64>,
    pub fat: Option<f64>,
    pub carbohydrates: Option<f64>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NutritionVersion {
    pub id: String,
    pub recipe_id: String,
    pub per_portion: Nutrition,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NutritionChange {
    pub changed: bool,
    pub per_portion: Nutrition,
}

pub fn recipe_nutrition_change(
    recipe: crate::recipe::Recipe,
    previous: Option<crate::recipe::Recipe>,
) -> Result<NutritionChange, String> {
    Ok(NutritionChange {
        changed: previous.is_none_or(|previous| {
            recipe.nutrition != previous.nutrition || recipe.base_portions != previous.base_portions
        }),
        per_portion: recipe.nutrition.scale(1.0 / recipe.base_portions)?,
    })
}

impl Nutrition {
    pub fn is_unknown(&self) -> bool {
        self == &Self::default()
    }

    pub fn validate(&self, errors: &mut Vec<FieldError>) {
        for (path, label, value) in [
            ("calories", "Calories", self.calories),
            ("protein", "Protein", self.protein),
            ("fat", "Fat", self.fat),
            ("carbohydrates", "Carbohydrates", self.carbohydrates),
        ] {
            if value.is_some_and(|value| !value.is_finite() || value < 0.0) {
                errors.push(FieldError {
                    path: format!("nutrition.{path}"),
                    message: format!("{label} must be zero or more, or left unknown."),
                });
            }
        }
    }

    pub fn scale(&self, portions: f64) -> Result<Self, String> {
        if !portions.is_finite() || portions <= 0.0 {
            return Err("Portions must be greater than zero.".into());
        }
        let scale = |value: Option<f64>| {
            value
                .map(|value| {
                    let scaled = value * portions;
                    if scaled.is_finite() && scaled >= 0.0 {
                        Ok(scaled)
                    } else {
                        Err("Nutrition exceeds the calculation range.".to_owned())
                    }
                })
                .transpose()
        };
        Ok(Self {
            calories: scale(self.calories)?,
            protein: scale(self.protein)?,
            fat: scale(self.fat)?,
            carbohydrates: scale(self.carbohydrates)?,
        })
    }
}
