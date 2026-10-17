#![allow(dead_code)]

use base64::{Engine, engine::general_purpose::STANDARD};
use forkcast_core::{Config, Core, Photo};
use serde_json::{Value, json};
use std::path::PathBuf;

/// A database file that is removed with its WAL files when dropped.
pub struct TempDatabase(PathBuf);

impl TempDatabase {
    pub fn new() -> Self {
        Self(std::env::temp_dir().join(format!("forkcast-core-{}.sqlite3", uuid::Uuid::new_v4())))
    }

    pub fn path(&self) -> &PathBuf {
        &self.0
    }

    pub fn open(&self) -> Core {
        Core::open(Config::new(&self.0)).expect("open core database")
    }
}

impl Drop for TempDatabase {
    fn drop(&mut self) {
        for suffix in ["", "-wal", "-shm"] {
            let mut path = self.0.clone().into_os_string();
            path.push(suffix);
            let _ = std::fs::remove_file(path);
        }
    }
}

/// The generated-recipe fixture the browser suite uses, as the editor saves
/// it: harmless zero-quantity allocations dropped, nutrition known.
pub fn risotto() -> Value {
    let mut recipe: Value = serde_json::from_str(include_str!(
        "../../../../tests/fixtures/pumpkin-risotto.json"
    ))
    .expect("risotto fixture");
    for step in recipe["steps"].as_array_mut().unwrap() {
        step["allocations"]
            .as_array_mut()
            .unwrap()
            .retain(|allocation| allocation["quantity"].as_f64().unwrap() > 0.0);
    }
    recipe["nutrition"] =
        json!({"calories": 2000.0, "protein": 60.0, "fat": 80.0, "carbohydrates": 280.0});
    recipe
}

pub fn cover_photo() -> Photo {
    Photo {
        mime: "image/png".into(),
        data: STANDARD.encode(include_bytes!("../../../../tests/fixtures/cover-photo.png")),
    }
}
