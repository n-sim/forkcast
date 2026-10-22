//! ChatGPT connection, handoff, and execution across real installed cores, a
//! real household server over HTTP and SQLite, and a deterministic OAuth,
//! JWKS, and inference provider.

mod harness;

use forkcast_core::ErrorKind;
use harness::{
    Device, Server, plan,
    provider::{Provider, api},
    recipe, save_recipe,
};
use serde_json::{Value, json};
use std::time::Duration;

const PASSWORD: &str = "correct horse battery";

fn eventually(mut check: impl FnMut() -> bool) {
    for _ in 0..200 {
        if check() {
            return;
        }
        std::thread::sleep(Duration::from_millis(25));
    }
    panic!("condition never became true");
}

fn status(device: &Device) -> Value {
    device.op(json!({"operation": "aiStatus"}))
}

fn state(device: &Device) -> String {
    status(device)["state"].as_str().unwrap().to_owned()
}

fn authorize(device: &Device) -> String {
    device.op(json!({"operation": "aiAuthorize"}))["authorizationUrl"]
        .as_str()
        .unwrap()
        .to_owned()
}

/// Standalone sign-in as a person does it: the app starts its listener, the
/// system browser authorizes, the provider redirects back to the listener.
fn connect(device: &Device, provider: &Provider) {
    let url = authorize(device);
    assert_eq!(state(device), "authorizing");
    let (code, page) = provider.sign_in(&url);
    assert_eq!(code, 200, "{page}");
    eventually(|| state(device) == "connected");
}

fn execute(device: &Device) -> forkcast_core::Result<Value> {
    device.try_op(json!({
        "operation": "aiExecute", "model": "fixture-recipe",
        "instructions": "Reply with JSON.", "input": "Dish: soup"
    }))
}

fn models(device: &Device) -> forkcast_core::Result<Value> {
    device.try_op(json!({"operation": "aiModels"}))
}

fn assert_no_secrets(text: &str) {
    for secret in [
        "SECRET_ACCESS",
        "SECRET_REFRESH",
        "DO_NOT_EXPOSE",
        "id_token",
        "code_verifier",
    ] {
        assert!(!text.contains(secret), "{secret} leaked: {text}");
    }
}

#[test]
fn standalone_sign_in_runs_models_and_execution_without_exposing_credentials() {
    let provider = Provider::start();
    let device = Device::with_provider(&provider.issuer);
    assert_eq!(state(&device), "unconfigured");
    assert_eq!(status(&device)["target"], "device");

    connect(&device, &provider);
    let connected = status(&device);
    assert_eq!(connected["email"], "cook@example.test");
    assert_no_secrets(&connected.to_string());
    // The provider saw a stable UUID host identity and exactly one exchange.
    assert_eq!(provider.with(|s| s.hosts.len()), 1);
    assert_eq!(provider.count("exchange"), 1);

    let listed = models(&device).unwrap();
    assert_eq!(
        listed,
        json!([{"slug": "fixture-recipe", "displayName": "Fixture recipe model"}])
    );
    let reply = execute(&device).unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(reply["text"].as_str().unwrap()).unwrap(),
        json!({"name": "Tomato soup"})
    );
    assert_no_secrets(&reply.to_string());

    // Credentials are in protected storage only, and survive a restart.
    assert!(
        device
            .secret(&format!("ai:{}", device.me().person_id()))
            .unwrap()
            .contains("SECRET_ACCESS")
    );
    assert_no_secrets(&device.everything_stored());
    let mut device = device;
    device.restart();
    assert_eq!(state(&device), "connected");
    execute(&device).unwrap();
}

#[test]
fn rejected_sign_ins_explain_themselves_and_allow_a_fresh_attempt() {
    for (mode, expected) in [
        ("nonce", "identity could not be verified"),
        ("signature", "identity could not be verified"),
        ("issuer", "identity could not be verified"),
        ("audience", "identity could not be verified"),
        ("expired", "identity could not be verified"),
        ("scope", "plan usage was not enabled"),
        ("exchange", "sign-in could not be completed"),
    ] {
        let provider = Provider::start();
        let device = Device::with_provider(&provider.issuer);
        provider.mode(mode);
        let url = authorize(&device);
        let (code, page) = provider.sign_in(&url);
        assert_eq!(code, 400, "{mode}");
        assert!(page.contains("sign-in incomplete"));
        assert_no_secrets(&page);
        eventually(|| state(&device) == "reconnect_required");
        let shown = status(&device);
        assert!(
            shown["message"].as_str().unwrap().contains(expected),
            "{mode}: {shown}"
        );
        assert_no_secrets(&shown.to_string());
        assert_eq!(
            models(&device).err().unwrap().kind,
            ErrorKind::ConnectionRequired
        );

        provider.mode("success");
        connect(&device, &provider);
        // A failed exchange kept the issued registration; it was reused.
        assert_eq!(status(&device)["message"], Value::Null);
    }
}

#[test]
fn denied_sign_in_and_stray_callbacks() {
    let provider = Provider::start();
    let device = Device::with_provider(&provider.issuer);
    provider.mode("denied");
    let (code, _) = provider.sign_in(&authorize(&device));
    assert_eq!(code, 400);
    eventually(|| state(&device) == "denied");
    assert!(
        status(&device)["message"]
            .as_str()
            .unwrap()
            .contains("cancelled or denied")
    );

    provider.mode("success");
    let url = authorize(&device);
    let redirect = url::Url::parse(&url)
        .unwrap()
        .query_pairs()
        .find(|(k, _)| k == "redirect_uri")
        .unwrap()
        .1
        .into_owned();
    // A callback with someone else's state, and a request for another path,
    // never consume the pending attempt.
    let stray = url::Url::parse(&format!("{redirect}?state=forged&code=x")).unwrap();
    assert_eq!(harness::provider::get(&stray).0, 400);
    let other = url::Url::parse(&redirect.replace("/auth/callback", "/other")).unwrap();
    assert_eq!(harness::provider::get(&other).0, 403);
    assert_eq!(state(&device), "authorizing");
    assert_eq!(provider.sign_in(&url).0, 200);
    eventually(|| state(&device) == "connected");
}

#[test]
fn a_cancelled_sign_in_stops_waiting() {
    let provider = Provider::start();
    let device = Device::with_provider(&provider.issuer);
    let _ = authorize(&device);
    let after = device.op(json!({"operation": "aiCancelAuthorization"}));
    assert_eq!(after["state"], "unconfigured");
}

#[test]
fn refresh_rotates_persists_and_is_serialized() {
    let provider = Provider::start();
    // A one-second session is always inside the refresh margin.
    provider.with(|s| {
        s.expires_in = 1;
        s.refresh_delay_ms = 100;
    });
    let mut device = Device::with_provider(&provider.issuer);
    connect(&device, &provider);

    // Concurrent requests each need a renewal; rotating refresh tokens only
    // work if they are strictly serialized and persisted before use.
    let core = device.core.clone();
    let person = device.me();
    let handles: Vec<_> = (0..4)
        .map(|_| {
            let (core, person) = (core.clone(), person.clone());
            std::thread::spawn(move || core.ai_models(&person))
        })
        .collect();
    for handle in handles {
        handle.join().unwrap().unwrap();
    }
    let refreshes: Vec<String> = provider
        .log()
        .into_iter()
        .filter(|l| l.starts_with("refresh "))
        .collect();
    assert_eq!(refreshes.len(), 4);
    let unique: std::collections::HashSet<_> = refreshes.iter().collect();
    assert_eq!(
        unique.len(),
        4,
        "a refresh token was used twice: {refreshes:?}"
    );

    // The rotated session was persisted: a restart keeps working.
    device.restart();
    models(&device).unwrap();
    assert_no_secrets(&device.everything_stored());
}

