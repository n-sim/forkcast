//! Gurkerl cart handoff through real installed cores and SQLite, with
//! deterministic Gurkerl MCP, authorization, and ChatGPT fixtures. No test
//! touches a real supermarket account or cart.

mod harness;

use forkcast_core::ErrorKind;
use harness::{
    Device, Server,
    gurkerl::{CartLine, Gurkerl},
    plan,
    provider::{Provider, api},
};
use serde_json::{Value, json};
use std::time::Duration;

const DAY: &str = "2030-05-06";

fn eventually(mut check: impl FnMut() -> bool) {
    for _ in 0..200 {
        if check() {
            return;
        }
        std::thread::sleep(Duration::from_millis(25));
    }
    panic!("condition never became true");
}

fn state(device: &Device) -> String {
    device.op(json!({"operation": "supermarketStatus"}))["state"]
        .as_str()
        .unwrap()
        .to_owned()
}

fn connect_chatgpt(device: &Device, provider: &Provider) {
    let url = device.op(json!({"operation": "aiAuthorize"}))["authorizationUrl"]
        .as_str()
        .unwrap()
        .to_owned();
    assert_eq!(provider.sign_in(&url).0, 200);
    eventually(|| device.op(json!({"operation": "aiStatus"}))["state"] == "connected");
}

fn connect_gurkerl(device: &Device, gurkerl: &Gurkerl) {
    let url = device.op(json!({"operation": "supermarketAuthorize"}))["authorizationUrl"]
        .as_str()
        .unwrap()
        .to_owned();
    assert_eq!(state(device), "authorizing");
    let (code, page) = gurkerl.sign_in(&url);
    assert_eq!(code, 200, "{page}");
    eventually(|| state(device) == "connected");
}

struct Shop {
    provider: Provider,
    gurkerl: Gurkerl,
    device: Device,
}

fn shop() -> Shop {
    let provider = Provider::start();
    let gurkerl = Gurkerl::start();
    let device = Device::with_supermarket(&provider.issuer, &gurkerl.server);
    connect_chatgpt(&device, &provider);
    connect_gurkerl(&device, &gurkerl);
    Shop {
        provider,
        gurkerl,
        device,
    }
}

/// A reviewed list: spaghetti from a planned recipe, reduced to 400 g, and
/// manual coffee, saffron, and bread, of which the bread is already checked.
fn reviewed_list(device: &Device) -> Value {
    device.op(json!({"operation": "saveRecipe", "recipe": {
        "id": "pasta", "name": "Pasta", "basePortions": 2,
        "ingredients": [{"id": "spaghetti", "name": "Spaghetti", "quantity": 500, "unit": "g"}],
        "steps": [{"id": "boil", "instruction": "Boil.",
            "allocations": [{"ingredientId": "spaghetti", "quantity": 500, "unit": "g"}]}],
        "difficulty": "easy", "activeMinutes": 5, "totalMinutes": 15,
    }}));
    plan(device, "cook-pasta", "pasta", DAY, 2.0);
    let mut view = device.op(json!({
        "operation": "generateShoppingList", "startDate": DAY, "endDate": DAY,
        "replacingListId": null, "editBase": null,
    }));
    let list = view["list"]["id"].clone();
    let spaghetti = view["list"]["items"][0]["id"].clone();
    view = device.op(json!({
        "operation": "saveShoppingItem", "listId": list, "kind": "generated",
        "item": {"id": spaghetti, "name": "Spaghetti", "quantity": 400, "unit": "g"},
        "editBase": view["editBase"],
    }));
    for (id, name, quantity, unit) in [
        ("coffee", "Coffee", 1.0, "piece"),
        ("saffron", "Saffron", 1.0, "g"),
        ("bread", "Bread", 1.0, "piece"),
    ] {
        view = device.op(json!({
            "operation": "saveShoppingItem", "listId": list, "kind": "manual",
            "item": {"id": id, "name": name, "quantity": quantity, "unit": unit},
            "editBase": view["editBase"],
        }));
    }
    device.op(json!({
        "operation": "checkShoppingItem", "listId": list, "itemId": "bread",
        "checked": true, "editBase": view["editBase"],
    }))
}

fn fill(device: &Device, view: &Value) -> forkcast_core::Result<Value> {
    device.try_op(json!({
        "operation": "fillSupermarketCart", "listId": view["list"]["id"], "model": "fixture-recipe",
    }))
}

fn script(provider: &Provider, replies: Vec<Value>) {
    provider.with(|s| s.replies = replies.into());
}

