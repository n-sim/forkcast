use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use std::collections::{BTreeMap, BTreeSet};

fn fields(value: &Value, allowed: &[&str]) -> Result<(), String> {
    if value
        .as_object()
        .is_some_and(|object| object.keys().all(|key| allowed.contains(&key.as_str())))
    {
        Ok(())
    } else {
        Err("Check the shared meal plan and shopping list.".into())
    }
}

pub fn validate(data: &Value) -> Result<(), String> {
    use crate::{
        calendar::valid_date,
        planning::{PlannedCooking, validate_planned_cooking},
        shopping::{ShoppingItem, validate_shopping_item},
    };
    let invalid = || "Check the shared meal plan and shopping list.".to_owned();
    fields(data, &["cookings", "shoppingList"])?;
    let cookings = data["cookings"].as_object().ok_or_else(invalid)?;
    for (id, cooking) in cookings {
        fields(
            cooking,
            &["id", "recipeId", "cookingDate", "portions", "cookingTime"],
        )?;
        let parsed: PlannedCooking =
            serde_json::from_value(cooking.clone()).map_err(|_| invalid())?;
        if parsed.id != *id {
            return Err(invalid());
        }
        validate_planned_cooking(parsed).map_err(|_| invalid())?;
    }
    let list = data.get("shoppingList").ok_or_else(invalid)?;
    if list.is_null() {
        return Ok(());
    }
    fields(
        list,
        &[
            "id",
            "startDate",
            "endDate",
            "generatedAt",
            "items",
            "contributions",
            "manualItems",
        ],
    )?;
    let start = list["startDate"].as_str().ok_or_else(invalid)?;
    let end = list["endDate"].as_str().ok_or_else(invalid)?;
    if !valid_date(start)
        || !valid_date(end)
        || start > end
        || !list["id"].as_str().is_some_and(|id| !id.trim().is_empty())
        || !list["generatedAt"].as_f64().is_some_and(|time| time >= 0.0)
    {
        return Err(invalid());
    }
    let contributions = list["contributions"].as_array().ok_or_else(invalid)?;
    let mut contribution_ids = BTreeSet::new();
    for contribution in contributions {
        fields(
            contribution,
            &[
                "cookingId",
                "recipeId",
                "recipeName",
                "cookingDate",
                "portions",
                "ingredients",
            ],
        )?;
        for key in ["cookingId", "recipeId", "recipeName"] {
            if !contribution[key]
                .as_str()
                .is_some_and(|value| !value.trim().is_empty())
            {
                return Err(invalid());
            }
        }
        if !contribution_ids.insert(contribution["cookingId"].as_str().ok_or_else(invalid)?)
            || !contribution["cookingDate"].as_str().is_some_and(valid_date)
            || !contribution["portions"].as_f64().is_some_and(|n| n > 0.0)
        {
            return Err(invalid());
        }
        let ingredients = contribution["ingredients"].as_array().ok_or_else(invalid)?;
        for ingredient in ingredients {
            let parsed: crate::recipe::IngredientDraft =
                serde_json::from_value(ingredient.clone()).map_err(|_| invalid())?;
            if parsed.id.trim().is_empty()
                || parsed.name.trim().is_empty()
                || !parsed.quantity.is_some_and(|n| n.is_finite() && n > 0.0)
            {
                return Err(invalid());
            }
        }
    }
    let mut ids = BTreeSet::new();
    for kind in ["items", "manualItems"] {
        for item in list[kind].as_array().ok_or_else(invalid)? {
            let allowed = if kind == "items" {
                &[
                    "id",
                    "name",
                    "quantity",
                    "unit",
                    "checked",
                    "sources",
                    "needsReview",
                ][..]
            } else {
                &["id", "name", "quantity", "unit", "checked"][..]
            };
            fields(item, allowed)?;
            let parsed: ShoppingItem =
                serde_json::from_value(item.clone()).map_err(|_| invalid())?;
            if !ids.insert(parsed.id.clone()) {
                return Err(invalid());
            }
            validate_shopping_item(parsed)?;
            if item
                .get("checked")
                .is_some_and(|checked| !checked.is_boolean())
            {
                return Err(invalid());
            }
            if kind == "items" {
                if !item["needsReview"].is_boolean() {
                    return Err(invalid());
                }
                for source in item["sources"].as_array().ok_or_else(invalid)? {
                    fields(source, &["cookingId", "ingredientId"])?;
                    if !contributions.iter().any(|contribution| {
                        contribution["cookingId"] == source["cookingId"]
                            && contribution["ingredients"]
                                .as_array()
                                .is_some_and(|ingredients| {
                                    ingredients.iter().any(|ingredient| {
                                        ingredient["id"] == source["ingredientId"]
                                    })
                                })
                    }) {
                        return Err(invalid());
                    }
                }
            }
        }
    }
    Ok(())
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Conflict {
    pub path: Vec<String>,
    pub values: Vec<Value>,
}

#[derive(Serialize)]
pub struct Merged {
    pub data: Value,
    pub conflicts: Vec<Conflict>,
}

pub fn empty() -> Value {
    json!({"cookings": {}, "shoppingList": null})
}

fn keyed(items: &Value) -> Value {
    Value::Object(
        items
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|item| Some((item.get("id")?.as_str()?.to_owned(), item.clone())))
            .collect(),
    )
}