#[test]
fn refresh_failures_distinguish_an_ended_session_from_an_unavailable_provider() {
    let provider = Provider::start();
    provider.with(|s| s.expires_in = 1);
    let device = Device::with_provider(&provider.issuer);
    connect(&device, &provider);

    provider.with(|s| s.refresh = "down".into());
    assert_eq!(models(&device).err().unwrap().kind, ErrorKind::Unavailable);
    // The session was kept: recovery needs no new sign-in.
    assert_eq!(state(&device), "connected");
    provider.with(|s| s.refresh = "ok".into());
    models(&device).unwrap();

    provider.with(|s| s.refresh = "reject".into());
    assert_eq!(
        models(&device).err().unwrap().kind,
        ErrorKind::ConnectionRequired
    );
    assert_eq!(state(&device), "reconnect_required");
    let before = provider.count("use ");
    assert_eq!(
        execute(&device).err().unwrap().kind,
        ErrorKind::ConnectionRequired
    );
    assert_eq!(
        provider.count("use "),
        before,
        "no request goes out without a session"
    );
}

#[test]
fn provider_failures_are_reported_without_provider_text() {
    let provider = Provider::start();
    let device = Device::with_provider(&provider.issuer);
    connect(&device, &provider);
    for (failure, kind, text) in [
        ("limited", ErrorKind::RateLimited, "temporarily limited"),
        ("http", ErrorKind::Unavailable, "could not complete"),
        ("failed", ErrorKind::Unavailable, "could not complete"),
        ("interrupted", ErrorKind::Unavailable, "could not complete"),
        ("malformed", ErrorKind::Unavailable, "could not complete"),
        ("refusal", ErrorKind::Invalid, "declined"),
    ] {
        provider.with(|s| s.failure = Some(failure.into()));
        let error = execute(&device)
            .err()
            .unwrap_or_else(|| panic!("{failure}"));
        assert_eq!(error.kind, kind, "{failure}");
        assert!(error.message.contains(text), "{failure}: {}", error.message);
        assert_no_secrets(&error.message);
        assert_eq!(state(&device), "connected", "{failure}");
    }
    // A refused access token is renewed once; if that fails too the person
    // must reconnect.
    provider.with(|s| s.failure = Some("unauthorized".into()));
    assert_eq!(
        execute(&device).err().unwrap().kind,
        ErrorKind::ConnectionRequired
    );
    assert_eq!(state(&device), "reconnect_required");
}

#[test]
fn sign_out_stops_execution_revokes_and_surfaces_a_failed_revocation() {
    let provider = Provider::start();
    let device = Device::with_provider(&provider.issuer);
    connect(&device, &provider);
    let out = device.op(json!({"operation": "aiSignOut"}));
    assert_eq!(out["state"], "unconfigured");
    assert_eq!(provider.count("revoke SECRET_REFRESH"), 1);
    assert_eq!(
        execute(&device).err().unwrap().kind,
        ErrorKind::ConnectionRequired
    );
    assert!(
        !device
            .secret(&format!("ai:{}", device.me().person_id()))
            .unwrap()
            .contains("SECRET_")
    );

    provider.mode("revocation");
    connect(&device, &provider);
    let out = device.op(json!({"operation": "aiSignOut"}));
    assert!(
        out["message"]
            .as_str()
            .unwrap()
            .contains("revocation was not confirmed")
    );
    assert_eq!(out["state"], "unconfigured");
}

// ----- joined installations: handoff to the server -----------------------

struct Household {
    provider: Provider,
    server: Server,
    admin: Device,
}

fn household() -> Household {
    let provider = Provider::start();
    let server = Server::with_provider(&provider.issuer);
    let admin = Device::with_provider(&provider.issuer);
    admin.found_household(&server);
    Household {
        provider,
        server,
        admin,
    }
}

fn selection(device: &Device) -> Value {
    let sync = device.status();
    json!({
        "operation": "aiAuthorize",
        "serverUrl": sync.server_url.unwrap(),
        "accountId": sync.active_account.unwrap().id,
    })
}

fn set_up_on_server(home: &Household, device: &Device) {
    let url = device.op(selection(device))["authorizationUrl"]
        .as_str()
        .unwrap()
        .to_owned();
    assert_eq!(home.provider.sign_in(&url).0, 200);
    eventually(|| state(device) == "connected");
}

fn login(server: &Server, username: &str) -> String {
    let (code, body) = api(
        "POST",
        &format!("{}/api/login", server.url),
        None,
        Some(&json!({"username": username, "password": PASSWORD})),
    );
    assert_eq!(code, 200, "{body}");
    body["token"].as_str().unwrap().to_owned()
}

#[test]
fn joined_setup_requires_an_explicit_server_choice() {
    let home = household();
    let shown = status(&home.admin);
    assert_eq!(shown["target"], "server");
    assert_eq!(shown["serverUrl"], home.server.url);
    assert_eq!(shown["state"], "unconfigured");

    for request in [
        json!({"operation": "aiAuthorize"}),
        json!({"operation": "aiAuthorize", "serverUrl": home.server.url}),
        json!({"operation": "aiAuthorize", "serverUrl": "https://elsewhere.example", "accountId": home.admin.status().active_account.unwrap().id}),
        json!({"operation": "aiAuthorize", "serverUrl": home.server.url, "accountId": "someone-else"}),
    ] {
        assert_eq!(
            home.admin.try_op(request).err().unwrap().kind,
            ErrorKind::Invalid
        );
    }
    assert_eq!(home.provider.count("authorize"), 0);
}

#[test]
fn handoff_gives_the_server_the_only_refreshing_copy() {
    let home = household();
    set_up_on_server(&home, &home.admin);

    // The grant was issued to the server's own host identity.
    let host = api(
        "GET",
        &format!("{}/api/ai/host", home.server.url),
        Some(&login(&home.server, "admin")),
        None,
    )
    .1["hostId"]
        .as_str()
        .unwrap()
        .to_owned();
    assert_eq!(home.provider.with(|s| s.hosts.clone()), vec![host]);

    // Nothing remains on the device; the server holds the session.
    let person = home.admin.me().person_id().to_owned();
    assert_eq!(home.admin.secret(&format!("ai:{person}")), None);
    assert!(
        home.server
            .secret(&format!("ai:{person}"))
            .unwrap()
            .contains("SECRET_ACCESS")
    );
    assert_eq!(status(&home.admin)["email"], "cook@example.test");

    // Execution happens on the server with the server's session.
    let reply = execute(&home.admin).unwrap();
    assert!(reply["text"].as_str().unwrap().contains("Tomato soup"));
    assert_eq!(home.provider.count("inference"), 1);
    assert_eq!(home.provider.count("use SECRET_ACCESS_1"), 1);

    // A browser of the same account uses the same connection.
    let token = login(&home.server, "admin");
    let (code, body) = api(
        "POST",
        &format!("{}/api/operations", home.server.url),
        Some(&token),
        Some(&json!({"operation": "aiStatus"})),
    );
    assert_eq!((code, body["state"].as_str()), (200, Some("connected")));
    assert_eq!(body["canAuthorize"], false);
    let (code, body) = api(
        "POST",
        &format!("{}/api/operations", home.server.url),
        Some(&token),
        Some(
            &json!({"operation": "aiExecute", "model": "fixture-recipe", "instructions": "x", "input": "y"}),
        ),
    );
    assert_eq!(code, 200, "{body}");
    assert_no_secrets(&body.to_string());
    // A browser cannot start sign-in: that belongs to the installed app.
    let (code, _) = api(
        "POST",
        &format!("{}/api/operations", home.server.url),
        Some(&token),
        Some(&json!({"operation": "aiAuthorize"})),
    );
    assert_eq!(code, 403);

    // The server survives a restart and keeps refreshing on its own.
    let mut home = home;
    home.server.restart();
    home.provider.with(|s| s.log.clear());
    execute(&home.admin).unwrap();

    assert_no_secrets(&home.admin.everything_stored());
    assert_no_secrets(&home.server.stored());
}