fn statuses(handoff: &Value) -> Vec<(String, String)> {
    handoff["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|item| {
            (
                item["name"].as_str().unwrap().to_owned(),
                item["status"].as_str().unwrap().to_owned(),
            )
        })
        .collect()
}

fn assert_no_secrets(text: &str) {
    for secret in ["GURKERL_SECRET", "code_verifier", "SECRET_ACCESS"] {
        assert!(!text.contains(secret), "{secret} leaked: {text}");
    }
}

#[test]
fn a_reviewed_list_fills_the_cart_with_preferred_products_and_stays_available() {
    let home = shop();
    let device = &home.device;
    assert_no_secrets(
        &device
            .op(json!({"operation": "supermarketStatus"}))
            .to_string(),
    );
    assert!(
        device
            .secret(&format!("gurkerl:{}", device.me().person_id()))
            .unwrap()
            .contains("GURKERL_SECRET_REFRESH")
    );
    assert_no_secrets(&device.everything_stored());

    let preferences = device.op(json!({"operation": "aiPreferences"}));
    assert!(
        preferences["cartPrompt"]
            .as_str()
            .unwrap()
            .contains("bought before")
    );
    device.op(json!({"operation": "setCartPrompt", "prompt": "Always the cheapest product."}));

    let view = reviewed_list(device);
    let spaghetti = view["list"]["items"][0]["id"].as_str().unwrap().to_owned();
    script(
        &home.provider,
        vec![
            json!({"calls": [
                {"tool": "search_products", "arguments": {"query": "spaghetti"}, "itemIds": [spaghetti]},
                {"tool": "search_products", "arguments": {"query": "kaffee"}, "itemIds": ["coffee"]},
                {"tool": "search_products", "arguments": {"query": "saffron"}, "itemIds": ["saffron"]},
            ]}),
            json!({"calls": [
                {"tool": "add_to_cart", "arguments": {"productId": "p-pasta-cheap", "quantity": 1},
                 "itemIds": [spaghetti], "product": "Clever Spaghetti 500 g"},
                {"tool": "add_to_cart", "arguments": {"productId": "p-coffee", "quantity": 1},
                 "itemIds": ["coffee"], "product": "Gurkerl Bio Kaffee 250 g"},
                {"tool": "checkout", "arguments": {}, "itemIds": []},
                {"tool": "remove_from_cart", "arguments": {"productId": "p-oil"}, "itemIds": []},
            ]}),
            json!({"done": {"items": [
                {"itemId": spaghetti, "product": "Clever Spaghetti 500 g", "note": null},
                {"itemId": "coffee", "product": "Gurkerl Bio Kaffee 250 g", "note": null},
                {"itemId": "saffron", "product": null, "note": "Gurkerl has no saffron."},
            ]}}),
        ],
    );
    let handoff = fill(device, &view).unwrap();
    assert_eq!(handoff["complete"], true);
    assert_eq!(handoff["message"], Value::Null);
    assert_eq!(
        statuses(&handoff),
        [
            ("Spaghetti".into(), "added".into()),
            ("Coffee".into(), "added".into()),
            ("Saffron".into(), "not_added".into()),
            ("Bread".into(), "skipped".into()),
        ]
    );
    assert_eq!(handoff["items"][0]["product"], "Clever Spaghetti 500 g");
    assert_eq!(handoff["items"][0]["quantity"], 400.0);
    assert_eq!(handoff["items"][2]["note"], "Gurkerl has no saffron.");
    assert_no_secrets(&handoff.to_string());

    // Only what the supermarket confirmed is in the cart; checkout and
    // removal were never offered and never reached Gurkerl.
    assert_eq!(
        home.gurkerl.cart(),
        [
            CartLine {
                product_id: "p-pasta-cheap".into(),
                quantity: 1
            },
            CartLine {
                product_id: "p-coffee".into(),
                quantity: 1
            },
        ]
    );
    let calls = home.gurkerl.calls();
    assert!(
        calls
            .iter()
            .all(|call| !call.starts_with("checkout") && !call.starts_with("remove")),
        "{calls:?}"
    );

    // The AI saw the reviewed quantities, manual items, the person's prompt,
    // and only the tools Forkcast allows; refused calls were reported back.
    let requests = home.provider.with(|s| s.requests.clone());
    assert_eq!(requests.len(), 3);
    let first: Value =
        serde_json::from_str(requests[0]["input"][0]["content"].as_str().unwrap()).unwrap();
    assert_eq!(
        first["selectionPreferences"],
        "Always the cheapest product."
    );
    let wanted: Vec<(&str, f64)> = first["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|item| {
            (
                item["name"].as_str().unwrap(),
                item["quantity"].as_f64().unwrap(),
            )
        })
        .collect();
    assert_eq!(
        wanted,
        [("Spaghetti", 400.0), ("Coffee", 1.0), ("Saffron", 1.0)]
    );
    let mut offered: Vec<&str> = first["tools"]
        .as_array()
        .unwrap()
        .iter()
        .map(|tool| tool["name"].as_str().unwrap())
        .collect();
    offered.sort();
    assert_eq!(
        offered,
        ["add_to_cart", "get_purchase_history", "search_products"]
    );
    let third = requests[2]["input"][0]["content"].as_str().unwrap();
    assert!(third.contains("Forkcast does not allow this tool."));
    assert!(
        requests[0]["instructions"]
            .as_str()
            .unwrap()
            .contains("Never check out")
    );

    // Filling the cart leaves the list available and not complete.
    let after = device.op(json!({"operation": "shoppingList"}));
    assert_eq!(after["list"], view["list"]);
    assert_ne!(after["list"]["completed"], true);
}

