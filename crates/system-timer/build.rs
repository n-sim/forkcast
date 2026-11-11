// The plugin exposes no commands to the web view: the desktop host's
// `start_system_timer` command calls it from native code.
const COMMANDS: &[&str] = &[];

fn main() {
    tauri_plugin::Builder::new(COMMANDS)
        .android_path("android")
        .build();
}
