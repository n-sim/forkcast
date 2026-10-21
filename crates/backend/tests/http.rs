//! The HTTP adapter over a real core database: status mapping, the shared
//! operation contract, and change notifications.

use axum::{
    Router,
    body::Body,
    http::{Method, Request, StatusCode, header},
};
use forkcast_backend::router;
use forkcast_core::{Config, Core};
use http_body_util::BodyExt;
use serde_json::{Value, json};
use std::{
    path::PathBuf,
    sync::atomic::{AtomicUsize, Ordering},
    time::Duration,
};
use tower::ServiceExt;

struct Server {
    app: Router,
    path: PathBuf,
}

impl Server {
    fn new() -> Self {
        // Tests run in parallel inside one process; a clock reading can repeat.
        static NEXT: AtomicUsize = AtomicUsize::new(0);
        let path = std::env::temp_dir().join(format!(
            "forkcast-http-{}-{}.sqlite3",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = std::fs::remove_file(&path);
        let core = Core::open(Config::new(&path)).unwrap();
        Self {
            app: router(core, vec![], None),
            path,
        }
    }

    fn request(
        &self,
        method: Method,
        uri: &str,
        token: Option<&str>,
        body: Option<Value>,
    ) -> Request<Body> {
        let mut request = Request::builder().method(method).uri(uri);
        if let Some(token) = token {
            request = request.header(header::AUTHORIZATION, format!("Bearer {token}"));
        }
        match body {
            Some(body) => request
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(body.to_string())),
            None => request.body(Body::empty()),
        }
        .unwrap()
    }

    async fn call(
        &self,
        method: Method,
        uri: &str,
        token: Option<&str>,
        body: Option<Value>,
    ) -> (StatusCode, Value) {
        let response = self
            .app
            .clone()
            .oneshot(self.request(method, uri, token, body))
            .await
            .unwrap();
        let status = response.status();
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        (
            status,
            serde_json::from_slice(&bytes).unwrap_or(Value::Null),
        )
    }
}

impl Drop for Server {
    fn drop(&mut self) {
        for suffix in ["", "-wal", "-shm"] {
            let mut path = self.path.clone().into_os_string();
            path.push(suffix);
            let _ = std::fs::remove_file(path);
        }
    }
}

fn risotto() -> Value {
    let mut recipe: Value =
        serde_json::from_str(include_str!("../../../tests/fixtures/pumpkin-risotto.json")).unwrap();
    for step in recipe["steps"].as_array_mut().unwrap() {
        step["allocations"]
            .as_array_mut()
            .unwrap()
            .retain(|allocation| allocation["quantity"].as_f64().unwrap() > 0.0);
    }
    recipe
}

async fn signed_in(server: &Server) -> (String, String, String) {
    let (status, body) = server
        .call(
            Method::POST,
            "/api/setup",
            None,
            Some(json!({"householdName": "Home", "username": "admin", "password": "correct horse battery"})),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED);
    (
        body["token"].as_str().unwrap().to_owned(),
        body["account"]["id"].as_str().unwrap().to_owned(),
        body["household"]["id"].as_str().unwrap().to_owned(),
    )
}

#[tokio::test]
async fn core_errors_map_to_the_same_statuses_and_messages() {
    let server = Server::new();
    let (status, body) = server.call(Method::GET, "/api/status", None, None).await;
    assert_eq!(
        (status, &body["setupRequired"]),
        (StatusCode::OK, &json!(true))
    );

    let (status, body) = server.call(Method::GET, "/api/session", None, None).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(body, json!({"message": "Sign in to your backend account."}));

    let (token, account, household) = signed_in(&server).await;
    let (status, _) = server
        .call(Method::POST, "/api/setup", None, Some(json!({"householdName": "Again", "username": "second", "password": "correct horse battery"})))
        .await;
    assert_eq!(status, StatusCode::CONFLICT);

    // Paths naming another owner are refused before any work happens.
    let (status, body) = server
        .call(
            Method::GET,
            "/api/households/elsewhere/recipes",
            Some(&token),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(
        body["message"],
        "This record is outside your account or household."
    );
    let (status, _) = server
        .call(
            Method::GET,
            "/api/accounts/elsewhere/recipe-ratings",
            Some(&token),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let (status, body) = server
        .call(
            Method::GET,
            &format!("/api/accounts/{account}/recipe-ratings"),
            Some(&token),
            None,
        )
        .await;
    assert_eq!((status, body), (StatusCode::OK, json!([])));
    let (status, _) = server
        .call(
            Method::GET,
            &format!("/api/households/{household}/planning"),
            Some(&token),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::OK);
}

#[tokio::test]
async fn operations_endpoint_runs_the_shared_core_contract() {
    let server = Server::new();
    let (token, _, household) = signed_in(&server).await;
    let operate = |operation: Value| {
        let server = &server;
        let token = token.clone();
        async move {
            server
                .call(
                    Method::POST,
                    "/api/operations",
                    Some(&token),
                    Some(operation),
                )
                .await
        }
    };

    let (status, body) = operate(json!({"operation": "saveRecipe", "recipe": risotto()})).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["current"]["recipe"]["id"], "veggie-pumpkin-risotto");

    // The recipe saved through the contract is what synchronization reads.
    let (status, body) = server
        .call(
            Method::GET,
            &format!("/api/households/{household}/recipes"),
            Some(&token),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["revisions"].as_array().unwrap().len(), 1);

    let (status, body) =
        operate(json!({"operation": "rateRecipe", "recipeId": "missing", "value": 3})).await;
    assert_eq!(
        (status, body["message"].as_str()),
        (StatusCode::NOT_FOUND, Some("Recipe not found."))
    );
    let (status, body) = operate(json!({"operation": "saveRecipe", "recipe": {"id": "x"}})).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(body["message"], "Check the recipe before saving.");

    let (status, body) = operate(json!({"operation": "setRecipePrompt", "prompt": "Vegan"})).await;
    assert_eq!(
        (status, &body["recipePrompt"]),
        (StatusCode::OK, &json!("Vegan"))
    );
    let (status, _) = server
        .call(
            Method::POST,
            "/api/operations",
            None,
            Some(json!({"operation": "aiPreferences"})),
        )
        .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn a_browser_archives_through_the_server_core_and_synchronization_carries_it() {
    let server = Server::new();
    let (token, _, household) = signed_in(&server).await;
    let operate = |operation: Value| {
        let server = &server;
        let token = token.clone();
        async move {
            server
                .call(
                    Method::POST,
                    "/api/operations",
                    Some(&token),
                    Some(operation),
                )
                .await
        }
    };
    operate(json!({"operation": "saveRecipe", "recipe": risotto()})).await;
    operate(
        json!({"operation": "planCooking", "cooking": {"id": "later",
        "recipeId": "veggie-pumpkin-risotto", "cookingDate": "2030-05-09", "portions": 2.0}}),
    )
    .await;

    let (status, body) = operate(json!({"operation": "archiveRecipe",
        "recipeId": "veggie-pumpkin-risotto", "today": "2030-05-06"}))
    .await;
    assert_eq!(
        (status, &body["removedCookings"]),
        (StatusCode::OK, &json!(1))
    );
    let (_, recipes) = operate(json!({"operation": "recipes"})).await;
    assert_eq!(recipes, json!([]));

    // Devices read the archival as one more revision of the shared collection.
    let (_, collection) = server
        .call(
            Method::GET,
            &format!("/api/households/{household}/recipes"),
            Some(&token),
            None,
        )
        .await;
    assert_eq!(collection["revisions"][1]["archivedOn"], "2030-05-06");
    assert_eq!(
        collection["current"][0]["revisionId"],
        body["archivedRevisionId"]
    );
    let (status, body) = operate(json!({"operation": "archiveRecipe",
        "recipeId": "veggie-pumpkin-risotto", "today": "someday"}))
    .await;
    assert_eq!(
        (status, body["message"].as_str()),
        (
            StatusCode::UNPROCESSABLE_ENTITY,
            Some("Choose a valid date.")
        )
    );
}

#[tokio::test]
async fn changes_stream_announces_committed_changes() {
    let server = Server::new();
    let (token, _, _) = signed_in(&server).await;
    let response = server
        .app
        .clone()
        .oneshot(server.request(Method::GET, "/api/changes", Some(&token), None))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        response.headers()[header::CONTENT_TYPE],
        "text/event-stream"
    );

    let (status, _) = server
        .call(
            Method::POST,
            "/api/operations",
            Some(&token),
            Some(json!({"operation": "setRecipePrompt", "prompt": "Quick"})),
        )
        .await;
    assert_eq!(status, StatusCode::OK);

    let mut body = response.into_body();
    let frame = tokio::time::timeout(Duration::from_secs(5), body.frame())
        .await
        .expect("a change event arrives")
        .unwrap()
        .unwrap();
    let text = String::from_utf8(frame.into_data().unwrap().to_vec()).unwrap();
    assert!(text.contains("event: change"), "{text}");
    assert!(text.contains(r#""topic":"preferences""#), "{text}");
}
