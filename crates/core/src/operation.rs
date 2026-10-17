//! The serializable operation contract a native bridge exposes to the
//! frontend. Each variant calls the same [`Core`] method the HTTP adapter's
//! `POST /api/operations` calls, so both transports share one implementation.

use crate::{
    AccountChange, CookingOutcome, Core, Credentials, CurrentChoice, JoinSelection, LogManualFood,
    LogRecipeFood, Photo, PlanningChoice, Principal, SetCoverPhoto, ShoppingItemKind, StartCooking,
    error::{Error, Result},
};
use forkcast_recipe_domain::{planning::PlannedCooking, shopping::ShoppingItem};
use serde::Deserialize;
use serde_json::{Value, json};

#[derive(Deserialize)]
#[serde(
    tag = "operation",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Operation {
    Recipes,
    RecipeCollection,
    SaveRecipe {
        recipe: Value,
        base_revision_id: Option<String>,
    },
    SetRecipeCoverPhoto {
        recipe_id: String,
        cover_photo: Option<Photo>,
        base_revision_id: Option<String>,
    },
    ChooseCurrentRecipe {
        recipe_id: String,
        revision_id: String,
        expected_revision_ids: Vec<String>,
    },
    Ratings,
    RateRecipe {
        recipe_id: String,
        value: Option<u8>,
    },
    MealPlan,
    PlanCooking {
        cooking: PlannedCooking,
    },
    RemovePlannedCooking {
        id: String,
    },
    PlanningSnapshot,
    ResolvePlanningConflict {
        #[serde(flatten)]
        choice: PlanningChoice,
    },
    ShoppingList,
    GenerateShoppingList {
        start_date: String,
        end_date: String,
        replacing_list_id: Option<String>,
    },
    SaveShoppingItem {
        list_id: String,
        kind: ShoppingItemKind,
        item: ShoppingItem,
    },
    RemoveShoppingItem {
        list_id: String,
        kind: ShoppingItemKind,
        item_id: String,
    },
    CheckShoppingItem {
        list_id: String,
        item_id: String,
        checked: bool,
    },
    CompleteShoppingList {
        list_id: String,
    },
    CookingSessions,
    StartCooking {
        #[serde(flatten)]
        start: StartCooking,
    },
    SaveCookingProgress {
        session_id: String,
        step: usize,
        timers: Value,
    },
    EndCooking {
        session_id: String,
        outcome: CookingOutcome,
    },
    FoodLog {
        date: String,
    },
    LogRecipeFood {
        #[serde(flatten)]
        entry: LogRecipeFood,
    },
    LogManualFood {
        #[serde(flatten)]
        entry: LogManualFood,
    },
    FoodLogDate,
    SetFoodLogDate {
        date: String,
    },
    AiPreferences,
    SetRecipePrompt {
        prompt: String,
    },
    SyncStatus,
    SyncNow,
    ConnectServer {
        server_url: String,
    },
    AuthenticateServer {
        #[serde(default)]
        setup: bool,
        username: String,
        password: String,
        household_name: Option<String>,
    },
    ReviewJoin,
    CompleteJoin {
        #[serde(flatten)]
        selection: JoinSelection,
    },
    CancelJoin,
    SignIn {
        username: String,
        password: String,
    },
    SignOut,
    Disconnect,
    Accounts,
    CreateAccount {
        username: String,
        password: String,
    },
    ChangeAccount {
        id: String,
        active: Option<bool>,
        password: Option<String>,
    },
    ImportLegacy {
        transfer: Value,
    },
}

fn json(value: impl serde::Serialize) -> Result<Value> {
    serde_json::to_value(value).map_err(|_| Error::internal())
}

