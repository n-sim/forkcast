use crate::ApiError;
use rusqlite::Connection;
use std::{path::PathBuf, time::Duration};

#[derive(Clone)]
pub struct Store {
    path: PathBuf,
}

impl Store {
    pub fn open(path: PathBuf) -> Result<Self, ApiError> {
        let store = Self { path };
        store.connect()?.execute_batch(
            "PRAGMA journal_mode = WAL;
             CREATE TABLE IF NOT EXISTS households (
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
             CREATE TABLE IF NOT EXISTS rating_mutations (
                 id TEXT PRIMARY KEY,
                 account_id TEXT NOT NULL REFERENCES accounts(id),
                 payload TEXT NOT NULL
             );",
        )?;
        Ok(store)
    }

    fn connect(&self) -> Result<Connection, ApiError> {
        let connection = Connection::open(&self.path)?;
        connection.busy_timeout(Duration::from_secs(5))?;
        connection.pragma_update(None, "foreign_keys", true)?;
        Ok(connection)
    }

    // SQLite and password hashing run off the async HTTP executor.
    pub async fn run<T: Send + 'static>(
        &self,
        operation: impl FnOnce(&mut Connection) -> Result<T, ApiError> + Send + 'static,
    ) -> Result<T, ApiError> {
        let store = self.clone();
        tokio::task::spawn_blocking(move || operation(&mut store.connect()?))
            .await
            .map_err(|error| {
                eprintln!("Backend worker failed: {error}");
                ApiError::internal()
            })?
    }
}
