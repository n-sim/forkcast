use crate::{
    calendar::valid_date,
    planning::{PlannedCooking, validate_planned_cooking},
    quantities::{DisplayUnits, convert_quantity, scale_quantity},
    recipe::{Ingredient, RecipeDraft, Unit, validate_recipe},
};
use serde::{Deserialize, Serialize};

#[derive(Deserialize, Serialize)]
pub struct ShoppingItem {
    pub id: String,
    pub name: String,
    pub quantity: Option<f64>,
    pub unit: Unit,
}

pub fn validate_shopping_item(mut item: ShoppingItem) -> Result<ShoppingItem, String> {
    item.name = item.name.trim().to_owned();
    if item.id.trim().is_empty() || item.name.is_empty() {
        return Err("Enter a food item name.".into());
    }
    if !item
        .quantity
        .is_some_and(|quantity| quantity.is_finite() && quantity > 0.0)
    {
        return Err("Shopping quantity must be greater than zero.".into());
    }
    Ok(item)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecipeContribution {
    pub cooking_id: String,
    pub recipe_id: String,
    pub recipe_name: String,
    pub cooking_date: String,
    pub cooking_time: Option<String>,
    pub portions: f64,
    pub ingredients: Vec<Ingredient>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShoppingSource {
    pub cooking_id: String,
    pub ingredient_id: String,
}

#[derive(Serialize)]
pub struct GeneratedShoppingItem {
    pub name: String,
    pub quantity: f64,
    pub unit: Unit,
    pub sources: Vec<ShoppingSource>,
    #[serde(rename = "needsReview")]
    pub needs_review: bool,
}

#[derive(Serialize)]
pub struct ShoppingRequirements {
    pub items: Vec<GeneratedShoppingItem>,
    pub contributions: Vec<RecipeContribution>,
}

fn ingredient_key(name: &str) -> String {
    name.split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}

/// Compare the selected source period, independently of reviewed shopping items.
pub fn shopping_source_changed(
    cookings: Vec<PlannedCooking>,
    source_cookings: Vec<PlannedCooking>,
    start_date: &str,
    end_date: &str,
) -> bool {
    let in_period = |cookings: Vec<PlannedCooking>| {
        cookings
            .into_iter()
            .filter(|cooking| {
                cooking.cooking_date.as_str() >= start_date
                    && cooking.cooking_date.as_str() <= end_date
            })
            .map(|cooking| (cooking.id.clone(), cooking))
            .collect::<std::collections::BTreeMap<_, _>>()
    };
    in_period(cookings) != in_period(source_cookings)
}

/// Capture scaled ingredient totals and their sources, independently of step allocations.
pub fn generate_shopping_requirements(
    cookings: Vec<PlannedCooking>,
    recipes: Vec<RecipeDraft>,
    start_date: &str,
    end_date: &str,
) -> Result<ShoppingRequirements, String> {
    if !valid_date(start_date) || !valid_date(end_date) || start_date > end_date {
        return Err("Choose valid shopping dates, with the start on or before the end.".into());
    }
    let mut cookings = cookings
        .into_iter()
        .filter(|cooking| {
            cooking.cooking_date.as_str() >= start_date && cooking.cooking_date.as_str() <= end_date
        })
        .map(|cooking| {
            validate_planned_cooking(cooking)
                .map_err(|_| "A planned cooking contains invalid quantities or dates.".to_owned())
        })
        .collect::<Result<Vec<_>, _>>()?;
    cookings.sort_by(|a, b| {
        a.cooking_date
            .cmp(&b.cooking_date)
            .then_with(|| {
                a.cooking_time
                    .as_deref()
                    .unwrap_or("99:99")
                    .cmp(b.cooking_time.as_deref().unwrap_or("99:99"))
            })
            .then_with(|| a.id.cmp(&b.id))
    });
    let recipes = recipes
        .into_iter()
        .filter(|recipe| {
            cookings
                .iter()
                .any(|cooking| cooking.recipe_id == recipe.id)
        })
        .map(|recipe| {
            validate_recipe(recipe)
                .map_err(|_| "A contributing recipe contains invalid ingredients.".to_owned())
        })
        .collect::<Result<Vec<_>, _>>()?;
    let mut items: Vec<GeneratedShoppingItem> = vec![];
    let mut contributions = vec![];
    for cooking in cookings {
        let recipe = recipes
            .iter()
            .find(|recipe| recipe.id == cooking.recipe_id)
            .ok_or(
                "A planned recipe is unavailable. Review the selected meal plan before generating.",
            )?;
        let portions = cooking.portions.unwrap(); // Validated above.
        let mut ingredients = recipe.ingredients.clone();
        for ingredient in &mut ingredients {
            ingredient.quantity =
                scale_quantity(ingredient.quantity, portions / recipe.base_portions)?;
            let unit = ingredient.unit.canonical_unit();
            let quantity = convert_quantity(ingredient.quantity, ingredient.unit, unit)?;
            let source = ShoppingSource {
                cooking_id: cooking.id.clone(),
                ingredient_id: ingredient.id.clone(),
            };
            if let Some(item) = items.iter_mut().find(|item| {
                ingredient_key(&item.name) == ingredient_key(&ingredient.name) && item.unit == unit
            }) {
                item.quantity += quantity;
                if !item.quantity.is_finite() {
                    return Err("This quantity is outside the supported calculation range.".into());
                }
                item.sources.push(source);
            } else {
                items.push(GeneratedShoppingItem {
                    name: ingredient.name.clone(),
                    quantity,
                    unit,
                    sources: vec![source],
                    needs_review: false,
                });
            }
        }
        contributions.push(RecipeContribution {
            cooking_id: cooking.id,
            recipe_id: recipe.id.clone(),
            recipe_name: recipe.name.clone(),
            cooking_date: cooking.cooking_date,
            cooking_time: cooking.cooking_time,
            portions,
            ingredients,
        });
    }
    let unresolved = items
        .iter()
        .map(|item| {
            items.iter().any(|other| {
                ingredient_key(&item.name) == ingredient_key(&other.name) && item.unit != other.unit
            })
        })
        .collect::<Vec<_>>();
    for (item, needs_review) in items.iter_mut().zip(unresolved) {
        item.needs_review = needs_review;
        let unit = item
            .unit
            .display_unit(item.quantity, DisplayUnits::Metric)?;
        item.quantity = convert_quantity(item.quantity, item.unit, unit)?;
        item.unit = unit;
    }
    Ok(ShoppingRequirements {
        items,
        contributions,
    })
}
