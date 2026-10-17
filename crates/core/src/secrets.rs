//! Runtime secrets such as remote session tokens. They are never stored with
//! application data and never leave the core except to the server they belong
//! to. Hosts supply protected storage (DPAPI, Keystore, ...); the default
//! keeps secrets in memory, so a restart requires signing in again.

use crate::error::Result;
use std::{collections::HashMap, sync::Mutex};

pub trait Secrets: Send + Sync {
    fn get(&self, key: &str) -> Result<Option<String>>;
    fn set(&self, key: &str, value: &str) -> Result<()>;
    fn delete(&self, key: &str) -> Result<()>;
}

#[derive(Default)]
pub struct MemorySecrets(Mutex<HashMap<String, String>>);

impl Secrets for MemorySecrets {
    fn get(&self, key: &str) -> Result<Option<String>> {
        Ok(self.0.lock().expect("secrets poisoned").get(key).cloned())
    }

    fn set(&self, key: &str, value: &str) -> Result<()> {
        self.0
            .lock()
            .expect("secrets poisoned")
            .insert(key.to_owned(), value.to_owned());
        Ok(())
    }

    fn delete(&self, key: &str) -> Result<()> {
        self.0.lock().expect("secrets poisoned").remove(key);
        Ok(())
    }
}
