//! ACP client — spawns `kiro-cli acp` workers and speaks newline-delimited
//! JSON-RPC over stdio (see `docs/acp-notes.md`).
//!
//! - [`protocol`] — pure message model, parsing, and mapping.
//! - [`client`] — transport-generic JSON-RPC client with reader/writer loops.

pub mod client;
pub mod protocol;

use serde::Serialize;

/// Lifecycle status of a session, derived from the prompt lifecycle and events.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum SessionStatus {
    /// No prompt in flight.
    Idle,
    /// A prompt turn is being processed.
    Working,
    /// The agent is awaiting a tool-permission decision.
    NeedsApproval,
    /// The session hit an error.
    Error,
}

/// An app-level event bridged to the frontend. Serialized as a tagged union so
/// the TypeScript side can discriminate on `type` (see `src/lib/bindings`).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum AcpEvent {
    /// Session status changed.
    Status {
        session_id: Option<String>,
        status: SessionStatus,
    },
    /// A chunk of streamed assistant text.
    AgentMessage { session_id: String, text: String },
    /// A chunk of streamed assistant reasoning ("thinking").
    AgentThought { session_id: String, text: String },
    /// A tool call was announced or updated.
    ToolCall {
        session_id: String,
        tool_call_id: String,
        title: String,
        status: Option<String>,
        diff: Option<protocol::ToolDiff>,
        output: Option<String>,
    },
    /// The agent requested permission for a tool call. The session is paused
    /// (NeedsApproval) until the frontend responds with an option via
    /// `respond_permission` (see Phase 3).
    PermissionRequested {
        session_id: String,
        request_id: String,
        tool_call_id: String,
        title: String,
        options: Vec<protocol::PermissionOption>,
    },
    /// Session metrics from `_kiro.dev/metadata`: context %, credits, turn time.
    Metrics {
        session_id: String,
        context_percent: Option<f64>,
        credits: Option<f64>,
        turn_duration_ms: Option<u64>,
    },
    /// The session's capability inventory from `_kiro.dev/commands/available`.
    /// Replaces the previously-known inventory for the session.
    Capabilities {
        session_id: String,
        commands: Vec<protocol::SessionCommand>,
        prompts: Vec<protocol::SessionPrompt>,
        tools: Vec<protocol::AgentTool>,
        mcp_servers: Vec<protocol::McpServer>,
    },
    /// Subagent fan-out state from `_kiro.dev/subagent/list_update`.
    /// Replaces the previously-known subagent list for the session.
    Subagents {
        session_id: String,
        subagents: Vec<protocol::Subagent>,
    },
    /// An MCP server came up (`_kiro.dev/mcp/server_initialized`). Augments the
    /// inventory: the frontend upserts this server as running.
    McpServerInitialized {
        session_id: String,
        server_name: String,
    },
    /// A transport- or protocol-level error surfaced to the UI.
    Error { message: String },
}

/// Sink for events emitted by the client. Kept Tauri-agnostic so the client is
/// unit/integration testable; the Tauri layer provides an `AppHandle`-backed
/// implementation.
pub trait EventSink: Send + Sync {
    fn emit(&self, event: AcpEvent);
}

/// Errors from the ACP client.
#[derive(Debug, thiserror::Error)]
pub enum AcpError {
    #[error("protocol: {0}")]
    Protocol(#[from] protocol::ProtocolError),
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("transport closed")]
    TransportClosed,
    #[error("request timed out")]
    Timeout,
    #[error("agent error: {0}")]
    Agent(String),
    #[error("unexpected response: {0}")]
    Unexpected(String),
}

/// kiro-cli locks each session with `~/.kiro/sessions/cli/<id>.lock` =
/// `{"pid":N,...}`. A hard-killed process leaves a stale lock that blocks
/// `session/load`. If the lock's owning PID is no longer alive, remove it so
/// the session can be resumed. Safe: only removes locks of dead processes.
pub fn reclaim_stale_lock(session_id: &str) {
    let home = match std::env::var("HOME") {
        Ok(h) if !h.is_empty() => h,
        _ => return,
    };
    let lock = std::path::PathBuf::from(home)
        .join(".kiro/sessions/cli")
        .join(format!("{session_id}.lock"));
    let Ok(contents) = std::fs::read_to_string(&lock) else {
        return;
    };
    let pid = serde_json::from_str::<serde_json::Value>(&contents)
        .ok()
        .and_then(|v| v.get("pid").and_then(|p| p.as_i64()));
    if let Some(pid) = pid {
        // `kill -0` succeeds iff the process exists.
        let alive = std::process::Command::new("kill")
            .arg("-0")
            .arg(pid.to_string())
            .status()
            .map(|s| s.success())
            .unwrap_or(false);
        if !alive {
            let _ = std::fs::remove_file(&lock);
        }
    }
}

/// Resolve the `kiro-cli` executable to an absolute path.
///
/// A GUI app launched from Finder/Dock on macOS (or from a desktop launcher on
/// Linux) does **not** inherit the user's login-shell `PATH`. launchd hands the
/// app a minimal `PATH` (`/usr/bin:/bin:/usr/sbin:/sbin`), so a bare `kiro-cli`
/// spawn fails with `NotFound` — "No such file or directory (os error 2)" —
/// even though the binary is installed and works from a terminal (and thus
/// under `tauri dev`, which inherits the terminal's environment).
///
/// Resolution order (first hit wins):
/// 1. `BUGYO_KIRO_CLI` env override — an explicit path to the executable.
/// 2. The current process `PATH` (covers `tauri dev` and any inherited env).
/// 3. The login shell's `PATH` (recovers the environment a terminal would have:
///    nix profiles, `~/.local/bin`, Homebrew, custom installs).
/// 4. A set of common install directories.
///
/// Falls back to the bare name `kiro-cli` so the original spawn error still
/// surfaces if nothing is found. The result is cached for the process lifetime
/// so the (potentially slow) login-shell probe runs at most once.
pub fn resolve_kiro_cli() -> &'static str {
    use std::sync::OnceLock;
    static RESOLVED: OnceLock<String> = OnceLock::new();
    RESOLVED.get_or_init(resolve_kiro_cli_uncached).as_str()
}

