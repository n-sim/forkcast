//! Gurkerl cart handoff: fills a person's Gurkerl cart from the reviewed
//! shopping list through Gurkerl's MCP server.
//!
//! - The connection is **personal and stays on the device** that made it.
//!   The installed app signs in through the person's own browser and the
//!   loopback listener, and keeps the session in [`crate::Secrets`]: never in
//!   the database, synchronization, household records, operation results,
//!   change notifications, or logs. A household server never holds it.
//! - Product choices come from the supermarket's own MCP tools, steered by
//!   the person's editable selection prompt. The person's AI connection
//!   decides which tools to call through the one AI execution interface; this
//!   module only offers it tools that read or add to the cart, refuses every
//!   other call, and records what the supermarket confirmed.
//! - Filling a cart never checks out, orders, or pays, and never changes the
//!   shopping list: it stays available, and completing it remains the
//!   checklist's or the person's explicit choice.

mod mcp;

use crate::{
    AiRequest, Core,
    ai::loopback,
    changes::{Change, Scope, Topic},
    error::{Error, ErrorKind, Result},
    principal::Principal,
};
use mcp::{Attempt, Failure, Gurkerl, Registration, Tokens, Tool};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, HashMap},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
};

/// Tool calls one AI turn may request.
const MAX_CALLS_PER_TURN: usize = 40;
/// AI turns one handoff may take.
const MAX_TURNS: usize = 12;
/// Characters of one tool result the AI sees again in later turns.
const MAX_TRANSCRIPT_RESULT: usize = 3000;
/// What an earlier tool result shrinks to when a turn's input runs long.
const SHORT_RESULT: usize = 300;
/// Bytes of input one AI turn may carry, within the execution interface's limit.
const MAX_INPUT: usize = 60_000;

/// Which Gurkerl MCP server this core talks to. Production is the only choice
/// for released builds; hosts may point debug builds at a loopback fixture.
#[derive(Clone)]
pub struct SupermarketConfig {
    server: String,
}

impl SupermarketConfig {
    pub fn production() -> Self {
        Self {
            server: mcp::PRODUCTION_SERVER.to_owned(),
        }
    }

    /// An isolated Gurkerl fixture on the loopback interface, for tests.
    pub fn fixture(server: &str) -> Result<Self> {
        let url = url::Url::parse(server)
            .map_err(|_| Error::invalid("The supermarket fixture address is not valid."))?;
        if url.scheme() != "http"
            || url.host_str() != Some("127.0.0.1")
            || url.query().is_some()
            || url.fragment().is_some()
            || !url.username().is_empty()
            || url.password().is_some()
        {
            return Err(Error::invalid(
                "A supermarket fixture must be a plain loopback HTTP address.",
            ));
        }
        Ok(Self {
            server: server.to_owned(),
        })
    }
}

impl Default for SupermarketConfig {
    fn default() -> Self {
        Self::production()
    }
}

#[derive(Default)]
pub(crate) struct Runtime {
    /// Serializes every read-modify-write of connection records.
    lock: Mutex<()>,
    /// Sign-in attempts in progress, by person.
    attempts: Mutex<HashMap<String, Arc<AtomicBool>>>,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SupermarketState {
    Unconfigured,
    Authorizing,
    Connected,
    Denied,
    Expired,
    ReconnectRequired,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SupermarketStatus {
    pub state: SupermarketState,
    pub message: Option<String>,
    /// Whether this runtime can sign in to Gurkerl and fill carts: only an
    /// installed app can.
    pub can_connect: bool,
}

#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Notice {
    state: Option<SupermarketState>,
    message: String,
}

#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Record {
    server: String,
    registration: Option<Registration>,
    tokens: Option<Tokens>,
    notice: Option<Notice>,
}

fn record_key(person: &str) -> String {
    format!("gurkerl:{person}")
}

fn reconnect(message: &str) -> Error {
    Error::new(ErrorKind::ConnectionRequired, message)
}

