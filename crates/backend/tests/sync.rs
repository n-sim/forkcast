//! Two installed cores and a real household server over HTTP and SQLite.

mod harness;

use forkcast_core::{ErrorKind, JoinSelection};
use harness::{Device, OtherRelease, Server, plan, recipe, save_recipe};
use serde_json::{Value, json};

fn selection(recipes: &[&str]) -> JoinSelection {
    JoinSelection {
        recipe_ids: recipes.iter().map(|id| (*id).to_owned()).collect(),
        cooking_ids: vec![],
        use_device_shopping_list: false,
        adopt_personal: false,
    }
}

/// An administrator's device that founded the household, plus a member
/// account created for a second device.
fn household(server: &Server) -> (Device, Device) {
    let admin = Device::new();
    save_recipe(&admin, "soup", "Soup");
    plan(&admin, "monday", "soup", "2030-05-06", 4.0);
    admin.found_household(server);
    admin.op(json!({
        "operation": "createAccount", "username": "sam", "password": "another long passphrase"
    }));
    let member = Device::new();
    member.join_as(server, "sam", "another long passphrase");
    (admin, member)
}

#[test]
fn joining_publishes_only_what_was_chosen_and_the_member_receives_it() {
    let server = Server::start();
    let device = Device::new();
    save_recipe(&device, "soup", "Soup");
    save_recipe(&device, "stew", "Stew");
    plan(&device, "monday", "soup", "2030-05-06", 4.0);
    device.op(json!({"operation": "rateRecipe", "recipeId": "soup", "value": 5}));

    device.core.connect_server(&server.url).unwrap();
    device
        .core
        .authenticate_server(true, "admin", "correct horse battery", Some("Home"))
        .unwrap();
    // Reviewing publishes nothing and changes nothing on either side.
    let review = serde_json::to_value(device.core.review_join().unwrap()).unwrap();
    assert_eq!(review["recipes"].as_array().unwrap().len(), 2);
    assert_eq!(review["personal"]["ratings"], 1);
    assert!(!device.status().bound);
    assert_eq!(device.status().pending, 0);

    let status = device.join_with(JoinSelection {
        recipe_ids: vec!["soup".into()],
        cooking_ids: vec!["monday".into()],
        use_device_shopping_list: false,
        adopt_personal: true,
    });
    assert!(status.bound && status.signed_in);
    assert_eq!(status.pending, 0, "{:?}", status.last_error);
    // The household sees Soup and Monday's cooking; Stew stayed on the device.
    assert_eq!(device.recipe_names(), ["Soup"]);

    device.op(json!({
        "operation": "createAccount", "username": "sam", "password": "another long passphrase"
    }));
    let member = Device::new();
    member.join_as(&server, "sam", "another long passphrase");
    assert_eq!(member.recipe_names(), ["Soup"]);
    let plan = member.op(json!({"operation": "mealPlan"}));
    assert_eq!(plan["cookings"][0]["id"], "monday");
    // The admin's private rating never became a household record.
    assert!(
        member
            .op(json!({"operation": "ratings"}))
            .as_array()
            .unwrap()
            .is_empty()
    );
    assert_eq!(device.op(json!({"operation": "ratings"}))[0]["value"], 5);
}

#[test]
fn cancelling_a_join_changes_neither_side() {
    let server = Server::start();
    let admin = Device::new();
    save_recipe(&admin, "soup", "Soup");
    admin.found_household(&server);

    let newcomer = Device::new();
    save_recipe(&newcomer, "pie", "Pie");
    plan(&newcomer, "tuesday", "pie", "2030-05-07", 2.0);
    admin.op(json!({
        "operation": "createAccount", "username": "sam", "password": "another long passphrase"
    }));
    newcomer.core.connect_server(&server.url).unwrap();
    newcomer
        .core
        .authenticate_server(false, "sam", "another long passphrase", None)
        .unwrap();
    let review = serde_json::to_value(newcomer.core.review_join().unwrap()).unwrap();
    assert_eq!(review["householdRecipes"], 1);
    newcomer.core.cancel_join().unwrap();

    assert!(!newcomer.status().bound);
    assert_eq!(newcomer.recipe_names(), ["Pie"]);
    assert_eq!(newcomer.status().pending, 0);
    assert_eq!(admin.sync().pending, 0);
    assert_eq!(admin.recipe_names(), ["Soup"]);
    // Nothing of the newcomer reached the household.
    let other = Device::new();
    other.join_as(&server, "admin", "correct horse battery");
    assert_eq!(other.recipe_names(), ["Soup"]);
}

