mod host;
mod protected;

use host::Host;
use tauri::{Manager, WebviewWindowBuilder, WindowEvent};

/// What Tauri passes to WebView2 unless told otherwise.
#[cfg(all(windows, debug_assertions))]
const DEFAULT_BROWSER_ARGUMENTS: &str =
    "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection";

/// Automation of the packaged app (see `tests/app-fixture.ts`) attaches to the
/// web view over a debugging port. Newer WebView2 runtimes can ignore
/// `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` once the app sets its own arguments,
/// so debug builds pass the variable's value on explicitly. Every window of one
/// process must use the same arguments.
pub(crate) fn for_automation<'a, R: tauri::Runtime, M: Manager<R>>(
    builder: WebviewWindowBuilder<'a, R, M>,
) -> WebviewWindowBuilder<'a, R, M> {
    #[cfg(all(windows, debug_assertions))]
    if let Ok(extra) = std::env::var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS") {
        return builder.additional_browser_args(&format!("{DEFAULT_BROWSER_ARGUMENTS} {extra}"));
    }
    builder
}

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
            // The first window is created here, not from the configuration, so
            // that it shares its browser arguments with later windows.
            let config = app.config().app.windows[0].clone();
            for_automation(WebviewWindowBuilder::from_config(app.handle(), &config)?).build()?;
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
