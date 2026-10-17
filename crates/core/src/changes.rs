use crate::principal::Principal;
use serde::Serialize;
use std::{
    sync::{
        Mutex,
        mpsc::{Receiver, Sender, channel},
    },
    time::Duration,
};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Topic {
    /// Recipes, cover photos, nutrition versions, and recipe conflicts.
    Recipes,
    /// A person's recipe ratings.
    Ratings,
    /// The meal plan and the shopping list.
    Planning,
    CookingSessions,
    FoodLog,
    /// A person's AI preferences. Never includes credentials.
    Preferences,
    /// The server binding or pending synchronization work.
    Sync,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", content = "id", rename_all = "camelCase")]
pub enum Scope {
    Household(String),
    Person(String),
}

/// Published only after the transaction that caused it has committed. It
/// identifies what to reload, never what changed.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Change {
    pub scope: Scope,
    pub topic: Topic,
}

#[derive(Default)]
pub(crate) struct Effects {
    pub(crate) changes: Vec<Change>,
    /// Pending synchronization work was queued; wake the sync worker.
    pub(crate) queued: bool,
}

impl Effects {
    pub(crate) fn household(&mut self, principal: &Principal, topic: Topic) {
        self.push(Scope::Household(principal.household_id().to_owned()), topic);
    }

    pub(crate) fn person(&mut self, principal: &Principal, topic: Topic) {
        self.push(Scope::Person(principal.person_id().to_owned()), topic);
    }

    pub(crate) fn household_id(&mut self, id: &str, topic: Topic) {
        self.push(Scope::Household(id.to_owned()), topic);
    }

    pub(crate) fn person_id(&mut self, id: &str, topic: Topic) {
        self.push(Scope::Person(id.to_owned()), topic);
    }

    fn push(&mut self, scope: Scope, topic: Topic) {
        let change = Change { scope, topic };
        if !self.changes.contains(&change) {
            self.changes.push(change);
        }
    }
}

struct Subscriber {
    household_id: String,
    person_id: String,
    sender: Sender<Change>,
}

#[derive(Default)]
pub(crate) struct Hub {
    subscribers: Mutex<Vec<Subscriber>>,
}

impl Hub {
    pub(crate) fn subscribe(&self, principal: &Principal) -> Subscription {
        let (sender, receiver) = channel();
        self.subscribers
            .lock()
            .expect("change subscribers poisoned")
            .push(Subscriber {
                household_id: principal.household_id().to_owned(),
                person_id: principal.person_id().to_owned(),
                sender,
            });
        Subscription { receiver }
    }

    pub(crate) fn publish(&self, changes: Vec<Change>) {
        if changes.is_empty() {
            return;
        }
        let mut subscribers = self
            .subscribers
            .lock()
            .expect("change subscribers poisoned");
        subscribers.retain(|subscriber| {
            changes
                .iter()
                .filter(|change| match &change.scope {
                    Scope::Household(id) => *id == subscriber.household_id,
                    Scope::Person(id) => *id == subscriber.person_id,
                })
                .all(|change| subscriber.sender.send(change.clone()).is_ok())
        });
    }
}

/// Changes visible to one principal. Dropping it unsubscribes.
pub struct Subscription {
    receiver: Receiver<Change>,
}

impl Subscription {
    pub fn try_next(&self) -> Option<Change> {
        self.receiver.try_recv().ok()
    }

    /// Blocks up to `timeout`; `None` means nothing changed in that time.
    pub fn next_timeout(&self, timeout: Duration) -> Option<Change> {
        self.receiver.recv_timeout(timeout).ok()
    }
}