#[test]
fn connections_are_isolated_per_account_and_a_second_device_reuses_the_server_session() {
    let home = household();
    home.admin
        .op(json!({"operation": "createAccount", "username": "sam", "password": PASSWORD}));
    set_up_on_server(&home, &home.admin);

    // The same account on a second installed device generates on the server
    // without any credential of its own.
    let second = Device::with_provider(&home.provider.issuer);
    second.join_as(&home.server, "admin", PASSWORD);
    assert_eq!(state(&second), "connected");
    assert!(execute(&second).is_ok());
    assert_eq!(
        second.secret(&format!("ai:{}", second.me().person_id())),
        None
    );
    assert_eq!(home.provider.count("authorize"), 1);

    // Another household member has nothing, and cannot borrow admin's session.
    let sam = Device::with_provider(&home.provider.issuer);
    sam.join_as(&home.server, "sam", PASSWORD);
    assert_eq!(state(&sam), "unconfigured");
    assert_eq!(
        execute(&sam).err().unwrap().kind,
        ErrorKind::ConnectionRequired
    );
    let (code, _) = api(
        "POST",
        &format!("{}/api/operations", home.server.url),
        Some(&login(&home.server, "sam")),
        Some(&json!({"operation": "aiModels"})),
    );
    assert_eq!(code, 412);
}

#[test]
fn imports_are_bound_to_the_authenticated_account_and_the_server_identity() {
    let home = household();
    let url = format!(
        "{}/api/ai/transfers/{}",
        home.server.url,
        uuid::Uuid::new_v4()
    );
    let tokens = json!({"accessToken": "SECRET_ACCESS_X", "refreshToken": "SECRET_REFRESH_X", "idToken": "t", "scope": "chatgpt.tokens.use.direct", "expiresAt": 4_000_000_000u64});
    let body = |host: &str| json!({"issuer": home.provider.issuer, "hostId": host, "clientId": "oaiapp_fixture", "subject": "s", "email": null, "tokens": tokens});
    let admin = login(&home.server, "admin");
    let host = api(
        "GET",
        &format!("{}/api/ai/host", home.server.url),
        Some(&admin),
        None,
    )
    .1["hostId"]
        .as_str()
        .unwrap()
        .to_owned();

    // No session, no import; no account ID in the body can substitute.
    assert_eq!(api("POST", &url, None, Some(&body(&host))).0, 401);
    let mut with_account = body(&host);
    with_account["accountId"] = json!("whoever");
    let (code, reply) = api("POST", &url, Some(&admin), Some(&with_account));
    assert_eq!(code, 422);
    assert_no_secrets(&reply.to_string());
    // A session issued to another host identity is refused.
    assert_eq!(
        api(
            "POST",
            &url,
            Some(&admin),
            Some(&body("urn:uuid:11111111-1111-4111-8111-111111111111"))
        )
        .0,
        422
    );
    assert_eq!(
        api(
            "GET",
            &format!("{}/api/ai/host", home.server.url),
            None,
            None
        )
        .0,
        401
    );

    // A valid import lands under the caller's own account only.
    let (code, ack) = api("POST", &url, Some(&admin), Some(&body(&host)));
    assert_eq!((code, ack["state"].as_str()), (200, Some("active")));
    assert_no_secrets(&ack.to_string());
    let person = home.admin.me().person_id().to_owned();
    assert!(home.server.secret(&format!("ai:{person}")).is_some());
    home.admin
        .op(json!({"operation": "createAccount", "username": "sam", "password": PASSWORD}));
    let sam = login(&home.server, "sam");
    let (_, status) = api(
        "POST",
        &format!("{}/api/operations", home.server.url),
        Some(&sam),
        Some(&json!({"operation": "aiStatus"})),
    );
    assert_eq!(status["state"], "unconfigured");
    // Repeating the same transfer is acknowledged without a second import.
    assert_eq!(api("POST", &url, Some(&admin), Some(&body(&host))).0, 200);
    // A malformed body is refused without echoing it.
    let (code, reply) = api(
        "POST",
        &url,
        Some(&admin),
        Some(&json!({"tokens": "SECRET_REFRESH_LEAK"})),
    );
    assert_eq!(code, 422);
    assert_no_secrets(&reply.to_string());
    assert!(!reply.to_string().contains("LEAK"));
}

/// Starts setup while the server is reachable, takes the server away, then
/// completes the person's browser step: the upload happens during the outage.
fn begin_handoff_with_outage(provider: &Provider, server: &mut Server, device: &Device) {
    let url = device.op(selection(device))["authorizationUrl"]
        .as_str()
        .unwrap()
        .to_owned();
    server.stop();
    assert_eq!(provider.sign_in(&url).0, 200);
}

#[test]
fn an_upload_failure_keeps_the_session_fenced_and_a_retry_completes_it() {
    let mut home = household();
    begin_handoff_with_outage(&home.provider, &mut home.server, &home.admin);
    eventually(|| state(&home.admin) == "transfer_failed");
    let shown = status(&home.admin);
    assert_eq!(shown["canRetry"], true);
    assert!(shown["message"].as_str().unwrap().contains("Retry"));

    // The local copy is retained but never used or refreshed meanwhile.
    let person = home.admin.me().person_id().to_owned();
    assert!(
        home.admin
            .secret(&format!("ai:{person}"))
            .unwrap()
            .contains("SECRET_ACCESS_1")
    );
    let mut device = home.admin;
    assert_eq!(home.provider.count("refresh"), 0);
    // Restarting the app does not lose the unfinished transfer.
    device.restart();
    assert_eq!(state(&device), "transfer_failed");

    home.server.restart();
    let after = device.op(json!({"operation": "aiRetryTransfer"}));
    assert_eq!(after["state"], "connected");
    assert_eq!(device.secret(&format!("ai:{person}")), None);
    assert!(execute(&device).is_ok());
    assert_eq!(home.provider.count("refresh"), 0);
}