fn resolve_kiro_cli_uncached() -> String {
    const BIN: &str = "kiro-cli";

    // 1. Explicit override.
    if let Some(p) = std::env::var_os("BUGYO_KIRO_CLI") {
        let path = std::path::PathBuf::from(&p);
        if is_executable(&path) {
            return path.to_string_lossy().into_owned();
        }
    }

    // 2. Current process PATH (works under `tauri dev`).
    if let Some(p) = find_on_path(BIN, std::env::var_os("PATH")) {
        return p;
    }

    // 3. Login-shell PATH (a GUI launch does not inherit it).
    if let Some(path) = login_shell_path() {
        if let Some(p) = find_on_path(BIN, Some(std::ffi::OsString::from(path))) {
            return p;
        }
    }

    // 4. Common install locations.
    if let Some(home) = std::env::var_os("HOME") {
        let home = std::path::PathBuf::from(home);
        let candidates = [
            home.join(".local/bin").join(BIN),
            std::path::PathBuf::from("/opt/homebrew/bin").join(BIN),
            std::path::PathBuf::from("/usr/local/bin").join(BIN),
            std::path::PathBuf::from("/usr/bin").join(BIN),
        ];
        for c in candidates {
            if is_executable(&c) {
                return c.to_string_lossy().into_owned();
            }
        }
    }

    // Last resort: bare name — spawn will surface the NotFound error.
    BIN.to_string()
}

/// True if `path` is a regular file with an executable bit set (on Unix). On
/// non-Unix platforms, existence as a file is sufficient.
fn is_executable(path: &std::path::Path) -> bool {
    match std::fs::metadata(path) {
        Ok(m) if m.is_file() => {
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                m.permissions().mode() & 0o111 != 0
            }
            #[cfg(not(unix))]
            {
                true
            }
        }
        _ => false,
    }
}

/// Search a `PATH`-style variable for an executable named `bin`, returning the
/// first matching absolute path.
fn find_on_path(bin: &str, path: Option<std::ffi::OsString>) -> Option<String> {
    let path = path?;
    std::env::split_paths(&path)
        .map(|dir| dir.join(bin))
        .find(|candidate| is_executable(candidate))
        .map(|candidate| candidate.to_string_lossy().into_owned())
}

/// Ask the user's login shell for its `PATH`. This is the standard way a
/// GUI-launched app recovers the environment a terminal would have (it sources
/// the user's shell profile). Returns `None` if the shell can't be run or
/// produces no `PATH`.
fn login_shell_path() -> Option<String> {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".into());
    // `-l` (login) + `-i` (interactive) so both profile and rc files are
    // sourced; `printf` avoids a trailing newline and shell-builtin quirks.
    let output = std::process::Command::new(&shell)
        .args(["-lic", "printf %s \"$PATH\""])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if path.is_empty() {
        None
    } else {
        Some(path)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn agent_message_serializes_as_camelcase_tagged_union() {
        let ev = AcpEvent::AgentMessage {
            session_id: "s1".into(),
            text: "hi".into(),
        };
        assert_eq!(
            serde_json::to_value(&ev).unwrap(),
            json!({ "type": "agentMessage", "sessionId": "s1", "text": "hi" })
        );
    }

    #[test]
    fn status_serializes_status_enum_camelcase() {
        let ev = AcpEvent::Status {
            session_id: Some("s1".into()),
            status: SessionStatus::NeedsApproval,
        };
        assert_eq!(
            serde_json::to_value(&ev).unwrap(),
            json!({ "type": "status", "sessionId": "s1", "status": "needsApproval" })
        );
    }

    #[test]
    fn find_on_path_locates_executable_across_dirs() {
        let dir = std::env::temp_dir().join(format!("bugyo-path-{}", std::process::id()));
        let bin_dir = dir.join("bin");
        std::fs::create_dir_all(&bin_dir).unwrap();
        let bin = bin_dir.join("kiro-cli");
        std::fs::write(&bin, b"#!/bin/sh\n").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755)).unwrap();
        }

        // A PATH with a non-existent dir first, then the real one.
        let path = std::env::join_paths([dir.join("nope"), bin_dir.clone()]).unwrap();
        let found = find_on_path("kiro-cli", Some(path));

        let _ = std::fs::remove_dir_all(&dir);

        #[cfg(unix)]
        assert_eq!(found.as_deref(), Some(bin.to_string_lossy().as_ref()));
        #[cfg(not(unix))]
        assert!(found.is_some());
    }

    #[test]
    fn find_on_path_returns_none_for_missing_binary() {
        let empty = std::env::temp_dir().join("bugyo-empty-does-not-exist");
        let path = std::env::join_paths([empty]).unwrap();
        assert!(find_on_path("kiro-cli", Some(path)).is_none());
        assert!(find_on_path("kiro-cli", None).is_none());
    }

    #[test]
    fn is_executable_rejects_missing_and_dirs() {
        assert!(!is_executable(std::path::Path::new(
            "/definitely/not/here/kiro-cli"
        )));
        // A directory is not an executable file.
        assert!(!is_executable(&std::env::temp_dir()));
    }
}
