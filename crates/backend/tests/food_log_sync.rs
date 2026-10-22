//! Personal food logs and dated goals between one account's installed apps,
//! through a real server, with retained nutrition versions intact.

mod harness;

use harness::{Device, Server, save_recipe};
use serde_json::{Value, json};

const ADMIN_PASSWORD: &str = "correct horse battery";
const SAM_PASSWORD: &str = "another long passphrase";
const DAY: &str = "2030-05-06";

/// The administrator's computer, the same account's tablet, and Sam's device.
fn household(server: &Server) -> (Device, Device, Device) {
    let computer = Device::new();
    save_recipe(&computer, "soup", "Soup");
    computer.found_household(server);
    computer.op(json!({
        "operation": "createAccount", "username": "sam", "password": SAM_PASSWORD
    }));
    let tablet = Device::new();
    tablet.join_as(server, "admin", ADMIN_PASSWORD);
    let sam = Device::new();
    sam.join_as(server, "sam", SAM_PASSWORD);
    (computer, tablet, sam)
}

fn current_version(device: &Device) -> String {
    device
        .core
        .recipes(&device.me())
        .unwrap()
        .iter()
        .find(|view| view.recipe["id"] == "soup")
        .unwrap()
        .recipe["nutritionVersionId"]
        .as_str()
        .unwrap()
        .to_owned()
}

/// Corrects the soup's calories, which retains a new nutrition version.
fn correct_calories(device: &Device, calories: f64) -> String {
    let mut recipe = harness::recipe("soup", "Soup");
    recipe["nutrition"]["calories"] = json!(calories);
    device.op(json!({"operation": "saveRecipe", "recipe": recipe}));
    current_version(device)
}

fn log_soup(device: &Device, id: &str, portions: f64) {
    let version = current_version(device);
    device.op(json!({
        "operation": "logRecipeFood", "id": id, "recipeId": "soup",
        "nutritionVersionId": version, "consumedAt": format!("{DAY}T12:30"), "portions": portions
    }));
}

fn log_toast(device: &Device, id: &str) {
    device.op(json!({
        "operation": "logManualFood", "id": id, "description": "Buttered toast",
        "consumedAt": format!("{DAY}T08:00"),
        "nutrition": {"calories": 250.0, "protein": null, "fat": 9.0, "carbohydrates": 30.0}
    }));
}

fn set_goals(device: &Device, from: &str, calories: f64) {
    device.op(json!({
        "operation": "setNutritionGoals", "effectiveFrom": from,
        "targets": {"calories": calories, "protein": 90.0, "fat": null, "carbohydrates": null}
    }));
}

fn day(device: &Device, date: &str) -> Value {
    device.op(json!({"operation": "foodLog", "date": date}))
}

fn entry(device: &Device, id: &str) -> Value {
    day(device, DAY)["entries"]
        .as_array()
        .unwrap()
        .iter()
        .find(|entry| entry["id"] == id)
        .cloned()
        .unwrap_or(Value::Null)
}

fn goals(device: &Device) -> Value {
    device.op(json!({"operation": "nutritionGoals"}))
}

fn conflicts(device: &Device) -> Vec<Value> {
    device
        .op(json!({"operation": "foodLogConflicts"}))
        .as_array()
        .unwrap()
        .clone()
}

fn settle(devices: &[&Device]) {
    for device in devices {
        let status = device.sync();
        assert_eq!(status.pending, 0, "{:?}", status.last_error);
    }
}

#[test]
fn the_food_log_and_goal_history_follow_the_account_with_retained_nutrition() {
    let server = Server::start();
    let (computer, tablet, sam) = household(&server);
    let logged = current_version(&computer);
    log_soup(&computer, "lunch", 2.0);
    log_toast(&computer, "breakfast");
    set_goals(&computer, "2030-05-01", 2000.0);
    set_goals(&computer, "2030-05-07", 1800.0);
    // The recipe's calories are corrected after the entry was logged.
    let corrected = correct_calories(&computer, 2400.0);
    assert_ne!(logged, corrected);
    // Cooking the recipe and planning it are not intake.
    computer.op(json!({"operation": "markCooked", "recipeId": "soup"}));
    harness::plan(&computer, "dinner", "soup", DAY, 4.0);
    settle(&[&computer, &tablet, &sam]);

    let here = day(&computer, DAY);
    let there = day(&tablet, DAY);
    assert_eq!(there, here);
    assert_eq!(there["entries"].as_array().unwrap().len(), 2);
    let lunch = entry(&tablet, "lunch");
    // The tablet shows the same old-version notice: the entry keeps the
    // retained version while the recipe's current one is newer.
    assert_eq!(lunch["nutritionVersionId"], logged.as_str());
    assert_eq!(current_version(&tablet), corrected);
    assert_eq!(lunch["portions"], 2.0);
    assert_eq!(lunch["consumedAt"], format!("{DAY}T12:30"));
    assert_eq!(lunch["nutrition"]["calories"], 1000.0);
    // Incomplete totals and the goals that applied on the day agree.
    assert_eq!(there["incomplete"], true);
    assert_eq!(there["totals"]["calories"]["knownValue"], 1250.0);
    assert_eq!(there["totals"]["protein"]["unknownEntries"], 1);
    assert_eq!(there["goals"]["effectiveFrom"], "2030-05-01");
    assert_eq!(there["totals"]["calories"]["target"], 2000.0);
    assert_eq!(
        day(&tablet, "2030-05-08")["totals"]["calories"]["target"],
        1800.0
    );
    assert_eq!(goals(&tablet), goals(&computer));

    // Another household member receives none of it.
    assert_eq!(day(&sam, DAY)["entries"], json!([]));
    assert_eq!(goals(&sam), json!([]));
}

