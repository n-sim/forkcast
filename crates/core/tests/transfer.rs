//! Importing an explicit browser-profile transfer into an installed core.

mod common;

use common::{TempDatabase, cover_photo, risotto};
use forkcast_core::{ErrorKind, Principal};
use serde_json::{Value, json};

const PERSON: &str = "browser-person-1";

fn recipe_with_ids() -> Value {
    let mut recipe = risotto();
    recipe["nutritionVersionId"] = json!("nutrition-1");
    recipe["syncRevisionId"] = json!("revision-1");
    recipe
}

/// What the old browser profile's IndexedDB export looks like.
fn transfer() -> Value {
    let recipe = recipe_with_ids();
    let photo = serde_json::to_value(cover_photo()).unwrap();
    let version = json!({"id": "nutrition-1", "recipeId": "veggie-pumpkin-risotto",
        "perPortion": {"calories": 500.0, "protein": 15.0, "fat": 20.0, "carbohydrates": 70.0}});
    json!({
        "format": "forkcast-browser-transfer",
        "version": 1,
        "exportId": "export-1",
        "exportedAt": "2030-05-06T12:00:00Z",
        "source": {"origin": "https://forkcast.example"},
        "localPersonId": PERSON,
        "recipes": [recipe],
        "coverPhotos": [{"recipeId": "veggie-pumpkin-risotto", "mime": photo["mime"], "data": photo["data"]}],
        "nutritionVersions": [version],
        "recipeRevisions": [{"id": "revision-1", "parentId": null, "recipe": recipe_with_ids(),
            "nutritionVersions": [version], "coverPhoto": photo, "pending": true}],
        "ratings": [{"personId": PERSON, "recipeId": "veggie-pumpkin-risotto", "value": 4}],
        "ratingChanges": [],
        "plannedCookings": [{"id": "cooking-1", "recipeId": "veggie-pumpkin-risotto",
            "cookingDate": "2030-05-06", "portions": 4.0, "cookingTime": "18:30", "personId": PERSON}],
        "shoppingLists": [
            {"id": "list-old", "startDate": "2030-04-01", "endDate": "2030-04-07", "generatedAt": 1.0,
             "items": [], "contributions": [], "manualItems": [], "personId": PERSON},
            {"id": "list-1", "startDate": "2030-05-06", "endDate": "2030-05-12", "generatedAt": 2.0,
             "items": [], "contributions": [], "personId": PERSON,
             "manualItems": [{"id": "tea", "name": "Tea", "quantity": 1.0, "unit": "piece", "checked": true}]},
        ],
        "cookingSessions": [{"id": "session-1", "personId": PERSON, "recipe": recipe_with_ids(),
            "portions": 4.0, "displayUnits": "metric", "currentStep": 2, "timers": {}}],
        "manualFoodLogEntries": [{"id": "manual-1", "personId": PERSON, "description": "Tea",
            "consumedAt": "2030-05-06T08:00",
            "nutrition": {"calories": 2.0, "protein": null, "fat": null, "carbohydrates": null}}],
        "recipeFoodLogEntries": [{"id": "logged-1", "personId": PERSON,
            "recipeId": "veggie-pumpkin-risotto", "recipeName": "Veggie Kürbisrisotto",
            "nutritionVersionId": "nutrition-1", "consumedAt": "2030-05-06T19:00", "portions": 2.0}],
        "settings": {"foodLogDates": {PERSON: "2030-05-06"}, "shoppingListIds": {},
            "recipeSyncBinding": null, "recipeSyncCurrent": [], "planningSync": null},
        "aiPrompts": {"standalone": "Vegan only"},
        "backend": null,
    })
}

fn me(core: &forkcast_core::Core) -> Principal {
    core.current_principal().unwrap()
}

