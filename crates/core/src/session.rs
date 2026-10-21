//! An embedded profile's relationship with a household server: connecting,
//! reviewing what joining would publish or replace, signing in and out, and
//! which person the app acts as.
//!
//! Joining is explicit. Nothing is published, replaced, or re-owned until
//! `complete_join`, and cancelling leaves both sides unchanged.

use crate::{
    Core,
    changes::Topic,
    error::{Error, ErrorKind, Result},
    planning,
    principal::{Principal, Standing},
    recipes,
    remote::{Remote, server_url},
    sync::{self, session_key},
};
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::HashSet;
use uuid::Uuid;

const PENDING_JOIN: &str = "pending-join";

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountInfo {
    pub id: String,
    pub username: String,
    pub role: String,
}

#[derive(Clone, Deserialize, Serialize)]
pub struct HouseholdInfo {
    pub id: String,
    pub name: String,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct StoredJoin {
    server_url: String,
    setup_required: bool,
    token: Option<String>,
    account: Option<AccountInfo>,
    household: Option<HouseholdInfo>,
}

/// A connection that has not joined anything yet. Holds no token.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingJoin {
    pub server_url: String,
    pub setup_required: bool,
    pub account: Option<AccountInfo>,
    pub household: Option<HouseholdInfo>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerProbe {
    pub server_url: String,
    pub setup_required: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerAuthentication {
    pub account: AccountInfo,
    pub household: HouseholdInfo,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ReviewRecipe {
    id: String,
    name: String,
    /// The household already has a recipe with this id. Contributing keeps
    /// both versions as alternatives; neither overwrites the other.
    collides: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ReviewCooking {
    id: String,
    recipe_id: String,
    recipe_name: String,
    cooking_date: String,
    cooking_time: Option<String>,
    portions: f64,
    likely_duplicate: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ListSummary {
    id: String,
    start_date: String,
    end_date: String,
    items: usize,
    manual_items: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PersonalSummary {
    ratings: usize,
    food_log_entries: usize,
    cooking_sessions: usize,
}

/// What joining would publish and what it would replace.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JoinReview {
    server_url: String,
    account: AccountInfo,
    household: HouseholdInfo,
    recipes: Vec<ReviewRecipe>,
    household_recipes: usize,
    cookings: Vec<ReviewCooking>,
    household_cookings: usize,
    device_shopping_list: Option<ListSummary>,
    household_shopping_list: Option<ListSummary>,
    personal: PersonalSummary,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct JoinSelection {
    /// Local recipes to contribute. Recipes whose ids the household already
    /// has are always contributed, as alternatives.
    #[serde(default)]
    pub recipe_ids: Vec<String>,
    #[serde(default)]
    pub cooking_ids: Vec<String>,
    /// Replace the household shopping list with this device's.
    #[serde(default)]
    pub use_device_shopping_list: bool,
    /// Re-own this device's ratings, food log, cooking sessions, and AI
    /// settings to the signed-in account.
    #[serde(default)]
    pub adopt_personal: bool,
}

fn summary(list: &Value) -> Option<ListSummary> {
    Some(ListSummary {
        id: list["id"].as_str()?.to_owned(),
        start_date: list["startDate"].as_str()?.to_owned(),
        end_date: list["endDate"].as_str()?.to_owned(),
        items: list["items"].as_array().map_or(0, Vec::len),
        manual_items: list["manualItems"].as_array().map_or(0, Vec::len),
    })
}

fn local_identity(db: &Connection) -> Result<(String, String)> {
    db.query_row(
        "SELECT id, household_id FROM people WHERE kind = 'local'",
        [],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )
    .optional()?
    .ok_or_else(|| Error::forbidden("This database is not an installed profile."))
}

impl Core {
    /// Whether this database is an installed profile rather than a server.
    pub fn is_embedded(&self) -> Result<bool> {
        self.read(|db| {
            Ok(db.query_row(
                "SELECT EXISTS(SELECT 1 FROM people WHERE kind = 'local')",
                [],
                |row| row.get::<_, bool>(0),
            )?)
        })
    }

    /// The person the installed app acts as: the standalone person until a
    /// household is joined, then the signed-in account. After sign-out the
    /// household stays usable but personal records are hidden.
    pub fn current_principal(&self) -> Result<Principal> {
        let standalone = self.standalone()?;
        self.read(|db| {
            let Some(state) = sync::state(db)? else {
                return Ok(standalone);
            };
            let account = state.active_account.ok_or_else(Error::unauthenticated)?;
            let role: String = db
                .query_row(
                    "SELECT role FROM remote_accounts WHERE account_id = ?",
                    [&account],
                    |row| row.get(0),
                )
                .optional()?
                .unwrap_or_else(|| "member".to_owned());
            let standing = if state.signed_out {
                Standing::SignedOut
            } else if role == "administrator" {
                Standing::Administrator
            } else {
                Standing::Member
            };
            Ok(Principal::new(
                account,
                standalone.household_id().to_owned(),
                standing,
            ))
        })
    }

    pub(crate) fn pending_join(&self) -> Result<Option<PendingJoin>> {
        Ok(self.stored_join()?.map(|join| PendingJoin {
            server_url: join.server_url,
            setup_required: join.setup_required,
            account: join.account,
            household: join.household,
        }))
    }

    fn stored_join(&self) -> Result<Option<StoredJoin>> {
        Ok(self
            .inner
            .secrets
            .get(PENDING_JOIN)?
            .and_then(|text| serde_json::from_str(&text).ok()))
    }

    fn require_unbound_profile(&self) -> Result<()> {
        // A first launch has no local person yet; a server database refuses.
        self.standalone()?;
        self.read(|db| {
            local_identity(db)?;
            if sync::is_bound(db)? {
                return Err(Error::conflict(
                    "This profile is already linked to a household. Sign in to resume, or use a separate local profile for another household.",
                ));
            }
            Ok(())
        })
    }

    /// Checks that `server_url` is a compatible Forkcast server.
    pub fn connect_server(&self, server_url_text: &str) -> Result<ServerProbe> {
        self.require_unbound_profile()?;
        let url = server_url(server_url_text)?;
        let setup_required = Remote::new(&url, None).status()?;
        self.discard_pending_join();
        self.store_join(&StoredJoin {
            server_url: url.clone(),
            setup_required,
            token: None,
            account: None,
            household: None,
        })?;
        Ok(ServerProbe {
            server_url: url,
            setup_required,
        })
    }

    fn store_join(&self, join: &StoredJoin) -> Result<()> {
        self.inner
            .secrets
            .set(PENDING_JOIN, &serde_json::to_string(join)?)
    }

    fn discard_pending_join(&self) {
        if let Ok(Some(join)) = self.stored_join()
            && let Some(token) = join.token
        {
            let _ = Remote::new(&join.server_url, Some(token)).call("DELETE", "/session", None);
        }
        let _ = self.inner.secrets.delete(PENDING_JOIN);
    }

    /// Signs in to (or sets up) the connected server. Joins nothing.
    pub fn authenticate_server(
        &self,
        setup: bool,
        username: &str,
        password: &str,
        household_name: Option<&str>,
    ) -> Result<ServerAuthentication> {
        self.require_unbound_profile()?;
        let mut join = self
            .stored_join()?
            .ok_or_else(|| Error::conflict("Connect to a backend first."))?;
        let remote = Remote::new(&join.server_url, None);
        let body = if setup {
            json!({"householdName": household_name.unwrap_or_default(), "username": username, "password": password})
        } else {
            json!({"username": username, "password": password})
        };
        let signed = remote.call("POST", if setup { "/setup" } else { "/login" }, Some(&body))?;
        let account: AccountInfo = serde_json::from_value(signed["account"].clone())
            .map_err(|_| Error::invalid("The server sent an account this app cannot read."))?;
        let household: HouseholdInfo = serde_json::from_value(signed["household"].clone())
            .map_err(|_| Error::invalid("The server sent a household this app cannot read."))?;
        join.token = signed["token"].as_str().map(str::to_owned);
        join.setup_required = false;
        join.account = Some(account.clone());
        join.household = Some(household.clone());
        self.store_join(&join)?;
        Ok(ServerAuthentication { account, household })
    }

    /// Forgets an unfinished connection and ends its server session.
    pub fn cancel_join(&self) -> Result<()> {
        self.discard_pending_join();
        let principal = self.current_principal()?;
        self.write(|_, effects| {
            effects.household(&principal, Topic::Sync);
            Ok(())
        })
    }

    fn joined(&self) -> Result<(StoredJoin, Remote, AccountInfo, HouseholdInfo)> {
        let join = self
            .stored_join()?
            .ok_or_else(|| Error::conflict("Connect to a backend first."))?;
        let (Some(token), Some(account), Some(household)) = (
            join.token.clone(),
            join.account.clone(),
            join.household.clone(),
        ) else {
            return Err(Error::unauthenticated());
        };
        let remote = Remote::new(&join.server_url, Some(token));
        Ok((join, remote, account, household))
    }

    /// Shows what joining would publish, replace, and re-own. Changes nothing.
    pub fn review_join(&self) -> Result<JoinReview> {
        self.require_unbound_profile()?;
        let (join, remote, account, household) = self.joined()?;
        let base = format!("/households/{}", household.id);
        let collection = remote.call("GET", &format!("{base}/recipes"), None)?;
        let remote_plan = remote.call("GET", &format!("{base}/planning"), None)?;
        let remote_ids: HashSet<&str> = collection["current"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|head| head["recipeId"].as_str())
            .collect();
        let remote_cookings: Vec<&Value> = remote_plan["data"]["cookings"]
            .as_object()
            .map(|cookings| cookings.values().collect())
            .unwrap_or_default();
        self.read(|db| {
            let (person, local_household) = local_identity(db)?;
            let views = recipes::current_recipe_views(db, &local_household)?;
            let names: std::collections::HashMap<String, String> =
                recipes::retained_recipe_views(db, &local_household)?
                .iter()
                .filter_map(|view| {
                    Some((
                        view.recipe["id"].as_str()?.to_owned(),
                        view.recipe["name"].as_str()?.to_owned(),
                    ))
                })
                .collect();
            let local_plan = planning::local_snapshot(db, &local_household)?;
            let cookings = local_plan["data"]["cookings"]
                .as_object()
                .into_iter()
                .flatten()
                .map(|(id, cooking)| ReviewCooking {
                    id: id.clone(),
                    recipe_id: cooking["recipeId"].as_str().unwrap_or_default().to_owned(),
                    recipe_name: names
                        .get(cooking["recipeId"].as_str().unwrap_or_default())
                        .cloned()
                        .unwrap_or_default(),
                    cooking_date: cooking["cookingDate"].as_str().unwrap_or_default().to_owned(),
                    cooking_time: cooking["cookingTime"].as_str().map(str::to_owned),
                    portions: cooking["portions"].as_f64().unwrap_or_default(),
                    likely_duplicate: remote_cookings.iter().any(|other| {
                        other["recipeId"] == cooking["recipeId"]
                            && other["cookingDate"] == cooking["cookingDate"]
                    }),
                })
                .collect();
            let count = |sql: &str| -> Result<usize> {
                Ok(db.query_row(sql, [&person], |row| row.get::<_, i64>(0))? as usize)
            };
            Ok(JoinReview {
                server_url: join.server_url.clone(),
                account: account.clone(),
                household: household.clone(),
                recipes: views
                    .iter()
                    .filter_map(|view| {
                        let id = view.recipe["id"].as_str()?;
                        Some(ReviewRecipe {
                            id: id.to_owned(),
                            name: view.recipe["name"].as_str()?.to_owned(),
                            collides: remote_ids.contains(id),
                        })
                    })
                    .collect(),
                household_recipes: remote_ids.len(),
                cookings,
                household_cookings: remote_cookings.len(),
                device_shopping_list: summary(&local_plan["data"]["shoppingList"]),
                household_shopping_list: summary(&remote_plan["data"]["shoppingList"]),
                personal: PersonalSummary {
                    ratings: count(
                        "SELECT count(*) FROM recipe_ratings WHERE person_id = ? AND value IS NOT NULL",
                    )?,
                    food_log_entries: count(
                        "SELECT (SELECT count(*) FROM manual_food_log_entries WHERE person_id = ?1) + (SELECT count(*) FROM recipe_food_log_entries WHERE person_id = ?1)",
                    )?,
                    cooking_sessions: count(
                        "SELECT count(*) FROM cooking_sessions WHERE person_id = ? AND ended = 0",
                    )?,
                },
            })
        })
    }

    /// Joins the household. Everything applies in one local transaction after
    /// the server's records have been fetched; nothing is delivered until the
    /// next synchronization.
    pub fn complete_join(&self, selection: JoinSelection) -> Result<sync::SyncStatus> {
        let _guard = self.inner.sync.lock.lock().expect("sync lock poisoned");
        self.require_unbound_profile()?;
        let (join, remote, account, household) = self.joined()?;
        let base = format!("/households/{}", household.id);
        let collection = remote.call("GET", &format!("{base}/recipes"), None)?;
        let remote_plan = remote.call("GET", &format!("{base}/planning"), None)?;
        let remote_ids: HashSet<String> = collection["current"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|head| head["recipeId"].as_str().map(str::to_owned))
            .collect();
        self.write(|db, effects| {
            let (local_person, local_household) = local_identity(db)?;
            if sync::is_bound(db)? {
                return Err(Error::conflict("This profile is already linked to a household."));
            }
            // Archived recipes are never offered for publishing; they join
            // only when the household already has them, else stay local.
            let views = recipes::retained_recipe_views(db, &local_household)?;
            let local_ids: HashSet<String> = views
                .iter()
                .filter_map(|view| view.recipe["id"].as_str().map(str::to_owned))
                .collect();
            for id in &selection.recipe_ids {
                if !local_ids.contains(id) {
                    return Err(Error::invalid("Choose recipes from this device's collection."));
                }
            }
            let contributed: HashSet<String> = local_ids
                .iter()
                .filter(|id| selection.recipe_ids.contains(id) || remote_ids.contains(*id))
                .cloned()
                .collect();
            let member = Principal::new(account.id.clone(), local_household.clone(), Standing::Member);

            db.execute(
                "INSERT OR IGNORE INTO people (id, household_id, kind) VALUES (?, ?, 'account')",
                params![account.id, local_household],
            )?;
            db.execute(
                "INSERT INTO remote_accounts (account_id, username, role) VALUES (?, ?, ?) ON CONFLICT(account_id) DO UPDATE SET username = excluded.username, role = excluded.role",
                params![account.id, account.username, account.role],
            )?;

            // Recipes: contributed ones queue every revision; the rest stay local.
            for id in local_ids.difference(&contributed) {
                db.execute("UPDATE shared_recipes SET held_back = 1 WHERE id = ?", [id])?;
            }
            for id in &contributed {
                let revisions: Vec<(String, String)> = db
                    .prepare("SELECT id, payload FROM recipe_revisions WHERE recipe_id = ? ORDER BY rowid")?
                    .query_map([id], |row| Ok((row.get(0)?, row.get(1)?)))?
                    .collect::<std::result::Result<_, _>>()?;
                for (revision_id, payload) in revisions {
                    db.execute(
                        "INSERT INTO sync_outbox (id, person_id, household_id, kind, payload) VALUES (?, ?, ?, 'recipeRevision', ?)",
                        params![revision_id, account.id, local_household, payload],
                    )?;
                }
            }
            db.execute(
                "INSERT INTO sync_binding (singleton, server_url, remote_household_id) VALUES (1, ?, ?)",
                params![join.server_url, household.id],
            )?;
            db.execute(
                "INSERT INTO sync_state (singleton, active_account, signed_out, paused, planning_revision) VALUES (1, ?, 0, 0, ?)",
                params![account.id, remote_plan["revision"].as_str()],
            )?;
            // Household records from the server join the contributed ones.
            let pending: HashSet<String> = contributed.clone();
            sync::mirror_recipes(db, &member, &collection, &pending, effects)?;

            // Planning: the household's, plus what was explicitly chosen.
            let local_plan = planning::local_snapshot(db, &local_household)?;
            let mut data = remote_plan["data"].clone();
            for id in &selection.cooking_ids {
                let cooking = local_plan["data"]["cookings"][id].clone();
                if cooking.is_null() {
                    return Err(Error::invalid("Choose planned cookings from this device's plan."));
                }
                let recipe_id = cooking["recipeId"].as_str().unwrap_or_default();
                if !contributed.contains(recipe_id) && !remote_ids.contains(recipe_id) {
                    return Err(Error::invalid(
                        "A selected planned cooking needs a recipe that is shared with the household. Contribute the recipe or deselect the cooking.",
                    ));
                }
                data["cookings"][id] = cooking;
            }
            if selection.use_device_shopping_list && !local_plan["data"]["shoppingList"].is_null() {
                data["shoppingList"] = local_plan["data"]["shoppingList"].clone();
            }
            let document = json!({
                "revision": remote_plan["revision"],
                "data": data,
                "conflicts": remote_plan["conflicts"],
            });
            db.execute(
                "INSERT INTO household_planning (household_id, payload) VALUES (?, ?) ON CONFLICT(household_id) DO UPDATE SET payload = excluded.payload",
                params![local_household, document.to_string()],
            )?;
            if data != remote_plan["data"] {
                let id = Uuid::new_v4().to_string();
                let mutation = json!({
                    "id": id,
                    "baseRevision": remote_plan["revision"],
                    "baseMutationId": null,
                    "baseData": remote_plan["data"],
                    "data": data,
                });
                db.execute(
                    "INSERT INTO sync_outbox (id, person_id, household_id, kind, payload) VALUES (?, ?, ?, 'planning', ?)",
                    params![id, account.id, local_household, mutation.to_string()],
                )?;
            }

            if selection.adopt_personal {
                for sql in [
                    "UPDATE recipe_ratings SET person_id = ?1 WHERE person_id = ?2",
                    "UPDATE cooking_sessions SET person_id = ?1 WHERE person_id = ?2",
                    "UPDATE manual_food_log_entries SET person_id = ?1 WHERE person_id = ?2",
                    "UPDATE recipe_food_log_entries SET person_id = ?1 WHERE person_id = ?2",
                    "UPDATE person_settings SET person_id = ?1 WHERE person_id = ?2",
                ] {
                    db.execute(sql, params![account.id, local_person])?;
                }
                crate::preferences::queue_all(db, effects, &member)?;
                let ratings: Vec<(String, i64)> = db
                    .prepare("SELECT recipe_id, value FROM recipe_ratings WHERE person_id = ? AND value IS NOT NULL")?
                    .query_map([&account.id], |row| Ok((row.get(0)?, row.get(1)?)))?
                    .collect::<std::result::Result<_, _>>()?;
                for (recipe_id, value) in ratings {
                    let id = Uuid::new_v4().to_string();
                    db.execute(
                        "INSERT INTO sync_outbox (id, person_id, household_id, kind, payload) VALUES (?, ?, ?, 'rating', ?)",
                        params![id, account.id, local_household, json!({"id": id, "recipeId": recipe_id, "value": value}).to_string()],
                    )?;
                }
            }
            effects.queued = true;
            for topic in [Topic::Recipes, Topic::Planning, Topic::Ratings, Topic::Sync] {
                effects.household(&member, topic);
            }
            effects.person_id(&account.id, Topic::FoodLog);
            effects.person_id(&account.id, Topic::CookingSessions);
            effects.person_id(&account.id, Topic::Preferences);
            if let Some(token) = &join.token {
                self.inner.secrets.set(&session_key(&account.id), token)?;
            }
            Ok(())
        })?;
        let _ = self.inner.secrets.delete(PENDING_JOIN);
        drop(_guard);
        // The standalone person's ChatGPT session is not the account's:
        // retire it rather than let the account reuse it.
        if let Ok((local_person, _)) = self.read(local_identity) {
            self.ai_discard_device_session(&local_person);
        }
        self.nudge_sync();
        self.sync_status()
    }

    /// Resumes a joined profile under the household's own accounts. Another
    /// account of the same household gets its own person; a different
    /// household is refused.
    pub fn profile_sign_in(&self, username: &str, password: &str) -> Result<sync::SyncStatus> {
        let _guard = self.inner.sync.lock.lock().expect("sync lock poisoned");
        let binding = self
            .read(sync::binding)?
            .ok_or_else(|| Error::conflict("This profile has not joined a household."))?;
        let remote = Remote::new(&binding.server_url, None);
        remote.status()?;
        let signed = remote.call(
            "POST",
            "/login",
            Some(&json!({"username": username, "password": password})),
        )?;
        let account: AccountInfo = serde_json::from_value(signed["account"].clone())
            .map_err(|_| Error::invalid("The server sent an account this app cannot read."))?;
        let token = signed["token"].as_str().unwrap_or_default().to_owned();
        if signed["household"]["id"].as_str() != Some(binding.remote_household_id.as_str()) {
            let _ = Remote::new(&binding.server_url, Some(token)).call("DELETE", "/session", None);
            return Err(Error::conflict(
                "This profile is linked to another household. Use a separate local profile for another household.",
            ));
        }
        self.inner.secrets.set(&session_key(&account.id), &token)?;
        let principal = self.write(|db, effects| {
            let (_, household) = local_identity(db)?;
            db.execute(
                "INSERT OR IGNORE INTO people (id, household_id, kind) VALUES (?, ?, 'account')",
                params![account.id, household],
            )?;
            db.execute(
                "INSERT INTO remote_accounts (account_id, username, role) VALUES (?, ?, ?) ON CONFLICT(account_id) DO UPDATE SET username = excluded.username, role = excluded.role",
                params![account.id, account.username, account.role],
            )?;
            db.execute(
                "UPDATE sync_state SET active_account = ?, signed_out = 0, paused = 0, last_error = NULL",
                [&account.id],
            )?;
            let principal = Principal::new(account.id.clone(), household, Standing::Member);
            for topic in [Topic::Recipes, Topic::Planning, Topic::Ratings, Topic::Sync] {
                effects.household(&principal, topic);
            }
            effects.person(&principal, Topic::FoodLog);
            effects.person(&principal, Topic::CookingSessions);
            effects.person(&principal, Topic::Preferences);
            effects.queued = true;
            Ok(principal)
        })?;
        let _ = principal;
        drop(_guard);
        self.sync_status()
    }

    /// Pauses remote work and hides the account's private data. Its pending
    /// changes stay with it.
    pub fn profile_sign_out(&self, disconnect: bool) -> Result<sync::SyncStatus> {
        let _guard = self.inner.sync.lock.lock().expect("sync lock poisoned");
        let (binding, state) = self.read(|db| Ok((sync::binding(db)?, sync::state(db)?)))?;
        let (Some(binding), Some(state)) = (binding, state) else {
            return Err(Error::conflict("This profile has not joined a household."));
        };
        if let Some(account) = &state.active_account {
            if let Some(token) = self.inner.secrets.get(&session_key(account))? {
                // Revocation is best effort; the local session ends regardless.
                let _ =
                    Remote::new(&binding.server_url, Some(token)).call("DELETE", "/session", None);
            }
            self.inner.secrets.delete(&session_key(account))?;
        }
        let principal = self.write(|db, effects| {
            let (_, household) = local_identity(db)?;
            db.execute(
                "UPDATE sync_state SET signed_out = 1, paused = ?",
                [disconnect || state.paused],
            )?;
            let principal = Principal::new(
                state.active_account.clone().unwrap_or_default(),
                household,
                Standing::SignedOut,
            );
            for topic in [Topic::Recipes, Topic::Planning, Topic::Ratings, Topic::Sync] {
                effects.household(&principal, topic);
            }
            if let Some(account) = &state.active_account {
                effects.person_id(account, Topic::FoodLog);
                effects.person_id(account, Topic::CookingSessions);
                effects.person_id(account, Topic::Preferences);
            }
            Ok(principal)
        })?;
        let _ = principal;
        drop(_guard);
        self.sync_status()
    }

    fn active_remote(&self) -> Result<Remote> {
        let (binding, state) = self.read(|db| Ok((sync::binding(db)?, sync::state(db)?)))?;
        let (Some(binding), Some(state)) = (binding, state) else {
            return Err(Error::unauthenticated());
        };
        let token = match (&state.active_account, state.signed_out) {
            (Some(account), false) => self.inner.secrets.get(&session_key(account))?,
            _ => None,
        };
        let token = token.ok_or_else(|| {
            Error::new(
                ErrorKind::Unauthenticated,
                "Sign in to your household to manage its accounts.",
            )
        })?;
        Ok(Remote::new(&binding.server_url, Some(token)))
    }

    /// Account administration reaches the server with the active session.
    pub fn remote_accounts(&self) -> Result<Value> {
        self.active_remote()?.call("GET", "/accounts", None)
    }

    pub fn remote_create_account(&self, username: &str, password: &str) -> Result<Value> {
        self.active_remote()?.call(
            "POST",
            "/accounts",
            Some(&json!({"username": username, "password": password})),
        )
    }

    pub fn remote_change_account(&self, id: &str, change: &Value) -> Result<Value> {
        self.active_remote()?
            .call("PATCH", &format!("/accounts/{id}"), Some(change))
    }

    /// Chooses among competing recipe edits on the server first, so a stale
    /// choice cannot overwrite newer alternatives, then mirrors the result.
    pub fn choose_current_recipe_synced(
        &self,
        recipe_id: &str,
        revision_id: &str,
        expected: &[String],
    ) -> Result<()> {
        self.sync_now()?;
        let binding = self
            .read(sync::binding)?
            .ok_or_else(|| Error::conflict("This profile has not joined a household."))?;
        self.active_remote()?.call(
            "POST",
            &format!(
                "/households/{}/recipes/{recipe_id}/current",
                binding.remote_household_id
            ),
            Some(&json!({"revisionId": revision_id, "expectedRevisionIds": expected})),
        )?;
        self.sync_now()?;
        Ok(())
    }

    /// Resolves a planning conflict on the server first, after delivering
    /// pending edits, then adopts the result.
    pub fn resolve_planning_conflict_synced(&self, choice: &Value) -> Result<()> {
        let status = self.sync_now()?;
        if status.pending > 0 {
            return Err(Error::conflict(
                "Synchronize pending planning changes before resolving conflicts.",
            ));
        }
        let binding = self
            .read(sync::binding)?
            .ok_or_else(|| Error::conflict("This profile has not joined a household."))?;
        self.active_remote()?.call(
            "POST",
            &format!(
                "/households/{}/planning/resolve",
                binding.remote_household_id
            ),
            Some(choice),
        )?;
        self.sync_now()?;
        Ok(())
    }
}
