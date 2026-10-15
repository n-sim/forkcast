use serde::{Deserialize, Serialize};
use std::collections::HashSet;

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Difficulty {
    Easy,
    Medium,
    Challenging,
}

#[derive(Clone, Copy, PartialEq, Deserialize, Serialize)]
pub enum Unit {
    #[serde(rename = "mg")]
    Milligram,
    #[serde(rename = "g")]
    Gram,
    #[serde(rename = "kg")]
    Kilogram,
    #[serde(rename = "oz")]
    Ounce,
    #[serde(rename = "lb")]
    Pound,
    #[serde(rename = "ml")]
    Millilitre,
    #[serde(rename = "l")]
    Litre,
    #[serde(rename = "tsp")]
    Teaspoon,
    #[serde(rename = "tbsp")]
    Tablespoon,
    #[serde(rename = "fl-oz")]
    FluidOunce,
    #[serde(rename = "cup")]
    Cup,
    #[serde(rename = "piece")]
    Piece,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IngredientDraft {
    pub id: String,
    pub name: String,
    pub quantity: Option<f64>,
    pub unit: Unit,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IngredientAllocationDraft {
    pub ingredient_id: String,
    pub quantity: Option<f64>,
    pub unit: Unit,
}

#[derive(Deserialize)]
pub struct CookingStepDraft {
    pub id: String,
    pub instruction: String,
    #[serde(default)]
    pub allocations: Vec<IngredientAllocationDraft>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IngredientAllocation {
    pub ingredient_id: String,
    pub quantity: f64,
    pub unit: Unit,
}

#[derive(Clone, Serialize)]
pub struct CookingStep {
    pub id: String,
    pub instruction: String,
    pub allocations: Vec<IngredientAllocation>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecipeDraft {
    pub id: String,
    pub name: String,
    pub base_portions: Option<f64>,
    pub ingredients: Vec<IngredientDraft>,
    pub steps: Vec<CookingStepDraft>,
    pub difficulty: Option<Difficulty>,
    pub active_minutes: Option<f64>,
    pub total_minutes: Option<f64>,
}

#[derive(Clone, Serialize)]
pub struct Ingredient {
    pub id: String,
    pub name: String,
    pub quantity: f64,
    pub unit: Unit,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Recipe {
    pub id: String,
    pub name: String,
    pub base_portions: f64,
    pub ingredients: Vec<Ingredient>,
    pub steps: Vec<CookingStep>,
    pub difficulty: Option<Difficulty>,
    pub active_minutes: Option<f64>,
    pub total_minutes: Option<f64>,
}

#[derive(Serialize)]
pub struct FieldError {
    pub path: String,
    pub message: String,
}

fn add_error(errors: &mut Vec<FieldError>, path: &str, message: impl Into<String>) {
    errors.push(FieldError {
        path: path.to_owned(),
        message: message.into(),
    });
}

fn valid_positive(value: Option<f64>) -> bool {
    value.is_some_and(|number| number.is_finite() && number > 0.0)
}

fn check_identity<'a>(
    id: &'a str,
    path: &str,
    identities: &mut HashSet<&'a str>,
    errors: &mut Vec<FieldError>,
) {
    if id.trim().is_empty() || !identities.insert(id) {
        add_error(
            errors,
            path,
            "Each recipe, ingredient, and step needs a unique identity.",
        );
    }
}

/// The native recipe boundary, shared with the browser's WebAssembly entry point.
pub fn validate_recipe(draft: RecipeDraft) -> Result<Recipe, Vec<FieldError>> {
    let mut errors = Vec::new();
    let mut identities = HashSet::new();
    check_identity(&draft.id, "id", &mut identities, &mut errors);
    if draft.name.trim().is_empty() {
        add_error(&mut errors, "name", "Enter a recipe name.");
    }
    if !valid_positive(draft.base_portions) {
        add_error(
            &mut errors,
            "basePortions",
            "Base portions must be greater than zero.",
        );
    }
    if draft.ingredients.is_empty() {
        add_error(&mut errors, "ingredients", "Add at least one ingredient.");
    }
    for (index, ingredient) in draft.ingredients.iter().enumerate() {
        check_identity(
            &ingredient.id,
            &format!("ingredients.{index}.id"),
            &mut identities,
            &mut errors,
        );
        if ingredient.name.trim().is_empty() {
            add_error(
                &mut errors,
                &format!("ingredients.{index}.name"),
                format!("Enter a name for ingredient {}.", index + 1),
            );
        }
        if !valid_positive(ingredient.quantity) {
            add_error(
                &mut errors,
                &format!("ingredients.{index}.quantity"),
                format!(
                    "Ingredient {} quantity must be greater than zero.",
                    index + 1
                ),
            );
        }
    }
    if draft.steps.is_empty() {
        add_error(&mut errors, "steps", "Add at least one cooking step.");
    }
    for (index, step) in draft.steps.iter().enumerate() {
        check_identity(
            &step.id,
            &format!("steps.{index}.id"),
            &mut identities,
            &mut errors,
        );
        if step.instruction.trim().is_empty() {
            add_error(
                &mut errors,
                &format!("steps.{index}.instruction"),
                format!("Enter an instruction for step {}.", index + 1),
            );
        }
        let mut allocated_ingredients = HashSet::new();
        for (allocation_index, allocation) in step.allocations.iter().enumerate() {
            let path = format!("steps.{index}.allocations.{allocation_index}");
            let ingredient = draft
                .ingredients
                .iter()
                .find(|ingredient| ingredient.id == allocation.ingredient_id);
            if let Some(ingredient) = ingredient {
                if crate::quantities::convert_quantity(1.0, allocation.unit, ingredient.unit)
                    .is_err()
                {
                    add_error(
                        &mut errors,
                        &format!("{path}.unit"),
                        "Allocation units must be compatible with the ingredient total. Mass, volume, and pieces cannot be interchanged.",
                    );
                }
            } else {
                add_error(
                    &mut errors,
                    &format!("{path}.ingredientId"),
                    "Choose an ingredient from the recipe totals.",
                );
            }
            if !allocated_ingredients.insert(&allocation.ingredient_id) {
                add_error(
                    &mut errors,
                    &format!("{path}.ingredientId"),
                    "Allocate each ingredient only once per step.",
                );
            }
            if !valid_positive(allocation.quantity) {
                add_error(
                    &mut errors,
                    &format!("{path}.quantity"),
                    "Allocation quantity must be greater than zero.",
                );
            }
        }
    }
    for (path, label, minutes) in [
        ("activeMinutes", "Active time", draft.active_minutes),
        ("totalMinutes", "Total time", draft.total_minutes),
    ] {
        if minutes.is_some_and(|number| !number.is_finite() || number < 0.0) {
            add_error(
                &mut errors,
                path,
                format!("{label} must be zero or more minutes."),
            );
        }
    }
    if let (Some(active), Some(total)) = (draft.active_minutes, draft.total_minutes)
        && active.is_finite()
        && total.is_finite()
        && total < active
    {
        add_error(
            &mut errors,
            "totalMinutes",
            "Total time cannot be less than active time.",
        );
    }
    if !errors.is_empty() {
        return Err(errors);
    }

    Ok(Recipe {
        id: draft.id,
        name: draft.name.trim().to_owned(),
        base_portions: draft.base_portions.unwrap_or_default(),
        ingredients: draft
            .ingredients
            .into_iter()
            .map(|ingredient| Ingredient {
                id: ingredient.id,
                name: ingredient.name.trim().to_owned(),
                quantity: ingredient.quantity.unwrap_or_default(),
                unit: ingredient.unit,
            })
            .collect(),
        steps: draft
            .steps
            .into_iter()
            .map(|step| CookingStep {
                id: step.id,
                instruction: step.instruction.trim().to_owned(),
                allocations: step
                    .allocations
                    .into_iter()
                    .map(|allocation| IngredientAllocation {
                        ingredient_id: allocation.ingredient_id,
                        quantity: allocation.quantity.unwrap_or_default(),
                        unit: allocation.unit,
                    })
                    .collect(),
            })
            .collect(),
        difficulty: draft.difficulty,
        active_minutes: draft.active_minutes,
        total_minutes: draft.total_minutes,
    })
}
