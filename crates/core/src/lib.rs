//! The Forkcast application core: workflows, validation, transaction
//! ordering, SQLite persistence and migrations, and pending synchronization
//! state. Installed apps and the household server host this same crate; it
//! knows nothing about HTTP, windows, or process startup.
//!
//! Hosts supply a database path and a [`Principal`]. See
//! `docs/core-interface.md` for the operation, error, principal, and
//! change-notification contracts.

mod accounts;
mod changes;
mod cooking;
mod db;
mod error;
mod food_log;
mod operation;
mod planning;
mod preferences;
mod principal;
mod recipes;
mod remote;
mod secrets;
mod session;
mod sync;
mod transfer;

pub use accounts::{
    Account, AccountChange, Authenticated, Credentials, Household, Role, ServerStatus, Session,
    SetupServer, SignedIn,
};
pub use changes::{Change, Scope, Subscription, Topic};
pub use cooking::{BeginCooking, CookingOutcome, StartCooking};
pub use db::SCHEMA_VERSION;
pub use error::{Error, ErrorKind, Result};
pub use food_log::{LogManualFood, LogRecipeFood};
pub use operation::Operation;
pub use planning::{
    EditBase, MealPlanView, PlanningChoice, PlanningMutation, ShoppingItemKind, ShoppingListView,
    SourceStatus,
};
pub use preferences::AiPreferences;
pub use principal::{Principal, Standing};
pub use recipes::{
    Collection, CurrentChoice, Photo, Rating, RatingChange, RecipeView, Revision, SaveRecipe,
    SavedRecipe, SetCoverPhoto,
};
pub use remote::PROTOCOL_VERSION;
pub use secrets::{MemorySecrets, Secrets};
pub use session::{
    AccountInfo, JoinReview, JoinSelection, PendingJoin, ServerAuthentication, ServerProbe,
};
pub use sync::{PendingChange, SyncStatus};
pub use transfer::ImportReport;

use changes::{Effects, Hub};
use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
use std::{
    path::PathBuf,
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};
use uuid::Uuid;

/// Milliseconds since the Unix epoch. Hosts and tests may substitute it.
pub type Clock = Arc<dyn Fn() -> i64 + Send + Sync>;

pub struct Config {
    pub database: PathBuf,
    pub clock: Clock,
    /// Protected storage for remote session tokens. Defaults to memory.
    pub secrets: Arc<dyn Secrets>,
}

impl Config {
    pub fn new(database: impl Into<PathBuf>) -> Self {
        Self {
            database: database.into(),
            secrets: Arc::new(MemorySecrets::default()),
            clock: Arc::new(|| {
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .expect("system clock before Unix epoch")
                    .as_millis() as i64
            }),
        }
    }
}

pub(crate) struct Inner {
    database: PathBuf,
    clock: Clock,
    hub: Hub,
    pub(crate) secrets: Arc<dyn Secrets>,
    pub(crate) sync: sync::SyncControl,
}

/// Cheap to clone and safe to share between threads. Every operation opens
/// its own SQLite connection, so the core holds no storage handle that a
/// host or frontend could reach.
#[derive(Clone)]
pub struct Core {
    pub(crate) inner: Arc<Inner>,
}

impl Core {
    /// Opens the database, upgrading it through the shared migrations. A
    /// database that cannot be upgraded fails with
    /// [`ErrorKind::Unsupported`] and is left untouched.
    pub fn open(config: Config) -> Result<Self> {
        db::migrate(&config.database)?;
        Ok(Self {
            inner: Arc::new(Inner {
                database: config.database,
                clock: config.clock,
                secrets: config.secrets,
                hub: Hub::default(),
                sync: sync::SyncControl::default(),
            }),
        })
    }

    /// The persistent local person of a standalone installation, created on
    /// first use without a password or any network call.
    pub fn standalone(&self) -> Result<Principal> {
        self.write(|db, _| {
            let existing = db
                .query_row(
                    "SELECT id, household_id FROM people WHERE kind = 'local'",
                    [],
                    |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
                )
                .optional()?;
            if let Some((person, household)) = existing {
                return Ok(Principal::new(person, household, Standing::Local));
            }
            if db.query_row("SELECT EXISTS(SELECT 1 FROM households)", [], |row| {
                row.get::<_, bool>(0)
            })? {
                return Err(Error::conflict(
                    "This database belongs to a household server and cannot be used as a standalone profile.",
                ));
            }
            let household = Uuid::new_v4().to_string();
            let person = Uuid::new_v4().to_string();
            db.execute(
                "INSERT INTO households (singleton, id, name) VALUES (1, ?, 'My household')",
                [&household],
            )?;
            db.execute(
                "INSERT INTO people (id, household_id, kind) VALUES (?, ?, 'local')",
                params![person, household],
            )?;
            Ok(Principal::new(person, household, Standing::Local))
        })
    }

    /// Every change on this device, for the embedded host that relays them to
    /// its frontend. The frontend only ever shows what its own principal may see.
    pub fn subscribe_all(&self) -> Subscription {
        self.inner.hub.subscribe_all()
    }

    /// Changes visible to `principal`, delivered after they commit.
    pub fn subscribe(&self, principal: &Principal) -> Subscription {
        self.inner.hub.subscribe(principal)
    }

    pub(crate) fn now(&self) -> i64 {
        (self.inner.clock)()
    }

    fn connect(&self) -> Result<Connection> {
        db::connect(&self.inner.database)
    }

    /// One consistent snapshot.
    pub(crate) fn read<T>(&self, f: impl FnOnce(&Connection) -> Result<T>) -> Result<T> {
        let mut connection = self.connect()?;
        let transaction = connection.transaction()?;
        f(&transaction)
    }

    /// One serialized transaction. Anything the closure fails with rolls the
    /// whole operation back, including pending synchronization records;
    /// change notifications are published only after the commit.
    pub(crate) fn write<T>(
        &self,
        f: impl FnOnce(&Connection, &mut Effects) -> Result<T>,
    ) -> Result<T> {
        let mut connection = self.connect()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let mut effects = Effects::default();
        let value = f(&transaction, &mut effects)?;
        transaction.commit()?;
        self.inner.hub.publish(effects.changes);
        if effects.queued {
            self.nudge_sync();
        }
        Ok(value)
    }
}