#[test]
fn a_standalone_browser_profile_arrives_whole_with_its_identities() {
    let database = TempDatabase::new();
    let core = database.open();
    let report = core.import_legacy(transfer()).unwrap();
    assert!(report.person_identity_preserved);
    assert_eq!((report.recipes, report.photos, report.ratings), (1, 1, 1));
    assert_eq!(report.cooking_sessions, 1);
    assert_eq!(report.food_log_entries, 2);
    assert!(
        report
            .notes
            .iter()
            .any(|note| note.contains("older shopping lists"))
    );

    let me = me(&core);
    assert_eq!(me.person_id(), PERSON);
    let recipes = core.recipes(&me).unwrap();
    assert_eq!(recipes[0].recipe["nutritionVersionId"], "nutrition-1");
    assert_eq!(recipes[0].revision_id, "revision-1");
    assert!(recipes[0].cover_photo.is_some());
    assert_eq!(core.ratings(&me).unwrap()[0].value, Some(4));
    assert_eq!(core.meal_plan(&me).unwrap().len(), 1);
    let list = core.shopping_list(&me).unwrap().unwrap();
    assert_eq!(list.list["id"], "list-1");
    assert_eq!(list.list["manualItems"][0]["checked"], true);
    // The cooking session resumes where it was.
    assert_eq!(core.cooking_sessions(&me).unwrap()[0]["currentStep"], 2);
    // Food-log entries keep resolving through their retained nutrition version.
    let day = serde_json::to_value(core.food_log(&me, "2030-05-06").unwrap()).unwrap();
    assert_eq!(day["totals"]["calories"]["knownValue"], 1002.0);
    assert_eq!(
        core.food_log_date(&me).unwrap().as_deref(),
        Some("2030-05-06")
    );
    assert_eq!(
        core.ai_preferences(&me).unwrap().recipe_prompt,
        "Vegan only"
    );
    // A standalone profile has nothing waiting for a server.
    assert_eq!(core.sync_status().unwrap().pending, 0);
}

#[test]
fn repeating_an_import_changes_nothing() {
    let database = TempDatabase::new();
    let core = database.open();
    core.import_legacy(transfer()).unwrap();
    let again = core.import_legacy(transfer()).unwrap();
    assert!(again.already_applied);
    drop(core);
    let core = database.open();
    let me = me(&core);
    assert_eq!(core.recipes(&me).unwrap().len(), 1);
    assert_eq!(core.cooking_sessions(&me).unwrap().len(), 1);
    // The same data under a new export id is applied without duplicates.
    let mut renamed = transfer();
    renamed["exportId"] = json!("export-2");
    core.import_legacy(renamed).unwrap();
    assert_eq!(core.recipes(&me).unwrap().len(), 1);
    assert_eq!(core.ratings(&me).unwrap().len(), 1);
    let day = serde_json::to_value(core.food_log(&me, "2030-05-06").unwrap()).unwrap();
    assert_eq!(day["entries"].as_array().unwrap().len(), 2);
}

#[test]
fn an_invalid_transfer_imports_nothing_and_can_be_retried_once_fixed() {
    let database = TempDatabase::new();
    let core = database.open();
    let mut broken = transfer();
    broken["recipes"][0]["steps"][0]["allocations"][0]["quantity"] = json!(-1.0);
    broken["recipeRevisions"][0]["recipe"]["steps"][0]["allocations"][0]["quantity"] = json!(-1.0);
    broken["manualFoodLogEntries"][0]["consumedAt"] = json!("not a time");
    let error = core.import_legacy(broken).err().unwrap();
    assert_eq!(error.kind, ErrorKind::Invalid);
    assert!(
        error.message.contains("nothing was changed"),
        "{}",
        error.message
    );
    assert!(error.message.contains("food-log"), "{}", error.message);
    let me = me(&core);
    assert!(core.recipes(&me).unwrap().is_empty());
    assert!(core.cooking_sessions(&me).unwrap().is_empty());
    assert_ne!(me.person_id(), PERSON, "no identity was taken");

    let report = core.import_legacy(transfer()).unwrap();
    assert!(!report.already_applied);
    assert_eq!(core.recipes(&self::me(&core)).unwrap().len(), 1);
}

