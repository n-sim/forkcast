//! The native bridge. The app lifecycle owns the embedded core: it opens at
//! launch, restores persisted state, relays change notifications to the
//! frontend, and reports startup or storage failures instead of hiding them.

use crate::protected;
use forkcast_core::{Config, Core, Error, ErrorKind, Operation};
use serde::Serialize;
use serde_json::Value;
use std::{path::PathBuf, sync::Mutex, time::Duration};
use tauri::{AppHandle, Emitter, Manager, State};

pub struct Host {
    data_directory: PathBuf,
    core: Mutex<Option<Core>>,
    failure: Mutex<Option<String>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostStatus {
    state: &'static str,
    message: Option<String>,
    data_directory: String,
    version: &'static str,
    platform: &'static str,
}

impl Host {
    pub fn new(data_directory: PathBuf) -> Self {
        Self {
            data_directory,
            core: Mutex::new(None),
            failure: Mutex::new(None),
        }
    }

    pub fn core_if_ready(&self) -> Option<Core> {
        self.core.lock().expect("core lock poisoned").clone()
    }

    fn core(&self) -> Result<Core, Error> {
        self.core
            .lock()
            .expect("core lock poisoned")
            .clone()
            .ok_or_else(|| {
                Error::new(
                    ErrorKind::Unavailable,
                    self.failure
                        .lock()
                        .expect("failure lock poisoned")
                        .clone()
                        .unwrap_or_else(|| "Forkcast is still starting.".to_owned()),
                )
            })
    }

    /// Opens (or reopens) the core and starts its background work.
    pub fn start(&self, app: &AppHandle) {
        if self.core.lock().expect("core lock poisoned").is_some() {
            return;
        }
        match self.open(app) {
            Ok(core) => {
                *self.failure.lock().expect("failure lock poisoned") = None;
                if std::env::var_os("FORKCAST_NO_SYNC_WORKER").is_none() {
                    core.start_sync_worker();
                }
                relay_changes(app.clone(), &core);
                *self.core.lock().expect("core lock poisoned") = Some(core);
            }
            Err(message) => {
                eprintln!("Forkcast could not open its storage: {message}");
                *self.failure.lock().expect("failure lock poisoned") = Some(message);
            }
        }
    }

    fn open(&self, app: &AppHandle) -> Result<Core, String> {
        std::fs::create_dir_all(&self.data_directory).map_err(|error| {
            format!(
                "The data folder {} could not be created: {error}. Check that the disk is writable.",
                self.data_directory.display()
            )
        })?;
        let mut config = Config::new(self.data_directory.join("forkcast.sqlite3"));
        config.secrets = protected::open(self.data_directory.clone(), app);
        Core::open(config).map_err(|error| error.message)
    }
}

/// Forwards committed changes to the frontend, which reloads what it shows.
fn relay_changes(app: AppHandle, core: &Core) {
    let subscription = core.subscribe_all();
    std::thread::spawn(move || {
        loop {
            if let Some(change) = subscription.next_timeout(Duration::from_secs(3600)) {
                let _ = app.emit("core-change", &change);
            }
        }
    });
}

pub fn data_directory(app: &tauri::App) -> PathBuf {
    std::env::var_os("FORKCAST_DATA_DIR")
        .map(PathBuf::from)
        .or_else(|| app.path().app_data_dir().ok())
        .unwrap_or_else(|| PathBuf::from("forkcast-data"))
}

#[tauri::command]
pub fn host_status(host: State<'_, Host>) -> HostStatus {
    let failure = host.failure.lock().expect("failure lock poisoned").clone();
    let ready = host.core.lock().expect("core lock poisoned").is_some();
    HostStatus {
        state: if ready { "ready" } else { "failed" },
        message: failure,
        data_directory: host.data_directory.display().to_string(),
        version: env!("CARGO_PKG_VERSION"),
        platform: std::env::consts::OS,
    }
}

/// Runs one operation of the shared application interface.
#[tauri::command]
pub async fn execute(host: State<'_, Host>, operation: Value) -> Result<Value, Error> {
    let core = host.core()?;
    tauri::async_runtime::spawn_blocking(move || {
        let operation: Operation = serde_json::from_value(operation)
            .map_err(|_| Error::invalid("This app does not know that operation."))?;
        let principal = core.current_principal()?;
        core.execute(&principal, operation)
    })
    .await
    .map_err(|_| Error::internal())?
}

#[tauri::command]
pub fn retry_startup(app: AppHandle, host: State<'_, Host>) -> HostStatus {
    host.start(&app);
    host_status(host)
}

#[tauri::command]
pub fn open_data_folder(app: AppHandle, host: State<'_, Host>) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    app.opener()
        .open_path(host.data_directory.display().to_string(), None::<&str>)
        .map_err(|error| error.to_string())
}

/// Opens another Forkcast window on the same data. Every window talks to the
/// one embedded core, whose transactions serialize what they do.
#[tauri::command]
pub async fn open_window(app: AppHandle) -> Result<String, String> {
    let label = format!("window-{}", uuid_label());
    crate::for_automation(tauri::WebviewWindowBuilder::new(
        &app,
        &label,
        tauri::WebviewUrl::App("index.html".into()),
    ))
    .title("Forkcast")
    .inner_size(1280.0, 860.0)
    .min_inner_size(360.0, 480.0)
    .build()
    .map_err(|error| error.to_string())?;
    Ok(label)
}

fn uuid_label() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_nanos())
}

