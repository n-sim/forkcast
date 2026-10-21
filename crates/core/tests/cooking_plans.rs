//! Filling days of the meal plan from the collection, manually and with AI,
//! through the public interface against real SQLite.

mod common;

use common::{TempDatabase, risotto};
use forkcast_core::{Config, Core, ErrorKind, MarkCooked, Operation, Principal, SaveRecipe};
use serde_json::{Value, json};
use std::sync::{
    Arc,
    atomic::{AtomicI64, Ordering},
};

const DAY_MS: i64 = 86_400_000;
/// 2030-01-01T12:00:00Z.
const JAN_1_2030: i64 = 1_893_499_200_000;

struct Kitchen {
    _database: TempDatabase,
    core: Core,
    me: Principal,
    now: Arc<AtomicI64>,
}

impl Kitchen {
    fn new() -> Self {
        let database = TempDatabase::new();
        let now = Arc::new(AtomicI64::new(JAN_1_2030));
        let clock = now.clone();
        let mut config = Config::new(database.path());
        config.clock = Arc::new(move || clock.load(Ordering::SeqCst));
        let core = Core::open(config).unwrap();
        let me = core.standalone().unwrap();
        Self {
            _database: database,
            core,
            me,
            now,
        }
    }

    fn op(&self, operation: Value) -> forkcast_core::Result<Value> {
        let operation: Operation = serde_json::from_value(operation).unwrap();
        self.core.execute(&self.me, operation)
    }

    fn recipe(&self, id: &str, name: &str, rating: Option<u8>) {
        let mut recipe = risotto();
        recipe["id"] = json!(id);
        recipe["name"] = json!(name);
        self.core
            .save_recipe(
                &self.me,
                SaveRecipe {
                    recipe,
                    base_revision_id: None,
                },
            )
            .unwrap();
        self.core.rate_recipe(&self.me, id, rating).unwrap();
    }

    /// Records a cooking `days` after 2030-01-01.
    fn cooked(&self, id: &str, days: i64) {
        self.now.store(JAN_1_2030 + days * DAY_MS, Ordering::SeqCst);
        self.core
            .mark_cooked(
                &self.me,
                MarkCooked {
                    recipe_id: id.into(),
                    id: None,
                    session_id: None,
                },
            )
            .unwrap();
    }

    fn plan(&self, id: &str, recipe: &str, date: &str) {
        self.op(json!({"operation": "planCooking", "cooking": {
            "id": id, "recipeId": recipe, "cookingDate": date, "portions": 2, "cookingTime": "evening",
        }}))
        .unwrap();
    }

    fn schedule(&self, dates: &[&str], minimum: Option<u8>, strategy: &str) -> Value {
        self.op(json!({
            "operation": "scheduleCookings", "dates": dates, "portions": 3,
            "minimumRating": minimum, "strategy": strategy,
        }))
        .unwrap()
    }

    /// The meal plan as `(date, recipe, portions)`, ordered.
    fn meal_plan(&self) -> Vec<(String, String, f64)> {
        self.op(json!({"operation": "mealPlan"})).unwrap()["cookings"]
            .as_array()
            .unwrap()
            .iter()
            .map(|cooking| {
                (
                    cooking["cookingDate"].as_str().unwrap().to_owned(),
                    cooking["recipeId"].as_str().unwrap().to_owned(),
                    cooking["portions"].as_f64().unwrap(),
                )
            })
            .collect()
    }
}

/// `(date, recipe)` of each proposed cooking.
fn chosen(proposal: &Value) -> Vec<(String, String)> {
    proposal["cookings"]
        .as_array()
        .unwrap()
        .iter()
        .map(|cooking| {
            (
                cooking["cookingDate"].as_str().unwrap().to_owned(),
                cooking["recipeId"].as_str().unwrap().to_owned(),
            )
        })
        .collect()
}

fn pairs(expected: &[(&str, &str)]) -> Vec<(String, String)> {
    expected
        .iter()
        .map(|(date, recipe)| ((*date).to_owned(), (*recipe).to_owned()))
        .collect()
}

/// Apple pie (5 stars, cooked Jan 1), bean stew (4 stars, cooked Jan 5 and
/// Jan 10), curry (2 stars, cooked Dec 1 2029) and dal (unrated, never).
fn stocked() -> Kitchen {
    let kitchen = Kitchen::new();
    kitchen.recipe("apple", "Apple pie", Some(5));
    kitchen.recipe("bean", "Bean stew", Some(4));
    kitchen.recipe("curry", "Curry", Some(2));
    kitchen.recipe("dal", "Dal", None);
    kitchen.cooked("apple", 0);
    kitchen.cooked("bean", 4);
    kitchen.cooked("bean", 9);
    kitchen.cooked("curry", -31);
    kitchen
}

const DAYS: [&str; 3] = ["2030-02-03", "2030-02-01", "2030-02-02"];

