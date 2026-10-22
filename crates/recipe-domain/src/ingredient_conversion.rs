//! Ingredient-dependent conversions: an ingredient's mass from an amount
//! measured by volume or by count. Compatible units convert exactly in
//! [`crate::quantities`]; these cannot, so an AI estimate is offered and
//! applied to a shopping list only when the person accepts it. Recipe
//! ingredient totals stay as written; a conversion changes only how the
//! shopping list combines their scaled amounts.

use crate::{
    quantities::{Dimension, DisplayUnits, convert_quantity},
    recipe::Unit,
    shopping::ingredient_key,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

const MAX_NOTE_CHARS: usize = 300;
const MAX_NAME_CHARS: usize = 200;

/// The measure an estimate converts from. Mass needs no conversion.
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum EstimatedDimension {
    Volume,
    Count,
}

impl EstimatedDimension {
    fn of(unit: Unit) -> Option<Self> {
        match unit.dimension() {
            Dimension::Volume => Some(Self::Volume),
            Dimension::Count => Some(Self::Count),
            Dimension::Mass => None,
        }
    }

    /// The amount an estimate states the mass of.
    pub fn reference(self) -> (f64, Unit) {
        match self {
            Self::Volume => (100.0, Unit::Millilitre),
            Self::Count => (1.0, Unit::Piece),
        }
    }

    /// The plausible mass of the reference amount, in grams: from the lightest
    /// foams to the densest syrups, and from a herb leaf to a whole joint.
    fn plausible_grams(self) -> std::ops::RangeInclusive<f64> {
        match self {
            Self::Volume => 1.0..=500.0,
            Self::Count => 0.01..=100_000.0,
        }
    }
}

/// An estimate or a person's accepted conversion for one ingredient.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct IngredientConversion {
    pub name: String,
    pub dimension: EstimatedDimension,
    /// The mass in grams of the dimension's reference amount.
    pub grams: f64,
    #[serde(default)]
    pub note: Option<String>,
}

pub fn validate_conversion(
    mut conversion: IngredientConversion,
) -> Result<IngredientConversion, String> {
    conversion.name = conversion.name.trim().to_owned();
    if conversion.name.is_empty() || conversion.name.chars().count() > MAX_NAME_CHARS {
        return Err("Name the ingredient to convert.".into());
    }
    if !conversion.grams.is_finite()
        || !conversion
            .dimension
            .plausible_grams()
            .contains(&conversion.grams)
    {
        return Err(
            "The estimated weight is outside the plausible range for this ingredient.".into(),
        );
    }
    conversion.note = conversion
        .note
        .map(|note| note.trim().to_owned())
        .filter(|note| !note.is_empty());
    if conversion
        .note
        .as_ref()
        .is_some_and(|note| note.chars().count() > MAX_NOTE_CHARS)
    {
        return Err("The estimate's note is too long.".into());
    }
    Ok(conversion)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct EstimateReply {
    grams: f64,
    #[serde(default)]
    note: Option<String>,
}

/// Reads an AI reply as a conversion estimate for `name`. A reply that is not
/// the requested object, or whose weight is implausible, is rejected whole.
pub fn read_conversion_estimate(
    text: &str,
    name: &str,
    dimension: EstimatedDimension,
) -> Result<IngredientConversion, String> {
    let reply: EstimateReply = serde_json::from_str(crate::unfenced(text)).map_err(|_| {
        "The reply was not a conversion estimate in the requested format.".to_owned()
    })?;
    validate_conversion(IngredientConversion {
        name: name.to_owned(),
        dimension,
        grams: reply.grams,
        note: reply.note,
    })
}

/// A generated item that cannot combine with the same ingredient measured
/// differently without an estimate.
#[derive(Serialize, PartialEq, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ConversionOffer {
    pub item_id: String,
    pub name: String,
    pub dimension: EstimatedDimension,
    /// The person declined an estimate; the quantities stay separate.
    pub declined: bool,
}