#[test]
fn joining_with_household_data_explicitly_replaces_the_device_plan_and_keeps_recipes_local() {
    let server = Server::start();
    let (admin, _member) = household(&server);
    admin.op(json!({
        "operation": "createAccount", "username": "kim", "password": "yet another passphrase"
    }));

    let device = Device::new();
    save_recipe(&device, "pie", "Pie");
    plan(&device, "tuesday", "pie", "2030-05-07", 2.0);
    device.core.connect_server(&server.url).unwrap();
    device
        .core
        .authenticate_server(false, "kim", "yet another passphrase", None)
        .unwrap();
    let review = serde_json::to_value(device.core.review_join().unwrap()).unwrap();
    assert_eq!(review["cookings"].as_array().unwrap().len(), 1);
    device.core.complete_join(selection(&[])).unwrap();
    device.sync();

    // The household plan replaced the device's; the device's recipe is held back,
    // not deleted and not published.
    assert_eq!(device.recipe_names(), ["Soup"]);
    let plan = device.op(json!({"operation": "mealPlan"}))["cookings"].clone();
    assert_eq!(plan.as_array().unwrap().len(), 1);
    assert_eq!(plan[0]["id"], "monday");
    assert_eq!(admin.sync().pending, 0);
    assert_eq!(admin.recipe_names(), ["Soup"]);
}

#[test]
fn a_recipe_id_collision_keeps_both_versions_as_alternatives() {
    let server = Server::start();
    let (admin, _member) = household(&server);
    admin.op(json!({
        "operation": "createAccount", "username": "kim", "password": "yet another passphrase"
    }));
    let device = Device::new();
    save_recipe(&device, "soup", "Kim's soup");
    device.core.connect_server(&server.url).unwrap();
    device
        .core
        .authenticate_server(false, "kim", "yet another passphrase", None)
        .unwrap();
    let review = serde_json::to_value(device.core.review_join().unwrap()).unwrap();
    assert_eq!(review["recipes"][0]["collides"], true);
    // A colliding recipe cannot be left out: it joins as an alternative.
    device.core.complete_join(selection(&[])).unwrap();
    device.sync();
    assert_eq!(device.status().conflicts.recipes, 1);
    admin.sync();
    assert_eq!(admin.status().conflicts.recipes, 1);
    // Neither overwrote the other.
    assert_eq!(admin.recipe_names(), ["Soup"]);
}

#[test]
fn offline_edits_survive_a_restart_and_deliver_once_the_server_returns() {
    let mut server = Server::start();
    let (mut admin, member) = household(&server);

    server.stop();
    save_recipe(&admin, "tea", "Tea");
    admin.op(json!({"operation": "rateRecipe", "recipeId": "soup", "value": 4}));
    plan(&admin, "friday", "tea", "2030-05-10", 1.0);
    let status = admin.sync();
    assert!(status.pending >= 3);
    assert!(
        status
            .last_error
            .as_deref()
            .unwrap()
            .contains("unavailable")
    );
    // Local work continues during the outage.
    assert_eq!(admin.recipe_names(), ["Soup", "Tea"]);
    admin.op(json!({"operation": "setRecipePrompt", "prompt": "Offline prompt"}));

    admin.restart();
    assert!(
        admin.status().pending >= 3,
        "pending work survived the restart"
    );
    assert_eq!(admin.recipe_names(), ["Soup", "Tea"]);

    server.restart();
    let status = admin.sync();
    assert_eq!(status.pending, 0, "{:?}", status.last_error);
    assert!(status.last_error.is_none());
    member.sync();
    assert_eq!(member.recipe_names(), ["Soup", "Tea"]);
    let plan = member.op(json!({"operation": "mealPlan"}))["cookings"].clone();
    assert_eq!(plan.as_array().unwrap().len(), 2);
    // The rating is the admin's alone.
    assert!(
        member
            .op(json!({"operation": "ratings"}))
            .as_array()
            .unwrap()
            .is_empty()
    );
}

