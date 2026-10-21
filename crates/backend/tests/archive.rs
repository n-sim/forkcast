//! Recipe archival across installed cores and a real household server over
//! HTTP and SQLite: the shared recipe collection and meal plan, reviewed
//! shopping lists, personal food logs, and cooking already underway.

mod harness;

use harness::{Device, Server, plan, save_recipe};
use serde_json::{Value, json};

/// An administrator's device that founded the household with Soup and Stew,
/// Soup cooked last week and planned from today on, plus a member device.
fn household(server: &Server) -> (Device, Device) {
    let admin = Device::new();
    save_recipe(&admin, "soup", "Soup");
    save_recipe(&admin, "stew", "Stew");
    plan(&admin, "past", "soup", "2030-05-01", 4.0);
    plan(&admin, "today", "soup", "2030-05-06", 4.0);
    plan(&admin, "later", "soup", "2030-05-09", 4.0);
    plan(&admin, "stew", "stew", "2030-05-09", 2.0);
    admin.found_household(server);
    admin.op(json!({
        "operation": "createAccount", "username": "sam", "password": "another long passphrase"
    }));
    let member = Device::new();
    member.join_as(server, "sam", "another long passphrase");
    (admin, member)
}

fn cooking_ids(device: &Device) -> Vec<String> {
    let mut ids: Vec<String> = device.op(json!({"operation": "mealPlan"}))["cookings"]
        .as_array()
        .unwrap()
        .iter()
        .map(|cooking| cooking["id"].as_str().unwrap().to_owned())
        .collect();
    ids.sort();
    ids
}

/// A list for the week that the member reviewed: a changed quantity and a
/// checked item.
fn reviewed_list(admin: &Device, member: &Device) -> Value {
    let list = admin.op(json!({
        "operation": "generateShoppingList", "startDate": "2030-05-01", "endDate": "2030-05-10"
    }));
    admin.sync();
    member.sync();
    let list_id = list["list"]["id"].clone();
    let item = &list["list"]["items"][0];
    member.op(
        json!({"operation": "saveShoppingItem", "listId": list_id, "kind": "generated",
        "item": {"id": item["id"], "name": item["name"], "quantity": 777.0, "unit": item["unit"]}}),
    );
    member.op(json!({"operation": "checkShoppingItem", "listId": list_id, "itemId": item["id"], "checked": true}));
    member.sync();
    admin.sync();
    member.op(json!({"operation": "shoppingList"}))
}

/// The member ate Soup last week and is cooking it now.
fn personal_records(member: &Device) -> (Value, String) {
    let version = member
        .op(json!({"operation": "recipes"}))
        .as_array()
        .unwrap()
        .iter()
        .find(|view| view["recipe"]["id"] == "soup")
        .unwrap()["recipe"]["nutritionVersionId"]
        .clone();
    member.op(
        json!({"operation": "logRecipeFood", "id": "lunch", "recipeId": "soup",
        "nutritionVersionId": version, "consumedAt": "2030-05-01T12:30", "portions": 2.0}),
    );
    let log = member.op(json!({"operation": "foodLog", "date": "2030-05-01"}));
    let session = member.op(json!({"operation": "startCooking", "recipeId": "soup", "portions": 4.0}))
        ["session"]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    member.op(
        json!({"operation": "saveCookingProgress", "sessionId": session, "step": 1, "timers": {}}),
    );
    (log, session)
}

/// The effects every device must agree on once archival has reached it.
fn assert_archived_everywhere(device: &Device, list: &Value) {
    assert_eq!(device.recipe_names(), ["Stew"]);
    assert_eq!(cooking_ids(device), ["past", "stew"]);
    let seen = device.op(json!({"operation": "shoppingList"}));
    assert_eq!(seen["list"], list["list"], "the reviewed list is unchanged");
    assert_eq!(seen["archivedRecipeIds"], json!(["soup"]));
    assert_eq!(seen["sourceStatus"], "changed");
}

/// The member's own records: retained nutrition without a way back to the
/// recipe, and a session that finishes from what it captured.
fn assert_personal_records_kept(member: &Device, log: &Value, session: &str) {
    let now = member.op(json!({"operation": "foodLog", "date": "2030-05-01"}));
    assert_eq!(now["totals"], log["totals"]);
    assert_eq!(now["entries"][0]["recipeArchived"], true);
    let sessions = member.op(json!({"operation": "cookingSessions"}));
    assert_eq!(sessions[0]["id"], session);
    assert_eq!(sessions[0]["recipeArchived"], true);
    let last = sessions[0]["recipe"]["steps"].as_array().unwrap().len() - 1;
    member.op(json!({"operation": "saveCookingProgress", "sessionId": session, "step": last, "timers": {}}));
    member.op(json!({"operation": "endCooking", "sessionId": session, "outcome": "finished"}));
}

