//! Archiving a recipe on an installed app, through the public operation
//! contract against real SQLite: future cooking, an old food-log entry, a
//! reviewed shopping list, and a started cooking session together.

mod common;

use common::{TempDatabase, risotto};
use forkcast_core::{Core, ErrorKind, Operation, Principal, Topic};
use serde_json::{Value, json};
use std::time::Duration;

const RISOTTO: &str = "veggie-pumpkin-risotto";

fn try_op(core: &Core, me: &Principal, operation: Value) -> forkcast_core::Result<Value> {
    let operation: Operation = serde_json::from_value(operation).expect("operation");
    core.execute(me, operation)
}

fn op(core: &Core, me: &Principal, operation: Value) -> Value {
    try_op(core, me, operation).expect("operation succeeds")
}

fn plan(
    core: &Core,
    me: &Principal,
    id: &str,
    recipe: &str,
    date: &str,
) -> forkcast_core::Result<Value> {
    try_op(
        core,
        me,
        json!({"operation": "planCooking", "cooking": {
            "id": id, "recipeId": recipe, "cookingDate": date, "portions": 4.0, "cookingTime": null
        }}),
    )
}

fn cooking_ids(core: &Core, me: &Principal) -> Vec<String> {
    op(core, me, json!({"operation": "mealPlan"}))["cookings"]
        .as_array()
        .unwrap()
        .iter()
        .map(|cooking| cooking["id"].as_str().unwrap().to_owned())
        .collect()
}

fn recipe_ids(core: &Core, me: &Principal) -> Vec<String> {
    op(core, me, json!({"operation": "recipes"}))
        .as_array()
        .unwrap()
        .iter()
        .map(|view| view["recipe"]["id"].as_str().unwrap().to_owned())
        .collect()
}

