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

/// Secrets kept in one owner-only file, replaced atomically on every change.
/// For hosts without a platform keystore (a household server, desktop
/// platforms other than Windows). The directory is created with mode `0700`
/// and the file with `0600`; nothing here is ever written to the database.
#[cfg(unix)]
pub struct FileSecrets {
    path: std::path::PathBuf,
    lock: Mutex<()>,
}

#[cfg(unix)]
impl FileSecrets {
    pub fn open(path: impl Into<std::path::PathBuf>) -> Result<Self> {
        let path = path.into();
        if let Some(directory) = path.parent().filter(|d| !d.as_os_str().is_empty()) {
            use std::os::unix::fs::DirBuilderExt;
            std::fs::DirBuilder::new()
                .recursive(true)
                .mode(0o700)
                .create(directory)
                .map_err(storage)?;
        }
        let store = Self {
            path,
            lock: Mutex::new(()),
        };
        store.load()?;
        Ok(store)
    }

    fn load(&self) -> Result<std::collections::BTreeMap<String, String>> {
        match std::fs::read(&self.path) {
            Ok(bytes) => serde_json::from_slice(&bytes).map_err(|_| {
                crate::error::Error::new(
                    crate::error::ErrorKind::Unsupported,
                    "The protected credential file is damaged. Remove it and sign in again.",
                )
            }),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Default::default()),
            Err(error) => Err(storage(error)),
        }
    }

    fn save(&self, map: &std::collections::BTreeMap<String, String>) -> Result<()> {
        use std::{io::Write, os::unix::fs::OpenOptionsExt};
        let pending = self.path.with_extension("pending");
        let _ = std::fs::remove_file(&pending);
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&pending)
            .map_err(storage)?;
        file.write_all(&serde_json::to_vec(map)?).map_err(storage)?;
        file.sync_all().map_err(storage)?;
        std::fs::rename(&pending, &self.path).map_err(storage)
    }
}

#[cfg(unix)]
fn storage(error: std::io::Error) -> crate::error::Error {
    eprintln!("Protected credential storage failed: {error}");
    crate::error::Error::new(
        crate::error::ErrorKind::Unavailable,
        "Forkcast could not use its protected credential storage. Check its folder permissions.",
    )
}

#[cfg(unix)]
impl Secrets for FileSecrets {
    fn get(&self, key: &str) -> Result<Option<String>> {
        let _guard = self.lock.lock().expect("secrets poisoned");
        Ok(self.load()?.get(key).cloned())
    }

    fn set(&self, key: &str, value: &str) -> Result<()> {
        let _guard = self.lock.lock().expect("secrets poisoned");
        let mut map = self.load()?;
        map.insert(key.to_owned(), value.to_owned());
        self.save(&map)
    }

    fn delete(&self, key: &str) -> Result<()> {
        let _guard = self.lock.lock().expect("secrets poisoned");
        let mut map = self.load()?;
        if map.remove(key).is_some() {
            self.save(&map)?;
        }
        Ok(())
    }
}
