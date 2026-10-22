use crate::error::{Error, ErrorKind, Result};
use rusqlite::{Connection, TransactionBehavior};
use std::{path::Path, time::Duration};

/// Version 1 is the schema the household server created before schema
/// versions existed. Its statements are idempotent, so an existing server
/// database is adopted in place and a new database starts from the same
/// baseline. Never edit a released migration; append a new one.
const MIGRATIONS: &[&str] = &[
    "CREATE TABLE IF NOT EXISTS households (
         singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
         id TEXT NOT NULL UNIQUE,
         name TEXT NOT NULL
     );
     CREATE TABLE IF NOT EXISTS accounts (
         id TEXT PRIMARY KEY,
         household_id TEXT NOT NULL REFERENCES households(id),
         username TEXT NOT NULL UNIQUE,
         password_hash TEXT NOT NULL,
         role TEXT NOT NULL CHECK (role IN ('administrator', 'member')),
         active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1))
     );
     CREATE TABLE IF NOT EXISTS sessions (
         token_hash TEXT PRIMARY KEY,
         account_id TEXT NOT NULL REFERENCES accounts(id),
         expires_at INTEGER NOT NULL
     );
     CREATE TABLE IF NOT EXISTS login_failures (
         username TEXT PRIMARY KEY,
         failures INTEGER NOT NULL,
         last_attempt INTEGER NOT NULL
     );
     CREATE TABLE IF NOT EXISTS shared_recipes (
         id TEXT PRIMARY KEY,
         household_id TEXT NOT NULL REFERENCES households(id),
         current_revision TEXT NOT NULL
     );
     CREATE TABLE IF NOT EXISTS recipe_revisions (
         id TEXT PRIMARY KEY,
         recipe_id TEXT NOT NULL REFERENCES shared_recipes(id),
         parent_id TEXT REFERENCES recipe_revisions(id),
         payload TEXT NOT NULL
     );
     CREATE INDEX IF NOT EXISTS revision_recipe ON recipe_revisions(recipe_id);
     CREATE TABLE IF NOT EXISTS resolved_recipe_revisions (
         revision_id TEXT PRIMARY KEY REFERENCES recipe_revisions(id)
     );
     CREATE TABLE IF NOT EXISTS nutrition_versions (
         id TEXT PRIMARY KEY,
         recipe_id TEXT NOT NULL REFERENCES shared_recipes(id),
         payload TEXT NOT NULL
     );
     CREATE TABLE IF NOT EXISTS recipe_ratings (
         account_id TEXT NOT NULL REFERENCES accounts(id),
         recipe_id TEXT NOT NULL REFERENCES shared_recipes(id),
         value INTEGER CHECK (value BETWEEN 1 AND 5),
         PRIMARY KEY (account_id, recipe_id)
     );
     CREATE TABLE IF NOT EXISTS household_planning (
         household_id TEXT PRIMARY KEY REFERENCES households(id),
         payload TEXT NOT NULL
     );
     CREATE TABLE IF NOT EXISTS planning_versions (
         id TEXT PRIMARY KEY,
         household_id TEXT NOT NULL REFERENCES households(id),
         payload TEXT NOT NULL
     );
     CREATE TABLE IF NOT EXISTS planning_mutations (
         id TEXT PRIMARY KEY,
         household_id TEXT NOT NULL REFERENCES households(id),
         payload TEXT NOT NULL
     );
     CREATE TABLE IF NOT EXISTS planning_generation_aliases (
         household_id TEXT NOT NULL REFERENCES households(id),
         source_id TEXT NOT NULL,
         payload TEXT NOT NULL,
         PRIMARY KEY (household_id, source_id)
     );
     CREATE TABLE IF NOT EXISTS rating_mutations (
         id TEXT PRIMARY KEY,
         account_id TEXT NOT NULL REFERENCES accounts(id),
         payload TEXT NOT NULL
     );",
    // Version 2: people (local or account), personal workflows, sync state.
    // Ratings are rebuilt so a standalone person can own them; every row and
    // identity of version 1 is copied unchanged.
    "CREATE TABLE people (
         id TEXT PRIMARY KEY,
         household_id TEXT NOT NULL REFERENCES households(id),
         kind TEXT NOT NULL CHECK (kind IN ('local', 'account'))
     );
     CREATE UNIQUE INDEX one_local_person ON people(kind) WHERE kind = 'local';
     INSERT INTO people (id, household_id, kind)
         SELECT id, household_id, 'account' FROM accounts;
     CREATE TABLE recipe_ratings_v2 (
         person_id TEXT NOT NULL REFERENCES people(id),
         recipe_id TEXT NOT NULL REFERENCES shared_recipes(id),
         value INTEGER CHECK (value BETWEEN 1 AND 5),
         PRIMARY KEY (person_id, recipe_id)
     );
     INSERT INTO recipe_ratings_v2 (person_id, recipe_id, value)
         SELECT account_id, recipe_id, value FROM recipe_ratings;
     DROP TABLE recipe_ratings;
     ALTER TABLE recipe_ratings_v2 RENAME TO recipe_ratings;
     CREATE TABLE rating_mutations_v2 (
         id TEXT PRIMARY KEY,
         person_id TEXT NOT NULL REFERENCES people(id),
         payload TEXT NOT NULL
     );
     INSERT INTO rating_mutations_v2 (id, person_id, payload)
         SELECT id, account_id, payload FROM rating_mutations;
     DROP TABLE rating_mutations;
     ALTER TABLE rating_mutations_v2 RENAME TO rating_mutations;
     CREATE TABLE cooking_sessions (
         id TEXT PRIMARY KEY,
         person_id TEXT NOT NULL REFERENCES people(id),
         ended INTEGER NOT NULL DEFAULT 0 CHECK (ended IN (0, 1)),
         payload TEXT NOT NULL
     );
     CREATE UNIQUE INDEX one_unfinished_cooking ON cooking_sessions(person_id) WHERE ended = 0;
     CREATE TABLE manual_food_log_entries (
         id TEXT PRIMARY KEY,
         person_id TEXT NOT NULL REFERENCES people(id),
         consumed_on TEXT NOT NULL,
         payload TEXT NOT NULL
     );
     CREATE INDEX manual_food_log_day ON manual_food_log_entries(person_id, consumed_on);
     CREATE TABLE recipe_food_log_entries (
         id TEXT PRIMARY KEY,
         person_id TEXT NOT NULL REFERENCES people(id),
         recipe_id TEXT NOT NULL REFERENCES shared_recipes(id),
         nutrition_version_id TEXT NOT NULL REFERENCES nutrition_versions(id),
         consumed_on TEXT NOT NULL,
         payload TEXT NOT NULL
     );
     CREATE INDEX recipe_food_log_day ON recipe_food_log_entries(person_id, consumed_on);
     CREATE TABLE person_settings (
         person_id TEXT NOT NULL REFERENCES people(id),
         key TEXT NOT NULL,
         value TEXT NOT NULL,
         PRIMARY KEY (person_id, key)
     );
     CREATE TABLE sync_binding (
         singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
         server_url TEXT NOT NULL,
         remote_household_id TEXT NOT NULL
     );
     CREATE TABLE remote_accounts (
         account_id TEXT PRIMARY KEY REFERENCES people(id),
         username TEXT,
         role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('administrator', 'member'))
     );
     CREATE TABLE sync_state (
         singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
         active_account TEXT REFERENCES people(id),
         signed_out INTEGER NOT NULL DEFAULT 0 CHECK (signed_out IN (0, 1)),
         paused INTEGER NOT NULL DEFAULT 0 CHECK (paused IN (0, 1)),
         planning_revision TEXT,
         last_error TEXT,
         last_synced_at INTEGER
     );
     CREATE TABLE sync_outbox (
         seq INTEGER PRIMARY KEY AUTOINCREMENT,
         id TEXT NOT NULL UNIQUE,
         person_id TEXT NOT NULL,
         household_id TEXT NOT NULL,
         kind TEXT NOT NULL,
         payload TEXT NOT NULL
     );
     CREATE TABLE legacy_imports (
         id TEXT PRIMARY KEY,
         applied_at INTEGER NOT NULL
     );
     ALTER TABLE shared_recipes ADD COLUMN held_back INTEGER NOT NULL DEFAULT 0 CHECK (held_back IN (0, 1));",
    // Version 3: household cooking occurrences. A guided session yields at
    // most one occurrence, so retrying its completion cannot count twice.
    "CREATE TABLE cooking_occurrences (
         id TEXT PRIMARY KEY,
         household_id TEXT NOT NULL REFERENCES households(id),
         recipe_id TEXT NOT NULL REFERENCES shared_recipes(id),
         person_id TEXT NOT NULL REFERENCES people(id),
         session_id TEXT UNIQUE,
         cooked_at INTEGER NOT NULL
     );
     CREATE INDEX cooking_occurrence_recipe ON cooking_occurrences(household_id, recipe_id);",
    // Version 4: the browser-profile import is gone, and with it the record of
    // which transfers had been applied.
    "DROP TABLE legacy_imports;",
    // Version 5: the confirmed fingerprint of a household server's own
    // (not publicly trusted) certificate.
    "ALTER TABLE sync_binding ADD COLUMN server_certificate TEXT;",
    // Version 6: cooking sessions synchronize between a person's devices.
    // Sessions started on two devices while apart both stay until the person
    // decides, so one unfinished session per person is no longer a storage
    // rule; starting cooking still asks about every unfinished one. Applied
    // session changes are remembered so a redelivery changes nothing.
    "DROP INDEX one_unfinished_cooking;
     CREATE TABLE cooking_session_mutations (
         id TEXT PRIMARY KEY,
         person_id TEXT NOT NULL REFERENCES people(id)
     );",
    // Version 7: a person's dated nutrition goals. One set per effective
    // date; earlier sets are kept so past days keep their targets.
    "CREATE TABLE nutrition_goals (
         person_id TEXT NOT NULL REFERENCES people(id),
         effective_from TEXT NOT NULL,
         payload TEXT NOT NULL,
         PRIMARY KEY (person_id, effective_from)
     );",
];