#[test]
fn archiving_withdraws_a_recipe_and_keeps_what_was_logged_reviewed_and_started() {
    let database = TempDatabase::new();
    let core = database.open();
    let me = core.standalone().unwrap();
    let saved = op(
        &core,
        &me,
        json!({"operation": "saveRecipe", "recipe": risotto()}),
    );
    let version = saved["current"]["recipe"]["nutritionVersionId"].clone();
    let mut soup = risotto();
    soup["id"] = json!("soup");
    soup["name"] = json!("Soup");
    op(
        &core,
        &me,
        json!({"operation": "saveRecipe", "recipe": soup}),
    );

    // Cooked last week, planned today and later, and another recipe's cooking.
    for (id, recipe, date) in [
        ("past", RISOTTO, "2030-05-01"),
        ("today", RISOTTO, "2030-05-06"),
        ("future", RISOTTO, "2030-05-08"),
        ("soup", "soup", "2030-05-08"),
    ] {
        plan(&core, &me, id, recipe, date).unwrap();
    }

    // A reviewed list: one quantity changed, one item checked, a manual item.
    let list = op(
        &core,
        &me,
        json!({"operation": "generateShoppingList", "startDate": "2030-05-01", "endDate": "2030-05-10"}),
    );
    let list_id = list["list"]["id"].clone();
    let first = list["list"]["items"][0].clone();
    let mut reviewed = first.clone();
    reviewed["quantity"] = json!(123.0);
    reviewed
        .as_object_mut()
        .unwrap()
        .retain(|key, _| ["id", "name", "quantity", "unit"].contains(&key.as_str()));
    op(
        &core,
        &me,
        json!({"operation": "saveShoppingItem", "listId": list_id, "kind": "generated", "item": reviewed}),
    );
    op(
        &core,
        &me,
        json!({"operation": "checkShoppingItem", "listId": list_id, "itemId": first["id"], "checked": true}),
    );
    op(
        &core,
        &me,
        json!({"operation": "saveShoppingItem", "listId": list_id, "kind": "manual",
        "item": {"id": "coffee", "name": "Coffee", "quantity": 1.0, "unit": "piece"}}),
    );
    let before = op(&core, &me, json!({"operation": "shoppingList"}));
    assert_eq!(before["archivedRecipeIds"], json!([]));

    // Eaten last week, and cooking underway.
    op(
        &core,
        &me,
        json!({"operation": "logRecipeFood", "id": "lunch", "recipeId": RISOTTO,
        "nutritionVersionId": version, "consumedAt": "2030-05-01T12:30", "portions": 2.0}),
    );
    let logged = op(
        &core,
        &me,
        json!({"operation": "foodLog", "date": "2030-05-01"}),
    );
    let session = op(
        &core,
        &me,
        json!({"operation": "startCooking", "recipeId": RISOTTO, "portions": 4.0}),
    )["session"]
        .clone();
    let session_id = session["id"].as_str().unwrap().to_owned();
    let last_step = session["recipe"]["steps"].as_array().unwrap().len() - 1;
    op(
        &core,
        &me,
        json!({"operation": "saveCookingProgress", "sessionId": session_id, "step": 1, "timers": {}}),
    );

    let changes = core.subscribe(&me);
    let archived = op(
        &core,
        &me,
        json!({"operation": "archiveRecipe", "recipeId": RISOTTO, "today": "2030-05-06"}),
    );
    assert_eq!(archived["removedCookings"], 2);
    let mut topics = vec![];
    while let Some(change) = changes.next_timeout(Duration::from_millis(200)) {
        topics.push(change.topic);
    }
    assert!(topics.contains(&Topic::Recipes) && topics.contains(&Topic::Planning));
    // Repeating it changes nothing more.
    let again = op(
        &core,
        &me,
        json!({"operation": "archiveRecipe", "recipeId": RISOTTO, "today": "2030-05-07"}),
    );
    assert_eq!(
        again,
        json!({"archivedRevisionId": null, "removedCookings": 0})
    );

    // Everything survives a restart, offline as an installed app always is.
    drop(core);
    let core = database.open();

    // Gone from the collection and from future planning; the past cooking stays.
    assert_eq!(recipe_ids(&core, &me), ["soup"]);
    assert_eq!(cooking_ids(&core, &me), ["past", "soup"]);
    // The earlier cooking still names the recipe, marked as archived.
    assert_eq!(
        op(&core, &me, json!({"operation": "mealPlan"}))["archivedRecipes"],
        json!({RISOTTO: saved["current"]["recipe"]["name"]})
    );

    // The reviewed list is unchanged, names the archived contributor, and says
    // its source plan changed rather than regenerating itself.
    let after = op(&core, &me, json!({"operation": "shoppingList"}));
    assert_eq!(after["list"], before["list"]);
    assert_eq!(after["list"]["items"][0]["quantity"], 123.0);
    assert_eq!(after["list"]["items"][0]["checked"], true);
    assert_eq!(after["archivedRecipeIds"], json!([RISOTTO]));
    assert_eq!(after["sourceStatus"], "changed");

    // The old entry keeps its retained nutrition but no longer leads to the recipe.
    let log = op(
        &core,
        &me,
        json!({"operation": "foodLog", "date": "2030-05-01"}),
    );
    assert_eq!(log["totals"], logged["totals"]);
    assert_eq!(
        log["entries"][0]["description"],
        logged["entries"][0]["description"]
    );
    assert_eq!(log["entries"][0]["recipeArchived"], true);
    assert_eq!(logged["entries"][0]["recipeArchived"], false);

    // Cooking underway finishes from what it captured, with a notice.
    let sessions = op(&core, &me, json!({"operation": "cookingSessions"}));
    assert_eq!(sessions[0]["recipeArchived"], true);
    assert_eq!(sessions[0]["recipe"], session["recipe"]);
    let progressed = op(
        &core,
        &me,
        json!({"operation": "saveCookingProgress", "sessionId": session_id,
        "step": last_step, "timers": {}}),
    );
    assert_eq!(progressed["recipeArchived"], true);
    op(
        &core,
        &me,
        json!({"operation": "endCooking", "sessionId": session_id, "outcome": "finished"}),
    );
    let history = op(&core, &me, json!({"operation": "cookingHistory"}));
    assert_eq!(history[0]["recipeId"], RISOTTO);
    assert_eq!(history[0]["count"], 1);

    // No new use: planning, logging, cooking, recording a cook, or editing.
    let refused = |operation: Value| try_op(&core, &me, operation).err().unwrap().kind;
    assert_eq!(
        plan(&core, &me, "new", RISOTTO, "2030-05-20")
            .err()
            .unwrap()
            .kind,
        ErrorKind::Invalid
    );
    assert_eq!(
        refused(
            json!({"operation": "logRecipeFood", "recipeId": RISOTTO, "nutritionVersionId": version,
            "consumedAt": "2030-05-06T12:30", "portions": 1.0})
        ),
        ErrorKind::NotFound
    );
    assert_eq!(
        refused(json!({"operation": "startCooking", "recipeId": RISOTTO, "portions": 4.0})),
        ErrorKind::NotFound
    );
    assert_eq!(
        refused(json!({"operation": "markCooked", "recipeId": RISOTTO})),
        ErrorKind::NotFound
    );
    assert_eq!(
        refused(json!({"operation": "saveRecipe", "recipe": risotto()})),
        ErrorKind::NotFound
    );
    assert_eq!(
        refused(
            json!({"operation": "setRecipeCoverPhoto", "recipeId": RISOTTO, "coverPhoto": null})
        ),
        ErrorKind::NotFound
    );
    let proposal = op(
        &core,
        &me,
        json!({"operation": "scheduleCookings",
        "dates": ["2030-05-20", "2030-05-21"], "portions": 2.0, "strategy": "leastOftenCooked"}),
    );
    assert!(
        proposal["cookings"]
            .as_array()
            .unwrap()
            .iter()
            .all(|c| c["recipeId"] == "soup")
    );

    // A new list draws only on recipes still in use; the reviewed one stays.
    let regenerated = op(
        &core,
        &me,
        json!({"operation": "generateShoppingList",
        "startDate": "2030-05-01", "endDate": "2030-05-10", "replacingListId": list_id}),
    );
    let contributors: Vec<&Value> = regenerated["list"]["contributions"]
        .as_array()
        .unwrap()
        .iter()
        .map(|contribution| &contribution["recipeId"])
        .collect();
    assert_eq!(contributors, [&json!("soup")]);
    assert_eq!(regenerated["archivedRecipeIds"], json!([]));
    assert_eq!(regenerated["sourceStatus"], "unchanged");
}