#[test]
fn concurrent_recipe_edits_become_alternatives_and_a_stale_choice_is_refused() {
    let server = Server::start();
    let (admin, member) = household(&server);
    let mut ours = recipe("soup", "Admin soup");
    ours["label"] = json!("a");
    let mut theirs = recipe("soup", "Member soup");
    theirs["label"] = json!("b");
    let base = admin.op(json!({"operation": "recipes"}))[0]["revisionId"].clone();
    admin.op(json!({"operation": "saveRecipe", "recipe": ours, "baseRevisionId": base}));
    member.op(json!({"operation": "saveRecipe", "recipe": theirs, "baseRevisionId": base}));
    admin.sync();
    member.sync();
    admin.sync();
    assert_eq!(admin.status().conflicts.recipes, 1);
    assert_eq!(member.status().conflicts.recipes, 1);

    let collection = admin.op(json!({"operation": "recipeCollection"}));
    let competing: Vec<Value> = collection["current"][0]["competingRevisionIds"]
        .as_array()
        .unwrap()
        .clone();
    assert_eq!(competing.len(), 2);
    let choose = |device: &Device, id: &Value, expected: &[Value]| {
        device.try_op(json!({
            "operation": "chooseCurrentRecipe", "recipeId": "soup",
            "revisionId": id, "expectedRevisionIds": expected
        }))
    };
    choose(&admin, &competing[0], &competing).unwrap();
    assert_eq!(admin.status().conflicts.recipes, 0);
    // The member's view of the alternatives is now stale only until they sync;
    // a resolution naming outdated alternatives must not overwrite anything.
    let stale = choose(&member, &competing[1], &[competing[1].clone()]);
    assert_eq!(stale.err().unwrap().kind, ErrorKind::Conflict);
    member.sync();
    assert_eq!(member.status().conflicts.recipes, 0);
    assert_eq!(member.recipe_names(), admin.recipe_names());
}

#[test]
fn planning_edits_combine_when_independent_and_conflict_when_not() {
    let server = Server::start();
    let (admin, member) = household(&server);
    admin.op(json!({"operation": "planCooking", "cooking": {
        "id": "monday", "recipeId": "soup", "cookingDate": "2030-05-06", "portions": 6.0, "cookingTime": null}}));
    member.op(json!({"operation": "planCooking", "cooking": {
        "id": "monday", "recipeId": "soup", "cookingDate": "2030-05-06", "portions": 4.0, "cookingTime": "18:00"}}));
    member.op(json!({"operation": "planCooking", "cooking": {
        "id": "extra", "recipeId": "soup", "cookingDate": "2030-05-08", "portions": 2.0, "cookingTime": null}}));
    admin.sync();
    member.sync();
    admin.sync();
    let plan = admin.op(json!({"operation": "mealPlan"}))["cookings"].clone();
    assert_eq!(plan.as_array().unwrap().len(), 2);
    let monday = plan
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["id"] == "monday")
        .unwrap();
    // Independent fields (portions vs time) combined.
    assert_eq!(monday["portions"], 6.0);
    assert_eq!(monday["cookingTime"], "18:00");

    // The same field edited differently is retained for explicit resolution.
    admin.op(json!({"operation": "planCooking", "cooking": {
        "id": "extra", "recipeId": "soup", "cookingDate": "2030-05-08", "portions": 3.0, "cookingTime": null}}));
    member.op(json!({"operation": "planCooking", "cooking": {
        "id": "extra", "recipeId": "soup", "cookingDate": "2030-05-08", "portions": 5.0, "cookingTime": null}}));
    admin.sync();
    member.sync();
    admin.sync();
    assert_eq!(admin.status().conflicts.planning, 1);
    let snapshot = admin.op(json!({"operation": "planningSnapshot"}));
    let conflict = snapshot["conflicts"][0].clone();
    let chosen = conflict["values"][0].clone();
    admin
        .op(json!({"operation": "resolvePlanningConflict", "conflict": conflict, "value": chosen}));
    member.sync();
    assert_eq!(admin.status().conflicts.planning, 0);
    assert_eq!(member.status().conflicts.planning, 0);
}

