//! Representative workflows through the public interface, against real SQLite.

mod common;

use common::{TempDatabase, cover_photo, risotto};
use forkcast_core::{
    CookingOutcome, Core, Credentials, CurrentChoice, ErrorKind, LogManualFood, LogRecipeFood,
    MarkCooked, Operation, Principal, SaveRecipe, SetCoverPhoto, SetupServer, ShoppingItemKind,
    SourceStatus, StartCooking, Topic,
};
use forkcast_recipe_domain::{planning::PlannedCooking, shopping::ShoppingItem};
use serde_json::{Value, json};
use std::time::Duration;

fn save(core: &Core, who: &Principal, recipe: Value) -> forkcast_core::SavedRecipe {
    core.save_recipe(
        who,
        SaveRecipe {
            recipe,
            base_revision_id: None,
        },
    )
    .expect("save recipe")
}

fn cooking(id: &str, date: &str, portions: f64) -> PlannedCooking {
    serde_json::from_value(json!({
        "id": id, "recipeId": "veggie-pumpkin-risotto", "cookingDate": date,
        "portions": portions, "cookingTime": "18:30",
    }))
    .unwrap()
}

fn manual_food(id: &str) -> LogManualFood {
    serde_json::from_value(json!({
        "id": id, "description": "Soup", "consumedAt": "2030-05-06T12:00",
        "nutrition": {"calories": 100.0, "protein": null, "fat": null, "carbohydrates": null},
    }))
    .unwrap()
}

#[test]
fn standalone_person_is_created_once_and_survives_restart() {
    let database = TempDatabase::new();
    let first = database.open().standalone().unwrap();
    let again = database.open().standalone().unwrap();
    assert_eq!(first.person_id(), again.person_id());
    assert_eq!(first.household_id(), again.household_id());
}

#[test]
fn a_server_database_is_not_a_standalone_profile() {
    let database = TempDatabase::new();
    let core = database.open();
    core.setup_server(SetupServer {
        household_name: "Home".into(),
        username: "admin".into(),
        password: "correct horse battery".into(),
    })
    .unwrap();
    assert_eq!(core.standalone().err().unwrap().kind, ErrorKind::Conflict);
}

#[test]
fn recipes_keep_versions_photos_and_ratings_across_restart() {
    let database = TempDatabase::new();
    let core = database.open();
    let me = core.standalone().unwrap();

    let first = save(&core, &me, risotto());
    let version = first.current.recipe["nutritionVersionId"]
        .as_str()
        .unwrap()
        .to_owned();

    // Unchanged nutrition keeps its retained version; a change mints a new one.
    let renamed = {
        let mut recipe = risotto();
        recipe["name"] = json!("Pumpkin risotto");
        save(&core, &me, recipe)
    };
    assert_eq!(
        renamed.current.recipe["nutritionVersionId"],
        version.as_str()
    );
    let richer = {
        let mut recipe = risotto();
        recipe["name"] = json!("Pumpkin risotto");
        recipe["nutrition"]["calories"] = json!(2400.0);
        save(&core, &me, recipe)
    };
    let newer = richer.current.recipe["nutritionVersionId"]
        .as_str()
        .unwrap()
        .to_owned();
    assert_ne!(newer, version);

    core.set_recipe_cover_photo(
        &me,
        SetCoverPhoto {
            recipe_id: "veggie-pumpkin-risotto".into(),
            cover_photo: Some(cover_photo()),
            base_revision_id: None,
        },
    )
    .unwrap();
    core.rate_recipe(&me, "veggie-pumpkin-risotto", Some(4))
        .unwrap();
    assert_eq!(
        core.rate_recipe(&me, "veggie-pumpkin-risotto", Some(9))
            .err()
            .unwrap()
            .kind,
        ErrorKind::Invalid
    );
    assert_eq!(
        core.rate_recipe(&me, "unknown", Some(3))
            .err()
            .unwrap()
            .kind,
        ErrorKind::NotFound
    );

    drop(core);
    let core = database.open();
    let recipes = core.recipes(&me).unwrap();
    assert_eq!(recipes.len(), 1);
    assert_eq!(recipes[0].recipe["name"], "Pumpkin risotto");
    assert_eq!(recipes[0].recipe["nutritionVersionId"], newer.as_str());
    assert!(recipes[0].cover_photo.is_some());
    assert_eq!(core.ratings(&me).unwrap()[0].value, Some(4));
    // Both nutrition versions stay available to food-log entries.
    let collection = core.recipe_collection(&me).unwrap();
    let versions: Vec<String> = collection
        .revisions
        .iter()
        .flat_map(|revision| revision["nutritionVersions"].as_array().unwrap().clone())
        .map(|version| version["id"].as_str().unwrap().to_owned())
        .collect();
    assert!(versions.contains(&version));
    assert!(versions.contains(&newer));
}

