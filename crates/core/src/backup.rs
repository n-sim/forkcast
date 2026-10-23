//! Server-side backup and recovery of the household server's application
//! data: accounts, shared recipes with their cover photos, retained
//! nutrition versions, planning, conflicts, personal records, and the
//! revision history that returning installed apps reconcile against.
//!
//! Everything durable lives in the one SQLite database, so one consistent
//! snapshot of it is the whole backup and later record types need no
//! separate export. Runtime secrets (ChatGPT sessions, host identity) live
//! in protected storage beside the database and are never part of a backup.
//! These are administration operations of the server host; no application
//! operation or frontend reaches them.

use crate::{
    db::{self, SCHEMA_VERSION},
    error::{Error, ErrorKind, Result},
};
use rusqlite::{Connection, OpenFlags};
use std::path::{Path, PathBuf};

/// What a backup or recovery found in the data it handled.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BackupReport {
    pub schema_version: i64,
    pub accounts: usize,
    pub recipes: usize,
}

/// What a recovery did.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RestoreReport {
    pub backup: BackupReport,
    /// Where the data this recovery replaced was kept, if there was any.
    pub previous: Option<PathBuf>,
}

fn io(context: &str, error: std::io::Error) -> Error {
    eprintln!("{context}: {error}");
    Error::new(ErrorKind::Unavailable, format!("{context}."))
}

fn sibling(path: &Path, suffix: &str) -> PathBuf {
    let mut name = path.as_os_str().to_owned();
    name.push(suffix);
    PathBuf::from(name)
}

/// SQLite's companion files for `database`.
fn companions(database: &Path) -> [PathBuf; 2] {
    [sibling(database, "-wal"), sibling(database, "-shm")]
}

fn remove_files(path: &Path) {
    let _ = std::fs::remove_file(path);
    for companion in companions(path) {
        let _ = std::fs::remove_file(companion);
    }
}

/// Checks that `path` is an intact backup of a household server and counts
/// what it holds. The file is opened read-only and never modified.
fn inspect(path: &Path) -> Result<BackupReport> {
    let not_a_backup = || {
        Error::invalid(format!(
            "{} is not a Forkcast server backup. Nothing was changed.",
            path.display()
        ))
    };
    let connection = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|_| not_a_backup())?;
    let version: i64 = connection
        .pragma_query_value(None, "user_version", |row| row.get(0))
        .map_err(|_| not_a_backup())?;
    // Databases copied from before schema versions existed carry version 0;
    // they are recognizable by the household server tables they were made of.
    let legacy_server = version == 0
        && ["accounts", "shared_recipes"].iter().all(|table| {
            connection
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?)",
                    [table],
                    |row| row.get::<_, bool>(0),
                )
                .unwrap_or(false)
        });
    if version == 0 && !legacy_server {
        return Err(not_a_backup());
    }
    if version > SCHEMA_VERSION {
        return Err(Error::new(
            ErrorKind::Unsupported,
            format!(
                "This backup uses schema version {version}, which this version of Forkcast (schema {SCHEMA_VERSION}) cannot read. Update Forkcast first; nothing was changed."
            ),
        ));
    }
    let intact: String = connection
        .query_row("PRAGMA integrity_check", [], |row| row.get(0))
        .map_err(|_| not_a_backup())?;
    if intact != "ok" {
        return Err(Error::invalid(format!(
            "{} is damaged and cannot be used. Nothing was changed.",
            path.display()
        )));
    }
    let count = |sql: &str| -> Result<usize> {
        connection
            .query_row(sql, [], |row| row.get::<_, i64>(0))
            .map(|count| count as usize)
            .map_err(|_| not_a_backup())
    };
    if version >= 2 && count("SELECT COUNT(*) FROM people WHERE kind = 'local'")? > 0 {
        return Err(Error::invalid(
            "This is a standalone installation's data, not a household server's. Only household servers are backed up and recovered.",
        ));
    }
    Ok(BackupReport {
        schema_version: version,
        accounts: count("SELECT COUNT(*) FROM accounts")?,
        recipes: count("SELECT COUNT(*) FROM shared_recipes")?,
    })
}