#[test]
fn failures_are_reported_without_claiming_items_or_losing_the_list() {
    let home = shop();
    let device = &home.device;
    let view = reviewed_list(device);
    let spaghetti = view["list"]["items"][0]["id"].as_str().unwrap().to_owned();

    // ChatGPT failing before anything was added fails the whole handoff.
    home.provider.with(|s| s.failure = Some("http".into()));
    let error = fill(device, &view).unwrap_err();
    assert_eq!(error.kind, ErrorKind::Unavailable);
    assert!(
        error
            .message
            .contains("Nothing was added to your Gurkerl cart"),
        "{}",
        error.message
    );
    home.provider.with(|s| s.failure = None);

    // An unreadable answer is not a success either.
    script(
        &home.provider,
        vec![json!("I have added everything for you.")],
    );
    let error = fill(device, &view).unwrap_err();
    assert!(error.message.contains("could not use"), "{}", error.message);

    // A sold-out product is a failure for that item; claiming an item was
    // added without a confirmed cart call does not make it added; a handoff
    // that stops after adding something reports exactly what was added.
    script(
        &home.provider,
        vec![
            json!({"calls": [
                {"tool": "add_to_cart", "arguments": {"productId": "p-pasta-500", "quantity": 1},
                 "itemIds": [spaghetti], "product": "Barilla Spaghetti 500 g"},
                {"tool": "add_to_cart", "arguments": {"productId": "p-gone", "quantity": 1},
                 "itemIds": ["coffee"], "product": "Unknown coffee"},
            ]}),
            json!("not json"),
        ],
    );
    let handoff = fill(device, &view).unwrap();
    assert_eq!(handoff["complete"], false);
    assert!(
        handoff["message"]
            .as_str()
            .unwrap()
            .contains("Items marked as added are in your Gurkerl cart")
    );
    assert_eq!(
        statuses(&handoff),
        [
            ("Spaghetti".into(), "added".into()),
            ("Coffee".into(), "failed".into()),
            ("Saffron".into(), "not_added".into()),
            ("Bread".into(), "skipped".into()),
        ]
    );

    script(
        &home.provider,
        vec![json!({"done": {"items": [
            {"itemId": "saffron", "product": "Saffron 1 g", "note": "Added."},
        ]}})],
    );
    let handoff = fill(device, &view).unwrap();
    assert_eq!(handoff["complete"], true);
    assert_eq!(handoff["items"][2]["status"], "not_added");
    assert_eq!(handoff["items"][2]["product"], Value::Null);

    // An addition before ChatGPT stops is reported; Gurkerl going down
    // before anything was added fails the handoff.
    script(
        &home.provider,
        vec![json!({"calls": [
            {"tool": "add_to_cart", "arguments": {"productId": "p-coffee", "quantity": 1}, "itemIds": ["coffee"]},
        ]})],
    );
    let handoff = fill(device, &view).unwrap();
    assert_eq!(handoff["items"][1]["status"], "added");
    home.gurkerl.with(|s| s.down = true);
    script(
        &home.provider,
        vec![json!({"calls": [
            {"tool": "add_to_cart", "arguments": {"productId": "p-coffee", "quantity": 1}, "itemIds": ["coffee"]},
        ]})],
    );
    let error = fill(device, &view).unwrap_err();
    assert!(
        error.message.contains("stopped responding"),
        "{}",
        error.message
    );
    home.gurkerl.with(|s| s.down = false);

    // A list replaced elsewhere is refused rather than filled unseen.
    let mut stale = view.clone();
    stale["list"]["id"] = json!("another-list");
    assert_eq!(fill(device, &stale).unwrap_err().kind, ErrorKind::Conflict);

    // Through all of it, the list stayed as reviewed.
    let after = device.op(json!({"operation": "shoppingList"}));
    assert_eq!(after["list"], view["list"]);
}