fn normalize(data: &Value) -> Value {
    let mut data = data.clone();
    if let Some(list) = data.get("shoppingList").and_then(Value::as_object) {
        let mut requirements = list.clone();
        let manual = requirements.remove("manualItems").unwrap_or(json!([]));
        requirements.insert("items".into(), keyed(&requirements["items"]));
        data["shoppingList"] = json!({"requirements": requirements, "manualItems": keyed(&manual)});
    }
    data
}

fn unkey(items: &Value) -> Value {
    Value::Array(
        items
            .as_object()
            .into_iter()
            .flat_map(|items| items.values().cloned())
            .collect(),
    )
}

fn denormalize(mut data: Value) -> Value {
    if data.get("shoppingList").is_some_and(Value::is_object) {
        let list = &data["shoppingList"];
        let mut requirements = list["requirements"]
            .as_object()
            .cloned()
            .unwrap_or_default();
        requirements.insert("items".into(), unkey(&requirements["items"]));
        requirements.insert("manualItems".into(), unkey(&list["manualItems"]));
        data["shoppingList"] = Value::Object(requirements);
    }
    data
}

fn item_contents(item: &Value) -> Value {
    let mut item = item.as_object().cloned().unwrap_or_default();
    item.remove("id");
    item.entry("checked").or_insert(Value::Bool(false));
    Value::Object(item)
}

fn requirement_contents(value: &Value) -> Option<Value> {
    let mut contents = value.as_object()?.clone();
    contents.remove("id");
    contents.remove("generatedAt");
    let mut items: Vec<Value> = contents
        .get("items")?
        .as_object()?
        .values()
        .map(item_contents)
        .collect();
    items.sort_by_cached_key(Value::to_string);
    contents.insert("items".into(), Value::Array(items));
    Some(Value::Object(contents))
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GenerationAlias {
    target_id: String,
    items: BTreeMap<String, String>,
}

pub fn equivalent_generation(from: &Value, to: &Value) -> Option<(String, GenerationAlias)> {
    let from = normalize(from);
    let to = normalize(to);
    let from = &from["shoppingList"]["requirements"];
    let to = &to["shoppingList"]["requirements"];
    let source_id = from["id"].as_str()?;
    let target_id = to["id"].as_str()?;
    if source_id == target_id || requirement_contents(from)? != requirement_contents(to)? {
        return None;
    }
    let mut available: Vec<_> = to["items"].as_object()?.values().collect();
    let mut items = BTreeMap::new();
    for (id, item) in from["items"].as_object()? {
        let index = available
            .iter()
            .position(|candidate| item_contents(candidate) == item_contents(item))?;
        items.insert(
            id.clone(),
            available.remove(index)["id"].as_str()?.to_owned(),
        );
    }
    Some((
        source_id.to_owned(),
        GenerationAlias {
            target_id: target_id.to_owned(),
            items,
        },
    ))
}

pub fn apply_generation_aliases(data: &mut Value, aliases: &BTreeMap<String, GenerationAlias>) {
    for _ in 0..aliases.len() {
        let Some(alias) = data["shoppingList"]["id"]
            .as_str()
            .and_then(|id| aliases.get(id))
        else {
            break;
        };
        data["shoppingList"]["id"] = Value::String(alias.target_id.clone());
        if let Some(items) = data["shoppingList"]["items"].as_array_mut() {
            for item in items {
                if let Some(id) = item["id"].as_str().and_then(|id| alias.items.get(id)) {
                    item["id"] = Value::String(id.clone());
                }
            }
        }
    }
}

fn merge_value(
    base: &Value,
    current: &Value,
    incoming: &Value,
    path: &mut Vec<String>,
    conflicts: &mut Vec<Conflict>,
) -> Value {
    if current == incoming || incoming == base {
        return current.clone();
    }
    if current == base {
        return incoming.clone();
    }
    if path.last().is_some_and(|key| key == "requirements")
        && requirement_contents(current)
            .zip(requirement_contents(incoming))
            .is_some_and(|(current, incoming)| current == incoming)
    {
        // Concurrent regenerations can have identical requirements but fresh
        // device-generated identities. Keep one shared generation in that case.
        return current.clone();
    }
    // Regeneration changes the requirements identity. Its snapshot is replaced
    // as a whole, while manual groceries merge independently outside this node.
    let regeneration = path.last().is_some_and(|key| key == "requirements")
        && (current.get("id") != incoming.get("id") || base.get("id") != current.get("id"));
    if !regeneration
        && let (Some(current), Some(incoming)) = (current.as_object(), incoming.as_object())
        && (base.is_object() || base.is_null())
    {
        let keys: BTreeSet<_> = current
            .keys()
            .chain(incoming.keys())
            .chain(base.as_object().into_iter().flat_map(|base| base.keys()))
            .collect();
        let mut merged = Map::new();
        for key in keys {
            path.push(key.clone());
            let value = merge_value(
                &base[key],
                current.get(key).unwrap_or(&Value::Null),
                incoming.get(key).unwrap_or(&Value::Null),
                path,
                conflicts,
            );
            path.pop();
            if !value.is_null() || (current.contains_key(key) && incoming.contains_key(key)) {
                merged.insert(key.clone(), value);
            }
        }
        return Value::Object(merged);
    }
    conflicts.push(Conflict {
        path: path.clone(),
        values: vec![current.clone(), incoming.clone()],
    });
    current.clone()
}

pub fn merge(base: &Value, current: &Value, incoming: &Value) -> Merged {
    let mut conflicts = vec![];
    let data = merge_value(
        &normalize(base),
        &normalize(current),
        &normalize(incoming),
        &mut vec![],
        &mut conflicts,
    );
    Merged {
        data: denormalize(data),
        conflicts,
    }
}

fn at_path<'a>(data: &'a Value, path: &[String]) -> &'a Value {
    path.iter().fold(data, |node, key| &node[key])
}