#[test]
fn confirmation_loss_is_idempotent_by_transfer_identity() {
    let mut home = household();
    begin_handoff_with_outage(&home.provider, &mut home.server, &home.admin);
    eventually(|| state(&home.admin) == "transfer_failed");
    home.server.restart();

    // The server imports the transfer (as if the first upload had arrived)
    // before the app retries.
    let person = home.admin.me().person_id().to_owned();
    let local: Value =
        serde_json::from_str(&home.admin.secret(&format!("ai:{person}")).unwrap()).unwrap();
    let transfer = local["owner"]["handoff"]["transferId"]
        .as_str()
        .unwrap()
        .to_owned();
    let admin = login(&home.server, "admin");
    let body = json!({
        "issuer": local["issuer"], "hostId": local["hostId"], "clientId": local["clientId"],
        "subject": local["subject"], "email": local["email"], "tokens": local["tokens"],
    });
    let url = format!("{}/api/ai/transfers/{transfer}", home.server.url);
    assert_eq!(api("POST", &url, Some(&admin), Some(&body)).0, 200);

    // The app retries with the same identity and is acknowledged, not duplicated.
    let after = home.admin.op(json!({"operation": "aiRetryTransfer"}));
    assert_eq!(after["state"], "connected");
    assert_eq!(home.admin.secret(&format!("ai:{person}")), None);
    assert!(execute(&home.admin).is_ok());
    // Cancelling a transfer the server already holds cannot take it back.
    assert_eq!(api("DELETE", &url, Some(&admin), None).0, 409);
}

#[test]
fn cancelling_completes_only_when_the_server_confirms_and_blocks_late_imports() {
    let mut home = household();
    begin_handoff_with_outage(&home.provider, &mut home.server, &home.admin);
    eventually(|| state(&home.admin) == "transfer_failed");
    let person = home.admin.me().person_id().to_owned();
    let local: Value =
        serde_json::from_str(&home.admin.secret(&format!("ai:{person}")).unwrap()).unwrap();
    let transfer = local["owner"]["handoff"]["transferId"]
        .as_str()
        .unwrap()
        .to_owned();

    // With the server away, cancelling stays pending and the copy stays fenced.
    let pending = home.admin.op(json!({"operation": "aiCancelTransfer"}));
    assert_eq!(pending["state"], "transfer_failed");
    assert!(home.admin.secret(&format!("ai:{person}")).is_some());
    assert_eq!(home.provider.count("revoke"), 0);

    home.server.restart();
    let done = home.admin.op(json!({"operation": "aiRetryTransfer"}));
    assert_eq!(done["state"], "unconfigured");
    assert_eq!(home.admin.secret(&format!("ai:{person}")), None);
    assert_eq!(home.provider.count("revoke SECRET_REFRESH_1"), 1);
    assert_eq!(
        execute(&home.admin).err().unwrap().kind,
        ErrorKind::ConnectionRequired
    );

    // A late retry of the cancelled transfer is refused.
    let admin = login(&home.server, "admin");
    let body = json!({
        "issuer": local["issuer"], "hostId": local["hostId"], "clientId": local["clientId"],
        "subject": local["subject"], "email": local["email"], "tokens": local["tokens"],
    });
    let url = format!("{}/api/ai/transfers/{transfer}", home.server.url);
    assert_eq!(api("POST", &url, Some(&admin), Some(&body)).0, 409);
    assert_eq!(home.server.secret(&format!("ai:{person}")), None);
}

#[test]
fn server_sign_out_clears_the_servers_session_and_revokes_it() {
    let home = household();
    set_up_on_server(&home, &home.admin);
    let person = home.admin.me().person_id().to_owned();
    let out = home.admin.op(json!({"operation": "aiSignOut"}));
    assert_eq!(out["state"], "unconfigured");
    assert_eq!(home.provider.count("revoke SECRET_REFRESH_1"), 1);
    assert!(
        !home
            .server
            .secret(&format!("ai:{person}"))
            .unwrap()
            .contains("SECRET_")
    );
    assert_eq!(
        execute(&home.admin).err().unwrap().kind,
        ErrorKind::ConnectionRequired
    );
}

#[test]
fn an_unreachable_server_is_reported_and_never_replaced_by_a_local_credential() {
    let mut home = household();
    set_up_on_server(&home, &home.admin);
    home.server.stop();
    let shown = status(&home.admin);
    assert_eq!(shown["state"], "unavailable");
    assert!(
        shown["message"]
            .as_str()
            .unwrap()
            .contains("Manual workflows remain available")
    );
    let before = home.provider.count("use ");
    assert_eq!(
        execute(&home.admin).err().unwrap().kind,
        ErrorKind::Unavailable
    );
    assert_eq!(home.provider.count("use "), before);
    // Manual workflows are untouched.
    harness::save_recipe(&home.admin, "soup", "Soup");
    home.server.restart();
    assert_eq!(state(&home.admin), "connected");
}

#[test]
fn joining_retires_the_standalone_session_instead_of_reusing_it() {
    let provider = Provider::start();
    let server = Server::with_provider(&provider.issuer);
    let device = Device::with_provider(&provider.issuer);
    connect(&device, &provider);
    let standalone = device.me().person_id().to_owned();
    device.found_household(&server);
    assert_eq!(provider.count("revoke SECRET_REFRESH_1"), 1);
    assert!(
        !device
            .secret(&format!("ai:{standalone}"))
            .is_some_and(|s| s.contains("SECRET_"))
    );
    assert_eq!(state(&device), "unconfigured");
    assert_eq!(status(&device)["target"], "server");
}

#[test]
fn model_and_prompt_preferences_follow_the_account_and_work_offline() {
    let mut home = household();
    let second = Device::with_provider(&home.provider.issuer);
    second.join_as(&home.server, "admin", PASSWORD);

    // Offline changes are durable and delivered later.
    home.server.stop();
    home.admin
        .op(json!({"operation": "setRecipePrompt", "prompt": "Vegetarian only."}));
    home.admin
        .op(json!({"operation": "setRecipeModel", "model": "fixture-recipe"}));
    home.admin
        .op(json!({"operation": "setPlanPrompt", "prompt": "Fish on Fridays."}));
    let kept = home.admin.op(json!({"operation": "aiPreferences"}));
    assert_eq!(
        (kept["recipePrompt"].as_str(), kept["recipeModel"].as_str()),
        (Some("Vegetarian only."), Some("fixture-recipe"))
    );
    assert_eq!(home.admin.status().pending, 3);
    home.server.restart();
    home.admin.sync();
    assert_eq!(home.admin.status().pending, 0);

    second.sync();
    let seen = second.op(json!({"operation": "aiPreferences"}));
    assert_eq!(
        (seen["recipePrompt"].as_str(), seen["recipeModel"].as_str()),
        (Some("Vegetarian only."), Some("fixture-recipe"))
    );
    assert_eq!(seen["planPrompt"], "Fish on Fridays.");

    // A browser write reaches installed apps through the server core, and a
    // second person's settings stay separate.
    let token = login(&home.server, "admin");
    api(
        "POST",
        &format!("{}/api/operations", home.server.url),
        Some(&token),
        Some(&json!({"operation": "setRecipePrompt", "prompt": "From the browser."})),
    );
    second.sync();
    assert_eq!(
        second.op(json!({"operation": "aiPreferences"}))["recipePrompt"],
        "From the browser."
    );
    home.admin
        .op(json!({"operation": "createAccount", "username": "sam", "password": PASSWORD}));
    let sam = login(&home.server, "sam");
    let (_, theirs) = api(
        "POST",
        &format!("{}/api/operations", home.server.url),
        Some(&sam),
        Some(&json!({"operation": "aiPreferences"})),
    );
    assert!(theirs["recipePrompt"].as_str().unwrap().contains("metric"));
    assert_eq!(theirs["recipeModel"], Value::Null);
    // Preferences never carry credentials.
    assert_no_secrets(&seen.to_string());
}

