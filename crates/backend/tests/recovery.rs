//! Backing up and recovering a household server, observed through real
//! installed cores, real HTTP, and real SQLite: what returns is judged by
//! what members and their devices see, not by table layouts.

mod harness;

use base64::{Engine, engine::general_purpose::STANDARD};
use harness::{Device, Server, plan, recipe, remove, save_recipe, temp};
use serde_json::{Value, json};
use std::path::PathBuf;

fn backup_file() -> PathBuf {
    temp("backup")
}

fn photo() -> Value {
    json!({
        "mime": "image/png",
        "data": STANDARD.encode(include_bytes!("../../../tests/fixtures/cover-photo.png")),
    })
}

/// A household with an administrator device and a member's device, holding a
/// shared recipe with a cover photo and two retained nutrition versions, a
/// plan, and a rating belonging to each person.
fn household(server: &Server) -> (Device, Device) {
    let admin = Device::new();
    save_recipe(&admin, "soup", "Soup");
    let mut richer = recipe("soup", "Soup");
    richer["nutrition"] =
        json!({"calories": 2400.0, "protein": 70.0, "fat": 90.0, "carbohydrates": 300.0});
    admin.op(json!({"operation": "saveRecipe", "recipe": richer}));
    admin
        .op(json!({"operation": "setRecipeCoverPhoto", "recipeId": "soup", "coverPhoto": photo()}));
    plan(&admin, "monday", "soup", "2030-05-06", 4.0);
    admin.found_household(server);
    admin.op(json!({
        "operation": "createAccount", "username": "sam", "password": "another long passphrase"
    }));
    let member = Device::new();
    member.join_as(server, "sam", "another long passphrase");
    admin.op(json!({"operation": "rateRecipe", "recipeId": "soup", "value": 4}));
    member.op(json!({"operation": "rateRecipe", "recipeId": "soup", "value": 2}));
    admin.sync();
    member.sync();
    (admin, member)
}

fn ratings(device: &Device) -> Vec<i64> {
    device
        .op(json!({"operation": "ratings"}))
        .as_array()
        .unwrap()
        .iter()
        .map(|rating| rating["value"].as_i64().unwrap())
        .collect()
}

#[test]
fn a_new_server_recovers_accounts_shared_records_photos_and_personal_ownership() {
    let backup = backup_file();
    let server = Server::start();
    let (admin, member) = household(&server);
    let before = member.op(json!({"operation": "recipeCollection"}));
    let newest = before["revisions"].as_array().unwrap().last().unwrap();
    assert_eq!(newest["nutritionVersions"].as_array().unwrap().len(), 2);
    assert_eq!(newest["coverPhoto"], photo());
    let report = server.backup(&backup);
    assert_eq!((report.accounts, report.recipes), (2, 1));

    // The original instance is gone; a new, empty one answers at its address.
    let address = server.address();
    drop(server);
    Server::wait_for(address);
    let mut recovered = Server::fresh_at(address);
    let restored = recovered.recover_from(&backup);
    assert_eq!(restored.backup, report);

    // A person who has never used this instance signs in with the password
    // they had and sees the household exactly as it was.
    let newcomer = Device::new();
    newcomer.join_as(&recovered, "sam", "another long passphrase");
    let after = newcomer.op(json!({"operation": "recipeCollection"}));
    assert_eq!(
        after, before,
        "revisions, photo, and retained nutrition versions"
    );
    assert_eq!(newcomer.recipe_names(), ["Soup"]);
    assert_eq!(
        newcomer.op(json!({"operation": "recipes"}))[0]["coverPhoto"],
        photo()
    );
    let plan = newcomer.op(json!({"operation": "mealPlan"}))["cookings"].clone();
    assert_eq!(plan.as_array().unwrap().len(), 1);
    // Each account keeps only its own rating.
    assert_eq!(ratings(&newcomer), [2]);
    admin.sync();
    assert_eq!(ratings(&admin), [4]);

    // Devices that were already linked carry on without signing in again or
    // re-contributing anything, and the household is still the same one.
    let household_id = admin.status().remote_household_id;
    let status = admin.sync();
    assert!(status.last_error.is_none(), "{:?}", status.last_error);
    assert_eq!(status.pending, 0);
    assert_eq!(status.remote_household_id, household_id);
    assert_eq!(admin.recipe_names(), ["Soup"]);
    assert_eq!(member.sync().pending, 0);
    remove(&backup);
}

#[test]
fn an_account_created_after_the_backup_is_not_recovered_and_the_rest_is() {
    let backup = backup_file();
    let mut server = Server::start();
    let (admin, _member) = household(&server);
    server.backup(&backup);
    admin.op(json!({
        "operation": "createAccount", "username": "late", "password": "a passphrase made later"
    }));
    save_recipe(&admin, "tea", "Tea");
    admin.sync();
    let latecomer = Device::new();
    latecomer.join_as(&server, "late", "a passphrase made later");
    assert_eq!(latecomer.recipe_names(), ["Soup", "Tea"]);

    server.recover_from(&backup);

    let refused = Device::new();
    refused.core.connect_server(&server.url).unwrap();
    assert!(
        refused
            .core
            .authenticate_server(false, "late", "a passphrase made later", None)
            .is_err()
    );
    let kept = Device::new();
    kept.join_as(&server, "sam", "another long passphrase");
    assert_eq!(kept.recipe_names(), ["Soup"]);
    remove(&backup);
}

#[test]
fn devices_with_pending_work_reconcile_with_a_recovered_server_and_conflicts_are_surfaced() {
    let backup = backup_file();
    let mut server = Server::start();
    let (admin, member) = household(&server);
    server.backup(&backup);
    let household_id = admin.status().remote_household_id;

    // The server is lost. Both devices keep working and queue changes: the
    // same recipe is edited differently on each, and each adds something new.
    server.stop();
    let base = admin.op(json!({"operation": "recipes"}))[0]["revisionId"].clone();
    let mut ours = recipe("soup", "Admin soup");
    ours["label"] = json!("a");
    let mut theirs = recipe("soup", "Member soup");
    theirs["label"] = json!("b");
    admin.op(json!({"operation": "saveRecipe", "recipe": ours, "baseRevisionId": base}));
    member.op(json!({"operation": "saveRecipe", "recipe": theirs, "baseRevisionId": base}));
    save_recipe(&admin, "tea", "Tea");
    save_recipe(&member, "bread", "Bread");
    assert!(admin.sync().pending >= 2);
    assert!(member.sync().pending >= 2);

    server.recover_from(&backup);

    for _ in 0..2 {
        let status = admin.sync();
        assert!(status.last_error.is_none(), "{:?}", status.last_error);
        member.sync();
    }
    assert_eq!(admin.status().pending, 0);
    assert_eq!(member.status().pending, 0);
    assert_eq!(admin.status().remote_household_id, household_id);
    // Nothing was lost and nothing was silently overwritten.
    for device in [&admin, &member] {
        assert_eq!(device.recipe_names().len(), 3, "Soup, Tea, and Bread");
        assert!(device.recipe_names().contains(&"Tea".to_owned()));
        assert!(device.recipe_names().contains(&"Bread".to_owned()));
        assert_eq!(device.status().conflicts.recipes, 1);
        let collection = device.op(json!({"operation": "recipeCollection"}));
        let soup = collection["current"]
            .as_array()
            .unwrap()
            .iter()
            .find(|head| head["recipeId"] == "soup")
            .unwrap();
        assert_eq!(soup["competingRevisionIds"].as_array().unwrap().len(), 2);
    }
    remove(&backup);
}
