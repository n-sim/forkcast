mod host;
mod protected;

use host::Host;
use tauri::{Manager, WindowEvent};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init());
    // Session tokens are protected by the Android Keystore on Android; other
    // platforms use their own adapter (see `protected`).
    #[cfg(target_os = "android")]
    let builder = builder.plugin(tauri_plugin_forkcast_secure_store::init());
    builder
        .setup(|app| {
            let host = Host::new(host::data_directory(app));
            host.start(app.handle());
            app.manage(host);
            Ok(())
        })
        .on_window_event(|window, event| {
            // Focus and resume are when a person expects pending work to deliver.
            if let WindowEvent::Focused(true) = event
                && let Some(core) = window
                    .app_handle()
                    .try_state::<Host>()
                    .and_then(|h| h.core_if_ready())
            {
                core.nudge_sync();
            }
        })
        .invoke_handler(tauri::generate_handler![
            host::host_status,
            host::execute,
            host::retry_startup,
            host::open_data_folder,
            host::save_file,
            host::open_external,
            host::open_window,
        ])
        .build(tauri::generate_context!())
        .expect("error while building Forkcast")
        .run(|app, event| {
            // Returning to the app is when pending work should deliver; the
            // core needs no daemon while the app is in the background.
            if let tauri::RunEvent::Resumed = event
                && let Some(core) = app.try_state::<Host>().and_then(|h| h.core_if_ready())
            {
                core.nudge_sync();
            }
        });
}
