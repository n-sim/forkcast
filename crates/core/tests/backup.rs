//! The server administration boundary for backup and recovery: what it
//! refuses, what it protects, and that it never touches secrets.

mod common;

use common::TempDatabase;
use forkcast_core::{
    Config, Core, ErrorKind, MemorySecrets, SCHEMA_VERSION, Secrets, SetupServer, backup_database,
    restore_database,
};
use rusqlite::Connection;
use std::sync::Arc;

fn setup(core: &Core) {
    core.setup_server(SetupServer {
        household_name: "Home".into(),
        username: "admin".into(),
        password: "correct horse battery".into(),
    })
    .unwrap();
}

fn server() -> (TempDatabase, Core) {
    let database = TempDatabase::new();
    let core = database.open();
    setup(&core);
    (database, core)
}

fn user_version(path: &std::path::Path) -> i64 {
    Connection::open(path)
        .unwrap()
        .pragma_query_value(None, "user_version", |row| row.get(0))
        .unwrap()
}

fn can_sign_in(database: &TempDatabase) -> bool {
    database
        .open()
        .sign_in(forkcast_core::Credentials {
            username: "admin".into(),
            password: "correct horse battery".into(),
        })
        .is_ok()
}

#[test]
fn a_backup_is_a_verified_copy_made_beside_a_running_server_and_never_overwritten() {
    let (database, _core) = server();
    let backup = TempDatabase::new();
    let report = backup_database(database.path(), backup.path()).unwrap();
    assert_eq!((report.accounts, report.recipes), (1, 0));
    assert_eq!(report.schema_version, SCHEMA_VERSION);
    assert_eq!(user_version(backup.path()), SCHEMA_VERSION);

    let error = backup_database(database.path(), backup.path()).unwrap_err();
    assert_eq!(error.kind, ErrorKind::Conflict);

    let missing = TempDatabase::new();
    let error = backup_database(missing.path(), TempDatabase::new().path()).unwrap_err();
    assert_eq!(error.kind, ErrorKind::NotFound);
    assert!(
        !missing.path().exists(),
        "a backup never creates a database"
    );
}

#[test]
fn only_a_household_server_is_backed_up() {
    let database = TempDatabase::new();
    database.open().standalone().unwrap();
    let error = backup_database(database.path(), TempDatabase::new().path()).unwrap_err();
    assert_eq!(error.kind, ErrorKind::Invalid);
}

#[test]
fn recovery_replaces_existing_data_only_on_request_and_keeps_it_aside() {
    let (original, _core) = server();
    let backup = TempDatabase::new();
    backup_database(original.path(), backup.path()).unwrap();

    // Another instance with its own account.
    let (other, other_core) = server();
    other_core
        .create_account(
            &other_core
                .sign_in(forkcast_core::Credentials {
                    username: "admin".into(),
                    password: "correct horse battery".into(),
                })
                .map(|signed| other_core.authenticate(&signed.token).unwrap().principal)
                .unwrap(),
            forkcast_core::Credentials {
                username: "extra".into(),
                password: "another long passphrase".into(),
            },
        )
        .unwrap();
    drop(other_core);

    let error = restore_database(backup.path(), other.path(), false, 7).unwrap_err();
    assert_eq!(error.kind, ErrorKind::Conflict);
    assert_eq!(
        Core::open(Config::new(other.path()))
            .unwrap()
            .server_status()
            .map(|status| status.setup_required)
            .ok(),
        Some(false)
    );

    let report = restore_database(backup.path(), other.path(), true, 7).unwrap();
    assert_eq!(report.backup.accounts, 1);
    let kept = report.previous.expect("previous data is kept");
    assert!(kept.is_file());
    assert_eq!(user_version(&kept), SCHEMA_VERSION);
    // The recovered database is the backup's: one account, and it works.
    assert!(can_sign_in(&other));
    let accounts: i64 = Connection::open(other.path())
        .unwrap()
        .query_row("SELECT COUNT(*) FROM accounts", [], |row| row.get(0))
        .unwrap();
    assert_eq!(accounts, 1);
    let _ = std::fs::remove_file(kept);
}

