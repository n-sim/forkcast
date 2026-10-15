pub mod recipe;

use serde::Serialize;
use wasm_bindgen::prelude::*;

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