/// Writes a consistent snapshot of the server database at `database` to the
/// new file `destination`, while the server keeps running. The snapshot is
/// verified before it appears under its final name, so a failed backup never
/// leaves something that looks usable. An existing file is never overwritten.
pub fn backup_database(database: &Path, destination: &Path) -> Result<BackupReport> {
    if !database.is_file() {
        return Err(Error::not_found(format!(
            "There is no database at {}. Nothing was backed up.",
            database.display()
        )));
    }
    if destination.exists() {
        return Err(Error::conflict(format!(
            "{} already exists. Choose a new file name; backups are never overwritten.",
            destination.display()
        )));
    }
    if let Some(directory) = destination.parent().filter(|d| !d.as_os_str().is_empty()) {
        std::fs::create_dir_all(directory).map_err(|e| io("Cannot create the backup folder", e))?;
    }
    let partial = sibling(destination, ".partial");
    remove_files(&partial);
    let snapshot = (|| {
        let connection = db::connect(database)?;
        connection.execute("VACUUM INTO ?", [partial.to_string_lossy().as_ref()])?;
        drop(connection);
        let report = inspect(&partial)?;
        std::fs::OpenOptions::new()
            .write(true)
            .open(&partial)
            .and_then(|file| file.sync_all())
            .map_err(|e| io("Cannot write the backup", e))?;
        Ok(report)
    })();
    match snapshot {
        Ok(report) => {
            std::fs::rename(&partial, destination)
                .map_err(|e| io("Cannot finish writing the backup", e))?;
            Ok(report)
        }
        Err(error) => {
            remove_files(&partial);
            Err(error)
        }
    }
}

/// Recovers `backup` as the server database at `database`. The server must
/// not be running. The backup is verified and upgraded to this release's
/// schema in a staging copy first, so a bad backup changes nothing. When a
/// database already exists it is replaced only with `replace`, and is kept
/// beside the new one so the recovery can itself be undone.
pub fn restore_database(
    backup: &Path,
    database: &Path,
    replace: bool,
    stamp: i64,
) -> Result<RestoreReport> {
    let existing = database.exists();
    if existing && !replace {
        return Err(Error::conflict(format!(
            "A database already exists at {}. Recovery would replace it; run it again with --replace to keep the current database aside and recover the backup.",
            database.display()
        )));
    }
    if let Some(directory) = database.parent().filter(|d| !d.as_os_str().is_empty()) {
        std::fs::create_dir_all(directory).map_err(|e| io("Cannot create the data folder", e))?;
    }
    let staging = sibling(database, ".restoring");
    remove_files(&staging);
    // Work on a copy so the backup itself is never opened for writing, and
    // so it may sit on a read-only volume.
    let staged = std::fs::copy(backup, &staging)
        .map_err(|e| io("Cannot read the backup", e))
        .and_then(|_| inspect(&staging))
        .and_then(|report| {
            db::migrate(&staging)?;
            // The server runs in WAL mode; fold the journal into the one file
            // that moves into place.
            let connection = db::connect(&staging)?;
            let _: String =
                connection.query_row("PRAGMA journal_mode = WAL", [], |row| row.get(0))?;
            connection.query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |_| Ok(()))?;
            Ok(report)
        });
    let report = match staged {
        Ok(report) => report,
        Err(error) => {
            remove_files(&staging);
            return Err(error);
        }
    };
    let previous = if existing {
        let kept = sibling(database, &format!(".before-restore-{stamp}"));
        std::fs::rename(database, &kept).map_err(|e| {
            remove_files(&staging);
            io("Cannot set the current database aside", e)
        })?;
        for (from, to) in companions(database).into_iter().zip(companions(&kept)) {
            let _ = std::fs::rename(from, to);
        }
        Some(kept)
    } else {
        for companion in companions(database) {
            let _ = std::fs::remove_file(companion);
        }
        None
    };
    std::fs::rename(&staging, database)
        .map_err(|e| io("Cannot put the recovered data in place", e))?;
    Ok(RestoreReport {
        backup: report,
        previous,
    })
}
