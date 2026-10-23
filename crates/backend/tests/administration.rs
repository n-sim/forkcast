//! The documented administration workflow, run through the real
//! `forkcast-backend` program the way an administrator runs it.

mod harness;

use forkcast_core::{Config, Core, Credentials, SetupServer};
use harness::{remove, temp};
use std::{path::Path, process::Command};

fn run(database: &Path, arguments: &[&str]) -> std::process::Output {
    Command::new(env!("CARGO_BIN_EXE_forkcast-backend"))
        .env("FORKCAST_DATABASE", database)
        .args(arguments)
        .output()
        .unwrap()
}

fn text(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).to_string()
}

#[test]
fn an_administrator_backs_up_and_recovers_a_server_with_the_program_itself() {
    let database = temp("administration");
    let backup = temp("administration-backup");
    let recovered = temp("administration-recovered");
    Core::open(Config::new(&database))
        .unwrap()
        .setup_server(SetupServer {
            household_name: "Home".into(),
            username: "admin".into(),
            password: "correct horse battery".into(),
        })
        .unwrap();

    let made = run(&database, &["backup", backup.to_str().unwrap()]);
    assert!(made.status.success(), "{}", text(&made.stderr));
    assert!(text(&made.stdout).contains("1 accounts"));
    let again = run(&database, &["backup", backup.to_str().unwrap()]);
    assert!(!again.status.success(), "a backup is never overwritten");

    let blocked = run(&database, &["restore", backup.to_str().unwrap()]);
    assert!(!blocked.status.success(), "existing data needs --replace");
    assert!(text(&blocked.stderr).contains("--replace"));

    let restored = run(&recovered, &["restore", backup.to_str().unwrap()]);
    assert!(restored.status.success(), "{}", text(&restored.stderr));
    Core::open(Config::new(&recovered))
        .unwrap()
        .sign_in(Credentials {
            username: "admin".into(),
            password: "correct horse battery".into(),
        })
        .unwrap();

    let unknown = run(&database, &["frobnicate"]);
    assert!(!unknown.status.success());
    assert!(text(&unknown.stderr).contains("Usage"));
    for path in [&database, &backup, &recovered] {
        remove(path);
    }
}