#[test]
fn manual_scheduling_orders_by_last_cooking_or_frequency_and_rotates() {
    let kitchen = stocked();

    // Never cooked first, then the oldest last cooking.
    let proposal = kitchen.schedule(&DAYS, None, "lastCookedLongestAgo");
    assert_eq!(
        chosen(&proposal),
        pairs(&[
            ("2030-02-01", "dal"),
            ("2030-02-02", "curry"),
            ("2030-02-03", "apple"),
        ])
    );
    assert_eq!(
        proposal["dates"],
        json!(["2030-02-01", "2030-02-02", "2030-02-03"])
    );
    assert!(
        proposal["cookings"]
            .as_array()
            .unwrap()
            .iter()
            .all(|cooking| cooking["portions"] == 3.0 && cooking["cookingTime"].is_null())
    );

    // Fewest cookings first; equal counts fall back to the older last cooking.
    let proposal = kitchen.schedule(&DAYS, None, "leastOftenCooked");
    assert_eq!(
        chosen(&proposal),
        pairs(&[
            ("2030-02-01", "dal"),
            ("2030-02-02", "curry"),
            ("2030-02-03", "apple"),
        ])
    );

    // Only recipes rated at least 4 stars; with fewer recipes than days, a
    // recipe scheduled earlier counts as cooked, so they rotate.
    let proposal = kitchen.schedule(&DAYS, Some(4), "lastCookedLongestAgo");
    assert_eq!(
        chosen(&proposal),
        pairs(&[
            ("2030-02-01", "apple"),
            ("2030-02-02", "bean"),
            ("2030-02-03", "apple"),
        ])
    );
    let proposal = kitchen.schedule(&DAYS, Some(5), "leastOftenCooked");
    assert_eq!(
        chosen(&proposal),
        pairs(&[
            ("2030-02-01", "apple"),
            ("2030-02-02", "apple"),
            ("2030-02-03", "apple"),
        ])
    );

    // Cookings still planned on other days count as upcoming cookings.
    kitchen.plan("planned-dal", "dal", "2030-01-20");
    kitchen.plan("planned-curry", "curry", "2030-03-01");
    let proposal = kitchen.schedule(&DAYS, None, "lastCookedLongestAgo");
    assert_eq!(
        chosen(&proposal),
        pairs(&[
            ("2030-02-01", "apple"),
            ("2030-02-02", "bean"),
            ("2030-02-03", "dal"),
        ])
    );
    // A planned cooking that was since recorded is not counted twice.
    kitchen.cooked("dal", 19);
    let proposal = kitchen.schedule(&DAYS, None, "leastOftenCooked");
    assert_eq!(
        chosen(&proposal)[0],
        ("2030-02-01".to_owned(), "apple".to_owned())
    );

    // A proposal changes nothing.
    assert_eq!(kitchen.meal_plan().len(), 2);
}

#[test]
fn manual_scheduling_explains_what_it_cannot_plan() {
    let kitchen = Kitchen::new();
    let empty = kitchen.op(json!({
        "operation": "scheduleCookings", "dates": ["2030-02-01"], "portions": 2,
        "strategy": "leastOftenCooked",
    }));
    assert_eq!(empty.unwrap_err().kind, ErrorKind::Invalid);

    kitchen.recipe("curry", "Curry", Some(2));
    let unrated = kitchen
        .op(json!({
            "operation": "scheduleCookings", "dates": ["2030-02-01"], "portions": 2,
            "minimumRating": 3, "strategy": "leastOftenCooked",
        }))
        .unwrap_err();
    assert_eq!(unrated.kind, ErrorKind::Invalid);
    assert!(
        unrated.message.contains("at least 3 stars"),
        "{}",
        unrated.message
    );

    for invalid in [
        json!({"dates": [], "portions": 2}),
        json!({"dates": ["2030-02-30"], "portions": 2}),
        json!({"dates": ["2030-02-01"], "portions": 0}),
        json!({"dates": ["2030-02-01"], "portions": 2, "minimumRating": 6}),
    ] {
        let mut operation =
            json!({"operation": "scheduleCookings", "strategy": "leastOftenCooked"});
        operation
            .as_object_mut()
            .unwrap()
            .extend(invalid.as_object().unwrap().clone());
        assert_eq!(kitchen.op(operation).unwrap_err().kind, ErrorKind::Invalid);
    }
}

#[test]
fn applying_replaces_only_the_chosen_days_after_confirmation() {
    let kitchen = stocked();
    kitchen.plan("inside", "bean", "2030-02-02");
    kitchen.plan("before", "bean", "2030-01-31");
    kitchen.plan("after", "bean", "2030-02-04");
    let before = kitchen.meal_plan();

    let proposal = kitchen.schedule(&DAYS, None, "leastOftenCooked");
    assert_eq!(proposal["replaced"].as_array().unwrap().len(), 1);
    assert_eq!(proposal["replaced"][0]["id"], "inside");
    let apply = |replacing: Value| {
        kitchen.op(json!({
            "operation": "applyCookingPlan", "dates": proposal["dates"],
            "cookings": proposal["cookings"], "replacing": replacing,
            "editBase": proposal["editBase"],
        }))
    };

    // Declining the replacement keeps the existing plan.
    assert_eq!(apply(json!([])).unwrap_err().kind, ErrorKind::Conflict);
    assert_eq!(kitchen.meal_plan(), before);

    let applied = apply(json!(["inside"])).unwrap();
    assert_eq!(applied.as_array().unwrap().len(), 3);
    let plan = kitchen.meal_plan();
    assert_eq!(
        plan.iter()
            .map(|(date, recipe, _)| (date.as_str(), recipe.as_str()))
            .collect::<Vec<_>>(),
        [
            ("2030-01-31", "bean"),
            ("2030-02-01", "dal"),
            ("2030-02-02", "curry"),
            ("2030-02-03", "apple"),
            ("2030-02-04", "bean"),
        ]
    );
    assert_eq!(plan[1].2, 3.0);

    // Applying the same proposal again would replace what it planned
    // without confirmation, so it is refused.
    assert_eq!(
        apply(json!(["inside"])).unwrap_err().kind,
        ErrorKind::Conflict
    );
    assert_eq!(kitchen.meal_plan(), plan);
}

