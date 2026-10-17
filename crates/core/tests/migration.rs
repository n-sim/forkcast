//! Upgrading databases created before the shared, versioned migrations.

mod common;

use common::TempDatabase;
use forkcast_core::{Config, Core, ErrorKind, RatingChange, SCHEMA_VERSION};
use rusqlite::{Connection, params};
use serde_json::json;
use sha2::{Digest, Sha256};

const LEGACY_SCHEMA: &str = include_str!("legacy-schema.sql");
const TOKEN: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

fn user_version(database: &TempDatabase) -> i64 {
    Connection::open(database.path())
        .unwrap()
        .pragma_query_value(None, "user_version", |row| row.get(0))
        .unwrap()
}

/// A household server database exactly as the unversioned backend left it:
/// an administrator with a live session, a recipe with two competing edits
/// and a retained nutrition version, a rating, and a planning document.
fn legacy_server(database: &TempDatabase) {
    let db = Connection::open(database.path()).unwrap();
    db.execute_batch(LEGACY_SCHEMA).unwrap();
    db.execute(
        "INSERT INTO households VALUES (1, 'household-1', 'Home')",
        [],
    )
    .unwrap();
    db.execute(
        "INSERT INTO accounts VALUES ('account-1', 'household-1', 'admin', 'not-a-real-hash', 'administrator', 1)",
        [],
    )
    .unwrap();
    db.execute(
        "INSERT INTO sessions VALUES (?, 'account-1', 4102444800)",
        [format!("{:x}", Sha256::digest(TOKEN.as_bytes()))],
    )
    .unwrap();
    db.execute(
        "INSERT INTO shared_recipes VALUES ('recipe-1', 'household-1', 'rev-1')",
        [],
    )
    .unwrap();
    for (id, name) in [("rev-1", "Soup"), ("rev-2", "Stew")] {
        let revision = json!({
            "id": id, "parentId": null,
            "recipe": {"id": "recipe-1", "name": name, "nutritionVersionId": "nutrition-1"},
            "nutritionVersions": [{"id": "nutrition-1", "recipeId": "recipe-1",
                "perPortion": {"calories": 100.0, "protein": null, "fat": null, "carbohydrates": null}}],
            "coverPhoto": null,
        });
        db.execute(
            "INSERT INTO recipe_revisions VALUES (?, 'recipe-1', NULL, ?)",
            params![id, revision.to_string()],
        )
        .unwrap();
    }
    db.execute(
        "INSERT INTO nutrition_versions VALUES ('nutrition-1', 'recipe-1', ?)",
        [json!({"id": "nutrition-1", "recipeId": "recipe-1",
            "perPortion": {"calories": 100.0, "protein": null, "fat": null, "carbohydrates": null}})
        .to_string()],
    )
    .unwrap();
    db.execute(
        "INSERT INTO recipe_ratings VALUES ('account-1', 'recipe-1', 4)",
        [],
    )
    .unwrap();
    db.execute(
        "INSERT INTO rating_mutations VALUES ('rating-change-1', 'account-1', ?)",
        [json!({"id": "rating-change-1", "recipeId": "recipe-1", "value": 4}).to_string()],
    )
    .unwrap();
    let planning =
        json!({"revision": "plan-1", "data": {"cookings": {}, "shoppingList": null}, "conflicts": []})
            .to_string();
    db.execute(
        "INSERT INTO household_planning VALUES ('household-1', ?)",
        [&planning],
    )
    .unwrap();
    db.execute(
        "INSERT INTO planning_versions VALUES ('plan-1', 'household-1', ?)",
        [&planning],
    )
    .unwrap();
}

