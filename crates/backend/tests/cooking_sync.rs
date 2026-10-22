//! Personal cooking sessions between one account's installed apps, and the
//! household's cooking history between everyone's, through a real server.

mod harness;

use harness::{Device, Server, save_recipe};
use serde_json::{Value, json};

const ADMIN_PASSWORD: &str = "correct horse battery";
const SAM_PASSWORD: &str = "another long passphrase";

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

fn start(device: &Device, portions: f64) -> Value {
    device.op(json!({
        "operation": "startCooking", "recipeId": "soup", "portions": portions,
        "displayUnits": "metric"
    }))["session"]
        .clone()
}

fn sessions(device: &Device) -> Vec<Value> {
    device
        .op(json!({"operation": "cookingSessions"}))
        .as_array()
        .unwrap()
        .clone()
}

fn save(device: &Device, id: &str, step: usize, timers: Value) -> Value {
    device.op(json!({
        "operation": "saveCookingProgress", "sessionId": id, "step": step, "timers": timers
    }))
}

fn paused_timer(minutes: f64) -> Value {
    let ms = minutes * 60_000.0;
    json!({"durationMs": ms, "remainingMs": ms, "endsAt": null})
}

fn history(device: &Device) -> Value {
    device.op(json!({"operation": "cookingHistory"}))
}

fn count(device: &Device) -> i64 {
    history(device)
        .as_array()
        .unwrap()
        .iter()
        .find(|entry| entry["recipeId"] == "soup")
        .map_or(0, |entry| entry["count"].as_i64().unwrap())
}

#[test]
fn a_session_resumes_on_the_same_accounts_other_device_with_what_it_captured() {
    let server = Server::start();
    let (computer, tablet, sam) = household(&server);
    let session = start(&computer, 3.0);
    let id = session["id"].as_str().unwrap();
    save(&computer, id, 1, json!({"step-2": paused_timer(4.5)}));
    computer.sync();

    // The recipe changes afterwards; resuming elsewhere keeps the capture.
    let mut edited = harness::recipe("soup", "Soup, but newer");
    edited["steps"].as_array_mut().unwrap().truncate(2);
    computer.op(json!({"operation": "saveRecipe", "recipe": edited, "baseRevisionId": null}));
    computer.sync();
    tablet.sync();

    let resumed = sessions(&tablet);
    assert_eq!(resumed.len(), 1);
    let resumed = &resumed[0];
    assert_eq!(resumed["id"], id);
    assert_eq!(resumed["recipe"], session["recipe"]);
    assert_eq!(resumed["recipe"]["name"], "Soup");
    assert_eq!(resumed["recipe"]["steps"].as_array().unwrap().len(), 4);
    assert_eq!(resumed["portions"], 3.0);
    assert_eq!(resumed["displayUnits"], "metric");
    assert_eq!(resumed["currentStep"], 1);
    assert_eq!(resumed["timers"]["step-2"], paused_timer(4.5));

    // Continuing there does not recapture the newer recipe either.
    let continued = save(&tablet, id, 3, json!({"step-2": paused_timer(4.5)}));
    assert_eq!(continued["recipe"]["name"], "Soup");
    tablet.sync();
    computer.sync();
    assert_eq!(sessions(&computer)[0]["currentStep"], 3);
    assert_eq!(sessions(&computer)[0]["recipe"]["name"], "Soup");

    // Another person never receives it, from the core or the server.
    sam.sync();
    assert!(sessions(&sam).is_empty());
}

#[test]
fn completion_counts_once_across_retries_and_devices_while_separate_cooks_add_up() {
    let server = Server::start();
    let (computer, tablet, sam) = household(&server);
    let session = start(&computer, 2.0);
    let id = session["id"].as_str().unwrap();
    save(&computer, id, 3, json!({}));
    computer.sync();
    tablet.sync();

    // The tablet marks the session's recipe cooked; the computer finishes
    // the same session, and retries the completion.
    tablet.op(json!({"operation": "markCooked", "recipeId": "soup", "sessionId": id}));
    for _ in 0..2 {
        computer.op(json!({"operation": "endCooking", "sessionId": id, "outcome": "finished"}));
    }
    // A separate cook marked twice with the same id counts once.
    let separate = uuid::Uuid::new_v4().to_string();
    for _ in 0..2 {
        sam.op(json!({"operation": "markCooked", "recipeId": "soup", "id": separate}));
    }
    for device in [&computer, &tablet, &sam, &computer, &tablet, &sam] {
        let status = device.sync();
        assert_eq!(status.pending, 0, "{:?}", status.last_error);
    }
    for device in [&computer, &tablet, &sam] {
        assert_eq!(count(device), 2);
    }
    // The finished session ended on the tablet too, without a food-log entry.
    assert!(sessions(&tablet).is_empty());
    assert_eq!(
        tablet.op(json!({"operation": "foodLog", "date": "2030-05-06"}))["entries"],
        json!([])
    );
}

#[test]
fn offline_progress_survives_a_cold_reopen_and_independent_changes_combine() {
    let mut server = Server::start();
    let (mut computer, tablet, _sam) = household(&server);
    let id = start(&computer, 2.0)["id"].as_str().unwrap().to_owned();
    computer.sync();
    tablet.sync();

    server.stop();
    // One device moves on while the other sets a timer on the first step.
    save(&computer, &id, 2, json!({}));
    computer.restart();
    assert_eq!(sessions(&computer)[0]["currentStep"], 2);
    save(&tablet, &id, 0, json!({"step-1": paused_timer(3.0)}));
    assert!(computer.sync().last_error.is_some());
    assert_eq!(computer.status().pending, 1);

    server.restart();
    for device in [&computer, &tablet, &computer] {
        let status = device.sync();
        assert_eq!(status.pending, 0, "{:?}", status.last_error);
    }
    for device in [&computer, &tablet] {
        let session = &sessions(device)[0];
        assert_eq!(session["currentStep"], 2);
        assert_eq!(session["timers"]["step-1"], paused_timer(3.0));
        assert!(session.get("conflict").is_none());
    }
}