#[test]
fn expired_sessions_refresh_and_ended_sessions_ask_to_reconnect() {
    let home = shop();
    let device = &home.device;
    let view = reviewed_list(device);
    let done = || json!({"done": {"items": []}});

    // A refused access token is renewed once, transparently.
    home.gurkerl.expire_access();
    script(&home.provider, vec![done()]);
    assert_eq!(fill(device, &view).unwrap()["complete"], true);
    assert_eq!(home.gurkerl.refreshes(), 1);
    assert_eq!(state(device), "connected");

    // A session Gurkerl ended asks the person to reconnect.
    home.gurkerl.revoke_all();
    let error = fill(device, &view).unwrap_err();
    assert_eq!(error.kind, ErrorKind::ConnectionRequired);
    assert_eq!(state(device), "reconnect_required");
    let record_key = format!("gurkerl:{}", device.me().person_id());
    assert!(
        !device
            .secret(&record_key)
            .unwrap()
            .contains("GURKERL_SECRET")
    );

    // Reconnecting works, and signing out forgets the session on this device.
    connect_gurkerl(device, &home.gurkerl);
    script(&home.provider, vec![done()]);
    assert_eq!(fill(device, &view).unwrap()["complete"], true);
    device.op(json!({"operation": "supermarketSignOut"}));
    let record_key = format!("gurkerl:{}", device.me().person_id());
    assert_eq!(state(device), "unconfigured");
    assert_eq!(device.secret(&record_key), None);
    assert_eq!(
        fill(device, &view).unwrap_err().kind,
        ErrorKind::ConnectionRequired
    );
}

#[test]
fn a_denied_sign_in_is_reported_and_stores_nothing() {
    let provider = Provider::start();
    let gurkerl = Gurkerl::start();
    let device = Device::with_supermarket(&provider.issuer, &gurkerl.server);
    gurkerl.with(|s| s.mode = "denied".into());
    let url = device.op(json!({"operation": "supermarketAuthorize"}))["authorizationUrl"]
        .as_str()
        .unwrap()
        .to_owned();
    assert_eq!(gurkerl.sign_in(&url).0, 400);
    eventually(|| state(&device) == "denied");
    let status = device.op(json!({"operation": "supermarketStatus"}));
    assert!(status["message"].as_str().unwrap().contains("denied"));
    assert_eq!(status["canConnect"], true);
}

#[test]
fn the_household_server_never_holds_supermarket_sessions() {
    let provider = Provider::start();
    let gurkerl = Gurkerl::start();
    let server = Server::with_provider(&provider.issuer);
    let device = Device::with_supermarket(&provider.issuer, &gurkerl.server);
    device.found_household(&server);
    connect_gurkerl(&device, &gurkerl);
    device.op(json!({"operation": "setCartPrompt", "prompt": "Organic when possible."}));
    device.sync();

    // The selection prompt is a personal preference that synchronizes; the
    // session is not.
    assert_no_secrets(&server.stored());
    let (code, login) = api(
        "POST",
        &format!("{}/api/login", server.url),
        None,
        Some(&json!({"username": "admin", "password": "correct horse battery"})),
    );
    assert_eq!(code, 200, "{login}");
    let token = login["token"].as_str().unwrap();
    let operation = |body: Value| {
        api(
            "POST",
            &format!("{}/api/operations", server.url),
            Some(token),
            Some(&body),
        )
    };
    let (_, preferences) = operation(json!({"operation": "aiPreferences"}));
    assert_eq!(preferences["cartPrompt"], "Organic when possible.");
    let (_, status) = operation(json!({"operation": "supermarketStatus"}));
    assert_eq!(status["canConnect"], false);
    for request in [
        json!({"operation": "supermarketAuthorize"}),
        json!({"operation": "fillSupermarketCart", "listId": "any", "model": "fixture-recipe"}),
    ] {
        let (code, body) = operation(request);
        assert_eq!(code, 403, "{body}");
        assert!(
            body["message"]
                .as_str()
                .unwrap()
                .contains("installed Forkcast app")
        );
    }
}