#[test]
fn a_recovery_onto_a_fresh_path_needs_no_replace() {
    let (original, _core) = server();
    let backup = TempDatabase::new();
    backup_database(original.path(), backup.path()).unwrap();
    let fresh = TempDatabase::new();
    let report = restore_database(backup.path(), fresh.path(), false, 1).unwrap();
    assert!(report.previous.is_none());
    assert!(can_sign_in(&fresh));
    assert!(backup.path().is_file(), "the backup stays as it was");
}

#[test]
fn a_bad_backup_changes_nothing() {
    let (target, _core) = server();
    let before = std::fs::read(target.path()).unwrap();

    let garbage = TempDatabase::new();
    std::fs::write(garbage.path(), b"this is not a database at all").unwrap();
    let error = restore_database(garbage.path(), target.path(), true, 1).unwrap_err();
    assert_eq!(error.kind, ErrorKind::Invalid);

    let nothing = TempDatabase::new();
    let error = restore_database(nothing.path(), target.path(), true, 1).unwrap_err();
    assert!(matches!(
        error.kind,
        ErrorKind::Invalid | ErrorKind::Unavailable
    ));

    // A database that belongs to some other application.
    let foreign = TempDatabase::new();
    Connection::open(foreign.path())
        .unwrap()
        .execute_batch("CREATE TABLE notes (text TEXT); PRAGMA user_version = 3;")
        .unwrap();
    let error = restore_database(foreign.path(), target.path(), true, 1).unwrap_err();
    assert_eq!(error.kind, ErrorKind::Invalid);

    // A standalone installation's data.
    let standalone = TempDatabase::new();
    standalone.open().standalone().unwrap();
    let error = restore_database(standalone.path(), target.path(), true, 1).unwrap_err();
    assert_eq!(error.kind, ErrorKind::Invalid);

    // A backup from a newer release.
    let newer = TempDatabase::new();
    backup_database(target.path(), newer.path()).unwrap();
    Connection::open(newer.path())
        .unwrap()
        .pragma_update(None, "user_version", SCHEMA_VERSION + 1)
        .unwrap();
    let error = restore_database(newer.path(), target.path(), true, 1).unwrap_err();
    assert_eq!(error.kind, ErrorKind::Unsupported);

    assert_eq!(std::fs::read(target.path()).unwrap(), before);
    assert!(can_sign_in(&target));
}

#[test]
fn an_older_release_backup_is_upgraded_during_recovery() {
    let legacy = TempDatabase::new();
    {
        let db = Connection::open(legacy.path()).unwrap();
        db.execute_batch(include_str!("legacy-schema.sql")).unwrap();
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
    }
    assert_eq!(user_version(legacy.path()), 0);
    let target = TempDatabase::new();
    let report = restore_database(legacy.path(), target.path(), false, 1).unwrap();
    assert_eq!(report.backup.accounts, 1);
    assert_eq!(user_version(target.path()), SCHEMA_VERSION);
    let people: i64 = Connection::open(target.path())
        .unwrap()
        .query_row("SELECT COUNT(*) FROM people", [], |row| row.get(0))
        .unwrap();
    assert_eq!(people, 1, "accounts keep their identities as people");
}

#[test]
fn protected_runtime_secrets_never_enter_a_backup() {
    let database = TempDatabase::new();
    let secrets = Arc::new(MemorySecrets::default());
    secrets
        .set("session:account-1", "chatgpt-refresh-token-value")
        .unwrap();
    let mut config = Config::new(database.path());
    config.secrets = secrets;
    let core = Core::open(config).unwrap();
    setup(&core);
    let backup = TempDatabase::new();
    backup_database(database.path(), backup.path()).unwrap();
    let bytes = String::from_utf8_lossy(&std::fs::read(backup.path()).unwrap()).to_string();
    assert!(!bytes.contains("chatgpt-refresh-token-value"));
    assert!(
        !bytes.contains("correct horse battery"),
        "no plaintext passwords"
    );
}