fn competing(core: &Core, me: &Principal) -> Value {
    op(core, me, json!({"operation": "recipeCollection"}))["current"][0]["competingRevisionIds"]
        .clone()
}

#[test]
fn an_archival_competing_with_an_edit_withdraws_cookings_only_once_chosen() {
    let database = TempDatabase::new();
    let core = database.open();
    let me = core.standalone().unwrap();
    let base = op(
        &core,
        &me,
        json!({"operation": "saveRecipe", "recipe": risotto()}),
    )["savedRevisionId"]
        .clone();
    plan(&core, &me, "later", RISOTTO, "2030-05-09").unwrap();
    let mut edited = risotto();
    edited["name"] = json!("Edited risotto");
    op(
        &core,
        &me,
        json!({"operation": "saveRecipe", "recipe": edited, "baseRevisionId": base}),
    );

    // Archiving what the person saw before that edit keeps both for review;
    // the recipe stays in use until someone chooses.
    let archived = op(
        &core,
        &me,
        json!({"operation": "archiveRecipe", "recipeId": RISOTTO,
        "baseRevisionId": base, "today": "2030-05-06"}),
    );
    let archival = archived["archivedRevisionId"].clone();
    assert!(archival.is_string());
    assert_eq!(archived["removedCookings"], 0);
    let recipes = op(&core, &me, json!({"operation": "recipes"}));
    assert_eq!(recipes[0]["recipe"]["name"], "Edited risotto");
    assert_eq!(recipes[0]["unresolved"], 1);
    plan(&core, &me, "earlier", RISOTTO, "2030-05-02").unwrap();
    plan(&core, &me, "meanwhile", RISOTTO, "2030-05-12").unwrap();
    let collection = op(&core, &me, json!({"operation": "recipeCollection"}));
    assert!(
        collection["revisions"]
            .as_array()
            .unwrap()
            .iter()
            .any(|revision| {
                revision["id"] == archival && revision["archivedOn"] == "2030-05-06"
            })
    );

    // Choosing the archival withdraws what was planned from its day on.
    op(
        &core,
        &me,
        json!({"operation": "chooseCurrentRecipe", "recipeId": RISOTTO,
        "revisionId": archival, "expectedRevisionIds": competing(&core, &me)}),
    );
    assert!(recipe_ids(&core, &me).is_empty());
    assert_eq!(cooking_ids(&core, &me), ["earlier"]);
    // Continuing the archived revision would revive it unseen, so it is refused.
    for base in [archival, Value::Null] {
        let refused = try_op(
            &core,
            &me,
            json!({"operation": "saveRecipe", "recipe": risotto(), "baseRevisionId": base}),
        );
        assert_eq!(refused.err().unwrap().kind, ErrorKind::NotFound);
    }
}

#[test]
fn an_edit_made_before_the_archival_was_seen_is_retained_and_can_be_chosen() {
    let database = TempDatabase::new();
    let core = database.open();
    let me = core.standalone().unwrap();
    let base = op(
        &core,
        &me,
        json!({"operation": "saveRecipe", "recipe": risotto()}),
    )["savedRevisionId"]
        .clone();
    plan(&core, &me, "later", RISOTTO, "2030-05-09").unwrap();
    let archived = op(
        &core,
        &me,
        json!({"operation": "archiveRecipe", "recipeId": RISOTTO, "today": "2030-05-06"}),
    );
    assert_eq!(archived["removedCookings"], 1);

    // An edit from the earlier revision competes with the archival instead of
    // silently reviving the recipe; it stays out of the collection meanwhile.
    let mut edited = risotto();
    edited["name"] = json!("Edited risotto");
    let edit = op(
        &core,
        &me,
        json!({"operation": "saveRecipe", "recipe": edited, "baseRevisionId": base}),
    );
    assert_eq!(edit["current"]["unresolved"], 1);
    assert_eq!(edit["current"]["archivedOn"], "2030-05-06");
    assert!(recipe_ids(&core, &me).is_empty());
    assert_eq!(competing(&core, &me).as_array().unwrap().len(), 2);

    // Choosing the edit brings the recipe back for new use.
    op(
        &core,
        &me,
        json!({"operation": "chooseCurrentRecipe", "recipeId": RISOTTO,
        "revisionId": edit["savedRevisionId"], "expectedRevisionIds": competing(&core, &me)}),
    );
    assert_eq!(recipe_ids(&core, &me), [RISOTTO]);
    plan(&core, &me, "again", RISOTTO, "2030-05-10").unwrap();
    assert_eq!(cooking_ids(&core, &me), ["again"]);
}