#[test]
fn an_edit_from_a_stale_revision_is_kept_as_a_competing_alternative() {
    let database = TempDatabase::new();
    let core = database.open();
    let me = core.standalone().unwrap();
    let base = save(&core, &me, risotto()).saved_revision_id;
    let mut ours = risotto();
    ours["name"] = json!("Ours");
    let current = save(&core, &me, ours).current;
    assert_eq!(current.unresolved, 0);

    let mut theirs = risotto();
    theirs["name"] = json!("Theirs");
    let stale = core
        .save_recipe(
            &me,
            SaveRecipe {
                recipe: theirs,
                base_revision_id: Some(base),
            },
        )
        .unwrap();
    // The competing edit did not replace the current recipe.
    assert_eq!(stale.current.recipe["name"], "Ours");
    assert_eq!(stale.current.unresolved, 1);

    let head = serde_json::to_value(&core.recipe_collection(&me).unwrap().current[0]).unwrap();
    let mut expected: Vec<String> = head["competingRevisionIds"]
        .as_array()
        .unwrap()
        .iter()
        .map(|id| id.as_str().unwrap().to_owned())
        .collect();
    expected.sort();
    core.choose_current_recipe(
        &me,
        "veggie-pumpkin-risotto",
        CurrentChoice {
            revision_id: stale.saved_revision_id.clone(),
            expected_revision_ids: expected,
        },
    )
    .unwrap();
    let chosen = &core.recipes(&me).unwrap()[0];
    assert_eq!(chosen.recipe["name"], "Theirs");
    assert_eq!(chosen.unresolved, 0);
}