#[test]
fn a_plan_changed_since_the_proposal_needs_a_new_review() {
    let kitchen = stocked();
    let proposal = kitchen.schedule(&DAYS, None, "leastOftenCooked");
    assert_eq!(proposal["replaced"], json!([]));
    // Another window plans a cooking on one of the days meanwhile.
    kitchen.plan("meanwhile", "bean", "2030-02-03");
    let refused = kitchen
        .op(json!({
            "operation": "applyCookingPlan", "dates": proposal["dates"],
            "cookings": proposal["cookings"], "replacing": [],
            "editBase": proposal["editBase"],
        }))
        .unwrap_err();
    assert_eq!(refused.kind, ErrorKind::Conflict);
    assert_eq!(
        kitchen.meal_plan(),
        [("2030-02-03".to_owned(), "bean".to_owned(), 2.0)]
    );
}

#[test]
fn applying_refuses_cookings_outside_the_days_or_the_collection_without_changes() {
    let kitchen = stocked();
    kitchen.plan("kept", "bean", "2030-02-01");
    kitchen.plan("outside", "bean", "2030-02-05");
    let before = kitchen.meal_plan();
    let cooking = |id: &str, recipe: &str, date: &str| json!({"id": id, "recipeId": recipe, "cookingDate": date, "portions": 2, "cookingTime": null});
    for cookings in [
        // A day that is not being planned.
        json!([
            cooking("a", "apple", "2030-02-01"),
            cooking("b", "apple", "2030-02-05")
        ]),
        // A recipe that is not in the collection.
        json!([
            cooking("a", "apple", "2030-02-01"),
            cooking("b", "invented", "2030-02-02")
        ]),
        // One identity twice, or the identity of a cooking on another day.
        json!([
            cooking("a", "apple", "2030-02-01"),
            cooking("a", "bean", "2030-02-02")
        ]),
        json!([cooking("outside", "apple", "2030-02-02")]),
        // Invalid portions.
        json!([{"id": "a", "recipeId": "apple", "cookingDate": "2030-02-01", "portions": -1}]),
    ] {
        let refused = kitchen
            .op(json!({
                "operation": "applyCookingPlan", "dates": ["2030-02-01", "2030-02-02"],
                "cookings": cookings, "replacing": ["kept"],
            }))
            .unwrap_err();
        assert_eq!(refused.kind, ErrorKind::Invalid, "{cookings}");
        assert_eq!(kitchen.meal_plan(), before);
    }
}

#[test]
fn plan_generation_needs_a_valid_request_and_a_connection_and_changes_nothing() {
    let kitchen = stocked();
    kitchen.plan("kept", "bean", "2030-02-01");
    for (start, end, request) in [
        ("2030-02-03", "2030-02-01", "Anything"),
        ("2030-02-01", "2030-03-15", "Anything"),
        ("2030-02-01", "2030-02-07", " "),
    ] {
        let refused = kitchen
            .op(json!({
                "operation": "generateCookingPlan", "model": "fixture-recipe",
                "request": request, "startDate": start, "endDate": end,
            }))
            .unwrap_err();
        assert_eq!(refused.kind, ErrorKind::Invalid);
    }
    let unconnected = kitchen
        .op(json!({
            "operation": "generateCookingPlan", "model": "fixture-recipe",
            "request": "Meals I liked", "startDate": "2030-02-01", "endDate": "2030-02-07",
        }))
        .unwrap_err();
    assert_eq!(unconnected.kind, ErrorKind::ConnectionRequired);
    assert_eq!(kitchen.meal_plan().len(), 1);
}

#[test]
fn the_plan_prompt_is_a_personal_default() {
    let kitchen = Kitchen::new();
    let defaults = kitchen.op(json!({"operation": "aiPreferences"})).unwrap();
    assert!(defaults["planPrompt"].as_str().unwrap().contains("variety"));
    let saved = kitchen
        .op(json!({"operation": "setPlanPrompt", "prompt": "Fish on Fridays."}))
        .unwrap();
    assert_eq!(saved["planPrompt"], "Fish on Fridays.");
    assert_eq!(
        kitchen
            .op(json!({"operation": "setPlanPrompt", "prompt": "x".repeat(8001)}))
            .unwrap_err()
            .kind,
        ErrorKind::Invalid
    );
}