#[test]
fn shopping_lists_synchronize_with_checklist_progress_and_completion() {
    let server = Server::start();
    let (admin, member) = household(&server);
    let list = admin.op(json!({
        "operation": "generateShoppingList",
        "startDate": "2030-05-06", "endDate": "2030-05-12", "replacingListId": null
    }));
    let list_id = list["list"]["id"].clone();
    admin.sync();
    member.sync();
    let seen = member.op(json!({"operation": "shoppingList"}));
    assert_eq!(seen["list"]["id"], list_id);
    assert_eq!(seen["sourceStatus"], "unchanged");

    let item = seen["list"]["items"][0]["id"].clone();
    member.op(json!({"operation": "checkShoppingItem", "listId": list_id, "itemId": item, "checked": true}));
    admin.op(json!({"operation": "completeShoppingList", "listId": list_id}));
    admin.sync();
    member.sync();
    admin.sync();
    let merged = admin.op(json!({"operation": "shoppingList"}));
    assert_eq!(merged["list"]["completed"], true);
    assert_eq!(merged["list"]["items"][0]["checked"], true);
}

#[test]
fn sign_out_hides_private_data_and_never_reassigns_pending_changes() {
    let server = Server::start();
    let (admin, member) = household(&server);
    admin.op(json!({"operation": "rateRecipe", "recipeId": "soup", "value": 5}));
    admin.sync();

    // The member's device signs out: private data disappears, household stays.
    member.op(json!({"operation": "rateRecipe", "recipeId": "soup", "value": 2}));
    let before = member.sync();
    assert_eq!(before.pending, 0, "{:?}", before.last_error);
    member.op(json!({"operation": "signOut"}));
    assert_eq!(member.recipe_names(), ["Soup"]);
    assert_eq!(
        member
            .try_op(json!({"operation": "ratings"}))
            .err()
            .unwrap()
            .kind,
        ErrorKind::Forbidden
    );
    // A household edit made while signed out belongs to the signed-out account.
    save_recipe(&member, "bread", "Bread");
    assert_eq!(member.status().pending, 1);
    assert!(!member.status().signed_in);

    // Another account of the household signs in on the same device.
    let admin_device = member;
    let status = admin_device
        .core
        .profile_sign_in("admin", "correct horse battery")
        .unwrap();
    assert!(status.signed_in);
    admin_device.sync();
    // Sam's pending recipe is not delivered under admin's session.
    assert_eq!(admin_device.status().pending_for_other_accounts, 1);
    assert_eq!(
        admin_device.op(json!({"operation": "ratings"}))[0]["value"],
        5
    );
    let other = Device::new();
    other.join_as(&server, "sam", "another long passphrase");
    assert_eq!(
        other.recipe_names(),
        ["Soup"],
        "Bread still waits for its author"
    );

    // Sam signs back in: private data returns and the pending change delivers.
    admin_device.core.profile_sign_out(false).unwrap();
    admin_device
        .core
        .profile_sign_in("sam", "another long passphrase")
        .unwrap();
    let status = admin_device.sync();
    assert_eq!(status.pending, 0, "{:?}", status.last_error);
    assert_eq!(
        admin_device.op(json!({"operation": "ratings"}))[0]["value"],
        2
    );
    other.sync();
    assert_eq!(other.recipe_names(), ["Bread", "Soup"]);
}