#[test]
fn unsupported_or_credential_bearing_transfers_are_refused_with_guidance() {
    let database = TempDatabase::new();
    let core = database.open();
    let mut wrong = transfer();
    wrong["format"] = json!("something-else");
    assert_eq!(
        core.import_legacy(wrong).err().unwrap().kind,
        ErrorKind::Invalid
    );
    let mut future = transfer();
    future["version"] = json!(2);
    let error = core.import_legacy(future).err().unwrap();
    assert_eq!(error.kind, ErrorKind::Unsupported);
    assert!(error.message.contains("Nothing was imported"));
    let mut secret = transfer();
    secret["backend"] = json!({"url": "https://x.example", "accountId": "a", "householdId": "h", "token": "secret"});
    let error = core.import_legacy(secret).err().unwrap();
    assert!(error.message.contains("session token"));
    assert!(core.recipes(&me(&core)).unwrap().is_empty());
}

#[test]
fn a_household_profile_keeps_its_binding_and_pending_work_but_must_sign_in_again() {
    let database = TempDatabase::new();
    let core = database.open();
    let mut bound = transfer();
    bound["backend"] = json!({"url": "https://household.example", "accountId": "account-7", "householdId": "household-9"});
    bound["settings"]["recipeSyncBinding"] =
        json!({"url": "https://household.example", "householdId": "household-9"});
    bound["settings"]["recipeSyncCurrent"] = json!([]);
    bound["ratings"][0]["personId"] = json!("account-7");
    bound["ratingChanges"] = json!([{"id": "change-1", "personId": "account-7",
        "recipeId": "veggie-pumpkin-risotto", "value": 4}]);
    bound["plannedCookings"][0]["householdId"] = json!("household-9");
    bound["plannedCookings"][0]
        .as_object_mut()
        .unwrap()
        .remove("personId");
    bound["shoppingLists"] = json!([]);
    bound["settings"]["planningSync"] = json!({
        "binding": {"url": "https://household.example", "householdId": "household-9"},
        "snapshot": {"revision": "plan-3", "data": {"cookings": {}, "shoppingList": null}, "conflicts": []},
        "pending": [{"id": "mutation-1", "baseRevision": "plan-3", "baseMutationId": null,
            "baseData": {"cookings": {}, "shoppingList": null},
            "data": {"cookings": {}, "shoppingList": null}}],
    });
    let report = core.import_legacy(bound).unwrap();
    assert!(report.sign_in_required);
    assert_eq!(report.pending_changes, 3);

    let status = core.sync_status().unwrap();
    assert!(status.bound && status.signed_out && !status.signed_in);
    assert_eq!(
        status.server_url.as_deref(),
        Some("https://household.example")
    );
    assert_eq!(status.remote_household_id.as_deref(), Some("household-9"));
    assert_eq!(status.active_account.unwrap().id, "account-7");
    assert_eq!(status.pending, 3);
    // Pending work belongs to the account that made it; household data stays usable.
    let me = me(&core);
    assert_eq!(me.person_id(), "account-7");
    assert_eq!(core.recipes(&me).unwrap().len(), 1);
    assert_eq!(core.meal_plan(&me).unwrap().len(), 1);
    assert_eq!(
        core.ratings(&me).err().unwrap().kind,
        ErrorKind::Forbidden,
        "private records stay hidden until sign-in"
    );
    // Without a session nothing is delivered and nothing is lost.
    let after = core.sync_now().unwrap();
    assert_eq!(after.pending, 3);
}

#[test]
fn importing_into_a_profile_with_data_maps_records_without_taking_its_identity() {
    let database = TempDatabase::new();
    let core = database.open();
    let own = me(&core);
    core.rate_recipe(&own, "none", Some(1)).err();
    core.save_recipe(
        &own,
        forkcast_core::SaveRecipe {
            recipe: {
                let mut other = risotto();
                other["id"] = json!("existing");
                other["name"] = json!("Existing");
                other
            },
            base_revision_id: None,
        },
    )
    .unwrap();
    let report = core.import_legacy(transfer()).unwrap();
    assert!(!report.person_identity_preserved);
    let me = me(&core);
    assert_eq!(me.person_id(), own.person_id());
    assert_eq!(core.recipes(&me).unwrap().len(), 2);
    assert_eq!(core.ratings(&me).unwrap().len(), 1);
    assert_eq!(core.cooking_sessions(&me).unwrap().len(), 1);
}
