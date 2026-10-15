use crate::recipe::{CookingStep, Ingredient, Recipe, Unit};
use serde::{Deserialize, Serialize};

#[derive(PartialEq)]
enum Dimension {
    Mass,
    Volume,
    Count,
}

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DisplayUnits {
    Metric,
    Us,
    Original,
}

// US customary volume (not metric, imperial, or nutrition-label cup/spoon measures).
// 1 US gallon = 231 cubic inches; 1 inch = 25.4 mm exactly.
const US_CUP_ML: f64 = 236.588_236_5;
// International avoirdupois pound; 16 ounces per pound.
const POUND_G: f64 = 453.592_37;

impl Unit {
    fn dimension_and_factor(self) -> (Dimension, f64) {
        match self {
            Self::Milligram => (Dimension::Mass, 0.001),
            Self::Gram => (Dimension::Mass, 1.0),
            Self::Kilogram => (Dimension::Mass, 1000.0),
            Self::Ounce => (Dimension::Mass, POUND_G / 16.0),
            Self::Pound => (Dimension::Mass, POUND_G),
            Self::Millilitre => (Dimension::Volume, 1.0),
            Self::Litre => (Dimension::Volume, 1000.0),
            Self::Teaspoon => (Dimension::Volume, US_CUP_ML / 48.0),
            Self::Tablespoon => (Dimension::Volume, US_CUP_ML / 16.0),
            Self::FluidOunce => (Dimension::Volume, US_CUP_ML / 8.0),
            Self::Cup => (Dimension::Volume, US_CUP_ML),
            Self::Piece => (Dimension::Count, 1.0),
        }
    }

    fn display_unit(self, quantity: f64, preference: DisplayUnits) -> Result<Self, String> {
        let (dimension, _) = self.dimension_and_factor();
        Ok(match (preference, dimension) {
            (DisplayUnits::Original, _) | (_, Dimension::Count) => self,
            (DisplayUnits::Metric, Dimension::Mass) => {
                let grams = convert_quantity(quantity, self, Self::Gram)?;
                if grams >= 1000.0 {
                    Self::Kilogram
                } else if grams < 1.0 {
                    Self::Milligram
                } else {
                    Self::Gram
                }
            }
            (DisplayUnits::Metric, Dimension::Volume) => {
                if convert_quantity(quantity, self, Self::Millilitre)? >= 1000.0 {
                    Self::Litre
                } else {
                    Self::Millilitre
                }
            }
            (DisplayUnits::Us, Dimension::Mass) => {
                if convert_quantity(quantity, self, Self::Pound)? >= 1.0 {
                    Self::Pound
                } else {
                    Self::Ounce
                }
            }
            (DisplayUnits::Us, Dimension::Volume) => {
                let cups = convert_quantity(quantity, self, Self::Cup)?;
                if cups >= 1.0 {
                    Self::Cup
                } else if cups >= 1.0 / 16.0 {
                    Self::Tablespoon
                } else {
                    Self::Teaspoon
                }
            }
        })
    }
}

pub fn convert_quantity(quantity: f64, from: Unit, to: Unit) -> Result<f64, String> {
    let (from_dimension, from_factor) = from.dimension_and_factor();
    let (to_dimension, to_factor) = to.dimension_and_factor();
    if from_dimension != to_dimension {
        return Err("Mass, volume, and pieces cannot be interchanged.".to_owned());
    }
    let converted = quantity * (from_factor / to_factor);
    if !converted.is_finite() || converted < 0.0 || (quantity > 0.0 && converted == 0.0) {
        return Err("This quantity is outside the supported calculation range.".to_owned());
    }
    Ok(converted)
}

fn scale_quantity(quantity: f64, scale: f64) -> Result<f64, String> {
    let scaled = quantity * scale;
    if !scaled.is_finite() || scaled <= 0.0 {
        return Err("This quantity is outside the supported calculation range.".to_owned());
    }
    Ok(scaled)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AllocationCheck {
    pub ingredient_id: String,
    pub total: f64,
    pub allocated: f64,
    pub difference: f64,
    pub unit: Unit,
}

#[derive(Serialize)]
pub struct RecipeQuantities {
    pub ingredients: Vec<Ingredient>,
    pub steps: Vec<CookingStep>,
    pub checks: Vec<AllocationCheck>,
}

/// Scales structured quantities; instructions never supply or change ingredient totals.
pub fn calculate_recipe(
    recipe: &Recipe,
    portions: f64,
    preference: DisplayUnits,
) -> Result<RecipeQuantities, String> {
    if !portions.is_finite() || portions <= 0.0 {
        return Err("Cooking portions must be greater than zero.".to_owned());
    }
    let scale = portions / recipe.base_portions;
    let mut ingredients = recipe.ingredients.clone();
    let mut steps = recipe.steps.clone();
    for ingredient in &mut ingredients {
        ingredient.quantity = scale_quantity(ingredient.quantity, scale)?;
    }
    for step in &mut steps {
        for allocation in &mut step.allocations {
            allocation.quantity = scale_quantity(allocation.quantity, scale)?;
        }
    }
    for ingredient in &mut ingredients {
        let display_unit = ingredient
            .unit
            .display_unit(ingredient.quantity, preference)?;
        ingredient.quantity = convert_quantity(ingredient.quantity, ingredient.unit, display_unit)?;
        ingredient.unit = display_unit;
        for allocation in steps
            .iter_mut()
            .flat_map(|step| &mut step.allocations)
            .filter(|allocation| allocation.ingredient_id == ingredient.id)
        {
            let unit = if matches!(preference, DisplayUnits::Original) {
                allocation.unit
            } else {
                display_unit
            };
            allocation.quantity = convert_quantity(allocation.quantity, allocation.unit, unit)?;
            allocation.unit = unit;
        }
    }
    let mut checks = Vec::new();
    for ingredient in &ingredients {
        let mut allocated = 0.0;
        for allocation in steps
            .iter()
            .flat_map(|step| &step.allocations)
            .filter(|allocation| allocation.ingredient_id == ingredient.id)
        {
            allocated += convert_quantity(allocation.quantity, allocation.unit, ingredient.unit)?;
        }
        if !allocated.is_finite() {
            return Err("This quantity is outside the supported calculation range.".to_owned());
        }
        let difference = ingredient.quantity - allocated;
        // Relative tolerance absorbs floating point conversion noise, without hiding real missing amounts.
        if difference.abs() > ingredient.quantity.max(allocated) * 1e-9 {
            checks.push(AllocationCheck {
                ingredient_id: ingredient.id.clone(),
                total: ingredient.quantity,
                allocated,
                difference,
                unit: ingredient.unit,
            });
        }
    }
    Ok(RecipeQuantities {
        ingredients,
        steps,
        checks,
    })
}