#[test]
fn planning_shopping_cooking_and_food_log_work_end_to_end() {
    let database = TempDatabase::new();
    let core = database.open();
    let me = core.standalone().unwrap();
    let saved = save(&core, &me, risotto()).current;
    let version = saved.recipe["nutritionVersionId"]
        .as_str()
        .unwrap()
        .to_owned();

    // Planning needs a household recipe.
    let mut unknown = cooking("c0", "2030-05-06", 2.0);
    unknown.recipe_id = "missing".into();
    assert_eq!(
        core.plan_cooking(&me, unknown, None).err().unwrap().kind,
        ErrorKind::Invalid
    );
    core.plan_cooking(&me, cooking("c1", "2030-05-06", 8.0), None)
        .unwrap();
    core.plan_cooking(&me, cooking("c2", "2030-05-07", 4.0), None)
        .unwrap();
    assert_eq!(core.meal_plan(&me).unwrap().cookings.len(), 2);

    // Shopping totals come from the shared domain calculation: 12 portions
    // of a 4-portion recipe needs 3x the 600 g pumpkin, shown as 1.8 kg.
    let list = core
        .generate_shopping_list(&me, "2030-05-06", "2030-05-07", None, None)
        .unwrap();
    let items = list.list["items"].as_array().unwrap();
    let pumpkin = items
        .iter()
        .find(|item| item["name"].as_str().unwrap().starts_with("Kürbis"))
        .unwrap();
    assert_eq!(pumpkin["quantity"], 1.8);
    assert_eq!(pumpkin["unit"], "kg");
    assert_eq!(list.source_status, SourceStatus::Unchanged);
    let list_id = list.list["id"].as_str().unwrap().to_owned();
    let item_id = pumpkin["id"].as_str().unwrap().to_owned();

    // A list changed elsewhere is never replaced unseen.
    assert_eq!(
        core.generate_shopping_list(&me, "2030-05-06", "2030-05-07", None, None)
            .err()
            .unwrap()
            .kind,
        ErrorKind::Conflict
    );
    core.check_shopping_item(&me, &list_id, &item_id, true, None)
        .unwrap();
    core.save_shopping_item(
        &me,
        &list_id,
        ShoppingItemKind::Manual,
        serde_json::from_value::<ShoppingItem>(
            json!({"id": "m1", "name": "Coffee", "quantity": 1.0, "unit": "piece"}),
        )
        .unwrap(),
        None,
    )
    .unwrap();
    // Changing the plan marks the reviewed list's sources as changed.
    core.plan_cooking(&me, cooking("c2", "2030-05-07", 6.0), None)
        .unwrap();
    let view = core.shopping_list(&me).unwrap().unwrap();
    assert_eq!(view.source_status, SourceStatus::Changed);
    let regenerated = core
        .generate_shopping_list(&me, "2030-05-06", "2030-05-07", Some(&list_id), None)
        .unwrap();
    assert_eq!(regenerated.list["manualItems"][0]["name"], "Coffee");
    assert_eq!(regenerated.list["manualItems"][0]["checked"], false);
    let new_id = regenerated.list["id"].as_str().unwrap().to_owned();
    let done = core.complete_shopping_list(&me, &new_id, None).unwrap();
    assert_eq!(done.list["completed"], true);
    assert_eq!(
        core.check_shopping_item(&me, &list_id, &item_id, true, None)
            .err()
            .unwrap()
            .kind,
        ErrorKind::Conflict
    );

    // One unfinished cooking session per person; the person decides.
    let start = || StartCooking {
        recipe_id: "veggie-pumpkin-risotto".into(),
        portions: 6.0,
        display_units: Some("metric".into()),
        cancel_session_ids: vec![],
    };
    let begun = core.start_cooking(&me, start()).unwrap().session.unwrap();
    let id = begun["id"].as_str().unwrap().to_owned();
    let blocked = core.start_cooking(&me, start()).unwrap();
    assert!(blocked.session.is_none());
    assert_eq!(blocked.conflicts[0]["id"], id.as_str());
    assert_eq!(
        core.end_cooking(&me, &id, CookingOutcome::Finished)
            .err()
            .unwrap()
            .kind,
        ErrorKind::Invalid,
        "finishing needs the last step"
    );
    let timer = json!({"durationMs": 60000.0, "remainingMs": 60000.0, "endsAt": null});
    core.save_cooking_progress(&me, &id, 3, json!({"step-3": timer}))
        .unwrap();
    assert_eq!(
        core.save_cooking_progress(&me, &id, 9, json!({}))
            .err()
            .unwrap()
            .kind,
        ErrorKind::Invalid
    );

    // The session resumes after a restart, captured from when it started.
    drop(core);
    let core = database.open();
    let resumed = core.cooking_sessions(&me).unwrap();
    assert_eq!(resumed[0]["currentStep"], 3);
    assert_eq!(resumed[0]["timers"]["step-3"]["durationMs"], 60000.0);
    core.end_cooking(&me, &id, CookingOutcome::Finished)
        .unwrap();
    assert!(core.cooking_sessions(&me).unwrap().is_empty());

    // Food log: entries keep the retained nutrition version they referenced.
    let entry = || LogRecipeFood {
        id: Some("e1".into()),
        recipe_id: "veggie-pumpkin-risotto".into(),
        nutrition_version_id: version.clone(),
        consumed_at: "2030-05-06T19:00".into(),
        portions: Some(2.0),
    };
    core.log_recipe_food(&me, entry()).unwrap();
    // A retry of the same entry changes nothing.
    core.log_recipe_food(&me, entry()).unwrap();
    core.log_manual_food(
        &me,
        serde_json::from_value::<LogManualFood>(json!({
            "description": "Coffee", "consumedAt": "2030-05-06T08:00",
            "nutrition": {"calories": 5.0, "protein": null, "fat": null, "carbohydrates": null},
        }))
        .unwrap(),
    )
    .unwrap();
    assert_eq!(
        core.food_log_date(&me).unwrap().as_deref(),
        Some("2030-05-06")
    );
    let day = serde_json::to_value(core.food_log(&me, "2030-05-06").unwrap()).unwrap();
    assert_eq!(day["entries"].as_array().unwrap().len(), 2);
    // 2000 kcal for 4 portions, 2 portions eaten, plus the coffee.
    assert_eq!(day["totals"]["calories"]["knownValue"], 1005.0);
    assert_eq!(day["totals"]["protein"]["unknownEntries"], 1);
    assert_eq!(day["incomplete"], true);

    // The serializable contract reaches the same implementation.
    let operation = |value: Value| -> Operation { serde_json::from_value(value).unwrap() };
    let prompt = core
        .execute(&me, operation(json!({"operation": "aiPreferences"})))
        .unwrap();
    assert!(prompt["recipePrompt"].as_str().unwrap().contains("metric"));
    core.execute(
        &me,
        operation(json!({"operation": "setRecipePrompt", "prompt": "Vegan only"})),
    )
    .unwrap();
    let via_operation = core
        .execute(
            &me,
            operation(json!({"operation": "foodLog", "date": "2030-05-06"})),
        )
        .unwrap();
    assert_eq!(via_operation, day);
    assert_eq!(
        core.ai_preferences(&me).unwrap().recipe_prompt,
        "Vegan only"
    );
}