fn item_unit(item: &Value) -> Option<Unit> {
    serde_json::from_value(item["unit"].clone()).ok()
}

fn item_key(item: &Value) -> String {
    ingredient_key(item["name"].as_str().unwrap_or_default())
}

/// Items measured by volume or count that share an ingredient with a differently
/// measured item. They stay separate until the person accepts an estimate.
pub fn conversion_offers(list: &Value) -> Vec<ConversionOffer> {
    let items = list["items"]
        .as_array()
        .map(Vec::as_slice)
        .unwrap_or_default();
    let dimensions = |key: &str| {
        let mut found: Vec<Dimension> = vec![];
        for item in items.iter().filter(|item| item_key(item) == key) {
            if let Some(unit) = item_unit(item)
                && !found.contains(&unit.dimension())
            {
                found.push(unit.dimension());
            }
        }
        found.len()
    };
    items
        .iter()
        .filter_map(|item| {
            let dimension = EstimatedDimension::of(item_unit(item)?)?;
            let key = item_key(item);
            if dimensions(&key) < 2 {
                return None;
            }
            let declined = list["conversions"].as_array().is_some_and(|conversions| {
                conversions.iter().any(|conversion| {
                    conversion["status"] == "declined"
                        && conversion["dimension"] == json!(dimension)
                        && ingredient_key(conversion["name"].as_str().unwrap_or_default()) == key
                })
            });
            Some(ConversionOffer {
                item_id: item["id"].as_str()?.to_owned(),
                name: item["name"].as_str()?.to_owned(),
                dimension,
                declined,
            })
        })
        .collect()
}

fn refresh_review_flags(items: &mut [Value]) {
    let flags: Vec<bool> = items
        .iter()
        .map(|item| {
            let key = item_key(item);
            items.iter().any(|other| {
                item_key(other) == key
                    && item_unit(other)
                        .zip(item_unit(item))
                        .is_some_and(|(a, b)| a.dimension() != b.dimension())
            })
        })
        .collect();
    for (item, flag) in items.iter_mut().zip(flags) {
        item["needsReview"] = Value::Bool(flag);
    }
}

fn unavailable() -> String {
    "This ingredient no longer needs a conversion. Review the current list.".into()
}

fn find_offered(items: &[Value], name: &str, dimension: EstimatedDimension) -> Option<usize> {
    let key = ingredient_key(name);
    let offered = items.iter().position(|item| {
        item_key(item) == key && item_unit(item).and_then(EstimatedDimension::of) == Some(dimension)
    })?;
    let mixed = items.iter().any(|item| {
        item_key(item) == key
            && item_unit(item).is_some_and(|unit| {
                unit.dimension() != item_unit(&items[offered]).unwrap().dimension()
            })
    });
    mixed.then_some(offered)
}

fn remember(list: &mut Value, record: Value) {
    let key = ingredient_key(record["name"].as_str().unwrap_or_default());
    let conversions = &mut list["conversions"];
    if !conversions.is_array() {
        *conversions = json!([]);
    }
    let conversions = conversions.as_array_mut().unwrap();
    conversions.retain(|existing| {
        !(existing["dimension"] == record["dimension"]
            && ingredient_key(existing["name"].as_str().unwrap_or_default()) == key)
    });
    conversions.push(record);
}

