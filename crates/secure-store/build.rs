// The plugin exposes no commands to the web view: tokens are read and written
// only by native code, through the core's `Secrets` interface.
const COMMANDS: &[&str] = &[];

fn main() {
    tauri_plugin::Builder::new(COMMANDS)
        .android_path("android")
        .build();
}