/// Generates a plan for 2030-05-06 to 2030-05-08 with the fixture's reply.
fn generate_plan(
    device: &Device,
    provider: &Provider,
    reply: Value,
) -> forkcast_core::Result<Value> {
    provider.with(|s| s.reply = reply);
    device.try_op(json!({
        "operation": "generateCookingPlan", "model": "fixture-recipe",
        "request": "Meals I liked and have not cooked for a while.",
        "startDate": "2030-05-06", "endDate": "2030-05-08",
    }))
}

fn planned(device: &Device) -> Vec<(String, String)> {
    device.op(json!({"operation": "mealPlan"}))["cookings"]
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

#[test]
fn a_generated_plan_uses_only_the_collection_and_replaces_its_period_after_confirmation() {
    let provider = Provider::start();
    let device = Device::with_provider(&provider.issuer);
    connect(&device, &provider);
    save_recipe(&device, "soup", "Soup");
    save_recipe(&device, "stew", "Stew");
    device.op(json!({"operation": "rateRecipe", "recipeId": "stew", "value": 5}));
    device.op(json!({"operation": "markCooked", "recipeId": "stew"}));
    device.op(json!({"operation": "setPlanPrompt", "prompt": "No cooking on Sundays."}));
    plan(&device, "inside", "soup", "2030-05-07", 2.0);
    plan(&device, "before", "soup", "2030-05-05", 2.0);
    plan(&device, "after", "soup", "2030-05-09", 2.0);
    let before = planned(&device);

    let proposal = generate_plan(
        &device,
        &provider,
        json!({"cookings": [
            {"recipeId": "stew", "cookingDate": "2030-05-06", "portions": 3, "cookingTime": "evening"},
            {"recipeId": "soup", "cookingDate": "2030-05-08"},
        ]}),
    )
    .unwrap();

    // The request carried the person's defaults, the request, the period
    // and the collection with ratings and cooking history.
    let request = provider.with(|s| s.requests.last().cloned().unwrap());
    let instructions = request["instructions"].as_str().unwrap();
    assert!(instructions.contains("No cooking on Sundays."));
    let input = request["input"][0]["content"].as_str().unwrap();
    assert!(input.contains("Meals I liked and have not cooked for a while."));
    let context: Value = serde_json::from_str(
        input
            .strip_prefix("Collection and period:\n")
            .unwrap()
            .split("\n\nRequest:\n")
            .next()
            .unwrap(),
    )
    .unwrap();
    assert_eq!(
        context["period"][0],
        json!({"date": "2030-05-06", "weekday": "Monday"})
    );
    assert_eq!(context["period"].as_array().unwrap().len(), 3);
    let stew = context["collection"]
        .as_array()
        .unwrap()
        .iter()
        .find(|recipe| recipe["id"] == "stew")
        .unwrap();
    assert_eq!(
        (stew["yourRating"].clone(), stew["timesCooked"].clone()),
        (json!(5), json!(1))
    );
    assert!(stew["lastCooked"].is_string());
    assert_eq!(context["plannedNearby"].as_array().unwrap().len(), 2);

    // Nothing changes until the proposal is applied.
    assert_eq!(planned(&device), before);
    assert_eq!(proposal["replaced"][0]["id"], "inside");
    let cookings = proposal["cookings"].as_array().unwrap();
    assert_eq!(cookings[0]["portions"].as_f64(), Some(3.0));
    assert_eq!(cookings[0]["cookingTime"], "evening");
    // Omitted portions default to the recipe's base yield.
    assert_eq!(
        cookings[1]["portions"].as_f64(),
        recipe("soup", "Soup")["basePortions"].as_f64()
    );

    let apply = |replacing: Value| {
        device.try_op(json!({
            "operation": "applyCookingPlan", "dates": proposal["dates"],
            "cookings": proposal["cookings"], "replacing": replacing,
            "editBase": proposal["editBase"],
        }))
    };
    assert_eq!(apply(json!([])).unwrap_err().kind, ErrorKind::Conflict);
    assert_eq!(planned(&device), before);
    apply(json!(["inside"])).unwrap();
    assert_eq!(
        planned(&device),
        [
            ("2030-05-05", "soup"),
            ("2030-05-06", "stew"),
            ("2030-05-08", "soup"),
            ("2030-05-09", "soup"),
        ]
        .map(|(date, recipe)| (date.to_owned(), recipe.to_owned()))
    );
}

#[test]
fn invalid_or_failed_plan_generation_never_changes_the_plan() {
    let provider = Provider::start();
    let device = Device::with_provider(&provider.issuer);
    connect(&device, &provider);
    save_recipe(&device, "soup", "Soup");
    plan(&device, "kept", "soup", "2030-05-07", 2.0);
    let before = device.op(json!({"operation": "planningSnapshot"}));
    let cooking = |recipe: &str, date: &str| json!({"recipeId": recipe, "cookingDate": date});
    for reply in [
        json!("Here is your plan: soup on Monday."),
        json!({"cookings": []}),
        json!({"plan": [cooking("soup", "2030-05-06")]}),
        // A recipe outside the collection fails the whole reply.
        json!({"cookings": [cooking("soup", "2030-05-06"), cooking("pizza", "2030-05-07")]}),
        json!({"cookings": [cooking("soup", "2030-05-06"), cooking("soup", "2030-05-09")]}),
        json!({"cookings": [{"recipeId": "soup", "cookingDate": "2030-05-06", "portions": 0}]}),
        json!({"cookings": [{"recipeId": "soup", "cookingDate": "2030-05-06", "cookingTime": "midnight"}]}),
    ] {
        let failure = generate_plan(&device, &provider, reply.clone()).unwrap_err();
        assert_eq!(failure.kind, ErrorKind::Invalid, "{reply}");
        assert!(failure.message.contains("Your meal plan was not changed."));
        assert_eq!(device.op(json!({"operation": "planningSnapshot"})), before);
    }
    for failure in ["http", "failed", "interrupted"] {
        provider.with(|s| s.failure = Some(failure.into()));
        let reply = json!({"cookings": [cooking("soup", "2030-05-06")]});
        assert!(generate_plan(&device, &provider, reply).is_err());
        assert_eq!(device.op(json!({"operation": "planningSnapshot"})), before);
    }
    // A fenced reply is still read.
    provider.with(|s| s.failure = None);
    let fenced = json!(format!(
        "```json\n{}\n```",
        json!({"cookings": [cooking("soup", "2030-05-06")]})
    ));
    provider.with(|s| s.reply = fenced);
    let proposal = device
        .try_op(json!({
            "operation": "generateCookingPlan", "model": "fixture-recipe",
            "request": "Soup", "startDate": "2030-05-06", "endDate": "2030-05-06",
        }))
        .unwrap();
    assert_eq!(proposal["cookings"][0]["recipeId"], "soup");
}

/// A PNG whose bytes carry a marker, so any retained copy can be found.
fn estimation_photo() -> (Value, String) {
    use base64::{Engine, engine::general_purpose::STANDARD};
    let mut bytes = b"\x89PNG\r\n\x1a\n".to_vec();
    bytes.extend_from_slice(b"ESTIMATION_PHOTO_MARKER_");
    bytes.extend((0..3000u32).map(|n| (n % 251) as u8));
    let data = STANDARD.encode(&bytes);
    (json!({"mime": "image/png", "data": data}), data)
}

fn assert_photo_not_stored(stored: &str, data: &str) {
    assert!(
        !stored.contains("ESTIMATION_PHOTO_MARKER"),
        "photo bytes kept"
    );
    assert!(!stored.contains(&data[16..96]), "encoded photo kept");
}

fn estimate_food(device: &Device, request: Value) -> forkcast_core::Result<Value> {
    let mut operation = json!({"operation": "estimateFood", "model": "fixture-recipe"});
    operation
        .as_object_mut()
        .unwrap()
        .extend(request.as_object().unwrap().clone());
    device.try_op(operation)
}

fn pizza() -> Value {
    json!({
        "description": "2 slices of margherita pizza (about 250 g)",
        "calories": 600, "protein": 25, "fat": 22, "carbohydrates": null,
    })
}

/// Saves an estimate as the person would: a manual entry with its own nutrition.
fn log_estimate(device: &Device, estimate: &Value) {
    device.op(json!({
        "operation": "logManualFood", "id": "estimated-pizza",
        "description": estimate["description"], "consumedAt": "2030-05-06T12:30",
        "nutrition": estimate["nutrition"],
    }));
}

#[test]
fn standalone_estimates_from_text_or_a_photo_become_manual_entries_without_keeping_the_photo() {
    let provider = Provider::start();
    let device = Device::with_provider(&provider.issuer);
    connect(&device, &provider);
    provider.with(|s| s.reply = pizza());

    // From a description: the request carries the text alone.
    let estimate = estimate_food(&device, json!({"description": "Two slices of pizza"})).unwrap();
    assert_eq!(
        estimate,
        json!({
            "description": "2 slices of margherita pizza (about 250 g)",
            "nutrition": {"calories": 600.0, "protein": 25.0, "fat": 22.0, "carbohydrates": null},
        })
    );
    let request = provider.with(|s| s.requests.last().cloned().unwrap());
    assert!(
        request["input"][0]["content"]
            .as_str()
            .unwrap()
            .contains("Two slices of pizza")
    );

    // From a photo: the image goes to the provider with the request.
    let (photo, data) = estimation_photo();
    let estimate = estimate_food(&device, json!({"image": photo})).unwrap();
    let request = provider.with(|s| s.requests.last().cloned().unwrap());
    let content = &request["input"][0]["content"];
    assert_eq!(content[0]["type"], "input_text");
    assert_eq!(content[1]["type"], "input_image");
    assert_eq!(
        content[1]["image_url"],
        format!("data:image/png;base64,{data}")
    );

    // Estimating stores nothing; saving stores only the entry's own values.
    let day = || device.op(json!({"operation": "foodLog", "date": "2030-05-06"}));
    assert_eq!(day()["entries"], json!([]));
    log_estimate(&device, &estimate);
    let entries = day()["entries"].clone();
    assert_eq!(entries.as_array().unwrap().len(), 1);
    assert_eq!(entries[0]["description"], estimate["description"]);
    assert_eq!(entries[0]["nutrition"], estimate["nutrition"]);
    assert_eq!(entries[0]["recipeId"], Value::Null);
    assert_eq!(day()["totals"]["carbohydrates"]["unknownEntries"], 1);
    // No recipe, catalog record, or cover photo came from it.
    assert_eq!(device.op(json!({"operation": "recipes"})), json!([]));
    assert_photo_not_stored(&device.everything_stored(), &data);
}

#[test]
fn joined_and_browser_estimates_run_on_the_server_and_no_runtime_keeps_the_photo() {
    let home = household();
    set_up_on_server(&home, &home.admin);
    home.provider.with(|s| s.reply = pizza());
    let (photo, data) = estimation_photo();

    // The installed app's estimate executes on the server's session.
    let estimate = estimate_food(
        &home.admin,
        json!({"description": "Pizza for lunch", "image": photo}),
    )
    .unwrap();
    let request = home.provider.with(|s| s.requests.last().cloned().unwrap());
    let content = &request["input"][0]["content"];
    assert!(
        content[0]["text"]
            .as_str()
            .unwrap()
            .contains("Pizza for lunch")
    );
    assert_eq!(
        content[1]["image_url"],
        format!("data:image/png;base64,{data}")
    );
    // The entry is saved by the app's own core, which synchronizes as usual.
    log_estimate(&home.admin, &estimate);
    home.admin.sync();
    let logged = home
        .admin
        .op(json!({"operation": "foodLog", "date": "2030-05-06"}));
    assert_eq!(logged["entries"][0]["nutrition"], estimate["nutrition"]);

    // A browser uses the same operation through the server's core.
    let token = login(&home.server, "admin");
    let operation = |body: Value| {
        api(
            "POST",
            &format!("{}/api/operations", home.server.url),
            Some(&token),
            Some(&body),
        )
    };
    let (code, browser) = operation(json!({
        "operation": "estimateFood", "model": "fixture-recipe", "image": photo,
    }));
    assert_eq!(code, 200, "{browser}");
    assert_eq!(browser, estimate);
    let (code, _) = operation(json!({
        "operation": "logManualFood", "id": "browser-pizza",
        "description": browser["description"], "consumedAt": "2030-05-07T19:00",
        "nutrition": browser["nutrition"],
    }));
    assert_eq!(code, 200);
    let (_, day) = operation(json!({"operation": "foodLog", "date": "2030-05-07"}));
    assert_eq!(day["entries"][0]["nutrition"], estimate["nutrition"]);

    // Neither the app, its synchronization records, nor the server kept it.
    assert_photo_not_stored(&home.admin.everything_stored(), &data);
    assert_photo_not_stored(&home.server.stored(), &data);
    assert_eq!(home.admin.op(json!({"operation": "recipes"})), json!([]));
}

#[test]
fn invalid_requests_images_and_replies_never_log_anything() {
    use base64::{Engine, engine::general_purpose::STANDARD};
    let provider = Provider::start();
    let device = Device::with_provider(&provider.issuer);

    // Without a connection, estimating needs one; manual logging does not.
    assert_eq!(
        estimate_food(&device, json!({"description": "Pizza"}))
            .unwrap_err()
            .kind,
        ErrorKind::ConnectionRequired
    );
    connect(&device, &provider);
    let sent = || provider.with(|s| s.requests.len());
    let before = sent();
    let jpeg_named_png =
        json!({"mime": "image/png", "data": STANDARD.encode([0xFF, 0xD8, 0xFF, 0xE0])});
    let oversized = json!({
        "mime": "image/jpeg",
        "data": STANDARD.encode([&[0xFF, 0xD8, 0xFF][..], &vec![0; 8 * 1024 * 1024]].concat()),
    });
    for request in [
        json!({}),
        json!({"description": "   "}),
        json!({"description": "x".repeat(2001)}),
        json!({"image": {"mime": "image/gif", "data": STANDARD.encode(b"GIF89a")}}),
        json!({"image": jpeg_named_png}),
        json!({"image": {"mime": "image/png", "data": "not base64!"}}),
        json!({"image": oversized}),
    ] {
        let failure = estimate_food(&device, request.clone()).unwrap_err();
        assert_eq!(failure.kind, ErrorKind::Invalid, "{request}");
    }
    assert_eq!(sent(), before, "invalid requests reached the provider");

    let day = || device.op(json!({"operation": "foodLog", "date": "2030-05-06"}));
    let empty = day();
    for reply in [
        json!("About 600 kcal."),
        json!({"description": "Pizza"}),
        json!({"description": "", "calories": 600}),
        json!({"description": "Pizza", "calories": -5}),
        json!({"description": "Pizza", "calories": 600, "recipe": {"name": "Pizza"}}),
    ] {
        provider.with(|s| s.reply = reply.clone());
        let failure = estimate_food(&device, json!({"description": "Pizza"})).unwrap_err();
        assert_eq!(failure.kind, ErrorKind::Invalid, "{reply}");
        assert!(
            failure.message.contains("Nothing was logged."),
            "{}",
            failure.message
        );
        assert_eq!(day(), empty);
    }
    provider.with(|s| s.reply = pizza());
    for failure in ["http", "failed", "interrupted"] {
        provider.with(|s| s.failure = Some(failure.into()));
        assert!(estimate_food(&device, json!({"description": "Pizza"})).is_err());
        assert_eq!(day(), empty);
    }
    // A fenced reply is still read.
    provider.with(|s| {
        s.failure = None;
        s.reply = json!(format!("```json\n{}\n```", pizza()));
    });
    assert_eq!(
        estimate_food(&device, json!({"description": "Pizza"})).unwrap()["nutrition"]["calories"],
        600.0
    );
}

// Ingredient-dependent conversions: AI estimates for shopping quantities that
// differ in kind, applied only when the person accepts them.

const LIST_DAY: &str = "2030-05-06";

fn measured_recipe(id: &str, name: &str, quantity: f64, unit: &str) -> Value {
    json!({
        "id": id, "name": name, "basePortions": 2,
        "ingredients": [{"id": "oil", "name": "Olive oil", "quantity": quantity, "unit": unit}],
        "steps": [{
            "id": "mix", "instruction": "Mix.",
            "allocations": [{"ingredientId": "oil", "quantity": quantity, "unit": unit}],
        }],
        "difficulty": "easy", "activeMinutes": 5, "totalMinutes": 10,
    })
}

/// A list whose olive oil is measured by volume in one recipe and by mass in another.
fn oil_list(device: &Device, volume_unit: &str, volume: f64) -> Value {
    for (id, recipe) in [
        (
            "dressing",
            measured_recipe("dressing", "Dressing", volume, volume_unit),
        ),
        ("frying", measured_recipe("frying", "Frying", 30.0, "g")),
    ] {
        device.op(json!({"operation": "saveRecipe", "recipe": recipe}));
        plan(device, &format!("cook-{id}"), id, LIST_DAY, 2.0);
    }
    device.op(json!({
        "operation": "generateShoppingList", "startDate": LIST_DAY, "endDate": LIST_DAY,
        "replacingListId": null, "editBase": null,
    }))
}

fn oil_items(view: &Value) -> Vec<(f64, String)> {
    view["list"]["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|item| {
            (
                item["quantity"].as_f64().unwrap(),
                item["unit"].as_str().unwrap().to_owned(),
            )
        })
        .collect()
}

