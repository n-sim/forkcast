//! Starts a countdown in the device's clock app (`AlarmClock.ACTION_SET_TIMER`),
//! which keeps running and rings while Forkcast is closed or the screen is off.
//! The plugin is registered on Android only; other platforms have no system
//! timer and the frontend falls back to its in-app timer.

use tauri::{
    Runtime,
    plugin::{Builder, TauriPlugin},
};

#[cfg(target_os = "android")]
use {
    serde_json::json,
    tauri::{Manager, plugin::PluginHandle},
};

#[cfg(target_os = "android")]
const PLUGIN_IDENTIFIER: &str = "app.forkcast.systemtimer";

#[cfg(target_os = "android")]
pub struct SystemTimer<R: Runtime>(PluginHandle<R>);

#[cfg(target_os = "android")]
impl<R: Runtime> SystemTimer<R> {
    /// Asks the clock app to start a timer of `seconds` labelled `label`.
    pub fn start(&self, seconds: u32, label: &str) -> Result<(), String> {
        self.0
            .run_mobile_plugin::<serde_json::Value>(
                "setTimer",
                json!({ "seconds": seconds, "label": label }),
            )
            .map(|_| ())
            .map_err(|error| error.to_string())
    }
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("forkcast-system-timer")
        .setup(|app, api| {
            #[cfg(target_os = "android")]
            {
                let handle = api.register_android_plugin(PLUGIN_IDENTIFIER, "SystemTimerPlugin")?;
                app.manage(SystemTimer(handle));
            }
            #[cfg(not(target_os = "android"))]
            let _ = (app, api);
            Ok(())
        })
        .build()
}