#[test]
fn archival_on_one_device_reaches_the_household_and_keeps_reviewed_and_personal_records() {
    let server = Server::start();
    let (admin, mut member) = household(&server);
    let list = reviewed_list(&admin, &member);
    let (log, session) = personal_records(&member);

    let archived =
        admin.op(json!({"operation": "archiveRecipe", "recipeId": "soup", "today": "2030-05-06"}));
    assert_eq!(archived["removedCookings"], 2);
    let status = admin.sync();
    assert_eq!(status.pending, 0, "{:?}", status.last_error);
    member.sync();

    for device in [&admin, &member] {
        assert_archived_everywhere(device, &list);
        assert_eq!(device.status().conflicts.recipes, 0);
    }
    // Retained references never become general archived-recipe browsing.
    let archived_view =
        member.try_op(json!({"operation": "startCooking", "recipeId": "soup", "portions": 2.0}));
    assert_eq!(
        archived_view.err().unwrap().kind,
        forkcast_core::ErrorKind::NotFound
    );

    member.restart();
    assert_archived_everywhere(&member, &list);
    assert_personal_records_kept(&member, &log, &session);
    // Finishing the archived session still records the cook in its history.
    let history = member.op(json!({"operation": "cookingHistory"}));
    assert!(
        history
            .as_array()
            .unwrap()
            .iter()
            .any(|entry| entry["recipeId"] == "soup")
    );
}

#[test]
fn a_device_offline_while_archival_happens_keeps_its_work_and_its_edit_competes_explicitly() {
    let mut server = Server::start();
    let (admin, mut member) = household(&server);
    let list = reviewed_list(&admin, &member);
    let list_id = list["list"]["id"].clone();
    let base = member
        .op(json!({"operation": "recipes"}))
        .as_array()
        .unwrap()
        .iter()
        .find(|view| view["recipe"]["id"] == "soup")
        .unwrap()["revisionId"]
        .clone();

    admin.op(json!({"operation": "archiveRecipe", "recipeId": "soup", "today": "2030-05-06"}));
    admin.sync();

    // The member has not heard of it: offline, they edit Soup, plan it again,
    // shop, eat, and cook, and restart the app.
    server.stop();
    let mut edited = harness::recipe("soup", "Member soup");
    edited["label"] = json!("spicier");
    member.op(json!({"operation": "saveRecipe", "recipe": edited, "baseRevisionId": base}));
    plan(&member, "offline", "soup", "2030-05-12", 3.0);
    plan(&member, "offline-stew", "stew", "2030-05-12", 3.0);
    let manual = json!({"id": "bread", "name": "Bread", "quantity": 1.0, "unit": "piece"});
    member.op(json!({"operation": "saveShoppingItem", "listId": list_id, "kind": "manual", "item": manual}));
    let (log, session) = personal_records(&member);
    assert!(member.sync().last_error.is_some());
    member.restart();
    assert!(member.status().pending >= 3);

    server.restart();
    let status = member.sync();
    assert_eq!(status.pending, 0, "{:?}", status.last_error);
    admin.sync();

    for device in [&admin, &member] {
        // The archival and the offline edit are both retained for an explicit
        // choice; neither silently discarded the other.
        assert_eq!(device.status().conflicts.recipes, 1);
        assert_eq!(device.recipe_names(), ["Stew"]);
        // The offline plan merged, except Soup's withdrawn cooking.
        assert_eq!(cooking_ids(device), ["offline-stew", "past", "stew"]);
        let seen = device.op(json!({"operation": "shoppingList"}));
        assert_eq!(
            seen["list"]["items"], list["list"]["items"],
            "reviewed quantities kept"
        );
        assert_eq!(seen["list"]["manualItems"][0]["name"], "Bread");
        assert_eq!(seen["archivedRecipeIds"], json!(["soup"]));
    }
    assert_personal_records_kept(&member, &log, &session);

    // Choosing the member's edit brings Soup back to every device, without
    // reviving the cookings archival withdrew.
    let collection = admin.op(json!({"operation": "recipeCollection"}));
    let head = collection["current"]
        .as_array()
        .unwrap()
        .iter()
        .find(|head| head["recipeId"] == "soup")
        .unwrap()
        .clone();
    let edit = collection["revisions"]
        .as_array()
        .unwrap()
        .iter()
        .find(|revision| revision["recipe"]["name"] == "Member soup")
        .unwrap()["id"]
        .clone();
    admin.op(
        json!({"operation": "chooseCurrentRecipe", "recipeId": "soup",
        "revisionId": edit, "expectedRevisionIds": head["competingRevisionIds"]}),
    );
    member.sync();
    for device in [&admin, &member] {
        assert_eq!(device.status().conflicts.recipes, 0);
        assert_eq!(device.recipe_names(), ["Member soup", "Stew"]);
        assert_eq!(cooking_ids(device), ["offline-stew", "past", "stew"]);
        assert_eq!(
            device.op(json!({"operation": "shoppingList"}))["archivedRecipeIds"],
            json!([])
        );
    }
}

#[test]
fn an_archival_made_offline_withdraws_cookings_planned_elsewhere_meanwhile() {
    let mut server = Server::start();
    let (mut admin, member) = household(&server);

    server.stop();
    admin.op(json!({"operation": "archiveRecipe", "recipeId": "soup", "today": "2030-05-06"}));
    admin.restart();
    server.restart();
    // Meanwhile the member planned Soup for later and earlier days.
    plan(&member, "member-later", "soup", "2030-05-20", 2.0);
    plan(&member, "member-earlier", "soup", "2030-05-02", 2.0);
    member.sync();

    let status = admin.sync();
    assert_eq!(status.pending, 0, "{:?}", status.last_error);
    member.sync();
    for device in [&admin, &member] {
        assert_eq!(device.recipe_names(), ["Stew"]);
        assert_eq!(cooking_ids(device), ["member-earlier", "past", "stew"]);
        assert_eq!(device.status().conflicts.planning, 0);
    }
}
