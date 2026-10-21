//! ChatGPT connection and AI execution, shared by installed apps and the
//! household server.
//!
//! One person has one connection, held by exactly one runtime that owns
//! refreshing it:
//!
//! - A **standalone** installation signs in on its own device (loopback
//!   listener, system browser) and executes against ChatGPT directly.
//! - A **joined** installation never executes with a device credential. The
//!   person explicitly chooses the server and account, signs in locally using
//!   the *server's* host identity, and hands the session to the server over
//!   the authenticated connection. While the handoff is unresolved the local
//!   copy is fenced: it is never refreshed or used, so two runtimes can never
//!   rotate one refresh token. The handoff is identified by a transfer id, so
//!   a lost acknowledgement is retried safely, and a cancellation is only
//!   complete once the server confirms it never imported the session.
//! - The **server** holds the imported session in protected storage keyed by
//!   the authenticated account, refreshes it, and executes for that account's
//!   devices and browsers. Request content never names the account.
//!
//! Credentials live only in [`crate::Secrets`]: never in the database, in
//! operation results, in change notifications, or in logs.

mod loopback;
mod provider;

use crate::{
    Core,
    changes::{Change, Scope, Topic},
    error::{Error, ErrorKind, Result},
    principal::{Principal, Standing},
    remote::Remote,
    sync::{self, session_key},
};
use provider::{Attempt, Connection, Failure, Provider, Tokens, now};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::{
    collections::HashMap,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use uuid::Uuid;

const HOST_KEY: &str = "ai-host";
const MAX_FIELD: usize = 64_000;
/// Refresh slightly early so a request never starts with a nearly dead token.
const REFRESH_MARGIN: u64 = 60;

/// Which authorization service this core talks to. Production is the only
/// choice for released builds; hosts may point debug builds at a loopback
/// fixture.
#[derive(Clone)]
pub struct AiConfig {
    issuer: String,
}

impl AiConfig {
    pub fn production() -> Self {
        Self {
            issuer: provider::PRODUCTION_ISSUER.to_owned(),
        }
    }

    /// An isolated authorization fixture on the loopback interface, for tests.
    pub fn fixture(issuer: &str) -> Result<Self> {
        let url = url::Url::parse(issuer)
            .map_err(|_| Error::invalid("The authorization fixture address is not valid."))?;
        if url.scheme() != "http"
            || url.host_str() != Some("127.0.0.1")
            || url.path() != "/"
            || url.query().is_some()
            || url.fragment().is_some()
            || !url.username().is_empty()
            || url.password().is_some()
        {
            return Err(Error::invalid(
                "An authorization fixture must be a plain loopback HTTP address.",
            ));
        }
        Ok(Self {
            issuer: issuer.trim_end_matches('/').to_owned(),
        })
    }
}

impl Default for AiConfig {
    fn default() -> Self {
        Self::production()
    }
}

#[derive(Default)]
pub(crate) struct Runtime {
    /// Serializes every read-modify-write of connection records, including
    /// rotating-token refresh.
    lock: Mutex<()>,
    /// Sign-in attempts in progress, by person.
    attempts: Mutex<HashMap<String, Arc<AtomicBool>>>,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AiState {
    Unconfigured,
    /// Waiting for the person to finish signing in.
    Authorizing,
    Connected,
    Denied,
    /// The sign-in attempt or the session ran out.
    Expired,
    ReconnectRequired,
    /// A session is being handed to the server.
    Transferring,
    TransferFailed,
    /// The server or provider cannot be reached right now.
    Unavailable,
}

/// What the interface shows. Never contains a credential.
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiStatus {
    pub state: AiState,
    /// `device` executes with a credential on this device; `server` executes
    /// on the household server for this account.
    pub target: String,
    pub email: Option<String>,
    pub message: Option<String>,
    pub server_url: Option<String>,
    pub account: Option<String>,
    /// Sign-in can be started from this host (installed app only).
    pub can_authorize: bool,
    pub can_retry: bool,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiModel {
    pub slug: String,
    pub display_name: String,
}

/// The explicit choice a joined installation must make before any server
/// access is granted.
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ServerSelection {
    pub server_url: String,
    pub account_id: String,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AiRequest {
    pub model: String,
    pub instructions: String,
    pub input: String,
}

#[derive(Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum NoticeKind {
    Denied,
    Expired,
    ReconnectRequired,
    TransferFailed,
    SignedOut,
}

#[derive(Clone, Serialize, Deserialize)]
struct Notice {
    kind: NoticeKind,
    message: String,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Handoff {
    transfer_id: String,
    server_url: String,
    account_id: String,
    /// The person chose to cancel; completes only when the server confirms.
    canceling: bool,
}

#[derive(Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
enum Owner {
    /// This runtime owns the session and refreshes it.
    #[default]
    Here,
    /// The session is fenced while it is handed to the server.
    Handoff(Handoff),
}

#[derive(Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct Record {
    issuer: String,
    host_id: String,
    client_id: Option<String>,
    subject: Option<String>,
    email: Option<String>,
    tokens: Option<Tokens>,
    owner: Owner,
    notice: Option<Notice>,
    /// Server side: the handoff this session came from.
    imported_transfer: Option<String>,
}

/// The wire body of a session handoff. Sent only native-to-server over the
/// authenticated connection, never stored in the database.
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CredentialTransfer {
    issuer: String,
    host_id: String,
    client_id: String,
    subject: String,
    email: Option<String>,
    tokens: Tokens,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferAck {
    pub transfer_id: String,
    pub state: String,
}

struct ServerContext {
    server_url: String,
    certificate: Option<String>,
    account_id: String,
    username: Option<String>,
    token: String,
}

impl ServerContext {
    fn remote(&self, timeout: Duration) -> Remote {
        Remote::with_timeout(
            &self.server_url,
            self.certificate.as_deref(),
            Some(self.token.clone()),
            timeout,
        )
    }
}

enum Route {
    /// This host is the household server.
    Hosted,
    /// A standalone installation.
    Device,
    /// A joined installation; AI runs on the server.
    Server(ServerContext),
}

enum Destination {
    Device,
    Handoff(Handoff),
}

fn record_key(person: &str) -> String {
    format!("ai:{person}")
}

fn canceled_key(person: &str, transfer: &str) -> String {
    format!("ai-canceled:{person}:{transfer}")
}

fn failure_error(failure: &Failure) -> Error {
    let kind = match failure {
        Failure::Unauthorized => ErrorKind::ConnectionRequired,
        Failure::Limited => ErrorKind::RateLimited,
        Failure::Declined => ErrorKind::Invalid,
        Failure::Rejected(_) | Failure::Unavailable => ErrorKind::Unavailable,
    };
    Error::new(kind, failure.message())
}

fn reconnect(message: &str) -> Error {
    Error::new(ErrorKind::ConnectionRequired, message)
}

fn validate_request(request: &AiRequest) -> Result<()> {
    if request.model.trim().is_empty()
        || request.model.len() > 200
        || request.instructions.len() > MAX_FIELD
        || request.input.trim().is_empty()
        || request.input.len() > MAX_FIELD
    {
        return Err(Error::invalid(
            "Provide a model and instructions within the request limits.",
        ));
    }
    Ok(())
}

const CALLBACK_OK: &str = "<!doctype html><title>ChatGPT connected</title><h1>ChatGPT connected</h1><p>Return to Forkcast. You can close this window.</p>";
const CALLBACK_FAILED: &str = "<!doctype html><title>ChatGPT sign-in incomplete</title><h1>ChatGPT sign-in incomplete</h1><p>Return to Forkcast settings and try connecting again.</p>";

impl Core {
    fn provider(&self) -> Provider {
        Provider::new(&self.inner.ai_config.issuer)
    }

    fn publish_ai(&self, person: &str) {
        self.inner.hub.publish(vec![Change {
            scope: Scope::Person(person.to_owned()),
            topic: Topic::Ai,
        }]);
    }

    /// The identity this runtime presents to the provider. Stable per device
    /// and per server.
    fn host_identity(&self) -> Result<String> {
        let _guard = self.inner.ai.lock.lock().expect("ai lock poisoned");
        if let Some(existing) = self.inner.secrets.get(HOST_KEY)? {
            return Ok(existing);
        }
        let id = Uuid::new_v4().urn().to_string();
        self.inner.secrets.set(HOST_KEY, &id)?;
        Ok(id)
    }

    fn load_record(&self, person: &str) -> Result<Record> {
        let Some(stored) = self.inner.secrets.get(&record_key(person))? else {
            return Ok(Record::default());
        };
        let Ok(mut record) = serde_json::from_str::<Record>(&stored) else {
            return Ok(Record {
                notice: Some(Notice {
                    kind: NoticeKind::ReconnectRequired,
                    message: "The saved ChatGPT connection could not be read. Connect again."
                        .into(),
                }),
                ..Record::default()
            });
        };
        if !record.issuer.is_empty() && record.issuer != self.inner.ai_config.issuer {
            record = Record {
                notice: Some(Notice {
                    kind: NoticeKind::ReconnectRequired,
                    message: "The saved ChatGPT connection belongs to a different authorization service. Connect again.".into(),
                }),
                ..Record::default()
            };
        }
        Ok(record)
    }

    fn store_record(&self, person: &str, record: &Record) -> Result<()> {
        let mut record = record.clone();
        record.issuer = self.inner.ai_config.issuer.clone();
        self.inner
            .secrets
            .set(&record_key(person), &serde_json::to_string(&record)?)
    }

    fn delete_record(&self, person: &str) -> Result<()> {
        self.inner.secrets.delete(&record_key(person))
    }

    /// Applies `change` to the person's record under the connection lock.
    fn update_record<T>(&self, person: &str, change: impl FnOnce(&mut Record) -> T) -> Result<T> {
        let _guard = self.inner.ai.lock.lock().expect("ai lock poisoned");
        let mut record = self.load_record(person)?;
        let value = change(&mut record);
        self.store_record(person, &record)?;
        Ok(value)
    }

    fn set_notice(&self, person: &str, kind: NoticeKind, message: &str) -> Result<()> {
        self.update_record(person, |record| {
            record.notice = Some(Notice {
                kind,
                message: message.to_owned(),
            });
        })?;
        self.publish_ai(person);
        Ok(())
    }

    fn route(&self, principal: &Principal) -> Result<Route> {
        if !self.is_embedded()? {
            return Ok(Route::Hosted);
        }
        let (binding, state) = self.read(|db| Ok((sync::binding(db)?, sync::state(db)?)))?;
        let (Some(binding), Some(state)) = (binding, state) else {
            return Ok(Route::Device);
        };
        let account = state
            .active_account
            .filter(|account| account == principal.person_id())
            .ok_or_else(|| Error::forbidden("This record is outside your account or household."))?;
        let token = if state.signed_out {
            None
        } else {
            self.inner.secrets.get(&session_key(&account))?
        };
        let token = token.ok_or_else(|| {
            Error::new(
                ErrorKind::Unauthenticated,
                "Sign in to your household to use ChatGPT through its server.",
            )
        })?;
        let username = self.read(|db| {
            Ok(rusqlite::OptionalExtension::optional(db.query_row(
                "SELECT username FROM remote_accounts WHERE account_id = ?",
                [&account],
                |row| row.get::<_, Option<String>>(0),
            ))?
            .flatten())
        })?;
        Ok(Route::Server(ServerContext {
            server_url: binding.server_url,
            certificate: binding.certificate,
            account_id: account,
            username,
            token,
        }))
    }

    // ----- status ---------------------------------------------------------

    /// The connection state for the principal's execution target.
    pub fn ai_status(&self, principal: &Principal) -> Result<AiStatus> {
        if principal.standing() == Standing::SignedOut {
            return Ok(AiStatus {
                state: AiState::Unavailable,
                target: "server".into(),
                email: None,
                message: Some(
                    "Sign in to your household to use ChatGPT through its server. Manual workflows remain available.".into(),
                ),
                server_url: None,
                account: None,
                can_authorize: false,
                can_retry: false,
            });
        }
        principal.require_personal()?;
        match self.route(principal) {
            Ok(Route::Hosted) => Ok(self.local_status(principal.person_id(), "server", false)?),
            Ok(Route::Device) => Ok(self.local_status(principal.person_id(), "device", true)?),
            Ok(Route::Server(context)) => {
                let mut status = self.local_status(principal.person_id(), "server", true)?;
                status.server_url = Some(context.server_url.clone());
                status.account = context.username.clone();
                let handoff = matches!(
                    self.load_record(principal.person_id())?.owner,
                    Owner::Handoff(_)
                );
                if handoff || status.state == AiState::Authorizing {
                    return Ok(status);
                }
                match context.remote(Duration::from_secs(8)).call(
                    "POST",
                    "/operations",
                    Some(&json!({"operation": "aiStatus"})),
                ) {
                    Ok(value) => {
                        let mut remote: AiStatus = serde_json::from_value(value).map_err(|_| {
                            Error::invalid("The server sent a ChatGPT status this app cannot read.")
                        })?;
                        remote.target = "server".into();
                        remote.server_url = Some(context.server_url);
                        remote.account = context.username;
                        remote.can_authorize = true;
                        Ok(remote)
                    }
                    Err(error) => {
                        status.state = AiState::Unavailable;
                        status.message = Some(match error.kind {
                            ErrorKind::Unauthenticated => {
                                "Your household session ended. Sign in again to use ChatGPT.".into()
                            }
                            _ => format!(
                                "{} Manual workflows remain available.",
                                error.message.trim_end()
                            ),
                        });
                        Ok(status)
                    }
                }
            }
            Err(error)
                if matches!(
                    error.kind,
                    ErrorKind::Unauthenticated | ErrorKind::Forbidden
                ) =>
            {
                Ok(AiStatus {
                    state: AiState::Unavailable,
                    target: "server".into(),
                    email: None,
                    message: Some(error.message),
                    server_url: None,
                    account: None,
                    can_authorize: false,
                    can_retry: false,
                })
            }
            Err(error) => Err(error),
        }
    }

    fn local_status(&self, person: &str, target: &str, can_authorize: bool) -> Result<AiStatus> {
        let _guard = self.inner.ai.lock.lock().expect("ai lock poisoned");
        let record = self.load_record(person)?;
        let authorizing = self
            .inner
            .ai
            .attempts
            .lock()
            .expect("ai attempts poisoned")
            .contains_key(person);
        let notice = record.notice.as_ref();
        let mut can_retry = false;
        let state = if authorizing {
            AiState::Authorizing
        } else if let Owner::Handoff(_) = &record.owner {
            can_retry = true;
            if notice.is_some_and(|n| n.kind == NoticeKind::TransferFailed) {
                AiState::TransferFailed
            } else {
                AiState::Transferring
            }
        } else if record.tokens.is_some() {
            AiState::Connected
        } else {
            match notice.map(|n| n.kind) {
                Some(NoticeKind::Denied) => AiState::Denied,
                Some(NoticeKind::Expired) => AiState::Expired,
                Some(NoticeKind::ReconnectRequired) => AiState::ReconnectRequired,
                _ => AiState::Unconfigured,
            }
        };
        let message = match state {
            AiState::Unconfigured if target == "server" && !can_authorize => Some(
                "Set up ChatGPT in the installed Forkcast app, choosing this server and your account."
                    .to_owned(),
            ),
            AiState::Authorizing => None,
            _ => notice.map(|n| n.message.clone()),
        };
        Ok(AiStatus {
            state,
            target: target.to_owned(),
            email: record
                .email
                .clone()
                .filter(|_| record.tokens.is_some() || state == AiState::Transferring),
            message,
            server_url: None,
            account: None,
            can_authorize,
            can_retry,
        })
    }

    // ----- sign-in --------------------------------------------------------

    /// Starts sign-in: binds the loopback listener, then returns the address
    /// the host opens in the person's own browser. A joined installation must
    /// name the server and account it is granting access to.
    pub fn ai_authorize(
        &self,
        principal: &Principal,
        selection: Option<ServerSelection>,
    ) -> Result<String> {
        principal.require_personal()?;
        let person = principal.person_id().to_owned();
        let (host_id, destination) = match self.route(principal)? {
            Route::Hosted => {
                return Err(Error::forbidden(
                    "ChatGPT is connected from the installed Forkcast app. Open it, choose this server and your account, and set up ChatGPT there.",
                ));
            }
            Route::Device => (self.host_identity()?, Destination::Device),
            Route::Server(context) => {
                let selected = selection.ok_or_else(|| {
                    Error::invalid("Choose the server and account that may use your ChatGPT plan.")
                })?;
                if selected.server_url.trim_end_matches('/')
                    != context.server_url.trim_end_matches('/')
                    || selected.account_id != context.account_id
                {
                    return Err(Error::invalid(
                        "The chosen server or account does not match your current household sign-in.",
                    ));
                }
                if matches!(self.load_record(&person)?.owner, Owner::Handoff(_)) {
                    return Err(Error::conflict(
                        "A ChatGPT transfer to the server is unfinished. Retry or cancel it first.",
                    ));
                }
                let host = context
                    .remote(Duration::from_secs(8))
                    .call("GET", "/ai/host", None)?;
                let host_id = host["hostId"]
                    .as_str()
                    .filter(|id| id.starts_with("urn:uuid:"))
                    .ok_or_else(|| {
                        Error::invalid("The server sent an identity this app cannot use.")
                    })?
                    .to_owned();
                (
                    host_id,
                    Destination::Handoff(Handoff {
                        transfer_id: Uuid::new_v4().to_string(),
                        server_url: context.server_url,
                        account_id: context.account_id,
                        canceling: false,
                    }),
                )
            }
        };
        let listener = loopback::Listener::bind().map_err(|_| {
            Error::new(
                ErrorKind::Unavailable,
                "Forkcast could not start its local sign-in listener. Close other apps using it and try again.",
            )
        })?;
        let redirect = listener.redirect();
        let (client_id, subject) = {
            let _guard = self.inner.ai.lock.lock().expect("ai lock poisoned");
            let mut record = self.load_record(&person)?;
            record.notice = None;
            // A server-bound sign-in never reuses a device registration: the
            // registration belongs to the host identity it was issued for.
            if matches!(destination, Destination::Handoff(_)) {
                record.client_id = None;
                record.subject = None;
            }
            self.store_record(&person, &record)?;
            (record.client_id.clone(), record.subject.clone())
        };
        let (attempt, url) = self.provider().start(
            &host_id,
            &redirect,
            client_id.as_deref(),
            subject.as_deref(),
        );
        let cancel = Arc::new(AtomicBool::new(false));
        if let Some(previous) = self
            .inner
            .ai
            .attempts
            .lock()
            .expect("ai attempts poisoned")
            .insert(person.clone(), cancel.clone())
        {
            previous.store(true, Ordering::SeqCst);
        }
        let core = self.clone();
        std::thread::spawn(move || {
            core.await_callback(
                &person,
                listener,
                attempt,
                redirect,
                host_id,
                destination,
                cancel,
            )
        });
        self.publish_ai(principal.person_id());
        Ok(url)
    }

    /// Stops a sign-in the person no longer wants.
    pub fn ai_cancel_authorization(&self, principal: &Principal) -> Result<AiStatus> {
        if let Some(flag) = self
            .inner
            .ai
            .attempts
            .lock()
            .expect("ai attempts poisoned")
            .remove(principal.person_id())
        {
            flag.store(true, Ordering::SeqCst);
        }
        self.publish_ai(principal.person_id());
        self.ai_status(principal)
    }

    #[allow(clippy::too_many_arguments)]
    fn await_callback(
        &self,
        person: &str,
        listener: loopback::Listener,
        attempt: Attempt,
        redirect: String,
        host_id: String,
        destination: Destination,
        cancel: Arc<AtomicBool>,
    ) {
        let mut outcome: Option<std::result::Result<Option<Handoff>, (NoticeKind, String)>> = None;
        listener.serve(&cancel, attempt.deadline(), |callback| {
            // Callbacks that are not ours never consume the attempt.
            if callback.params.get("state") != Some(&attempt.state) {
                return None;
            }
            let result = self.finish_authorization(
                person,
                &attempt,
                &redirect,
                &host_id,
                &destination,
                &callback.params,
            );
            let page = if result.is_ok() {
                CALLBACK_OK
            } else {
                CALLBACK_FAILED
            };
            outcome = Some(result);
            Some((if page == CALLBACK_OK { 200 } else { 400 }, page))
        });
        let ours = {
            let mut attempts = self.inner.ai.attempts.lock().expect("ai attempts poisoned");
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
            None => {
                let _ = self.set_notice(
                    person,
                    NoticeKind::Expired,
                    "ChatGPT sign-in timed out. Try connecting again.",
                );
            }
            Some(Err((kind, message))) => {
                let _ = self.set_notice(person, kind, &message);
            }
            Some(Ok(None)) => self.publish_ai(person),
            Some(Ok(Some(_))) => {
                self.publish_ai(person);
                let _ = self.deliver_handoff(person);
            }
        }
    }

    /// Verifies the callback and stores the session. Returns the handoff to
    /// deliver when the session is destined for the server.
    fn finish_authorization(
        &self,
        person: &str,
        attempt: &Attempt,
        redirect: &str,
        host_id: &str,
        destination: &Destination,
        params: &HashMap<String, String>,
    ) -> std::result::Result<Option<Handoff>, (NoticeKind, String)> {
        let reconnect = |message: &str| (NoticeKind::ReconnectRequired, message.to_owned());
        if attempt.expired() {
            return Err((
                NoticeKind::Expired,
                "ChatGPT sign-in timed out. Try connecting again.".into(),
            ));
        }
        if params.contains_key("error") {
            return Err((
                NoticeKind::Denied,
                "ChatGPT sign-in was cancelled or denied. Try connecting again.".into(),
            ));
        }
        let client_id =
            Provider::issued_client(attempt, params.get("client_id").map(String::as_str))
                .map_err(reconnect)?;
        let code = params
            .get("code")
            .filter(|code| !code.is_empty())
            .ok_or_else(|| {
                reconnect("ChatGPT callback could not be verified. Try connecting again.")
            })?;
        // Retain an issued registration even if the code exchange fails, so
        // the next attempt never falls back to the dynamic placeholder.
        if matches!(destination, Destination::Device) {
            self.update_record(person, |record| {
                record.client_id = Some(client_id.clone());
                if record.host_id.is_empty() {
                    record.host_id = host_id.to_owned();
                }
            })
            .map_err(|_| reconnect(PROTECT_FAILED))?;
        }
        let Connection {
            subject,
            email,
            tokens,
            client_id,
        } = self
            .provider()
            .exchange(redirect, attempt, &client_id, code)
            .map_err(reconnect)?;
        let handoff = match destination {
            Destination::Device => None,
            Destination::Handoff(handoff) => Some(handoff.clone()),
        };
        let revoke = {
            let _guard = self.inner.ai.lock.lock().expect("ai lock poisoned");
            let mut record = self
                .load_record(person)
                .map_err(|_| reconnect(PROTECT_FAILED))?;
            let previous = record.tokens.take();
            record.host_id = host_id.to_owned();
            record.client_id = Some(client_id);
            record.subject = Some(subject);
            record.email = email;
            record.tokens = Some(tokens);
            record.notice = None;
            record.owner = match &handoff {
                Some(handoff) => Owner::Handoff(handoff.clone()),
                None => Owner::Here,
            };
            if self.store_record(person, &record).is_err() {
                return Err(reconnect(PROTECT_FAILED));
            }
            previous.zip(record.client_id.clone())
        };
        // Replacing a device session retires the old refresh token.
        if let Some((previous, client_id)) = revoke {
            let _ = self.provider().revoke(&client_id, &previous.refresh_token);
        }
        Ok(handoff)
    }

    // ----- handoff to the server -----------------------------------------

    fn server_for(&self, person: &str, handoff: &Handoff) -> Result<ServerContext> {
        let (binding, state) = self.read(|db| Ok((sync::binding(db)?, sync::state(db)?)))?;
        // The handoff goes to the server it started with, under the
        // certificate confirmed for it.
        let certificate = binding
            .filter(|binding| binding.server_url == handoff.server_url)
            .and_then(|binding| binding.certificate);
        let token = match state {
            Some(state)
                if state.active_account.as_deref() == Some(person)
                    && state.active_account.as_deref() == Some(&handoff.account_id)
                    && !state.signed_out =>
            {
                self.inner.secrets.get(&session_key(person))?
            }
            _ => None,
        };
        Ok(ServerContext {
            server_url: handoff.server_url.clone(),
            certificate,
            account_id: handoff.account_id.clone(),
            username: None,
            token: token.ok_or_else(|| {
                Error::new(
                    ErrorKind::Unauthenticated,
                    "Sign in to your household as the same account, then retry the transfer.",
                )
            })?,
        })
    }

    /// Delivers the fenced session to the server. Safe to repeat: the server
    /// answers a transfer it already imported with the same acknowledgement.
    fn deliver_handoff(&self, person: &str) -> Result<()> {
        let (record, handoff) = {
            let _guard = self.inner.ai.lock.lock().expect("ai lock poisoned");
            let record = self.load_record(person)?;
            let Owner::Handoff(handoff) = record.owner.clone() else {
                return Ok(());
            };
            (record, handoff)
        };
        if handoff.canceling {
            return self.cancel_handoff(person);
        }
        let outcome = (|| -> Result<()> {
            let context = self.server_for(person, &handoff)?;
            let tokens = record.tokens.clone().ok_or_else(|| {
                reconnect("The ChatGPT session to transfer is gone. Connect again.")
            })?;
            let body = serde_json::to_value(CredentialTransfer {
                issuer: self.inner.ai_config.issuer.clone(),
                host_id: record.host_id.clone(),
                client_id: record.client_id.clone().unwrap_or_default(),
                subject: record.subject.clone().unwrap_or_default(),
                email: record.email.clone(),
                tokens,
            })?;
            let ack = context.remote(Duration::from_secs(15)).call(
                "POST",
                &format!("/ai/transfers/{}", handoff.transfer_id),
                Some(&body),
            )?;
            if ack["transferId"].as_str() != Some(&handoff.transfer_id)
                || ack["state"].as_str() != Some("active")
            {
                return Err(Error::new(
                    ErrorKind::Unavailable,
                    "The server did not confirm the ChatGPT transfer. Retry it.",
                ));
            }
            Ok(())
        })();
        match outcome {
            Ok(()) => self.complete_handoff(person),
            Err(error) => {
                let message = match error.kind {
                    ErrorKind::Unavailable => format!(
                        "The ChatGPT transfer to your server did not finish: {} Retry when the server is reachable, or cancel.",
                        error.message.trim_end()
                    ),
                    _ => format!(
                        "The ChatGPT transfer to your server did not finish: {} Retry, or cancel.",
                        error.message.trim_end()
                    ),
                };
                self.set_notice(person, NoticeKind::TransferFailed, &message)?;
                Err(error)
            }
        }
    }

    /// The server owns the session: forget the local copy entirely.
    fn complete_handoff(&self, person: &str) -> Result<()> {
        {
            let _guard = self.inner.ai.lock.lock().expect("ai lock poisoned");
            self.delete_record(person)?;
        }
        self.publish_ai(person);
        Ok(())
    }

    fn cancel_handoff(&self, person: &str) -> Result<()> {
        let handoff = {
            let _guard = self.inner.ai.lock.lock().expect("ai lock poisoned");
            let mut record = self.load_record(person)?;
            let Owner::Handoff(handoff) = &mut record.owner else {
                return Ok(());
            };
            handoff.canceling = true;
            let handoff = handoff.clone();
            self.store_record(person, &record)?;
            handoff
        };
        let result = self.server_for(person, &handoff).and_then(|context| {
            context.remote(Duration::from_secs(15)).call(
                "DELETE",
                &format!("/ai/transfers/{}", handoff.transfer_id),
                None,
            )
        });
        match result {
            // The server never imported it and never will: the local copy is
            // the only one, so retire it.
            Ok(_) => {
                let record = {
                    let _guard = self.inner.ai.lock.lock().expect("ai lock poisoned");
                    let record = self.load_record(person)?;
                    self.delete_record(person)?;
                    record
                };
                if let (Some(tokens), Some(client_id)) = (&record.tokens, &record.client_id) {
                    let _ = self.provider().revoke(client_id, &tokens.refresh_token);
                }
                self.publish_ai(person);
                Ok(())
            }
            // The server already imported it: it owns the session.
            Err(error) if error.kind == ErrorKind::Conflict => self.complete_handoff(person),
            Err(error) => {
                self.set_notice(
                    person,
                    NoticeKind::TransferFailed,
                    "The ChatGPT transfer could not be cancelled yet. Forkcast keeps the session unused here until the server confirms. Retry when it is reachable.",
                )?;
                Err(error)
            }
        }
    }

    /// Retries an unfinished handoff (or its cancellation).
    pub fn ai_retry_transfer(&self, principal: &Principal) -> Result<AiStatus> {
        principal.require_personal()?;
        let _ = self.deliver_handoff(principal.person_id());
        self.ai_status(principal)
    }

    /// Gives up on an unfinished handoff. Complete only once the server
    /// confirms it did not import the session.
    pub fn ai_cancel_transfer(&self, principal: &Principal) -> Result<AiStatus> {
        principal.require_personal()?;
        let _ = self.cancel_handoff(principal.person_id());
        self.ai_status(principal)
    }

    /// Resumes an unfinished handoff after a restart or reconnection. Cheap
    /// when there is nothing to resume.
    pub fn resume_ai_handoff(&self) {
        let Ok(principal) = self.current_principal() else {
            return;
        };
        if matches!(
            self.load_record(principal.person_id()).map(|r| r.owner),
            Ok(Owner::Handoff(_))
        ) {
            let _ = self.deliver_handoff(principal.person_id());
        }
    }

    // ----- server side of the handoff ------------------------------------

    /// The server's own provider identity. A session imported for an account
    /// must have been issued to it.
    pub fn ai_host(&self, principal: &Principal) -> Result<String> {
        self.require_hosted(principal)?;
        self.host_identity()
    }

    fn require_hosted(&self, principal: &Principal) -> Result<()> {
        principal.require_personal()?;
        if self.is_embedded()? || !principal.is_server_account() {
            return Err(Error::forbidden(
                "Only a household server accepts a ChatGPT session.",
            ));
        }
        Ok(())
    }

    /// Imports a session for the authenticated account. The account comes
    /// from the verified bearer session, never from the request.
    pub fn ai_import_transfer(
        &self,
        principal: &Principal,
        transfer_id: &str,
        transfer: CredentialTransfer,
    ) -> Result<TransferAck> {
        self.require_hosted(principal)?;
        if Uuid::parse_str(transfer_id).is_err() {
            return Err(Error::invalid("The transfer identifier is not valid."));
        }
        let person = principal.person_id();
        let host = self.host_identity()?;
        let tokens = &transfer.tokens;
        if transfer.issuer != self.inner.ai_config.issuer
            || transfer.host_id != host
            || !transfer.client_id.starts_with("oaiapp_")
            || transfer.client_id.len() > 256
            || transfer.subject.is_empty()
            || tokens.access_token.is_empty()
            || tokens.refresh_token.is_empty()
            || !tokens
                .scope
                .split_whitespace()
                .any(|scope| scope == "chatgpt.tokens.use.direct")
            || tokens.expires_at == 0
        {
            return Err(Error::invalid(
                "This ChatGPT session was not issued to this server. Start the setup again from the app.",
            ));
        }
        let _guard = self.inner.ai.lock.lock().expect("ai lock poisoned");
        if self
            .inner
            .secrets
            .get(&canceled_key(person, transfer_id))?
            .is_some()
        {
            return Err(Error::conflict(
                "This ChatGPT transfer was cancelled. Start the setup again.",
            ));
        }
        let existing = self.load_record(person)?;
        let ack = TransferAck {
            transfer_id: transfer_id.to_owned(),
            state: "active".into(),
        };
        if existing.imported_transfer.as_deref() == Some(transfer_id) {
            return Ok(ack);
        }
        self.store_record(
            person,
            &Record {
                issuer: transfer.issuer,
                host_id: transfer.host_id,
                client_id: Some(transfer.client_id),
                subject: Some(transfer.subject),
                email: transfer.email,
                tokens: Some(transfer.tokens),
                owner: Owner::Here,
                notice: None,
                imported_transfer: Some(transfer_id.to_owned()),
            },
        )?;
        drop(_guard);
        // A session this one replaces is retired.
        if let (Some(old), Some(client_id)) = (existing.tokens, existing.client_id) {
            let _ = self.provider().revoke(&client_id, &old.refresh_token);
        }
        self.publish_ai(person);
        Ok(ack)
    }

    /// Records that a transfer must never be imported. `Conflict` means it
    /// already was, so the caller's cancellation did not take effect.
    pub fn ai_cancel_import(
        &self,
        principal: &Principal,
        transfer_id: &str,
    ) -> Result<TransferAck> {
        self.require_hosted(principal)?;
        if Uuid::parse_str(transfer_id).is_err() {
            return Err(Error::invalid("The transfer identifier is not valid."));
        }
        let person = principal.person_id();
        let _guard = self.inner.ai.lock.lock().expect("ai lock poisoned");
        if self.load_record(person)?.imported_transfer.as_deref() == Some(transfer_id) {
            return Err(Error::conflict(
                "The server already holds this ChatGPT session.",
            ));
        }
        self.inner
            .secrets
            .set(&canceled_key(person, transfer_id), "1")?;
        Ok(TransferAck {
            transfer_id: transfer_id.to_owned(),
            state: "canceled".into(),
        })
    }

    // ----- sign-out -------------------------------------------------------

    /// Stops affected execution, clears this runtime's tokens, and asks the
    /// provider to revoke them. A revocation that is not confirmed stays
    /// visible with recovery guidance.
    pub fn ai_sign_out(&self, principal: &Principal) -> Result<AiStatus> {
        principal.require_personal()?;
        let person = principal.person_id();
        if let Some(flag) = self
            .inner
            .ai
            .attempts
            .lock()
            .expect("ai attempts poisoned")
            .remove(person)
        {
            flag.store(true, Ordering::SeqCst);
        }
        match self.route(principal)? {
            Route::Hosted | Route::Device => self.sign_out_here(person)?,
            Route::Server(context) => {
                if matches!(self.load_record(person)?.owner, Owner::Handoff(_)) {
                    self.cancel_handoff(person)?;
                }
                context.remote(Duration::from_secs(20)).call(
                    "POST",
                    "/operations",
                    Some(&json!({"operation": "aiSignOut"})),
                )?;
            }
        }
        self.publish_ai(person);
        self.ai_status(principal)
    }

    fn sign_out_here(&self, person: &str) -> Result<()> {
        let (tokens, client_id) = {
            let _guard = self.inner.ai.lock.lock().expect("ai lock poisoned");
            let mut record = self.load_record(person)?;
            let tokens = record.tokens.take();
            let client_id = record.client_id.clone();
            // The registration stays; the account does not, so another
            // ChatGPT account can connect afterwards.
            record.subject = None;
            record.email = None;
            record.owner = Owner::Here;
            record.imported_transfer = None;
            record.notice = Some(Notice {
                kind: NoticeKind::SignedOut,
                message: "Signed out of ChatGPT. Connect again when you want to use AI.".into(),
            });
            self.store_record(person, &record)?;
            (tokens, client_id)
        };
        if let (Some(tokens), Some(client_id)) = (tokens, client_id)
            && !self.provider().revoke(&client_id, &tokens.refresh_token)
        {
            self.set_notice(
                person,
                NoticeKind::SignedOut,
                "Signed out locally. Remote revocation was not confirmed. Disconnect Forkcast in ChatGPT Settings to end its remote access.",
            )?;
        }
        Ok(())
    }

    /// Joining a household makes the account's own connection the only one:
    /// a session held for the standalone person is retired, never reused.
    pub(crate) fn ai_discard_device_session(&self, person: &str) {
        let _ = self.sign_out_here(person);
        let _ = self.delete_record(person);
        self.publish_ai(person);
    }

    // ----- execution ------------------------------------------------------

    /// A usable access token for a session this runtime owns, refreshing it
    /// first when it is about to expire.
    fn access_token(&self, person: &str) -> Result<String> {
        let _guard = self.inner.ai.lock.lock().expect("ai lock poisoned");
        let record = self.load_record(person)?;
        match (&record.owner, &record.tokens) {
            (Owner::Handoff(_), _) => Err(Error::new(
                ErrorKind::ConnectionRequired,
                "The ChatGPT session is being transferred to the server. Retry or cancel the transfer in Settings.",
            )),
            (Owner::Here, Some(tokens)) if tokens.expires_at > now() + REFRESH_MARGIN => {
                Ok(tokens.access_token.clone())
            }
            (Owner::Here, Some(_)) => self.refresh_locked(person, record),
            _ => Err(reconnect("Connect ChatGPT in Settings before using AI.")),
        }
    }

    /// Caller holds the connection lock, which serializes rotating-token
    /// refresh. The rotated session is persisted before it is used.
    fn refresh_locked(&self, person: &str, mut record: Record) -> Result<String> {
        let (Some(tokens), Some(client_id)) = (record.tokens.clone(), record.client_id.clone())
        else {
            return Err(reconnect("Connect ChatGPT in Settings before using AI."));
        };
        match self.provider().refresh(&client_id, &tokens) {
            Ok(Some(renewed)) => {
                let access = renewed.access_token.clone();
                record.tokens = Some(renewed);
                self.store_record(person, &record)?;
                Ok(access)
            }
            Ok(None) => {
                record.tokens = None;
                record.notice = Some(Notice {
                    kind: NoticeKind::ReconnectRequired,
                    message: "Your ChatGPT session ended. Connect again in Settings.".into(),
                });
                self.store_record(person, &record)?;
                self.publish_ai(person);
                Err(reconnect(
                    "Your ChatGPT session ended. Connect again in Settings.",
                ))
            }
            Err(failure) => Err(failure_error(&failure)),
        }
    }

    /// Runs a provider call with the person's own session, retrying once
    /// after a refusal that a refresh can repair.
    fn with_session<T>(
        &self,
        person: &str,
        call: impl Fn(&Provider, &str) -> std::result::Result<T, Failure>,
    ) -> Result<T> {
        let provider = self.provider();
        let access = self.access_token(person)?;
        match call(&provider, &access) {
            Err(Failure::Unauthorized) => {
                let renewed = {
                    let _guard = self.inner.ai.lock.lock().expect("ai lock poisoned");
                    let record = self.load_record(person)?;
                    // Another request may already have renewed it.
                    match &record.tokens {
                        Some(tokens) if tokens.access_token != access => {
                            Ok(tokens.access_token.clone())
                        }
                        _ => self.refresh_locked(person, record),
                    }
                }?;
                call(&provider, &renewed).map_err(|failure| {
                    if failure == Failure::Unauthorized {
                        let _ = self.set_notice(
                            person,
                            NoticeKind::ReconnectRequired,
                            "ChatGPT needs reconnection. Connect again in Settings.",
                        );
                        let _ = self.update_record(person, |record| record.tokens = None);
                    }
                    failure_error(&failure)
                })
            }
            other => other.map_err(|failure| failure_error(&failure)),
        }
    }

    /// Models the person's ChatGPT plan can use.
    pub fn ai_models(&self, principal: &Principal) -> Result<Vec<AiModel>> {
        principal.require_personal()?;
        match self.route(principal)? {
            Route::Server(context) => {
                let value = context.remote(Duration::from_secs(15)).call(
                    "POST",
                    "/operations",
                    Some(&json!({"operation": "aiModels"})),
                )?;
                serde_json::from_value(value)
                    .map_err(|_| Error::invalid("The server sent models this app cannot read."))
            }
            Route::Hosted | Route::Device => {
                let models = self.with_session(principal.person_id(), |provider, access| {
                    provider.models(access)
                })?;
                Ok(models
                    .into_iter()
                    .map(|model| AiModel {
                        slug: model.slug,
                        display_name: model.display_name,
                    })
                    .collect())
            }
        }
    }

    /// The one execution interface every AI workflow uses: a workflow supplies
    /// its instructions and input, and gets text back. Validation of what the
    /// text means belongs to the workflow.
    pub fn ai_execute(&self, principal: &Principal, request: AiRequest) -> Result<String> {
        principal.require_personal()?;
        validate_request(&request)?;
        match self.route(principal)? {
            // Never falls back to a device credential: the server's session is
            // the only one this account's requests may use.
            Route::Server(context) => {
                let value = context.remote(Duration::from_secs(190)).call(
                    "POST",
                    "/operations",
                    Some(&json!({
                        "operation": "aiExecute",
                        "model": request.model,
                        "instructions": request.instructions,
                        "input": request.input,
                    })),
                )?;
                value["text"]
                    .as_str()
                    .map(str::to_owned)
                    .ok_or_else(|| Error::invalid("The server sent a reply this app cannot read."))
            }
            Route::Hosted | Route::Device => {
                self.with_session(principal.person_id(), |provider, access| {
                    provider.execute(
                        access,
                        &request.model,
                        &request.instructions,
                        &request.input,
                    )
                })
            }
        }
    }
}

const PROTECT_FAILED: &str =
    "Forkcast could not protect the ChatGPT session. Check its storage permissions and reconnect.";