#[test]
fn each_day_is_compared_against_the_nutrition_goals_that_applied_then() {
    let database = TempDatabase::new();
    let core = database.open();
    let me = core.standalone().unwrap();
    let operation = |value: Value| -> Operation { serde_json::from_value(value).unwrap() };
    let set = |from: &str, targets: Value| {
        core.execute(
            &me,
            operation(json!({"operation": "setNutritionGoals", "effectiveFrom": from, "targets": targets})),
        )
    };
    let day = |date: &str| serde_json::to_value(core.food_log(&me, date).unwrap()).unwrap();

    let invalid = set(
        "2030-05-01",
        json!({"calories": 0.0, "protein": null, "fat": null, "carbohydrates": null}),
    )
    .err()
    .unwrap();
    assert_eq!(invalid.kind, ErrorKind::Invalid);
    assert!(core.nutrition_goals(&me).unwrap().is_empty());

    set(
        "2030-05-01",
        json!({"calories": 2000.0, "protein": 120.0, "fat": null, "carbohydrates": 250.0}),
    )
    .unwrap();
    core.log_manual_food(&me, manual_food("soup")).unwrap();
    // A later change applies from its own date only.
    set(
        "2030-05-10",
        json!({"calories": 1800.0, "protein": 140.0, "fat": 60.0, "carbohydrates": null}),
    )
    .unwrap();

    let before = day("2030-04-30");
    assert_eq!(before["goals"], Value::Null);
    assert_eq!(before["totals"]["calories"]["target"], Value::Null);
    let earlier = day("2030-05-06");
    assert_eq!(earlier["goals"]["effectiveFrom"], "2030-05-01");
    assert_eq!(earlier["totals"]["calories"]["target"], 2000.0);
    assert_eq!(earlier["totals"]["fat"]["target"], Value::Null);
    // Unknown intake stays unknown and the day stays incomplete.
    assert_eq!(earlier["totals"]["calories"]["knownValue"], 100.0);
    assert_eq!(earlier["totals"]["protein"]["knownValue"], Value::Null);
    assert_eq!(earlier["incomplete"], true);
    assert_eq!(day("2030-05-09")["totals"]["calories"]["target"], 2000.0);
    let later = day("2030-05-10");
    assert_eq!(later["totals"]["calories"]["target"], 1800.0);
    assert_eq!(later["totals"]["fat"]["target"], 60.0);
    assert_eq!(later["totals"]["carbohydrates"]["target"], Value::Null);

    // Goals survive a restart, newest first; the same date replaces its set.
    let core = database.open();
    set(
        "2030-05-10",
        json!({"calories": 1900.0, "protein": null, "fat": null, "carbohydrates": null}),
    )
    .unwrap();
    let history = core
        .execute(&me, operation(json!({"operation": "nutritionGoals"})))
        .unwrap();
    assert_eq!(history.as_array().unwrap().len(), 2);
    assert_eq!(history[0]["effectiveFrom"], "2030-05-10");
    assert_eq!(history[0]["targets"]["calories"], 1900.0);
    assert_eq!(day("2030-05-06")["totals"]["calories"]["target"], 2000.0);

    // Removing a set lets the previous one apply again.
    core.execute(
        &me,
        operation(json!({"operation": "removeNutritionGoals", "effectiveFrom": "2030-05-10"})),
    )
    .unwrap();
    assert_eq!(day("2030-05-20")["totals"]["calories"]["target"], 2000.0);
    assert_eq!(
        core.remove_nutrition_goals(&me, "2030-05-10")
            .err()
            .unwrap()
            .kind,
        ErrorKind::NotFound
    );
}