const NOT_HERE: &str = "Gurkerl carts are filled from the installed Forkcast app. Your Gurkerl sign-in stays on that device.";
const CALLBACK_OK: &str = "<!doctype html><title>Gurkerl connected</title><h1>Gurkerl connected</h1><p>Return to Forkcast. You can close this window.</p>";
const CALLBACK_FAILED: &str = "<!doctype html><title>Gurkerl sign-in incomplete</title><h1>Gurkerl sign-in incomplete</h1><p>Return to Forkcast settings and try connecting again.</p>";
const PROTECT_FAILED: &str =
    "Forkcast could not protect the Gurkerl session. Check its storage permissions and reconnect.";

/// A request to fill the cart from the reviewed list.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FillCart {
    /// The list the person reviewed; a list replaced elsewhere is refused.
    pub list_id: String,
    /// The ChatGPT model that chooses products.
    pub model: String,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CartItemStatus {
    /// Gurkerl confirmed adding a product for this item.
    Added,
    /// Gurkerl refused adding a product for this item.
    Failed,
    /// Nothing was added for this item.
    NotAdded,
    /// Already checked off on the shopping checklist, so not sent.
    Skipped,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CartItem {
    pub item_id: String,
    pub name: String,
    pub quantity: Option<f64>,
    pub unit: Value,
    pub status: CartItemStatus,
    pub product: Option<String>,
    pub note: Option<String>,
}

/// What a handoff did. `complete` is false when it stopped early; the items
/// say exactly what Gurkerl confirmed either way.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CartHandoff {
    pub list_id: String,
    pub complete: bool,
    pub message: Option<String>,
    pub items: Vec<CartItem>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Access {
    Read,
    AddToCart,
}

/// Words that mark a tool Forkcast never calls: checkout, ordering, payment,
/// delivery booking, complaints, and anything that removes or replaces what is
/// already in the cart.
const FORBIDDEN: [&str; 24] = [
    "checkout",
    "order",
    "orders",
    "pay",
    "payment",
    "purchase",
    "place",
    "submit",
    "confirm",
    "book",
    "reserve",
    "slot",
    "timeslot",
    "claim",
    "complaint",
    "delete",
    "remove",
    "clear",
    "empty",
    "cancel",
    "reorder",
    "repeat",
    "replace",
    "subscribe",
];
const READ_VERBS: [&str; 11] = [
    "get", "search", "list", "find", "show", "fetch", "browse", "read", "lookup", "query", "view",
];

fn words(name: &str) -> Vec<String> {
    let mut words = Vec::new();
    let mut current = String::new();
    let mut previous_lower = false;
    for character in name.chars() {
        if !character.is_alphanumeric() {
            words.extend((!current.is_empty()).then(|| std::mem::take(&mut current)));
            previous_lower = false;
            continue;
        }
        if character.is_uppercase() && previous_lower {
            words.push(std::mem::take(&mut current));
        }
        previous_lower = character.is_lowercase() || character.is_numeric();
        current.extend(character.to_lowercase());
    }
    words.extend((!current.is_empty()).then_some(current));
    words
}

/// What Forkcast lets the AI do with a tool, judged from the tool's own name
/// and annotations: read anything that reads, add to the cart, nothing else.
/// Reading order history is allowed so previously bought products can guide
/// choices; tools that act on orders are not.
fn tool_access(tool: &Tool) -> Option<Access> {
    let words = words(&tool.name);
    let reads = tool.read_only
        || words
            .first()
            .is_some_and(|w| READ_VERBS.contains(&w.as_str()));
    if reads {
        let acts = words
            .iter()
            .any(|word| ["checkout", "pay", "payment", "submit", "place"].contains(&word.as_str()));
        return (!acts).then_some(Access::Read);
    }
    if words.iter().any(|word| FORBIDDEN.contains(&word.as_str())) {
        return None;
    }
    words
        .iter()
        .any(|word| matches!(word.as_str(), "cart" | "basket"))
        .then_some(Access::AddToCart)
}

const HANDOFF_CONTRACT: &str = r#"You fill a person's Gurkerl grocery delivery cart from their reviewed shopping list by calling the supermarket's MCP tools.
Each turn, reply with exactly one JSON object and nothing else, either:
{"calls":[{"tool":"<tool name>","arguments":{},"itemIds":["<shopping item id>"],"product":"<product name and package size, when adding to the cart>"}]}
to call tools (their results arrive in the next turn's "transcript"), or, when every item is handled:
{"done":{"items":[{"itemId":"<shopping item id>","product":"<chosen product, or null>","note":"<short reason, required when nothing was added>"}]}}
Rules:
- Use only the tools in "tools", with arguments that match each tool's input schema. Find products with the supermarket's own search, product, and purchase-history tools; never invent product identifiers.
- Add each shopping item at most once, in a number of packages that covers the reviewed quantity without much excess. Name the shopping item ids every cart call is for in "itemIds".
- Follow the person's "selectionPreferences" when choosing between products.
- When no suitable product exists, add nothing for that item and explain why in its note.
- Never check out, place, change, or pay for an order, book a delivery slot, or remove anything from the cart.
- Request at most 40 calls per turn; prefer several independent calls in one turn."#;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RequestedCall {
    tool: String,
    #[serde(default)]
    arguments: Value,
    #[serde(default)]
    item_ids: Vec<String>,
    product: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Decision {
    item_id: String,
    product: Option<String>,
    note: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
enum Reply {
    Calls(Vec<RequestedCall>),
    Done { items: Vec<Decision> },
}

fn read_reply(text: &str) -> Option<Reply> {
    let text = text.trim();
    let text = text
        .strip_prefix("```json")
        .or_else(|| text.strip_prefix("```"))
        .and_then(|inner| inner.strip_suffix("```"))
        .unwrap_or(text);
    serde_json::from_str(text.trim()).ok()
}

fn clipped(text: Option<String>, limit: usize) -> Option<String> {
    text.map(|text| text.trim().chars().take(limit).collect::<String>())
        .filter(|text| !text.is_empty())
}

/// One turn's input, shortening the oldest tool results first so it stays
/// within [`MAX_INPUT`]. `None` when even the shortest form does not fit.
fn fitted_input(
    preferences: &str,
    items: &[Value],
    tools: &[&Tool],
    transcript: &mut [Value],
    turns_left: usize,
) -> Option<String> {
    let mut shortened = 0;
    loop {
        let input = json!({
            "selectionPreferences": preferences,
            "items": items,
            "tools": tools,
            "transcript": transcript,
            "turnsLeft": turns_left,
        })
        .to_string();
        if input.len() <= MAX_INPUT {
            return Some(input);
        }
        let entry = transcript.get_mut(shortened)?;
        shortened += 1;
        if let Some(result) = entry["result"].as_str()
            && result.chars().count() > SHORT_RESULT
        {
            entry["result"] = json!(format!(
                "{}… (shortened)",
                result.chars().take(SHORT_RESULT).collect::<String>()
            ));
        }
    }
}

/// What happened to one list item so far.
#[derive(Default)]
struct Progress {
    added: bool,
    failed: bool,
    product: Option<String>,
    note: Option<String>,
}

impl Core {
    fn gurkerl(&self) -> Gurkerl {
        Gurkerl::new(&self.inner.supermarket_config.server)
    }

    fn publish_supermarket(&self, person: &str) {
        self.inner.hub.publish(vec![Change {
            scope: Scope::Person(person.to_owned()),
            topic: Topic::Supermarket,
        }]);
    }

    fn load_cart_record(&self, person: &str) -> Result<Record> {
        let Some(stored) = self.inner.secrets.get(&record_key(person))? else {
            return Ok(Record::default());
        };
        match serde_json::from_str::<Record>(&stored) {
            Ok(record) if record.server == self.inner.supermarket_config.server => Ok(record),
            _ => Ok(Record {
                notice: Some(Notice {
                    state: Some(SupermarketState::ReconnectRequired),
                    message: "The saved Gurkerl connection could not be used. Connect again."
                        .into(),
                }),
                ..Record::default()
            }),
        }
    }

    fn update_cart_record<T>(
        &self,
        person: &str,
        change: impl FnOnce(&mut Record) -> T,
    ) -> Result<T> {
        let _guard = self
            .inner
            .supermarket
            .lock
            .lock()
            .expect("cart lock poisoned");
        let mut record = self.load_cart_record(person)?;
        let value = change(&mut record);
        record.server = self.inner.supermarket_config.server.clone();
        self.inner
            .secrets
            .set(&record_key(person), &serde_json::to_string(&record)?)?;
        Ok(value)
    }

    fn set_cart_notice(&self, person: &str, state: SupermarketState, message: &str) {
        let _ = self.update_cart_record(person, |record| {
            record.notice = Some(Notice {
                state: Some(state),
                message: message.to_owned(),
            });
        });
        self.publish_supermarket(person);
    }

    /// Supermarket sessions live only in an installed app's own core.
    fn require_device(&self) -> Result<()> {
        if self.is_embedded()? {
            Ok(())
        } else {
            Err(Error::forbidden(NOT_HERE))
        }
    }

    /// The person's Gurkerl connection on this device.
    pub fn supermarket_status(&self, principal: &Principal) -> Result<SupermarketStatus> {
        principal.require_personal()?;
        if !self.is_embedded()? {
            return Ok(SupermarketStatus {
                state: SupermarketState::Unconfigured,
                message: None,
                can_connect: false,
            });
        }
        let person = principal.person_id();
        let authorizing = self
            .inner
            .supermarket
            .attempts
            .lock()
            .expect("cart attempts poisoned")
            .contains_key(person);
        let record = self.load_cart_record(person)?;
        let state = if authorizing {
            SupermarketState::Authorizing
        } else if record.tokens.is_some() {
            SupermarketState::Connected
        } else {
            record
                .notice
                .as_ref()
                .and_then(|notice| notice.state)
                .unwrap_or(SupermarketState::Unconfigured)
        };
        Ok(SupermarketStatus {
            state,
            message: if authorizing {
                None
            } else {
                record.notice.map(|notice| notice.message)
            },
            can_connect: true,
        })
    }

    /// Starts Gurkerl sign-in: discovers and registers with Gurkerl's
    /// authorization server, binds the loopback listener, and returns the
    /// address the host opens in the person's own browser.
    pub fn supermarket_authorize(&self, principal: &Principal) -> Result<String> {
        principal.require_personal()?;
        self.require_device()?;
        let person = principal.person_id().to_owned();
        let listener = loopback::Listener::bind().map_err(|_| {
            Error::new(
                ErrorKind::Unavailable,
                "Forkcast could not start its local sign-in listener. Close other apps using it and try again.",
            )
        })?;
        let redirect = listener.redirect();
        let (attempt, url) = self
            .gurkerl()
            .start(&redirect)
            .map_err(|message| Error::new(ErrorKind::Unavailable, message))?;
        let cancel = Arc::new(AtomicBool::new(false));
        if let Some(previous) = self
            .inner
            .supermarket
            .attempts
            .lock()
            .expect("cart attempts poisoned")
            .insert(person.clone(), cancel.clone())
        {
            previous.store(true, Ordering::SeqCst);
        }
        let core = self.clone();
        std::thread::spawn(move || core.await_cart_callback(&person, listener, attempt, cancel));
        self.publish_supermarket(principal.person_id());
        Ok(url)
    }

    /// Stops a sign-in the person no longer wants.
    pub fn supermarket_cancel_authorization(
        &self,
        principal: &Principal,
    ) -> Result<SupermarketStatus> {
        principal.require_personal()?;
        if let Some(flag) = self
            .inner
            .supermarket
            .attempts
            .lock()
            .expect("cart attempts poisoned")
            .remove(principal.person_id())
        {
            flag.store(true, Ordering::SeqCst);
        }
        self.publish_supermarket(principal.person_id());
        self.supermarket_status(principal)
    }

    fn await_cart_callback(
        &self,
        person: &str,
        listener: loopback::Listener,
        attempt: Attempt,
        cancel: Arc<AtomicBool>,
    ) {
        let mut outcome: Option<std::result::Result<(), (SupermarketState, String)>> = None;
        listener.serve(&cancel, attempt.deadline(), |callback| {
            // Callbacks that are not ours never consume the attempt.
            if callback.params.get("state") != Some(&attempt.state) {
                return None;
            }
            let result = self.finish_cart_authorization(person, &attempt, &callback.params);
            let ok = result.is_ok();
            outcome = Some(result);
            Some(if ok {
                (200, CALLBACK_OK)
            } else {
                (400, CALLBACK_FAILED)
            })
        });
        let ours = {
            let mut attempts = self
                .inner
                .supermarket
                .attempts
                .lock()
                .expect("cart attempts poisoned");
            let ours = attempts
                .get(person)
                .is_some_and(|current| Arc::ptr_eq(current, &cancel));
            if ours {
                attempts.remove(person);
            }
            ours
        };
        if !ours {
            return;
        }
        match outcome {
            None => self.set_cart_notice(
                person,
                SupermarketState::Expired,
                "Gurkerl sign-in timed out. Try connecting again.",
            ),
            Some(Err((state, message))) => self.set_cart_notice(person, state, &message),
            Some(Ok(())) => self.publish_supermarket(person),
        }
    }

    fn finish_cart_authorization(
        &self,
        person: &str,
        attempt: &Attempt,
        params: &HashMap<String, String>,
    ) -> std::result::Result<(), (SupermarketState, String)> {
        let reconnect = |message: &str| (SupermarketState::ReconnectRequired, message.to_owned());
        if attempt.expired() {
            return Err((
                SupermarketState::Expired,
                "Gurkerl sign-in timed out. Try connecting again.".into(),
            ));
        }
        if params.contains_key("error") {
            return Err((
                SupermarketState::Denied,
                "Gurkerl sign-in was cancelled or denied. Try connecting again.".into(),
            ));
        }
        let code = params
            .get("code")
            .filter(|code| !code.is_empty())
            .ok_or_else(|| {
                reconnect("Gurkerl sign-in could not be verified. Try connecting again.")
            })?;
        let tokens = self.gurkerl().exchange(attempt, code).map_err(reconnect)?;
        self.update_cart_record(person, |record| {
            record.registration = Some(attempt.registration.clone());
            record.tokens = Some(tokens);
            record.notice = None;
        })
        .map_err(|_| reconnect(PROTECT_FAILED))
    }

    /// Forgets the Gurkerl session on this device. The cart itself and the
    /// shopping list are unchanged.
    pub fn supermarket_sign_out(&self, principal: &Principal) -> Result<SupermarketStatus> {
        principal.require_personal()?;
        self.require_device()?;
        {
            let _guard = self
                .inner
                .supermarket
                .lock
                .lock()
                .expect("cart lock poisoned");
            self.inner
                .secrets
                .delete(&record_key(principal.person_id()))?;
        }
        self.publish_supermarket(principal.person_id());
        self.supermarket_status(principal)
    }

    /// A usable access token, refreshed first when it is about to expire.
    /// `stale` names a token the supermarket just refused.
    fn cart_access_token(&self, person: &str, stale: Option<&str>) -> Result<String> {
        let _guard = self
            .inner
            .supermarket
            .lock
            .lock()
            .expect("cart lock poisoned");
        let mut record = self.load_cart_record(person)?;
        let (Some(tokens), Some(registration)) =
            (record.tokens.clone(), record.registration.clone())
        else {
            return Err(reconnect(
                "Connect Gurkerl in Settings before filling your cart.",
            ));
        };
        if tokens.fresh() && stale != Some(tokens.access_token.as_str()) {
            return Ok(tokens.access_token);
        }
        match self.gurkerl().refresh(&registration, &tokens) {
            Ok(Some(renewed)) => {
                let access = renewed.access_token.clone();
                record.tokens = Some(renewed);
                self.inner
                    .secrets
                    .set(&record_key(person), &serde_json::to_string(&record)?)?;
                Ok(access)
            }
            Ok(None) => {
                let message = "Your Gurkerl session ended. Connect again in Settings.";
                record.tokens = None;
                record.notice = Some(Notice {
                    state: Some(SupermarketState::ReconnectRequired),
                    message: message.into(),
                });
                self.inner
                    .secrets
                    .set(&record_key(person), &serde_json::to_string(&record)?)?;
                drop(_guard);
                self.publish_supermarket(person);
                Err(reconnect(message))
            }
            Err(_) => Err(Error::new(
                ErrorKind::Unavailable,
                "Gurkerl could not be reached. Try again.",
            )),
        }
    }

    /// Fills the person's Gurkerl cart from the reviewed shopping list:
    /// generated and manual items at their reviewed quantities, except items
    /// already checked off. The list is read, never changed. When nothing
    /// could be added this fails; once Gurkerl confirmed anything, the result
    /// reports exactly what it confirmed even if the handoff stopped early.
    pub fn fill_supermarket_cart(
        &self,
        principal: &Principal,
        request: FillCart,
    ) -> Result<CartHandoff> {
        principal.require_personal()?;
        self.require_device()?;
        let view = self
            .shopping_list(principal)?
            .ok_or_else(|| Error::not_found("Generate a shopping list first."))?;
        let list = view.list;
        if list["id"].as_str() != Some(request.list_id.as_str()) {
            return Err(Error::conflict(
                "The shopping list was replaced. Review the current list, then fill your cart again.",
            ));
        }
        let mut items: Vec<CartItem> = list["items"]
            .as_array()
            .into_iter()
            .flatten()
            .chain(list["manualItems"].as_array().into_iter().flatten())
            .map(|item| CartItem {
                item_id: item["id"].as_str().unwrap_or_default().to_owned(),
                name: item["name"].as_str().unwrap_or_default().to_owned(),
                quantity: item["quantity"].as_f64(),
                unit: item["unit"].clone(),
                status: if item["checked"] == true {
                    CartItemStatus::Skipped
                } else {
                    CartItemStatus::NotAdded
                },
                product: None,
                note: None,
            })
            .collect();
        let wanted: Vec<Value> = items
            .iter()
            .filter(|item| item.status != CartItemStatus::Skipped)
            .map(|item| {
                json!({"id": item.item_id, "name": item.name, "quantity": item.quantity, "unit": item.unit})
            })
            .collect();
        if wanted.is_empty() {
            return Err(Error::invalid(
                "Every item on this list is already checked off, so there is nothing to add to your cart.",
            ));
        }
        let preferences = self.ai_preferences(principal)?.cart_prompt;
        let person = principal.person_id();
        let gurkerl = self.gurkerl();
        let unreachable = || {
            Error::new(
                ErrorKind::Unavailable,
                "Gurkerl could not be reached. Nothing was added to your cart. Your shopping list was not changed.",
            )
        };
        let access = self.cart_access_token(person, None)?;
        let mut session = match gurkerl.connect(&access) {
            Err(Failure::Unauthorized) => {
                let renewed = self.cart_access_token(person, Some(&access))?;
                gurkerl.connect(&renewed).map_err(|failure| {
                    if failure == Failure::Unauthorized {
                        let message = "Gurkerl needs reconnection. Connect again in Settings.";
                        self.set_cart_notice(person, SupermarketState::ReconnectRequired, message);
                        let _ = self.update_cart_record(person, |record| record.tokens = None);
                        reconnect(message)
                    } else {
                        unreachable()
                    }
                })?
            }
            other => other.map_err(|_| unreachable())?,
        };
        let tools: BTreeMap<String, (Tool, Access)> = session
            .tools()
            .map_err(|_| unreachable())?
            .into_iter()
            .filter_map(|tool| tool_access(&tool).map(|access| (tool.name.clone(), (tool, access))))
            .collect();
        if !tools
            .values()
            .any(|(_, access)| *access == Access::AddToCart)
        {
            return Err(Error::new(
                ErrorKind::Unavailable,
                "Gurkerl does not offer adding products to your cart right now. Nothing was added. Your shopping list was not changed.",
            ));
        }
        let offered: Vec<&Tool> = tools.values().map(|(tool, _)| tool).collect();
        let mut progress: HashMap<String, Progress> = HashMap::new();
        let mut transcript: Vec<Value> = Vec::new();
        let mut decisions: Option<Vec<Decision>> = None;
        let mut stopped: Option<Error> = None;
        for turn in 0..MAX_TURNS {
            let Some(input) = fitted_input(
                &preferences,
                &wanted,
                &offered,
                &mut transcript,
                MAX_TURNS - turn,
            ) else {
                stopped = Some(Error::new(
                    ErrorKind::Unavailable,
                    "This shopping list is too large to choose products for in one handoff.",
                ));
                break;
            };
            let text = match self.ai_execute(
                principal,
                AiRequest {
                    model: request.model.clone(),
                    instructions: HANDOFF_CONTRACT.to_owned(),
                    input,
                    image: None,
                },
            ) {
                Ok(text) => text,
                Err(error) => {
                    stopped = Some(error);
                    break;
                }
            };
            let calls = match read_reply(&text) {
                Some(Reply::Done { items }) => {
                    decisions = Some(items);
                    break;
                }
                Some(Reply::Calls(calls)) if !calls.is_empty() => calls,
                _ => {
                    stopped = Some(Error::invalid(
                        "ChatGPT returned an answer Forkcast could not use while choosing products.",
                    ));
                    break;
                }
            };
            for call in calls.into_iter().take(MAX_CALLS_PER_TURN) {
                let Some((_, kind)) = tools.get(&call.tool) else {
                    transcript.push(json!({
                        "call": {"tool": call.tool, "arguments": call.arguments},
                        "refused": "Forkcast does not allow this tool.",
                    }));
                    continue;
                };
                let arguments = if call.arguments.is_object() {
                    call.arguments
                } else {
                    json!({})
                };
                let result = match session.call(&call.tool, &arguments) {
                    Ok(result) => result,
                    Err(_) => {
                        stopped = Some(Error::new(
                            ErrorKind::Unavailable,
                            "Gurkerl stopped responding while your cart was being filled.",
                        ));
                        break;
                    }
                };
                if *kind == Access::AddToCart {
                    for id in &call.item_ids {
                        if let Some(entry) = wanted
                            .iter()
                            .any(|item| item["id"] == id.as_str())
                            .then(|| progress.entry(id.clone()).or_default())
                        {
                            if result.is_error {
                                entry.failed = true;
                            } else {
                                entry.added = true;
                                entry.product =
                                    clipped(call.product.clone(), 200).or(entry.product.take());
                            }
                        }
                    }
                }
                transcript.push(json!({
                    "call": {"tool": call.tool, "arguments": arguments, "itemIds": call.item_ids},
                    "isError": result.is_error,
                    "result": result.text.chars().take(MAX_TRANSCRIPT_RESULT).collect::<String>(),
                }));
            }
            if stopped.is_some() {
                break;
            }
        }
        for decision in decisions.iter().flatten() {
            if let Some(entry) = wanted
                .iter()
                .any(|item| item["id"] == decision.item_id.as_str())
                .then(|| progress.entry(decision.item_id.clone()).or_default())
            {
                if entry.product.is_none() || !entry.added {
                    entry.product = clipped(decision.product.clone(), 200);
                }
                entry.note = clipped(decision.note.clone(), 300);
            }
        }
        let touched = progress.values().any(|entry| entry.added || entry.failed);
        let complete = decisions.is_some();
        if !complete && stopped.is_none() {
            stopped = Some(Error::new(
                ErrorKind::Unavailable,
                "Choosing products took too many steps, so Forkcast stopped.",
            ));
        }
        if let Some(error) = &stopped
            && !touched
        {
            return Err(Error::new(
                error.kind,
                format!(
                    "{} Nothing was added to your Gurkerl cart. Your shopping list was not changed.",
                    error.message
                ),
            ));
        }
        for item in &mut items {
            if item.status == CartItemStatus::Skipped {
                continue;
            }
            let entry = progress.remove(&item.item_id).unwrap_or_default();
            item.status = if entry.added {
                CartItemStatus::Added
            } else if entry.failed {
                CartItemStatus::Failed
            } else {
                CartItemStatus::NotAdded
            };
            item.product = if item.status == CartItemStatus::NotAdded {
                None
            } else {
                entry.product
            };
            item.note = match item.status {
                CartItemStatus::Failed => Some(
                    entry
                        .note
                        .unwrap_or_else(|| "Gurkerl did not accept this product.".into()),
                ),
                CartItemStatus::NotAdded => Some(entry.note.unwrap_or_else(|| {
                    if complete {
                        "No product was added for this item.".into()
                    } else {
                        "Not reached before the handoff stopped.".into()
                    }
                })),
                _ => entry.note,
            };
        }
        Ok(CartHandoff {
            list_id: request.list_id,
            complete,
            message: stopped.map(|error| {
                format!(
                    "{} Items marked as added are in your Gurkerl cart; add the rest there or try again. Your shopping list was not changed.",
                    error.message
                )
            }),
            items,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tool(name: &str, read_only: bool) -> Tool {
        Tool {
            name: name.into(),
            description: String::new(),
            input_schema: json!({}),
            read_only,
        }
    }

    #[test]
    fn tools_that_read_or_add_to_the_cart_are_offered_and_nothing_else() {
        let judged = |name: &str, read_only: bool| tool_access(&tool(name, read_only));
        assert!(judged("search_products", false) == Some(Access::Read));
        assert!(judged("getOrderHistory", false) == Some(Access::Read));
        assert!(judged("product_details", true) == Some(Access::Read));
        assert!(judged("add_items_to_cart", false) == Some(Access::AddToCart));
        assert!(judged("addToCart", false) == Some(Access::AddToCart));
        assert!(judged("update_cart_item", false) == Some(Access::AddToCart));
        for refused in [
            "checkout",
            "checkout_cart",
            "place_order",
            "create_order",
            "remove_from_cart",
            "clear_cart",
            "reorder_previous_order",
            "book_delivery_slot",
            "pay_cart",
            "submit_claim",
            "set_address",
        ] {
            assert!(judged(refused, false).is_none(), "{refused} was offered");
        }
        assert!(judged("get_checkout_and_pay", true).is_none());
    }

    #[test]
    fn long_transcripts_shorten_the_oldest_results_to_fit() {
        let tools = [tool("search_products", true)];
        let offered: Vec<&Tool> = tools.iter().collect();
        let items = [json!({"id": "pasta", "name": "Pasta"})];
        let mut transcript: Vec<Value> = (0..30)
            .map(|index| json!({"call": index, "result": "x".repeat(MAX_TRANSCRIPT_RESULT)}))
            .collect();
        let input = fitted_input("Cheapest.", &items, &offered, &mut transcript, 3).unwrap();
        assert!(input.len() <= MAX_INPUT);
        assert!(
            transcript[0]["result"]
                .as_str()
                .unwrap()
                .ends_with("(shortened)")
        );
        assert_eq!(
            transcript[29]["result"].as_str().unwrap().len(),
            MAX_TRANSCRIPT_RESULT
        );
        let huge = [json!({"id": "x", "name": "y".repeat(MAX_INPUT)})];
        assert!(fitted_input("", &huge, &offered, &mut transcript, 1).is_none());
    }

    #[test]
    fn replies_are_read_with_or_without_a_code_fence() {
        assert!(matches!(
            read_reply("```json\n{\"calls\":[{\"tool\":\"search\",\"arguments\":{}}]}\n```"),
            Some(Reply::Calls(calls)) if calls.len() == 1
        ));
        assert!(matches!(
            read_reply("{\"done\":{\"items\":[]}}"),
            Some(Reply::Done { .. })
        ));
        assert!(read_reply("I added everything.").is_none());
    }
}