#[test]
fn competing_progress_is_kept_for_an_explicit_decision() {
    let mut server = Server::start();
    let (computer, tablet, _sam) = household(&server);
    let id = start(&computer, 2.0)["id"].as_str().unwrap().to_owned();
    computer.sync();
    tablet.sync();

    server.stop();
    save(&computer, &id, 1, json!({}));
    save(&tablet, &id, 2, json!({}));
    server.restart();
    computer.sync();
    tablet.sync();
    computer.sync();

    for device in [&computer, &tablet] {
        let session = &sessions(device)[0];
        assert_eq!(session["currentStep"], 1);
        assert_eq!(session["conflict"]["progress"]["currentStep"], 2);
    }
    let resolved = tablet.op(json!({
        "operation": "resolveCookingSession", "sessionId": id, "keep": "alternative"
    }));
    assert_eq!(resolved["currentStep"], 2);
    assert!(resolved.get("conflict").is_none());
    tablet.sync();
    computer.sync();
    let session = &sessions(&computer)[0];
    assert_eq!(session["currentStep"], 2);
    assert!(session.get("conflict").is_none());

    // Nothing left to decide is refused rather than silently applied.
    let error = computer
        .try_op(json!({"operation": "resolveCookingSession", "sessionId": id, "keep": "current"}))
        .unwrap_err();
    assert_eq!(error.kind, forkcast_core::ErrorKind::Conflict);
}

#[test]
fn a_finished_session_never_silently_resumes_from_a_stale_device() {
    let mut server = Server::start();
    let (computer, tablet, _sam) = household(&server);
    let id = start(&computer, 2.0)["id"].as_str().unwrap().to_owned();
    save(&computer, &id, 3, json!({}));
    computer.sync();
    tablet.sync();

    server.stop();
    computer.op(json!({"operation": "endCooking", "sessionId": &id, "outcome": "finished"}));
    // The tablet, still offline, steps back and keeps cooking.
    save(&tablet, &id, 2, json!({}));
    server.restart();
    computer.sync();
    tablet.sync();
    computer.sync();

    // The finish stands, but the continuation waits for the person.
    for device in [&computer, &tablet] {
        let open = sessions(device);
        assert_eq!(open.len(), 1, "the decision is offered on every device");
        assert!(open[0]["completedAt"].is_number());
        assert_eq!(open[0]["conflict"]["progress"]["currentStep"], 2);
        assert!(open[0]["conflict"]["progress"]["completedAt"].is_null());
        assert_eq!(count(device), 1);
    }
    // Progress cannot be saved onto the finished session meanwhile.
    assert!(
        tablet
            .try_op(json!({"operation": "saveCookingProgress", "sessionId": &id, "step": 3, "timers": {}}))
            .is_err()
    );
    computer.op(json!({"operation": "resolveCookingSession", "sessionId": &id, "keep": "current"}));
    computer.sync();
    tablet.sync();
    for device in [&computer, &tablet] {
        assert!(sessions(device).is_empty());
        assert_eq!(count(device), 1);
    }
}

#[test]
fn sessions_started_on_two_offline_devices_both_wait_for_the_person() {
    let mut server = Server::start();
    let (computer, tablet, _sam) = household(&server);
    server.stop();
    let first = start(&computer, 2.0)["id"].as_str().unwrap().to_owned();
    let second = start(&tablet, 4.0)["id"].as_str().unwrap().to_owned();
    server.restart();
    computer.sync();
    tablet.sync();
    computer.sync();
    for device in [&computer, &tablet] {
        let mut ids: Vec<String> = sessions(device)
            .iter()
            .map(|session| session["id"].as_str().unwrap().to_owned())
            .collect();
        ids.sort();
        let mut expected = vec![first.clone(), second.clone()];
        expected.sort();
        assert_eq!(ids, expected);
    }
    // Starting again names both; canceling them counts no cooking.
    let started = computer.op(json!({
        "operation": "startCooking", "recipeId": "soup", "portions": 1.0,
        "cancelSessionIds": [&first, &second]
    }));
    assert!(started["session"].is_object());
    computer.sync();
    tablet.sync();
    assert_eq!(sessions(&tablet).len(), 1);
    assert_eq!(sessions(&tablet)[0]["portions"], 1.0);
    assert_eq!(count(&tablet), 0);
}

#[test]
fn joining_with_personal_records_brings_the_unfinished_session_and_past_cooking() {
    let server = Server::start();
    let computer = Device::new();
    save_recipe(&computer, "soup", "Soup");
    computer.op(json!({"operation": "markCooked", "recipeId": "soup"}));
    let id = start(&computer, 2.0)["id"].as_str().unwrap().to_owned();
    save(&computer, &id, 1, json!({}));
    computer.found_household(&server);
    computer.op(json!({
        "operation": "createAccount", "username": "sam", "password": SAM_PASSWORD
    }));

    let tablet = Device::new();
    tablet.join_as(&server, "admin", ADMIN_PASSWORD);
    assert_eq!(sessions(&tablet)[0]["id"], id.as_str());
    assert_eq!(sessions(&tablet)[0]["currentStep"], 1);
    let sam = Device::new();
    sam.join_as(&server, "sam", SAM_PASSWORD);
    assert_eq!(count(&sam), 1);
    assert!(sessions(&sam).is_empty());
}
