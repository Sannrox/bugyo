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
}