pub const SCHEMA_VERSION: i64 = MIGRATIONS.len() as i64;

pub(crate) fn connect(path: &Path) -> Result<Connection> {
    let connection = Connection::open(path)?;
    connection.busy_timeout(Duration::from_secs(5))?;
    connection.pragma_update(None, "foreign_keys", true)?;
    Ok(connection)
}

/// Brings a database to [`SCHEMA_VERSION`]. Each step is one transaction that
/// also records its version, so an interrupted or failing upgrade leaves the
/// previous version intact. A database from a newer Forkcast is refused
/// without any change; there is no reset path.
pub(crate) fn migrate(path: &Path) -> Result<()> {
    let mut connection = connect(path)?;
    let version = user_version(&connection)?;
    if version > SCHEMA_VERSION {
        return Err(unsupported(version));
    }
    if version == SCHEMA_VERSION {
        return Ok(());
    }
    let _: String = connection.query_row("PRAGMA journal_mode = WAL", [], |row| row.get(0))?;
    for (index, sql) in MIGRATIONS.iter().enumerate() {
        let target = index as i64 + 1;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let current = user_version(&transaction)?;
        if current > SCHEMA_VERSION {
            return Err(unsupported(current));
        }
        if current >= target {
            continue;
        }
        transaction
            .execute_batch(sql)
            .map_err(|error| upgrade_failed(target, error))?;
        let violations = transaction
            .prepare("PRAGMA foreign_key_check")?
            .query_map([], |_| Ok(()))?
            .count();
        if violations > 0 {
            eprintln!("Upgrade to schema {target} found {violations} inconsistent records.");
            return Err(upgrade_failed(target, rusqlite::Error::InvalidQuery));
        }
        transaction.pragma_update(None, "user_version", target)?;
        transaction.commit()?;
    }
    Ok(())
}

fn user_version(connection: &Connection) -> Result<i64> {
    Ok(connection.pragma_query_value(None, "user_version", |row| row.get(0))?)
}

fn unsupported(version: i64) -> Error {
    Error::new(
        ErrorKind::Unsupported,
        format!(
            "This database uses schema version {version}, which this version of Forkcast (schema {SCHEMA_VERSION}) cannot open. Update Forkcast; the database has not been changed."
        ),
    )
}

fn upgrade_failed(version: i64, error: rusqlite::Error) -> Error {
    eprintln!("Database upgrade to schema {version} failed: {error}");
    Error::new(
        ErrorKind::Unsupported,
        format!(
            "The database could not be upgraded to schema {version}. It has been left at its previous version with all data intact."
        ),
    )
}