#[test]
fn an_unversioned_server_database_upgrades_in_place_keeping_every_identity() {
    let database = TempDatabase::new();
    legacy_server(&database);
    let core = database.open();
    assert_eq!(user_version(&database), SCHEMA_VERSION);

    // The existing session still signs the same account in.
    let admin = core.authenticate(TOKEN).unwrap().principal;
    assert_eq!(admin.person_id(), "account-1");
    assert_eq!(admin.household_id(), "household-1");
    assert_eq!(core.session(&admin).unwrap().account.username, "admin");

    // Recipes, retained nutrition, and the unresolved competing edit remain.
    let collection = core.recipe_collection(&admin).unwrap();
    assert_eq!(collection.revisions.len(), 2);
    let head = serde_json::to_value(&collection.current[0]).unwrap();
    assert_eq!(head["unresolved"], 1);
    assert_eq!(
        core.recipes(&admin).unwrap()[0].recipe["nutritionVersionId"],
        "nutrition-1"
    );

    // The rating and its change identity: a replay is accepted unchanged and
    // a different change under the same identity is still refused.
    assert_eq!(core.ratings(&admin).unwrap()[0].value, Some(4));
    let change = |value| RatingChange {
        id: "rating-change-1".into(),
        recipe_id: "recipe-1".into(),
        value,
    };
    core.apply_rating_changes(&admin, vec![change(Some(4))])
        .unwrap();
    assert_eq!(
        core.apply_rating_changes(&admin, vec![change(Some(5))])
            .err()
            .unwrap()
            .kind,
        ErrorKind::Conflict
    );
    assert_eq!(
        core.planning_snapshot(&admin).unwrap()["revision"],
        "plan-1"
    );

    // Upgrading again changes nothing, and the server stays a server.
    drop(core);
    let core = database.open();
    assert_eq!(core.authenticate(TOKEN).unwrap().principal, admin);
    assert_eq!(core.standalone().err().unwrap().kind, ErrorKind::Conflict);
}

#[test]
fn a_database_from_a_newer_forkcast_is_refused_untouched() {
    let database = TempDatabase::new();
    {
        let db = Connection::open(database.path()).unwrap();
        db.execute_batch(&format!(
            "PRAGMA user_version = {}; CREATE TABLE future (note TEXT); INSERT INTO future VALUES ('keep me');",
            SCHEMA_VERSION + 1
        ))
        .unwrap();
    }
    let error = Core::open(Config::new(database.path())).err().unwrap();
    assert_eq!(error.kind, ErrorKind::Unsupported);

    assert_eq!(user_version(&database), SCHEMA_VERSION + 1);
    let db = Connection::open(database.path()).unwrap();
    let note: String = db
        .query_row("SELECT note FROM future", [], |row| row.get(0))
        .unwrap();
    assert_eq!(note, "keep me");
    let tables: i64 = db
        .query_row(
            "SELECT count(*) FROM sqlite_master WHERE name = 'households'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(tables, 0, "no schema was added");
}

#[test]
fn an_upgrade_that_cannot_complete_leaves_the_previous_version_intact() {
    let database = TempDatabase::new();
    legacy_server(&database);
    {
        // A rating whose account is gone, as a connection that left foreign
        // keys off could have recorded it.
        let db = Connection::open(database.path()).unwrap();
        db.pragma_update(None, "foreign_keys", false).unwrap();
        db.execute(
            "INSERT INTO recipe_ratings VALUES ('ghost', 'recipe-1', 2)",
            [],
        )
        .unwrap();
    }
    let error = Core::open(Config::new(database.path())).err().unwrap();
    assert_eq!(error.kind, ErrorKind::Unsupported);
    assert!(error.message.contains("left at its previous version"));

    // The inconsistent database was not stamped or reshaped.
    assert_eq!(user_version(&database), 0);
    let db = Connection::open(database.path()).unwrap();
    let ratings: i64 = db
        .query_row(
            "SELECT count(*) FROM recipe_ratings WHERE account_id IN ('account-1', 'ghost')",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(ratings, 2, "no rating was dropped");
    let people: i64 = db
        .query_row(
            "SELECT count(*) FROM sqlite_master WHERE name = 'people'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(people, 0);
}