#[test]
fn use_current_nutrition_updates_only_the_chosen_food_log_entry() {
    let database = TempDatabase::new();
    let core = database.open();
    let me = core.standalone().unwrap();
    let older = save(&core, &me, risotto()).current.recipe["nutritionVersionId"]
        .as_str()
        .unwrap()
        .to_owned();
    let log = |id: &str, at: &str| LogRecipeFood {
        id: Some(id.into()),
        recipe_id: "veggie-pumpkin-risotto".into(),
        nutrition_version_id: older.clone(),
        consumed_at: at.into(),
        portions: Some(1.0),
    };
    core.log_recipe_food(&me, log("lunch", "2030-05-06T12:00"))
        .unwrap();
    core.log_recipe_food(&me, log("dinner", "2030-05-06T19:00"))
        .unwrap();
    core.log_recipe_food(&me, log("next-day", "2030-05-07T12:00"))
        .unwrap();
    let newer = {
        let mut recipe = risotto();
        recipe["nutrition"]["calories"] = json!(2400.0);
        save(&core, &me, recipe).current.recipe["nutritionVersionId"]
            .as_str()
            .unwrap()
            .to_owned()
    };
    assert_ne!(newer, older);
    let references = |date: &str| -> Vec<(String, String, Value)> {
        let day = serde_json::to_value(core.food_log(&me, date).unwrap()).unwrap();
        day["entries"]
            .as_array()
            .unwrap()
            .iter()
            .map(|entry| {
                (
                    entry["id"].as_str().unwrap().to_owned(),
                    entry["nutritionVersionId"].as_str().unwrap().to_owned(),
                    entry["nutrition"]["calories"].clone(),
                )
            })
            .collect()
    };
    // Every entry still references the older version: 2000 kcal for 4 portions.
    for (_, version, calories) in references("2030-05-06")
        .into_iter()
        .chain(references("2030-05-07"))
    {
        assert_eq!(version, older);
        assert_eq!(calories, 500.0);
    }

    let changes = core.subscribe(&me);
    assert!(core.use_current_food_nutrition(&me, "dinner").unwrap());
    assert_eq!(
        changes.next_timeout(Duration::from_secs(1)).unwrap().topic,
        Topic::FoodLog
    );
    assert_eq!(
        references("2030-05-06"),
        vec![
            ("lunch".into(), older.clone(), json!(500.0)),
            ("dinner".into(), newer.clone(), json!(600.0)),
        ]
    );
    assert_eq!(
        references("2030-05-07"),
        vec![("next-day".into(), older.clone(), json!(500.0))]
    );
    // Repeating it changes nothing, and the update survives a restart.
    assert!(!core.use_current_food_nutrition(&me, "dinner").unwrap());
    drop(changes);
    drop(core);
    let core = database.open();
    let operation = |value: Value| -> Operation { serde_json::from_value(value).unwrap() };
    assert_eq!(
        core.execute(
            &me,
            operation(json!({"operation": "useCurrentFoodNutrition", "entryId": "lunch"})),
        )
        .unwrap(),
        json!({"changed": true})
    );
    let day = serde_json::to_value(core.food_log(&me, "2030-05-07").unwrap()).unwrap();
    assert_eq!(day["entries"][0]["nutritionVersionId"], older.as_str());
    assert_eq!(
        core.use_current_food_nutrition(&me, "missing")
            .err()
            .unwrap()
            .kind,
        ErrorKind::NotFound
    );
}

fn server(database: &TempDatabase) -> (Core, Principal, Principal) {
    let core = database.open();
    let admin = core
        .setup_server(SetupServer {
            household_name: "Home".into(),
            username: "admin".into(),
            password: "correct horse battery".into(),
        })
        .unwrap();
    let admin = core.authenticate(&admin.token).unwrap().principal;
    let member = core
        .create_account(
            &admin,
            Credentials {
                username: "sam".into(),
                password: "another long passphrase".into(),
            },
        )
        .unwrap();
    let signed_in = core
        .sign_in(Credentials {
            username: member.username,
            password: "another long passphrase".into(),
        })
        .unwrap();
    let member = core.authenticate(&signed_in.token).unwrap().principal;
    (core, admin, member)
}

