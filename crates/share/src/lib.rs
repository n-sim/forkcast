//! Shares a generated file (a recipe or shopping-list PDF) through Android's
//! share sheet, so the person can send it to a messaging app, email and so on.
//! The file is written to the app's cache and offered to the chosen app through
//! the app's `FileProvider`, with a read grant for that app only. Other hosts
//! have no share sheet here; this plugin is registered on Android only.

use tauri::{
    Runtime,
    plugin::{Builder, TauriPlugin},
};

#[cfg(target_os = "android")]
use {
    base64::Engine,
    serde_json::json,
    tauri::{Manager, plugin::PluginHandle},
};

#[cfg(target_os = "android")]
const PLUGIN_IDENTIFIER: &str = "app.forkcast.share";

#[cfg(target_os = "android")]
pub struct Share<R: Runtime>(PluginHandle<R>);

/// Opens the share sheet with `data` attached as `name`. Returns once the sheet
/// is shown; Android does not report which app, if any, the person chose.
#[cfg(target_os = "android")]
pub fn share_file<R: Runtime>(
    app: &tauri::AppHandle<R>,
    name: &str,
    data: &[u8],
    mime_type: &str,
    title: &str,
) -> Result<(), String> {
    let share = app
        .try_state::<Share<R>>()
        .ok_or("Sharing is not available on this device.")?;
    share
        .0
        .run_mobile_plugin::<serde_json::Value>(
            "share",
            json!({
                "name": name,
                "data": base64::engine::general_purpose::STANDARD.encode(data),
                "mimeType": mime_type,
                "title": title,
            }),
        )
        .map(|_| ())
        .map_err(|error| error.to_string())
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("forkcast-share")
        .setup(|app, api| {
            #[cfg(target_os = "android")]
            {
                let handle = api.register_android_plugin(PLUGIN_IDENTIFIER, "SharePlugin")?;
                app.manage(Share(handle));
            }
            #[cfg(not(target_os = "android"))]
            let _ = (app, api);
            Ok(())
        })
        .build()
}
