//! Thin Tauri command handlers.
//!
//! Handlers stay minimal and delegate to unit-testable library functions, so
//! the core logic can be tested without spinning up Tauri (see AGENTS.md).

use serde::Serialize;

/// Response for the `ping` command — the Phase 1 IPC smoke test.
///
/// This is an example of the "types as contract" boundary: the Rust struct is
/// the source of truth; the TS side has a matching type in
/// `src/lib/bindings/`. When this changes, update both sides.
#[derive(Debug, Clone, Serialize)]
#[cfg_attr(test, derive(PartialEq, Eq))]
#[serde(rename_all = "camelCase")]
pub struct PingResponse {
    /// Human-readable acknowledgement.
    pub message: String,
    /// Backend crate version, so the frontend can display/verify the pairing.
    pub app_version: String,
}

/// Pure, testable core of the `ping` command.
pub fn build_ping(name: &str) -> PingResponse {
    let name = name.trim();
    let who = if name.is_empty() { "world" } else { name };
    PingResponse {
        message: format!("pong: hello, {who}"),
        app_version: env!("CARGO_PKG_VERSION").to_string(),
    }
}

/// IPC bridge smoke test: greet by name and report the backend version.
#[tauri::command]
pub fn ping(name: String) -> PingResponse {
    build_ping(&name)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_to_world_when_blank() {
        let r = build_ping("   ");
        assert_eq!(r.message, "pong: hello, world");
        assert_eq!(r.app_version, env!("CARGO_PKG_VERSION"));
    }

    #[test]
    fn uses_trimmed_name() {
        assert_eq!(build_ping("  Ada ").message, "pong: hello, Ada");
    }
}