/// Opens an address in the person's own browser, for sign-in pages. Automation
/// can set `FORKCAST_EXTERNAL_URL_FILE` to record addresses instead.
#[tauri::command]
pub fn open_external(app: AppHandle, url: String) -> Result<(), String> {
    let parsed = url
        .parse::<tauri::Url>()
        .map_err(|_| "Enter a valid web address.")?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err("Only web addresses can be opened.".to_owned());
    }
    if let Some(file) = std::env::var_os("FORKCAST_EXTERNAL_URL_FILE") {
        use std::io::Write;
        let mut file = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(file)
            .map_err(|error| error.to_string())?;
        return writeln!(file, "{parsed}").map_err(|error| error.to_string());
    }
    use tauri_plugin_opener::OpenerExt;
    app.opener()
        .open_url(parsed.as_str(), None::<&str>)
        .map_err(|error| error.to_string())
}

/// Saves a generated file (the shopping-list PDF) where the person chooses,
/// then opens it. Automation can set `FORKCAST_SAVE_DIRECTORY` to deliver
/// files without a dialog.
#[tauri::command]
pub async fn save_file(
    app: AppHandle,
    suggested_name: String,
    data: Vec<u8>,
    open: bool,
) -> Result<Option<String>, String> {
    let name = std::path::Path::new(&suggested_name)
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .filter(|name| !name.is_empty())
        .ok_or("Choose a file name.")?;
    let chosen = if let Some(directory) = std::env::var_os("FORKCAST_SAVE_DIRECTORY") {
        Some(PathBuf::from(directory).join(&name))
    } else {
        let app = app.clone();
        tauri::async_runtime::spawn_blocking(move || {
            use tauri_plugin_dialog::DialogExt;
            app.dialog()
                .file()
                .set_file_name(&name)
                .blocking_save_file()
                .and_then(|path| path.into_path().ok())
        })
        .await
        .map_err(|error| error.to_string())?
    };
    let Some(path) = chosen else {
        return Ok(None);
    };
    std::fs::write(&path, data)
        .map_err(|error| format!("The file could not be saved to {}: {error}", path.display()))?;
    if open && std::env::var_os("FORKCAST_SAVE_DIRECTORY").is_none() {
        use tauri_plugin_opener::OpenerExt;
        app.opener()
            .open_path(path.display().to_string(), None::<&str>)
            .map_err(|error| error.to_string())?;
    }
    Ok(Some(path.display().to_string()))
}