#[test]
fn household_records_are_shared_and_personal_records_are_not() {
    let database = TempDatabase::new();
    let (core, admin, member) = server(&database);
    assert_eq!(admin.household_id(), member.household_id());
    save(&core, &admin, risotto());
    assert_eq!(core.recipes(&member).unwrap().len(), 1);
    core.plan_cooking(&member, cooking("c1", "2030-05-06", 2.0), None)
        .unwrap();
    assert_eq!(core.meal_plan(&admin).unwrap().cookings.len(), 1);

    // Ratings, cooking sessions, food logs, and AI preferences stay personal.
    core.rate_recipe(&admin, "veggie-pumpkin-risotto", Some(5))
        .unwrap();
    assert!(core.ratings(&member).unwrap().is_empty());
    let begun = core
        .start_cooking(
            &admin,
            StartCooking {
                recipe_id: "veggie-pumpkin-risotto".into(),
                portions: 4.0,
                display_units: None,
                cancel_session_ids: vec![],
            },
        )
        .unwrap()
        .session
        .unwrap();
    assert!(core.cooking_sessions(&member).unwrap().is_empty());
    let id = begun["id"].as_str().unwrap();
    assert_eq!(
        core.end_cooking(&member, id, CookingOutcome::Canceled)
            .err()
            .unwrap()
            .kind,
        ErrorKind::NotFound
    );
    core.log_manual_food(&admin, manual_food("shared-id"))
        .unwrap();
    assert!(
        core.food_log(&member, "2030-05-06")
            .unwrap()
            .entries
            .is_empty()
    );
    assert_eq!(
        core.log_manual_food(&member, manual_food("shared-id"))
            .err()
            .unwrap()
            .kind,
        ErrorKind::Forbidden
    );
    core.execute(
        &admin,
        serde_json::from_value(
            json!({"operation": "setNutritionGoals", "effectiveFrom": "2030-05-01",
            "targets": {"calories": 2000.0, "protein": null, "fat": null, "carbohydrates": null}}),
        )
        .unwrap(),
    )
    .unwrap();
    assert!(core.nutrition_goals(&member).unwrap().is_empty());
    assert_eq!(core.food_log(&member, "2030-05-06").unwrap().goals, None);
    let version = save(&core, &admin, risotto()).current.recipe["nutritionVersionId"]
        .as_str()
        .unwrap()
        .to_owned();
    core.log_recipe_food(
        &admin,
        LogRecipeFood {
            id: Some("admin-lunch".into()),
            recipe_id: "veggie-pumpkin-risotto".into(),
            nutrition_version_id: version,
            consumed_at: "2030-05-06T12:00".into(),
            portions: Some(1.0),
        },
    )
    .unwrap();
    assert_eq!(
        core.use_current_food_nutrition(&member, "admin-lunch")
            .err()
            .unwrap()
            .kind,
        ErrorKind::Forbidden
    );
    core.set_recipe_prompt(&admin, "Admin only").unwrap();
    assert_ne!(
        core.ai_preferences(&member).unwrap().recipe_prompt,
        "Admin only"
    );

    // Server entry points authorize the owner named by a request path, and
    // administration never grants access to another person's records.
    assert_eq!(
        member.require_person(admin.person_id()).err().unwrap().kind,
        ErrorKind::Forbidden
    );
    assert_eq!(
        member.require_household("elsewhere").err().unwrap().kind,
        ErrorKind::Forbidden
    );
    assert_eq!(
        core.accounts(&member).err().unwrap().kind,
        ErrorKind::Forbidden
    );
    assert_eq!(core.accounts(&admin).unwrap().len(), 2);
}

#[test]
fn committed_changes_are_published_to_those_who_may_see_them() {
    let database = TempDatabase::new();
    let (core, admin, member) = server(&database);
    let for_admin = core.subscribe(&admin);
    let for_member = core.subscribe(&member);

    save(&core, &admin, risotto());
    core.rate_recipe(&admin, "veggie-pumpkin-risotto", Some(3))
        .unwrap();
    // A rolled-back operation announces nothing.
    assert!(core.rate_recipe(&admin, "unknown", Some(3)).is_err());

    let wait = Duration::from_millis(200);
    let mut admin_topics = vec![];
    while let Some(change) = for_admin.next_timeout(wait) {
        admin_topics.push(change.topic);
    }
    assert_eq!(admin_topics, [Topic::Recipes, Topic::Ratings]);
    // The member sees the shared recipe change, never the admin's rating.
    let change = for_member.next_timeout(wait).unwrap();
    assert_eq!(change.topic, Topic::Recipes);
    assert!(for_member.next_timeout(wait).is_none());
}