#[test]
fn another_household_requires_a_separate_profile() {
    let mut server = Server::start();
    let device = Device::new();
    save_recipe(&device, "soup", "Soup");
    device.found_household(&server);
    let address = server.address();

    // A joined profile cannot start another join.
    assert_eq!(
        device
            .core
            .connect_server("http://127.0.0.1:1")
            .err()
            .unwrap()
            .kind,
        ErrorKind::Conflict
    );

    // The same address now answers as a different household with the same
    // account name. Signing in is refused, publishes nothing, and keeps the
    // profile exactly as it was.
    save_recipe(&device, "tea", "Tea");
    server.stop();
    Server::wait_for(address);
    let elsewhere = Server::fresh_at(address);
    let other = Device::new();
    other.found_household(&elsewhere);
    device.core.profile_sign_out(false).unwrap();
    let error = device
        .core
        .profile_sign_in("admin", "correct horse battery")
        .err()
        .unwrap();
    assert_eq!(error.kind, ErrorKind::Conflict);
    assert!(error.message.contains("separate local profile"));
    let status = device.status();
    assert!(status.signed_out);
    assert_eq!(status.pending, 1);
    assert_eq!(other.recipe_names(), Vec::<String>::new());
}

#[test]
fn local_changes_commit_with_their_pending_work_or_not_at_all() {
    let server = Server::start();
    let device = Device::new();
    device.found_household(&server);
    save_recipe(&device, "soup", "Soup");
    let pending = device.status().pending;
    assert_eq!(pending, 1);

    // A planning edit naming a missing recipe fails; neither the plan nor
    // the pending work changes.
    let rejected = device.try_op(json!({"operation": "planCooking", "cooking": {
        "id": "x", "recipeId": "missing", "cookingDate": "2030-05-06", "portions": 2.0, "cookingTime": null}}));
    assert_eq!(rejected.err().unwrap().kind, ErrorKind::Invalid);
    assert!(
        device.op(json!({"operation": "mealPlan"}))["cookings"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    assert_eq!(device.status().pending, pending);
    // An invalid rating likewise.
    assert!(
        device
            .try_op(json!({"operation": "rateRecipe", "recipeId": "soup", "value": 9}))
            .is_err()
    );
    assert_eq!(device.status().pending, pending);

    // The pending work and the change it describes both survive a restart
    // and deliver exactly once.
    let mut device = device;
    device.restart();
    assert_eq!(device.status().pending, pending);
    assert_eq!(device.sync().pending, 0);
    assert_eq!(device.sync().pending, 0);
    let other = Device::new();
    other.join_as(&server, "admin", "correct horse battery");
    assert_eq!(other.recipe_names(), ["Soup"]);
}

#[test]
fn an_ended_session_pauses_sync_but_never_blocks_local_work() {
    let server = Server::start();
    let (admin, member) = household(&server);
    admin.op(json!({
        "operation": "changeAccount", "id": member.status().active_account.unwrap().id, "active": false
    }));
    save_recipe(&member, "bread", "Bread");
    let status = member.sync();
    assert_eq!(
        status.last_error.as_deref(),
        Some("Your session ended. Sign in again.")
    );
    assert!(!status.signed_in);
    assert_eq!(status.pending, 1);
    // Cooking, planning, food logging, and recipes keep working.
    plan(&member, "friday", "bread", "2030-05-10", 2.0);
    member.op(json!({"operation": "setRecipePrompt", "prompt": "Still works"}));
    member.op(json!({"operation": "logManualFood", "description": "Tea",
        "consumedAt": "2030-05-06T08:00",
        "nutrition": {"calories": 2.0, "protein": null, "fat": null, "carbohydrates": null}}));
}

#[test]
fn release_skew_fails_visibly_and_keeps_pending_work() {
    let mut server = Server::start();
    let (admin, _member) = household(&server);
    let address = server.address();
    server.stop();
    save_recipe(&admin, "tea", "Tea");
    let _newer = OtherRelease::at(address, 2);
    let status = admin.sync();
    let message = status.last_error.unwrap();
    assert!(message.contains("protocol"), "{message}");
    assert_eq!(status.pending, 1);
    assert_eq!(admin.recipe_names(), ["Soup", "Tea"]);

    let fresh = Device::new();
    let error = fresh
        .core
        .connect_server(&format!("http://{address}"))
        .err()
        .unwrap();
    assert_eq!(error.kind, ErrorKind::ProtocolMismatch);
}

#[test]
fn an_edit_from_a_stale_view_becomes_an_explicit_conflict() {
    let server = Server::start();
    let (admin, member) = household(&server);
    let list = admin.op(json!({
        "operation": "generateShoppingList",
        "startDate": "2030-05-06", "endDate": "2030-05-12", "replacingListId": null
    }));
    let list_id = list["list"]["id"].clone();
    admin.sync();
    member.sync();

    // The member opens the list and starts editing a quantity...
    let seen = member.op(json!({"operation": "shoppingList"}));
    let item = seen["list"]["items"][0].clone();
    let base = seen["editBase"].clone();
    // ...while the admin saves a different quantity for the same item.
    let mut admin_item = item.clone();
    admin_item["quantity"] = json!(7.0);
    admin.op(json!({"operation": "saveShoppingItem", "listId": list_id, "kind": "generated", "item": admin_item}));
    admin.sync();
    // The member saves from the view they started from: nothing is overwritten.
    let mut member_item = item.clone();
    member_item["quantity"] = json!(9.0);
    member.op(
        json!({"operation": "saveShoppingItem", "listId": list_id, "kind": "generated",
        "item": member_item, "editBase": base}),
    );
    member.sync();
    admin.sync();
    assert_eq!(admin.status().conflicts.planning, 1);
    let snapshot = admin.op(json!({"operation": "planningSnapshot"}));
    let values = snapshot["conflicts"][0]["values"].as_array().unwrap();
    assert_eq!(values.len(), 2, "both quantities are retained for review");
}

#[test]
fn an_applied_cooking_plan_synchronizes_atomically_and_keeps_concurrent_edits_reviewable() {
    let server = Server::start();
    let (admin, member) = household(&server);
    save_recipe(&admin, "stew", "Stew");
    plan(&admin, "friday", "soup", "2030-05-10", 2.0);
    admin.sync();
    member.sync();

    // The member reviews a schedule for Monday and Tuesday, which replaces
    // Monday's soup...
    let proposal = member.op(json!({
        "operation": "scheduleCookings", "dates": ["2030-05-06", "2030-05-07"],
        "portions": 2, "strategy": "leastOftenCooked",
    }));
    assert_eq!(proposal["replaced"][0]["id"], "monday");
    let apply = |replacing: Value| {
        member.try_op(json!({
            "operation": "applyCookingPlan", "dates": proposal["dates"],
            "cookings": proposal["cookings"], "replacing": replacing,
            "editBase": proposal["editBase"],
        }))
    };
    // A declined replacement queues nothing.
    assert_eq!(apply(json!([])).unwrap_err().kind, ErrorKind::Conflict);
    assert_eq!(member.status().pending, 0);

    // ...while the admin changes Monday's portions.
    admin.op(json!({"operation": "planCooking", "cooking": {
        "id": "monday", "recipeId": "soup", "cookingDate": "2030-05-06", "portions": 6.0, "cookingTime": null}}));
    admin.sync();

    apply(json!(["monday"])).unwrap();
    assert_eq!(member.status().pending, 1, "one atomic planning change");
    member.sync();
    admin.sync();
    assert_eq!(member.status().pending, 0);

    let plan = admin.op(json!({"operation": "mealPlan"}))["cookings"].clone();
    let on = |date: &str| {
        plan.as_array()
            .unwrap()
            .iter()
            .filter(|cooking| cooking["cookingDate"] == date)
            .map(|cooking| cooking["id"].as_str().unwrap().to_owned())
            .collect::<Vec<_>>()
    };
    let proposed = |date: &str| {
        proposal["cookings"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|cooking| cooking["cookingDate"] == date)
            .map(|cooking| cooking["id"].as_str().unwrap().to_owned())
            .collect::<Vec<_>>()
    };
    assert_eq!(on("2030-05-07"), proposed("2030-05-07"));
    assert_eq!(on("2030-05-10"), ["friday"], "other days are untouched");
    // Removing Monday's soup competes with the admin's edit, so the edit is
    // kept for explicit review instead of being discarded.
    assert!(on("2030-05-06").contains(&proposed("2030-05-06")[0]));
    assert_eq!(admin.status().conflicts.planning, 1);
}
