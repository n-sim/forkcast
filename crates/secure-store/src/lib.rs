//! Android Keystore-backed implementation of the core's `Secrets`. Values are
//! encrypted with an AES-256-GCM key that never leaves the Keystore and stored
//! in app-private preferences that are excluded from backup. A restored or
//! transferred copy therefore cannot be decrypted: the person signs in again.
//! Desktop hosts use their own adapter; this plugin is registered on Android only.

use tauri::{
    Runtime,
    plugin::{Builder, TauriPlugin},
};

#[cfg(target_os = "android")]
use {
    forkcast_core::{Error, ErrorKind, Result, Secrets},
    serde::Deserialize,
    serde_json::json,
    std::sync::Arc,
    tauri::{Manager, plugin::PluginHandle},
};

#[cfg(target_os = "android")]
const PLUGIN_IDENTIFIER: &str = "app.forkcast.securestore";

#[cfg(target_os = "android")]
pub struct SecureStore<R: Runtime>(PluginHandle<R>);

#[cfg(target_os = "android")]
#[derive(Deserialize)]
struct Stored {
    value: Option<String>,
}

#[cfg(target_os = "android")]
fn unavailable(error: impl std::fmt::Display) -> Error {
    eprintln!("Keystore storage failed: {error}");
    Error::new(
        ErrorKind::Internal,
        "Credentials could not be protected on this device.",
    )
}

#[cfg(target_os = "android")]
impl<R: Runtime> Secrets for SecureStore<R> {
    fn get(&self, key: &str) -> Result<Option<String>> {
        let stored: Stored = self
            .0
            .run_mobile_plugin("get", json!({ "key": key }))
            .map_err(unavailable)?;
        Ok(stored.value)
    }

    fn set(&self, key: &str, value: &str) -> Result<()> {
        self.0
            .run_mobile_plugin::<serde_json::Value>("set", json!({ "key": key, "value": value }))
            .map(|_| ())
            .map_err(unavailable)
    }

    fn delete(&self, key: &str) -> Result<()> {
        self.0
            .run_mobile_plugin::<serde_json::Value>("delete", json!({ "key": key }))
            .map(|_| ())
            .map_err(unavailable)
    }
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("forkcast-secure-store")
        .setup(|app, api| {
            #[cfg(target_os = "android")]
            {
                let handle = api.register_android_plugin(PLUGIN_IDENTIFIER, "SecureStorePlugin")?;
                app.manage(SecureStore(handle));
            }
            #[cfg(not(target_os = "android"))]
            let _ = (app, api);
            Ok(())
        })
        .build()
}

/// The registered store, as the core wants it.
#[cfg(target_os = "android")]
pub fn secrets<R: Runtime>(app: &tauri::AppHandle<R>) -> Arc<dyn Secrets> {
    struct Shared<R: Runtime>(tauri::AppHandle<R>);
    impl<R: Runtime> Secrets for Shared<R> {
        fn get(&self, key: &str) -> Result<Option<String>> {
            self.0.state::<SecureStore<R>>().get(key)
        }
        fn set(&self, key: &str, value: &str) -> Result<()> {
            self.0.state::<SecureStore<R>>().set(key, value)
        }
        fn delete(&self, key: &str) -> Result<()> {
            self.0.state::<SecureStore<R>>().delete(key)
        }
    }
    Arc::new(Shared(app.clone()))
}