#[test]
fn every_operation_shape_parses_from_the_serialized_contract() {
    let shapes = [
        json!({"operation": "startCooking", "recipeId": "r", "portions": 2.0, "cancelSessionIds": []}),
        json!({"operation": "markCooked", "recipeId": "r", "id": "i", "sessionId": "s"}),
        json!({"operation": "cookingHistory"}),
        json!({"operation": "logRecipeFood", "recipeId": "r", "nutritionVersionId": "v",
               "consumedAt": "2030-05-06T19:00", "portions": 1.0}),
        json!({"operation": "useCurrentFoodNutrition", "entryId": "e"}),
        json!({"operation": "logManualFood", "description": "Tea", "consumedAt": "2030-05-06T19:00",
               "nutrition": {"calories": null, "protein": null, "fat": null, "carbohydrates": null}}),
        json!({"operation": "connectServer", "serverUrl": "https://x.example"}),
        json!({"operation": "completeJoin", "recipeIds": ["r"], "adoptPersonal": true}),
        json!({"operation": "changeAccount", "id": "a", "active": false}),
        json!({"operation": "resolvePlanningConflict",
               "conflict": {"path": ["cookings"], "values": [1, 2]}, "value": 1}),
        json!({"operation": "saveShoppingItem", "listId": "l", "kind": "manual",
               "item": {"id": "i", "name": "Tea", "quantity": 1.0, "unit": "piece"}}),
        json!({"operation": "chooseCurrentRecipe", "recipeId": "r", "revisionId": "a",
               "expectedRevisionIds": ["a", "b"]}),
    ];
    for shape in shapes {
        serde_json::from_value::<Operation>(shape.clone())
            .unwrap_or_else(|error| panic!("{shape} does not parse: {error}"));
    }
    assert!(serde_json::from_value::<Operation>(json!({"operation": "dropEverything"})).is_err());
}

fn start(core: &Core, me: &Principal) -> Value {
    core.start_cooking(
        me,
        StartCooking {
            recipe_id: "veggie-pumpkin-risotto".into(),
            portions: 4.0,
            display_units: None,
            cancel_session_ids: vec![],
        },
    )
    .unwrap()
    .session
    .unwrap()
}

fn finish(core: &Core, me: &Principal, session: &Value) -> forkcast_core::Result<()> {
    let id = session["id"].as_str().unwrap();
    let last = session["recipe"]["steps"].as_array().unwrap().len() - 1;
    core.save_cooking_progress(me, id, last, json!({})).unwrap();
    core.end_cooking(me, id, CookingOutcome::Finished)
}

fn mark(recipe: &str, id: Option<&str>, session: Option<&str>) -> MarkCooked {
    MarkCooked {
        id: id.map(str::to_owned),
        recipe_id: recipe.into(),
        session_id: session.map(str::to_owned),
    }
}

#[test]
fn cooking_occurrences_update_household_history_once_per_cook() {
    let database = TempDatabase::new();
    let core = database.open();
    let me = core.standalone().unwrap();
    save(&core, &me, risotto());
    let recipe = "veggie-pumpkin-risotto";
    assert!(core.cooking_history(&me).unwrap().is_empty());
    let id = "4f8f1c0e-6a3d-4a6e-9a43-1d2c3b4a5f60";

    // Explicit marking; an identical retry does not count again.
    assert_eq!(
        core.mark_cooked(&me, mark(recipe, Some(id), None))
            .unwrap()
            .count,
        1
    );
    assert_eq!(
        core.mark_cooked(&me, mark(recipe, Some(id), None))
            .unwrap()
            .count,
        1
    );
    // A genuinely separate cook counts.
    assert_eq!(
        core.mark_cooked(&me, mark(recipe, None, None))
            .unwrap()
            .count,
        2
    );

    // Guided completion records once, even when completion is retried.
    let session = start(&core, &me);
    finish(&core, &me, &session).unwrap();
    core.end_cooking(
        &me,
        session["id"].as_str().unwrap(),
        CookingOutcome::Finished,
    )
    .unwrap();
    assert_eq!(core.cooking_history(&me).unwrap()[0].count, 3);

    // Marking cooked during a session and then finishing it is one cook.
    let session = start(&core, &me);
    let sid = session["id"].as_str().unwrap();
    core.mark_cooked(&me, mark(recipe, None, Some(sid)))
        .unwrap();
    core.mark_cooked(&me, mark(recipe, None, Some(sid)))
        .unwrap();
    finish(&core, &me, &session).unwrap();
    // Canceling records nothing.
    let canceled = start(&core, &me);
    core.end_cooking(
        &me,
        canceled["id"].as_str().unwrap(),
        CookingOutcome::Canceled,
    )
    .unwrap();
    let history = core.cooking_history(&me).unwrap();
    assert_eq!(history.len(), 1);
    assert_eq!(history[0].count, 4);
    assert!(history[0].last_cooked_at > 0);

    // Unknown recipes and another recipe's session are refused.
    assert_eq!(
        core.mark_cooked(&me, mark("missing", None, None))
            .err()
            .unwrap()
            .kind,
        ErrorKind::NotFound
    );
    let other = start(&core, &me);
    assert!(
        core.mark_cooked(&me, mark("missing", None, other["id"].as_str()))
            .is_err()
    );

    // No food log or other side effect, and history survives a restart.
    let today = "2030-05-06";
    assert!(core.food_log(&me, today).unwrap().entries.is_empty());
    drop(core);
    let reopened = database.open();
    let me = reopened.standalone().unwrap();
    assert_eq!(reopened.cooking_history(&me).unwrap()[0].count, 4);
}