pub fn retain_conflicts(
    existing: &mut Vec<Conflict>,
    incoming: Vec<Conflict>,
    previous: &Value,
    current: &Value,
) {
    let previous_normalized = normalize(previous);
    let current_normalized = normalize(current);
    let sources: Vec<_> = existing.iter().cloned().chain(incoming).collect();
    let mut targets: Vec<_> = sources
        .iter()
        .map(|conflict| {
            let mut target = conflict.path.clone();
            let mut node = &current_normalized;
            for (index, key) in conflict.path.iter().enumerate() {
                if !node.is_object() {
                    target.truncate(index);
                    break;
                }
                node = &node[key];
            }
            if target.len() > 2
                && target[0] == "shoppingList"
                && target[1] == "requirements"
                && previous_normalized["shoppingList"]["requirements"]["id"]
                    != current_normalized["shoppingList"]["requirements"]["id"]
            {
                target.truncate(2);
            }
            target
        })
        .collect();
    // A removal or regeneration can encompass an earlier field conflict.
    // Promote those alternatives together so none becomes unreachable.
    for index in 0..targets.len() {
        if let Some(parent) = targets
            .iter()
            .filter(|candidate| targets[index].starts_with(candidate))
            .min_by_key(|candidate| candidate.len())
            .cloned()
        {
            targets[index] = parent;
        }
    }
    let mut grouped: BTreeMap<Vec<String>, Vec<Value>> = BTreeMap::new();
    for (source, target) in sources.iter().zip(targets) {
        let values = grouped.entry(target.clone()).or_default();
        for value in &source.values {
            let candidate = if source.path == target {
                value.clone()
            } else if let Some(alternative) = choose(previous, &source.path, value) {
                at_path(&normalize(&alternative), &target).clone()
            } else {
                continue;
            };
            if !values.contains(&candidate) {
                values.push(candidate);
            }
        }
    }
    *existing = grouped
        .into_iter()
        .map(|(path, mut values)| {
            let value = at_path(&current_normalized, &path).clone();
            if !values.contains(&value) {
                values.push(value);
            }
            Conflict { path, values }
        })
        .collect();
}

pub fn choose(data: &Value, path: &[String], value: &Value) -> Option<Value> {
    let mut normalized = normalize(data);
    let (last, parents) = path.split_last()?;
    let mut node = &mut normalized;
    for key in parents {
        node = node.as_object_mut()?.get_mut(key)?;
    }
    let object = node.as_object_mut()?;
    let record = matches!(
        parents.last().map(String::as_str),
        Some("cookings" | "items" | "manualItems")
    );
    if value.is_null() && record {
        object.remove(last);
    } else {
        object.insert(last.clone(), value.clone());
    }
    Some(denormalize(normalized))
}
