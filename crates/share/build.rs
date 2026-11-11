// The plugin exposes no commands to the web view: the host's `share_file`
// command reaches it from native code.
const COMMANDS: &[&str] = &[];

fn main() {
    tauri_plugin::Builder::new(COMMANDS)
        .android_path("android")
        .build();
}