fn estimate_conversion(
    device: &Device,
    name: &str,
    dimension: &str,
) -> forkcast_core::Result<Value> {
    device.try_op(json!({
        "operation": "estimateIngredientConversion", "model": "fixture-recipe",
        "name": name, "dimension": dimension,
    }))
}

fn accept_conversion(device: &Device, view: &Value, grams: f64) -> forkcast_core::Result<Value> {
    device.try_op(json!({
        "operation": "acceptIngredientConversion", "listId": view["list"]["id"],
        "conversion": {"name": "Olive oil", "dimension": "volume", "grams": grams, "note": "about 0.91 g/ml"},
        "editBase": view["editBase"],
    }))
}

#[test]
fn an_estimate_is_reviewed_and_only_an_accepted_one_combines_shopping_quantities() {
    let provider = Provider::start();
    let device = Device::with_provider(&provider.issuer);
    let view = oil_list(&device, "tbsp", 2.0);
    let volume = 2.0 * 236.588_236_5 / 16.0;

    // Mass and volume of one ingredient stay separate, and offer an estimate.
    assert_eq!(oil_items(&view).len(), 2);
    assert_eq!(view["conversionOffers"].as_array().unwrap().len(), 1);
    let offer = &view["conversionOffers"][0];
    assert_eq!(
        (offer["name"].as_str(), offer["dimension"].as_str()),
        (Some("Olive oil"), Some("volume"))
    );
    assert_eq!(offer["declined"], false);
    assert!(
        view["list"]["items"]
            .as_array()
            .unwrap()
            .iter()
            .all(|item| item["needsReview"] == true)
    );

    // Without an AI connection nothing combines and the list is unchanged.
    assert_eq!(
        estimate_conversion(&device, "Olive oil", "volume")
            .unwrap_err()
            .kind,
        ErrorKind::ConnectionRequired
    );
    let unchanged = device.op(json!({"operation": "shoppingList"}));
    assert_eq!(unchanged, view);

    // An estimate is a suggestion: it changes nothing and carries its note.
    connect(&device, &provider);
    provider.with(|s| s.reply = json!({"grams": 91, "note": "Olive oil is about 0.91 g/ml."}));
    let estimate = estimate_conversion(&device, " Olive oil ", "volume").unwrap();
    assert_eq!(
        estimate,
        json!({"name": "Olive oil", "dimension": "volume", "grams": 91.0, "note": "Olive oil is about 0.91 g/ml."})
    );
    let request = provider.with(|s| s.requests.last().cloned().unwrap());
    let sent = request["input"][0]["content"].as_str().unwrap().to_owned();
    assert!(
        sent.contains("Olive oil") && sent.contains("100 millilitres"),
        "{sent}"
    );
    assert_eq!(device.op(json!({"operation": "shoppingList"})), view);

    // Declining keeps the quantities separate and the decision is retained.
    let mut declined = device.op(json!({
        "operation": "declineIngredientConversion", "listId": view["list"]["id"],
        "name": "Olive oil", "dimension": "volume", "editBase": view["editBase"],
    }));
    assert_eq!(oil_items(&declined).len(), 2);
    assert_eq!(declined["conversionOffers"][0]["declined"], true);
    assert_eq!(declined["list"]["conversions"][0]["status"], "declined");
    let mut device = device;
    device.restart();
    declined = device.op(json!({"operation": "shoppingList"}));
    assert_eq!(declined["conversionOffers"][0]["declined"], true);
    assert_eq!(oil_items(&declined).len(), 2);

    // Accepting a new estimate applies it to the scaled recipe totals.
    let accepted = accept_conversion(&device, &declined, 91.0).unwrap();
    assert_eq!(accepted["conversionOffers"], json!([]));
    let items = accepted["list"]["items"].as_array().unwrap();
    assert_eq!(items.len(), 1);
    let expected = 30.0 + volume / 100.0 * 91.0;
    assert!((items[0]["quantity"].as_f64().unwrap() - expected).abs() < 1e-9);
    assert_eq!(items[0]["unit"], "g");
    assert_eq!(items[0]["needsReview"], false);
    assert_eq!(items[0]["sources"].as_array().unwrap().len(), 2);
    assert_eq!(items[0]["convertedFrom"][0]["unit"], "ml");
    let conversions = accepted["list"]["conversions"].as_array().unwrap();
    assert_eq!(conversions.len(), 1);
    assert_eq!(
        (
            conversions[0]["status"].as_str(),
            conversions[0]["source"].as_str()
        ),
        (Some("accepted"), Some("ai"))
    );
    assert_eq!(
        items[0]["convertedFrom"][0]["conversionId"],
        conversions[0]["id"]
    );

    // Recipe totals and step allocations stay authoritative, and so do the
    // list's recorded contributions and source status.
    for (id, quantity, unit) in [("dressing", 2.0, "tbsp"), ("frying", 30.0, "g")] {
        let recipes = device.op(json!({"operation": "recipes"}));
        let recipe = recipes
            .as_array()
            .unwrap()
            .iter()
            .find(|r| r["recipe"]["id"] == id)
            .unwrap();
        let ingredient = &recipe["recipe"]["ingredients"][0];
        assert_eq!(
            (ingredient["quantity"].as_f64(), ingredient["unit"].as_str()),
            (Some(quantity), Some(unit))
        );
        assert_eq!(
            recipe["recipe"]["steps"][0]["allocations"][0]["quantity"].as_f64(),
            Some(quantity)
        );
    }
    assert_eq!(
        accepted["list"]["contributions"],
        view["list"]["contributions"]
    );
    assert_eq!(accepted["sourceStatus"], "unchanged");

    // Acceptance survives a restart; a stale second acceptance changes nothing.
    device.restart();
    assert_eq!(device.op(json!({"operation": "shoppingList"})), accepted);
    assert_eq!(
        accept_conversion(&device, &accepted, 91.0)
            .unwrap_err()
            .kind,
        ErrorKind::Invalid
    );

    // Regenerating reviews the recipe requirements afresh, without the estimate.
    let regenerated = device.op(json!({
        "operation": "generateShoppingList", "startDate": LIST_DAY, "endDate": LIST_DAY,
        "replacingListId": accepted["list"]["id"], "editBase": accepted["editBase"],
    }));
    assert_eq!(oil_items(&regenerated).len(), 2);
    assert!(regenerated["list"].get("conversions").is_none());
}

