//! A household server that serves HTTPS itself with a self-signed
//! certificate, and installed cores that accept it only once its fingerprint
//! has been confirmed.

mod harness;

use forkcast_core::ErrorKind;
use harness::{Device, Server, plan, save_recipe};
use serde_json::json;

#[test]
fn an_unconfirmed_certificate_is_shown_and_nothing_is_stored_or_sent() {
    let server = Server::with_own_certificate();
    let device = Device::new();

    let probe = device.core.connect_server(&server.url, None).unwrap();
    assert_eq!(probe.untrusted_certificate, server.certificate);
    assert_eq!(probe.untrusted_certificate.as_ref().unwrap().len(), 95);
    assert!(device.status().pending_join.is_none());
    // Without a stored connection there is nothing to sign in to.
    let error = device
        .core
        .authenticate_server(true, "admin", "correct horse battery", Some("Home"))
        .err()
        .unwrap();
    assert_eq!(error.kind, ErrorKind::Conflict);
    // The server is still waiting for its first administrator.
    let confirmed = device
        .core
        .connect_server(&server.url, server.certificate.as_deref())
        .unwrap();
    assert!(confirmed.setup_required);
}

#[test]
fn a_confirmed_certificate_carries_joining_and_synchronization() {
    let mut server = Server::with_own_certificate();
    let fingerprint = server.certificate.clone().unwrap();
    let admin = Device::new();
    save_recipe(&admin, "soup", "Soup");
    plan(&admin, "monday", "soup", "2030-05-06", 4.0);

    // The fingerprint is accepted however it was copied.
    let typed = fingerprint.replace(':', "").to_lowercase();
    let probe = admin
        .core
        .connect_server(&server.url, Some(&typed))
        .unwrap();
    assert!(probe.setup_required && probe.untrusted_certificate.is_none());
    let pending = admin.status().pending_join.unwrap();
    assert_eq!(pending.certificate.as_deref(), Some(fingerprint.as_str()));
    admin
        .core
        .authenticate_server(true, "admin", "correct horse battery", Some("Home"))
        .unwrap();
    let status = admin.join_with(harness::everything(&admin.core));
    assert!(status.bound && status.signed_in);
    assert_eq!(status.pending, 0, "{:?}", status.last_error);
    assert_eq!(
        status.server_certificate.as_deref(),
        Some(fingerprint.as_str())
    );

    admin.op(json!({
        "operation": "createAccount", "username": "sam", "password": "another long passphrase"
    }));
    let member = Device::new();
    member.join_as(&server, "sam", "another long passphrase");
    assert_eq!(member.recipe_names(), ["Soup"]);

    // The certificate lives beside the database and survives a restart.
    server.restart();
    assert_eq!(server.certificate.as_deref(), Some(fingerprint.as_str()));
    save_recipe(&admin, "stew", "Stew");
    let status = admin.sync();
    assert_eq!(status.pending, 0, "{:?}", status.last_error);
    member.sync();
    assert_eq!(member.recipe_names(), ["Soup", "Stew"]);
}

#[test]
fn a_different_certificate_is_refused_before_anything_is_sent() {
    let mut server = Server::with_own_certificate();
    let device = Device::new();
    let wrong = "AB".repeat(32);
    let error = device
        .core
        .connect_server(&server.url, Some(&wrong))
        .err()
        .unwrap();
    assert_eq!(error.kind, ErrorKind::Unavailable);
    assert!(
        error.message.contains("different certificate"),
        "{}",
        error.message
    );
    assert!(device.status().pending_join.is_none());

    // A replaced certificate stops synchronization; local changes stay queued.
    save_recipe(&device, "soup", "Soup");
    device.found_household(&server);
    let confirmed = device.status().server_certificate;
    let files = server.certificate_files();
    std::fs::remove_file(files.certificate).unwrap();
    std::fs::remove_file(files.key).unwrap();
    server.restart();
    assert_ne!(server.certificate, confirmed);
    save_recipe(&device, "stew", "Stew");
    let status = device.sync();
    assert_eq!(status.pending, 1);
    assert!(
        status
            .last_error
            .as_deref()
            .is_some_and(|error| error.contains("different certificate")),
        "{:?}",
        status.last_error
    );

    // Settings shows both fingerprints; confirming the new one resumes.
    let check = device.core.check_server_certificate().unwrap();
    assert_eq!(check.confirmed, confirmed);
    assert_eq!(check.presented, server.certificate);
    assert!(!check.trusted);
    let error = device
        .core
        .trust_server_certificate(confirmed.as_deref().unwrap())
        .err()
        .unwrap();
    assert_eq!(error.kind, ErrorKind::Conflict);
    let status = device
        .core
        .trust_server_certificate(server.certificate.as_deref().unwrap())
        .unwrap();
    assert_eq!(status.server_certificate, server.certificate);
    let status = device.sync();
    assert_eq!(status.pending, 0, "{:?}", status.last_error);
    assert!(status.last_error.is_none());
}

#[test]
fn a_malformed_fingerprint_is_invalid() {
    let server = Server::with_own_certificate();
    let device = Device::new();
    let error = device
        .core
        .connect_server(&server.url, Some("not a fingerprint"))
        .err()
        .unwrap();
    assert_eq!(error.kind, ErrorKind::Invalid);
}