/// Applies an accepted conversion: the item measured by volume or count
/// becomes grams and combines with the same ingredient's mass. The original
/// amounts and the accepted estimate stay on the list.
pub fn accept_conversion(
    list: &mut Value,
    conversion: IngredientConversion,
    conversion_id: &str,
) -> Result<(), String> {
    let conversion = validate_conversion(conversion)?;
    let key = ingredient_key(&conversion.name);
    let items = list["items"].as_array_mut().ok_or_else(unavailable)?;
    let index =
        find_offered(items, &conversion.name, conversion.dimension).ok_or_else(unavailable)?;
    let source = items.remove(index);
    let range = "This quantity is outside the supported calculation range.".to_owned();
    let quantity = source["quantity"].as_f64().ok_or_else(|| range.clone())?;
    let unit = item_unit(&source).ok_or_else(unavailable)?;
    let (reference, reference_unit) = conversion.dimension.reference();
    let grams = convert_quantity(quantity, unit, reference_unit)? / reference * conversion.grams;
    if !grams.is_finite() || grams <= 0.0 {
        return Err(range);
    }
    let mut origins = source["convertedFrom"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    origins
        .push(json!({"quantity": quantity, "unit": source["unit"], "conversionId": conversion_id}));
    let mass = items.iter().position(|item| {
        item_key(item) == key
            && item_unit(item).is_some_and(|unit| unit.dimension() == Dimension::Mass)
    });
    let (target, total) = match mass {
        Some(position) => {
            let existing = &items[position];
            let current = convert_quantity(
                existing["quantity"].as_f64().ok_or_else(|| range.clone())?,
                item_unit(existing).ok_or_else(unavailable)?,
                Unit::Gram,
            )?;
            (position, current + grams)
        }
        None => {
            items.insert(index, source.clone());
            (index, grams)
        }
    };
    let display = Unit::Gram.display_unit(total, DisplayUnits::Metric)?;
    let merged = &mut items[target];
    merged["quantity"] = json!(convert_quantity(total, Unit::Gram, display)?);
    merged["unit"] = json!(display);
    if mass.is_some() {
        let mut combined = merged["convertedFrom"]
            .as_array()
            .cloned()
            .unwrap_or_default();
        combined.extend(origins);
        merged["convertedFrom"] = Value::Array(combined);
        let sources = source["sources"].as_array().cloned().unwrap_or_default();
        merged["sources"]
            .as_array_mut()
            .ok_or_else(unavailable)?
            .extend(sources);
        let checked = |item: &Value| item["checked"].as_bool().unwrap_or(false);
        merged["checked"] = Value::Bool(checked(merged) && checked(&source));
    } else {
        merged["convertedFrom"] = Value::Array(origins);
    }
    refresh_review_flags(items);
    remember(
        list,
        json!({
            "id": conversion_id,
            "name": conversion.name,
            "dimension": conversion.dimension,
            "status": "accepted",
            "source": "ai",
            "grams": conversion.grams,
            "note": conversion.note,
        }),
    );
    Ok(())
}

/// Records that the person declined an estimate. The quantities stay separate.
pub fn decline_conversion(
    list: &mut Value,
    name: &str,
    dimension: EstimatedDimension,
    conversion_id: &str,
) -> Result<(), String> {
    let items = list["items"].as_array().ok_or_else(unavailable)?;
    find_offered(items, name, dimension).ok_or_else(unavailable)?;
    remember(
        list,
        json!({
            "id": conversion_id,
            "name": name.trim(),
            "dimension": dimension,
            "status": "declined",
        }),
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn list() -> Value {
        json!({"items": [
            {"id": "mass", "name": "Olive oil", "quantity": 100, "unit": "g", "sources": [{"cookingId": "a", "ingredientId": "i"}], "needsReview": true},
            {"id": "volume", "name": " olive  OIL ", "quantity": 100, "unit": "ml", "sources": [{"cookingId": "b", "ingredientId": "j"}], "needsReview": true},
            {"id": "other", "name": "Salt", "quantity": 5, "unit": "g", "sources": [], "needsReview": false},
        ]})
    }

    fn estimate(grams: f64) -> IngredientConversion {
        IngredientConversion {
            name: "olive oil".into(),
            dimension: EstimatedDimension::Volume,
            grams,
            note: Some(" about 0.91 g/ml ".into()),
        }
    }

    #[test]
    fn reads_an_estimate_and_rejects_anything_else() {
        let read = |text| read_conversion_estimate(text, "Olive oil", EstimatedDimension::Volume);
        let estimate =
            read("```json\n{\"grams\": 91, \"note\": \"About 0.91 g/ml.\"}\n```").unwrap();
        assert_eq!(estimate.grams, 91.0);
        assert_eq!(estimate.note.as_deref(), Some("About 0.91 g/ml."));
        for reply in [
            "About 91 g.",
            r#"{"note":"no weight"}"#,
            r#"{"grams":0}"#,
            r#"{"grams":-3}"#,
            r#"{"grams":9100}"#,
            r#"{"grams":91,"density":0.91}"#,
        ] {
            assert!(read(reply).is_err(), "{reply}");
        }
        assert!(
            read_conversion_estimate(r#"{"grams":0.5}"#, "Egg", EstimatedDimension::Count).is_ok()
        );
    }

    #[test]
    fn offers_a_conversion_only_for_differently_measured_amounts() {
        let offers = conversion_offers(&list());
        assert_eq!(offers.len(), 1);
        assert_eq!(offers[0].item_id, "volume");
        assert_eq!(offers[0].dimension, EstimatedDimension::Volume);
        assert!(!offers[0].declined);
    }

    #[test]
    fn accepting_merges_into_the_mass_and_keeps_the_original_amount() {
        let mut list = list();
        accept_conversion(&mut list, estimate(91.0), "c1").unwrap();
        let items = list["items"].as_array().unwrap();
        assert_eq!(items.len(), 2);
        assert_eq!(items[0]["id"], "mass");
        assert_eq!(items[0]["quantity"].as_f64().unwrap(), 191.0);
        assert_eq!(items[0]["unit"], "g");
        assert_eq!(items[0]["needsReview"], false);
        assert_eq!(items[0]["sources"].as_array().unwrap().len(), 2);
        assert_eq!(
            items[0]["convertedFrom"],
            json!([{"quantity": 100.0, "unit": "ml", "conversionId": "c1"}])
        );
        assert_eq!(list["conversions"][0]["status"], "accepted");
        assert_eq!(list["conversions"][0]["note"], "about 0.91 g/ml");
        assert!(conversion_offers(&list).is_empty());
    }

    #[test]
    fn accepting_without_mass_converts_in_place() {
        let mut list = json!({"items": [
            {"id": "c", "name": "Egg", "quantity": 3, "unit": "piece", "sources": [], "needsReview": true, "checked": true},
            {"id": "v", "name": "Egg", "quantity": 20, "unit": "ml", "sources": [], "needsReview": true},
        ]});
        accept_conversion(
            &mut list,
            IngredientConversion {
                name: "egg".into(),
                dimension: EstimatedDimension::Count,
                grams: 60.0,
                note: None,
            },
            "c1",
        )
        .unwrap();
        assert_eq!(list["items"][0]["quantity"].as_f64().unwrap(), 180.0);
        assert_eq!(list["items"][0]["unit"], "g");
        assert_eq!(list["items"][0]["checked"], true);
        assert_eq!(
            list["items"][0]["needsReview"], true,
            "volume still differs from mass"
        );
        // The remaining volume is offered for its own estimate.
        assert_eq!(conversion_offers(&list).len(), 1);
    }

    #[test]
    fn declining_keeps_quantities_separate_and_stale_requests_fail() {
        let mut list = list();
        decline_conversion(&mut list, "Olive oil", EstimatedDimension::Volume, "d1").unwrap();
        assert_eq!(list["items"].as_array().unwrap().len(), 3);
        assert_eq!(list["items"][1]["needsReview"], true);
        assert!(conversion_offers(&list)[0].declined);
        assert!(decline_conversion(&mut list, "Salt", EstimatedDimension::Volume, "d2").is_err());
        assert!(accept_conversion(&mut list, estimate(0.0), "c1").is_err());
        let mut unaffected = list.clone();
        accept_conversion(&mut unaffected, estimate(91.0), "c1").unwrap();
        // An accepted estimate replaces the earlier decline.
        assert_eq!(unaffected["conversions"].as_array().unwrap().len(), 1);
        assert!(accept_conversion(&mut unaffected, estimate(91.0), "c2").is_err());
    }
}