#[test]
fn compatible_dimensions_combine_exactly_without_asking_ai() {
    let provider = Provider::start();
    let device = Device::with_provider(&provider.issuer);
    connect(&device, &provider);
    let before = provider.with(|s| s.requests.len());
    // Tablespoons and millilitres of one ingredient are both volume.
    for (id, recipe) in [
        (
            "dressing",
            measured_recipe("dressing", "Dressing", 2.0, "tbsp"),
        ),
        ("frying", measured_recipe("frying", "Frying", 30.0, "ml")),
    ] {
        device.op(json!({"operation": "saveRecipe", "recipe": recipe}));
        plan(&device, &format!("cook-{id}"), id, LIST_DAY, 2.0);
    }
    let view = device.op(json!({
        "operation": "generateShoppingList", "startDate": LIST_DAY, "endDate": LIST_DAY,
        "replacingListId": null, "editBase": null,
    }));
    let items = oil_items(&view);
    assert_eq!(items.len(), 1);
    assert!((items[0].0 - (30.0 + 2.0 * 236.588_236_5 / 16.0)).abs() < 1e-9);
    assert_eq!(items[0].1, "ml");
    assert_eq!(view["conversionOffers"], json!([]));
    assert_eq!(provider.with(|s| s.requests.len()), before);
}