#[test]
fn cooking_history_belongs_to_the_household_not_the_person() {
    let database = TempDatabase::new();
    let (core, admin, member) = server(&database);
    save(&core, &admin, risotto());
    core.mark_cooked(&admin, mark("veggie-pumpkin-risotto", None, None))
        .unwrap();
    core.mark_cooked(&member, mark("veggie-pumpkin-risotto", None, None))
        .unwrap();
    for who in [&admin, &member] {
        assert_eq!(core.cooking_history(who).unwrap()[0].count, 2);
    }
}

#[test]
fn an_entry_can_be_corrected_or_removed_while_keeping_its_retained_nutrition() {
    let database = TempDatabase::new();
    let core = database.open();
    let me = core.standalone().unwrap();
    let version = save(&core, &me, risotto()).current.recipe["nutritionVersionId"]
        .as_str()
        .unwrap()
        .to_owned();
    core.log_recipe_food(
        &me,
        LogRecipeFood {
            id: Some("lunch".into()),
            recipe_id: "veggie-pumpkin-risotto".into(),
            nutrition_version_id: version.clone(),
            consumed_at: "2030-05-06T12:00".into(),
            portions: Some(1.0),
        },
    )
    .unwrap();
    core.log_manual_food(&me, manual_food("snack")).unwrap();
    let operation = |value: Value| -> forkcast_core::Result<Value> {
        core.execute(&me, serde_json::from_value::<Operation>(value).unwrap())
    };
    let day = |date: &str| serde_json::to_value(core.food_log(&me, date).unwrap()).unwrap();

    // Moving lunch to the next day with more portions keeps its version.
    operation(json!({
        "operation": "editFoodLogEntry", "entryId": "lunch",
        "consumedAt": "2030-05-07T13:00", "portions": 2.0
    }))
    .unwrap();
    let moved = &day("2030-05-07")["entries"][0];
    assert_eq!(moved["id"], "lunch");
    assert_eq!(moved["portions"], 2.0);
    assert_eq!(moved["nutritionVersionId"], version.as_str());
    assert_eq!(moved["nutrition"]["calories"], 1000.0);
    assert_eq!(day("2030-05-06")["entries"].as_array().unwrap().len(), 1);
    // A recipe entry's name and nutrition come from its recipe version.
    let error = operation(json!({
        "operation": "editFoodLogEntry", "entryId": "lunch", "description": "Something else"
    }))
    .unwrap_err();
    assert_eq!(error.kind, ErrorKind::Invalid);
    // Invalid changes are refused and the entry is kept as it was.
    let error = operation(json!({
        "operation": "editFoodLogEntry", "entryId": "lunch", "portions": 0.0
    }))
    .unwrap_err();
    assert_eq!(error.kind, ErrorKind::Invalid);
    assert_eq!(day("2030-05-07")["entries"][0]["portions"], 2.0);

    operation(json!({
        "operation": "editFoodLogEntry", "entryId": "snack", "description": "Tomato soup",
        "nutrition": {"calories": 180.0, "protein": 4.0, "fat": null, "carbohydrates": null}
    }))
    .unwrap();
    let snack = &day("2030-05-06")["entries"][0];
    assert_eq!(snack["description"], "Tomato soup");
    assert_eq!(snack["nutrition"]["protein"], 4.0);

    operation(json!({"operation": "removeFoodLogEntry", "entryId": "snack"})).unwrap();
    assert_eq!(day("2030-05-06")["entries"], json!([]));
    let error =
        operation(json!({"operation": "removeFoodLogEntry", "entryId": "snack"})).unwrap_err();
    assert_eq!(error.kind, ErrorKind::NotFound);
    // A standalone profile queues nothing and has nothing to decide.
    assert_eq!(
        operation(json!({"operation": "foodLogConflicts"})).unwrap(),
        json!([])
    );
}