#[test]
fn use_current_nutrition_on_one_device_updates_only_that_entry_everywhere() {
    let mut server = Server::start();
    let (computer, tablet, _sam) = household(&server);
    let logged = current_version(&computer);
    log_soup(&computer, "lunch", 1.0);
    log_soup(&computer, "dinner", 1.0);
    let corrected = correct_calories(&computer, 2400.0);
    settle(&[&computer, &tablet]);

    let changed = tablet.op(json!({"operation": "useCurrentFoodNutrition", "entryId": "lunch"}));
    assert_eq!(changed["changed"], true);
    settle(&[&tablet, &computer]);
    assert_eq!(
        entry(&computer, "lunch")["nutritionVersionId"],
        corrected.as_str()
    );
    assert_eq!(entry(&computer, "lunch")["nutrition"]["calories"], 600.0);
    assert_eq!(
        entry(&computer, "dinner")["nutritionVersionId"],
        logged.as_str()
    );

    // Offline, one device changes the portions and the other adopts the
    // current nutrition for the same entry: both changes apply.
    server.stop();
    tablet.op(json!({"operation": "editFoodLogEntry", "entryId": "dinner", "portions": 3.0}));
    computer.op(json!({"operation": "useCurrentFoodNutrition", "entryId": "dinner"}));
    server.restart();
    settle(&[&computer, &tablet, &computer]);
    for device in [&computer, &tablet] {
        let dinner = entry(device, "dinner");
        assert_eq!(dinner["portions"], 3.0);
        assert_eq!(dinner["nutritionVersionId"], corrected.as_str());
        assert_eq!(dinner["nutrition"]["calories"], 1800.0);
        assert_eq!(entry(device, "lunch")["portions"], 1.0);
        assert!(conflicts(device).is_empty());
    }
}

#[test]
fn competing_edits_and_removal_against_an_edit_wait_for_a_decision() {
    let mut server = Server::start();
    let (computer, tablet, _sam) = household(&server);
    log_soup(&computer, "lunch", 1.0);
    log_toast(&computer, "breakfast");
    set_goals(&computer, "2030-05-01", 2000.0);
    settle(&[&computer, &tablet]);

    server.stop();
    computer.op(json!({"operation": "editFoodLogEntry", "entryId": "lunch", "portions": 3.0}));
    tablet.op(json!({"operation": "editFoodLogEntry", "entryId": "lunch", "portions": 4.0}));
    computer.op(json!({"operation": "removeNutritionGoals", "effectiveFrom": "2030-05-01"}));
    set_goals(&tablet, "2030-05-01", 2100.0);
    // The same correction made on both devices simply agrees, and a time
    // change combines with it.
    for device in [&computer, &tablet] {
        device.op(json!({
            "operation": "editFoodLogEntry", "entryId": "breakfast", "description": "Two slices of toast"
        }));
    }
    tablet.op(json!({
        "operation": "editFoodLogEntry", "entryId": "breakfast", "consumedAt": format!("{DAY}T08:30")
    }));
    server.restart();
    settle(&[&computer, &tablet, &computer]);

    for device in [&computer, &tablet] {
        let breakfast = entry(device, "breakfast");
        assert_eq!(breakfast["description"], "Two slices of toast");
        assert_eq!(breakfast["consumedAt"], format!("{DAY}T08:30"));
        // The computer's changes arrived first and are shown; the tablet's
        // wait as alternatives.
        assert_eq!(entry(device, "lunch")["portions"], 3.0);
        assert_eq!(goals(device), json!([]));
        let open = conflicts(device);
        assert_eq!(open.len(), 2, "{open:?}");
        let lunch = open.iter().find(|c| c["key"] == "lunch").unwrap();
        assert_eq!(lunch["kind"], "recipeEntry");
        assert_eq!(lunch["current"]["portions"], 3.0);
        assert_eq!(lunch["alternative"]["portions"], 4.0);
        let removed = open.iter().find(|c| c["key"] == "2030-05-01").unwrap();
        assert_eq!(removed["kind"], "goals");
        assert!(removed["current"].is_null());
        assert_eq!(removed["alternative"]["targets"]["calories"], 2100.0);
        assert_eq!(device.status().conflicts.food_log, 2);
    }

    let id = |device: &Device, key: &str| {
        conflicts(device).iter().find(|c| c["key"] == key).unwrap()["id"]
            .as_str()
            .unwrap()
            .to_owned()
    };
    let lunch = id(&tablet, "lunch");
    tablet.op(
        json!({"operation": "resolveFoodLogConflict", "conflictId": lunch, "keep": "alternative"}),
    );
    let removed = id(&computer, "2030-05-01");
    computer.op(json!({"operation": "resolveFoodLogConflict", "conflictId": removed, "keep": "alternative"}));
    settle(&[&tablet, &computer, &tablet]);
    for device in [&computer, &tablet] {
        assert_eq!(entry(device, "lunch")["portions"], 4.0);
        assert_eq!(goals(device)[0]["targets"]["calories"], 2100.0);
        assert!(conflicts(device).is_empty());
        assert_eq!(device.status().conflicts.food_log, 0);
    }
    // Nothing left to decide is refused rather than silently applied.
    let error = computer
        .try_op(
            json!({"operation": "resolveFoodLogConflict", "conflictId": lunch, "keep": "current"}),
        )
        .unwrap_err();
    assert_eq!(error.kind, forkcast_core::ErrorKind::Conflict);

    // Removing an entry on one device while it is edited on the other keeps
    // the edit for a decision; keeping the removal removes it everywhere.
    server.stop();
    computer.op(json!({"operation": "removeFoodLogEntry", "entryId": "breakfast"}));
    tablet.op(json!({"operation": "editFoodLogEntry", "entryId": "breakfast", "consumedAt": format!("{DAY}T09:00")}));
    server.restart();
    settle(&[&tablet, &computer, &tablet]);
    for device in [&computer, &tablet] {
        assert_eq!(
            entry(device, "breakfast")["consumedAt"],
            format!("{DAY}T09:00")
        );
        let open = conflicts(device);
        assert_eq!(open.len(), 1);
        assert!(open[0]["alternative"].is_null());
    }
    let removal = id(&computer, "breakfast");
    computer.op(json!({"operation": "resolveFoodLogConflict", "conflictId": removal, "keep": "alternative"}));
    settle(&[&computer, &tablet]);
    for device in [&computer, &tablet] {
        assert!(entry(device, "breakfast").is_null());
        assert!(conflicts(device).is_empty());
    }
}