impl Core {
    /// Runs one operation for `principal` and returns its JSON result.
    pub fn execute(&self, principal: &Principal, operation: Operation) -> Result<Value> {
        use Operation::*;
        match operation {
            Recipes => json(self.recipes(principal)?),
            RecipeCollection => json(self.recipe_collection(principal)?),
            SaveRecipe {
                recipe,
                base_revision_id,
            } => json(self.save_recipe(
                principal,
                crate::SaveRecipe {
                    recipe,
                    base_revision_id,
                },
            )?),
            SetRecipeCoverPhoto {
                recipe_id,
                cover_photo,
                base_revision_id,
            } => json(self.set_recipe_cover_photo(
                principal,
                SetCoverPhoto {
                    recipe_id,
                    cover_photo,
                    base_revision_id,
                },
            )?),
            ChooseCurrentRecipe {
                recipe_id,
                revision_id,
                expected_revision_ids,
            } => {
                if self.is_embedded()? && self.sync_status()?.bound {
                    self.choose_current_recipe_synced(
                        &recipe_id,
                        &revision_id,
                        &expected_revision_ids,
                    )?;
                } else {
                    self.choose_current_recipe(
                        principal,
                        &recipe_id,
                        CurrentChoice {
                            revision_id,
                            expected_revision_ids,
                        },
                    )?;
                }
                Ok(Value::Null)
            }
            Ratings => json(self.ratings(principal)?),
            RateRecipe { recipe_id, value } => {
                self.rate_recipe(principal, &recipe_id, value)?;
                Ok(Value::Null)
            }
            MealPlan => json(self.meal_plan(principal)?),
            PlanCooking { cooking } => json(self.plan_cooking(principal, cooking)?),
            RemovePlannedCooking { id } => {
                self.remove_planned_cooking(principal, &id)?;
                Ok(Value::Null)
            }
            PlanningSnapshot => self.planning_snapshot(principal),
            ResolvePlanningConflict { choice } => {
                if self.is_embedded()? && self.sync_status()?.bound {
                    self.resolve_planning_conflict_synced(&json!({
                        "conflict": choice.conflict,
                        "value": choice.value,
                    }))?;
                    self.planning_snapshot(principal)
                } else {
                    self.resolve_planning_conflict(principal, choice)
                }
            }
            ShoppingList => json(self.shopping_list(principal)?),
            GenerateShoppingList {
                start_date,
                end_date,
                replacing_list_id,
            } => json(self.generate_shopping_list(
                principal,
                &start_date,
                &end_date,
                replacing_list_id.as_deref(),
            )?),
            SaveShoppingItem {
                list_id,
                kind,
                item,
            } => json(self.save_shopping_item(principal, &list_id, kind, item)?),
            RemoveShoppingItem {
                list_id,
                kind,
                item_id,
            } => json(self.remove_shopping_item(principal, &list_id, kind, &item_id)?),
            CheckShoppingItem {
                list_id,
                item_id,
                checked,
            } => json(self.check_shopping_item(principal, &list_id, &item_id, checked)?),
            CompleteShoppingList { list_id } => {
                json(self.complete_shopping_list(principal, &list_id)?)
            }
            CookingSessions => json(self.cooking_sessions(principal)?),
            StartCooking { start } => json(self.start_cooking(principal, start)?),
            SaveCookingProgress {
                session_id,
                step,
                timers,
            } => self.save_cooking_progress(principal, &session_id, step, timers),
            EndCooking {
                session_id,
                outcome,
            } => {
                self.end_cooking(principal, &session_id, outcome)?;
                Ok(Value::Null)
            }
            FoodLog { date } => json(self.food_log(principal, &date)?),
            LogRecipeFood { entry } => {
                self.log_recipe_food(principal, entry)?;
                Ok(Value::Null)
            }
            LogManualFood { entry } => {
                self.log_manual_food(principal, entry)?;
                Ok(Value::Null)
            }
            FoodLogDate => json(self.food_log_date(principal)?),
            SetFoodLogDate { date } => {
                self.set_food_log_date(principal, &date)?;
                Ok(Value::Null)
            }
            AiPreferences => json(self.ai_preferences(principal)?),
            SetRecipePrompt { prompt } => json(self.set_recipe_prompt(principal, &prompt)?),
            SyncStatus => json(self.sync_status()?),
            SyncNow => json(self.sync_now()?),
            ConnectServer { server_url } => json(self.connect_server(&server_url)?),
            AuthenticateServer {
                setup,
                username,
                password,
                household_name,
            } => json(self.authenticate_server(
                setup,
                &username,
                &password,
                household_name.as_deref(),
            )?),
            ReviewJoin => json(self.review_join()?),
            CompleteJoin { selection } => json(self.complete_join(selection)?),
            CancelJoin => {
                self.cancel_join()?;
                Ok(Value::Null)
            }
            SignIn { username, password } => json(self.profile_sign_in(&username, &password)?),
            SignOut => json(self.profile_sign_out(false)?),
            Disconnect => json(self.profile_sign_out(true)?),
            Accounts => {
                if self.is_embedded()? {
                    self.remote_accounts()
                } else {
                    json(self.accounts(principal)?)
                }
            }
            CreateAccount { username, password } => {
                if self.is_embedded()? {
                    self.remote_create_account(&username, &password)
                } else {
                    json(self.create_account(principal, Credentials { username, password })?)
                }
            }
            ChangeAccount {
                id,
                active,
                password,
            } => {
                if self.is_embedded()? {
                    let mut change = serde_json::Map::new();
                    if let Some(active) = active {
                        change.insert("active".into(), active.into());
                    }
                    if let Some(password) = password {
                        change.insert("password".into(), password.into());
                    }
                    self.remote_change_account(&id, &Value::Object(change))
                } else {
                    json(self.change_account(principal, &id, AccountChange { active, password })?)
                }
            }
            ImportLegacy { transfer } => json(self.import_legacy(transfer)?),
        }
    }
}
