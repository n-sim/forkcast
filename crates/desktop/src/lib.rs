mod host;
mod protected;

use host::Host;
use tauri::{Manager, WindowEvent};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
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
        ])
        .run(tauri::generate_context!())
        .expect("error while running Forkcast");
}