#[test]
fn offline_entries_survive_a_cold_reopen_and_stay_bound_to_their_account() {
    let mut server = Server::start();
    let (mut computer, tablet, _sam) = household(&server);
    server.stop();
    log_toast(&computer, "breakfast");
    set_goals(&computer, "2030-05-01", 2000.0);
    computer.restart();
    assert!(!entry(&computer, "breakfast").is_null());
    assert!(computer.sync().last_error.is_some());
    assert_eq!(computer.status().pending, 2);

    // Signed out, the records are hidden and wait for their own account.
    computer.core.profile_sign_out(false).unwrap();
    let hidden = computer
        .try_op(json!({"operation": "foodLog", "date": DAY}))
        .unwrap_err();
    assert_eq!(hidden.kind, forkcast_core::ErrorKind::Forbidden);
    assert!(
        computer
            .try_op(json!({"operation": "nutritionGoals"}))
            .is_err()
    );

    // Sam signing in on the same device neither sees nor publishes them.
    server.restart();
    computer.core.profile_sign_in("sam", SAM_PASSWORD).unwrap();
    let status = computer.sync();
    assert_eq!(status.pending, 2);
    assert_eq!(status.pending_for_other_accounts, 2);
    assert_eq!(day(&computer, DAY)["entries"], json!([]));
    assert_eq!(goals(&computer), json!([]));
    tablet.sync();
    assert!(entry(&tablet, "breakfast").is_null());

    // Back under the administrator, they deliver to the account's devices.
    computer.core.profile_sign_out(false).unwrap();
    computer
        .core
        .profile_sign_in("admin", ADMIN_PASSWORD)
        .unwrap();
    settle(&[&computer, &tablet]);
    assert_eq!(entry(&tablet, "breakfast")["description"], "Buttered toast");
    assert_eq!(goals(&tablet)[0]["effectiveFrom"], "2030-05-01");
}

#[test]
fn joining_with_personal_records_brings_the_food_log_and_goals() {
    let server = Server::start();
    let computer = Device::new();
    save_recipe(&computer, "soup", "Soup");
    log_soup(&computer, "lunch", 2.0);
    log_toast(&computer, "breakfast");
    set_goals(&computer, "2030-05-01", 2000.0);
    computer.found_household(&server);
    computer.op(json!({
        "operation": "createAccount", "username": "sam", "password": SAM_PASSWORD
    }));

    let tablet = Device::new();
    tablet.join_as(&server, "admin", ADMIN_PASSWORD);
    assert_eq!(day(&tablet, DAY), day(&computer, DAY));
    assert_eq!(entry(&tablet, "lunch")["portions"], 2.0);
    assert_eq!(goals(&tablet), goals(&computer));
    let sam = Device::new();
    sam.join_as(&server, "sam", SAM_PASSWORD);
    assert_eq!(day(&sam, DAY)["entries"], json!([]));
    assert_eq!(goals(&sam), json!([]));
}
