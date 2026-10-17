//! Import of a browser-profile transfer. Placeholder until implemented.

use serde::Serialize;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportReport {}

impl crate::Core {
    pub fn import_legacy(&self, _transfer: serde_json::Value) -> crate::Result<ImportReport> {
        Ok(ImportReport {})
    }
}