#[test]
fn invalid_estimates_and_acceptances_never_change_the_list() {
    let provider = Provider::start();
    let device = Device::with_provider(&provider.issuer);
    let view = oil_list(&device, "ml", 40.0);
    connect(&device, &provider);
    let sent = || provider.with(|s| s.requests.len());
    let before = sent();
    for request in [("   ", "volume"), (&"x".repeat(201), "count")] {
        assert_eq!(
            estimate_conversion(&device, request.0, request.1)
                .unwrap_err()
                .kind,
            ErrorKind::Invalid,
            "{request:?}"
        );
    }
    assert_eq!(sent(), before, "invalid requests reached the provider");
    for reply in [
        json!("About 91 g."),
        json!({"note": "no weight"}),
        json!({"grams": 0}),
        json!({"grams": -4}),
        json!({"grams": 91000}),
        json!({"grams": 91, "density": 0.91}),
    ] {
        provider.with(|s| s.reply = reply.clone());
        let failure = estimate_conversion(&device, "Olive oil", "volume").unwrap_err();
        assert_eq!(failure.kind, ErrorKind::Invalid, "{reply}");
        assert!(
            failure.message.contains("shopping list was not changed"),
            "{}",
            failure.message
        );
    }
    provider.with(|s| s.failure = Some("http".into()));
    assert!(estimate_conversion(&device, "Olive oil", "volume").is_err());
    for grams in [0.0, -1.0, 100_000.0] {
        assert!(accept_conversion(&device, &view, grams).is_err(), "{grams}");
    }
    // Only an ingredient that really needs a conversion can be accepted.
    let other = device.try_op(json!({
        "operation": "acceptIngredientConversion", "listId": view["list"]["id"],
        "conversion": {"name": "Salt", "dimension": "volume", "grams": 90}, "editBase": null,
    }));
    assert_eq!(other.unwrap_err().kind, ErrorKind::Invalid);
    assert_eq!(device.op(json!({"operation": "shoppingList"})), view);
}

#[test]
fn joined_devices_and_browsers_share_estimates_and_synchronize_accepted_conversions() {
    let home = household();
    set_up_on_server(&home, &home.admin);
    home.provider
        .with(|s| s.reply = json!({"grams": 91, "note": "About 0.91 g/ml."}));
    let view = oil_list(&home.admin, "ml", 40.0);
    home.admin.sync();

    // A browser estimates and accepts through the server's core.
    let token = login(&home.server, "admin");
    let operation = |body: Value| {
        api(
            "POST",
            &format!("{}/api/operations", home.server.url),
            Some(&token),
            Some(&body),
        )
    };
    let (code, listed) = operation(json!({"operation": "shoppingList"}));
    assert_eq!(code, 200, "{listed}");
    assert_eq!(listed["conversionOffers"][0]["dimension"], "volume");
    let (code, estimate) = operation(json!({
        "operation": "estimateIngredientConversion", "model": "fixture-recipe",
        "name": "Olive oil", "dimension": "volume",
    }));
    assert_eq!(code, 200, "{estimate}");
    assert_eq!(estimate["grams"], 91.0);
    let (code, accepted) = operation(json!({
        "operation": "acceptIngredientConversion", "listId": view["list"]["id"],
        "conversion": estimate, "editBase": listed["editBase"],
    }));
    assert_eq!(code, 200, "{accepted}");
    assert_eq!(accepted["list"]["items"].as_array().unwrap().len(), 1);

    // The installed app receives the accepted conversion with its uncertainty.
    home.admin.sync();
    let synced = home.admin.op(json!({"operation": "shoppingList"}));
    assert_eq!(synced["list"]["items"], accepted["list"]["items"]);
    assert_eq!(
        synced["list"]["conversions"],
        accepted["list"]["conversions"]
    );
    assert_eq!(synced["list"]["conversions"][0]["source"], "ai");
    assert_eq!(synced["list"]["items"][0]["convertedFrom"][0]["unit"], "ml");
    assert_eq!(synced["conversionOffers"], json!([]));

    // The app's own acceptance synchronizes the other way, too.
    let second = home.admin.op(json!({
        "operation": "generateShoppingList", "startDate": LIST_DAY, "endDate": LIST_DAY,
        "replacingListId": synced["list"]["id"], "editBase": synced["editBase"],
    }));
    assert_eq!(oil_items(&second).len(), 2);
    let applied = accept_conversion(&home.admin, &second, 91.0).unwrap();
    home.admin.sync();
    let (_, seen) = operation(json!({"operation": "shoppingList"}));
    assert_eq!(seen["list"]["items"], applied["list"]["items"]);
    assert_eq!(seen["list"]["conversions"], applied["list"]["conversions"]);
}
