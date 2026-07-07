//! ACP JSON-RPC message model and mapping.
//!
//! Shapes are modeled on the real traffic captured in `docs/acp-notes.md`
//! (kiro-cli 2.11.1). Transport is newline-delimited JSON-RPC 2.0 over stdio.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

/// JSON-RPC id. Our client uses integer ids; the agent's requests (e.g.
/// `session/request_permission`) use string UUIDs — so we accept both.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum Id {
    Num(i64),
    Str(String),
}

/// Errors from parsing inbound protocol lines.
#[derive(Debug, thiserror::Error)]
pub enum ProtocolError {
    #[error("invalid json: {0}")]
    Json(#[from] serde_json::Error),
    #[error("message has neither id nor method")]
    NotAMessage,
}

/// A parsed inbound line from the agent.
#[derive(Debug, Clone, PartialEq)]
pub enum Incoming {
    /// A response to one of our requests.
    Response {
        id: Id,
        result: Option<Value>,
        error: Option<Value>,
    },
    /// A request FROM the agent that we must answer (e.g. permission).
    Request {
        id: Id,
        method: String,
        params: Value,
    },
    /// A notification (no id): `session/update`, `_kiro.dev/*`, etc.
    Notification { method: String, params: Value },
}

/// Parse one newline-delimited JSON-RPC message.
pub fn parse_incoming(line: &str) -> Result<Incoming, ProtocolError> {
    let v: Value = serde_json::from_str(line)?;
    let id = v.get("id").cloned();
    let method = v.get("method").and_then(Value::as_str).map(str::to_string);
    let params = || v.get("params").cloned().unwrap_or(Value::Null);

    match (id, method) {
        (Some(id), Some(method)) => Ok(Incoming::Request {
            id: serde_json::from_value(id)?,
            method,
            params: params(),
        }),
        (Some(id), None) => Ok(Incoming::Response {
            id: serde_json::from_value(id)?,
            result: v.get("result").cloned(),
            error: v.get("error").cloned(),
        }),
        (None, Some(method)) => Ok(Incoming::Notification {
            method,
            params: params(),
        }),
        (None, None) => Err(ProtocolError::NotAMessage),
    }
}

// ---- Outgoing message constructors ---------------------------------------

/// `initialize` request. `protocolVersion` is an integer (`1`) per the capture.
pub fn initialize_request(id: i64) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "method": "initialize",
        "params": {
            "protocolVersion": 1,
            "clientCapabilities": { "fs": { "readTextFile": true, "writeTextFile": true } }
        }
    })
}

/// `session/new` request. `cwd` must be absolute.
pub fn new_session_request(id: i64, cwd: &str) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "method": "session/new",
        "params": { "cwd": cwd, "mcpServers": [] }
    })
}

/// `session/load` request — resume a persisted session by id (see
/// `docs/acp-notes.md` "Session resume").
pub fn load_session_request(id: i64, session_id: &str, cwd: &str) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "method": "session/load",
        "params": { "sessionId": session_id, "cwd": cwd, "mcpServers": [] }
    })
}

/// An image to inject into a prompt as an ACP image content block.
///
/// The wire shape `{type:"image", mimeType, data}` was verified live against
/// `kiro-cli acp` (see `docs/spikes/acp_image_probe.py`); the agent advertises
/// `promptCapabilities.image: true`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImageAttachment {
    /// e.g. `image/png`.
    pub mime_type: String,
    /// Base64-encoded image bytes.
    pub data_base64: String,
}

/// `session/prompt` request with a single text content block.
pub fn prompt_request(id: i64, session_id: &str, text: &str) -> Value {
    prompt_request_with_images(id, session_id, text, &[])
}

/// `session/prompt` request carrying a text block followed by zero or more
/// image content blocks. This is how Bugyo feeds a screenshot of the running
/// app into a session (Codex-style) for a visual self-improvement loop.
pub fn prompt_request_with_images(
    id: i64,
    session_id: &str,
    text: &str,
    images: &[ImageAttachment],
) -> Value {
    let mut prompt: Vec<Value> = Vec::with_capacity(1 + images.len());
    prompt.push(json!({ "type": "text", "text": text }));
    for img in images {
        prompt.push(json!({
            "type": "image",
            "mimeType": img.mime_type,
            "data": img.data_base64,
        }));
    }
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "method": "session/prompt",
        "params": {
            "sessionId": session_id,
            "prompt": prompt,
        }
    })
}

/// `session/cancel` notification.
///
/// NOTE: exact shape not exercised in the Phase 0 spike (see `acp-notes.md`
/// "still to verify"); modeled on the ACP spec. Verify against a live agent.
pub fn cancel_notification(session_id: &str) -> Value {
    json!({
        "jsonrpc": "2.0",
        "method": "session/cancel",
        "params": { "sessionId": session_id }
    })
}

/// Reply to a `session/request_permission` request by selecting an option.
pub fn permission_response(id: &Id, option_id: &str) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "result": { "outcome": { "outcome": "selected", "optionId": option_id } }
    })
}

/// Generic empty reply to an unrecognized agent request (avoids stalling).
pub fn empty_response(id: &Id) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "result": {} })
}

// ---- session/update mapping ----------------------------------------------

/// A file edit carried by a tool call's `content` (`type:"diff"`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolDiff {
    pub path: String,
    pub old_text: Option<String>,
    pub new_text: String,
}

/// A meaningful update parsed from a `session/update` notification.
#[derive(Debug, Clone, PartialEq)]
pub enum Update {
    /// Streamed assistant text.
    AgentMessage { text: String },
    /// Streamed assistant reasoning ("thinking").
    AgentThought { text: String },
    /// A tool call was announced.
    ToolCall {
        tool_call_id: String,
        title: String,
        status: Option<String>,
        diff: Option<ToolDiff>,
        output: Option<String>,
    },
    /// A tool call changed state (e.g. completed).
    ToolCallUpdate {
        tool_call_id: String,
        title: Option<String>,
        status: Option<String>,
        output: Option<String>,
    },
    /// A `sessionUpdate` variant we don't specifically model yet.
    Unknown { session_update: String },
}

/// Extract a file diff from a tool call's `content` array, if present.
fn parse_tool_diff(update: &Value) -> Option<ToolDiff> {
    let content = update.get("content")?.as_array()?;
    content.iter().find_map(|part| {
        if part.get("type").and_then(Value::as_str) == Some("diff") {
            Some(ToolDiff {
                path: part
                    .get("path")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string(),
                old_text: part
                    .get("oldText")
                    .and_then(Value::as_str)
                    .map(str::to_string),
                new_text: part
                    .get("newText")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string(),
            })
        } else {
            None
        }
    })
}

/// Extract the `sessionId` from a notification's params, if present.
pub fn session_id_of(params: &Value) -> Option<String> {
    params
        .get("sessionId")
        .and_then(Value::as_str)
        .map(str::to_string)
}

/// Extract human-readable output from a tool call's `rawOutput`
/// (kiro emits `{"items":[{"Text":"..."}]}`). Collects string leaves.
fn parse_tool_output(update: &Value) -> Option<String> {
    let items = update.get("rawOutput")?.get("items")?.as_array()?;
    let mut parts = Vec::new();
    for item in items {
        match item {
            Value::String(s) => parts.push(s.clone()),
            Value::Object(map) => {
                for v in map.values() {
                    if let Some(s) = v.as_str() {
                        parts.push(s.to_string());
                    }
                }
            }
            _ => {}
        }
    }
    let joined = parts.join("\n");
    if joined.trim().is_empty() {
        None
    } else {
        Some(joined)
    }
}

/// Map a `session/update` notification's params into an [`Update`].
pub fn parse_update(params: &Value) -> Option<Update> {
    let update = params.get("update")?;
    let kind = update.get("sessionUpdate")?.as_str()?;
    let str_field = |key: &str| update.get(key).and_then(Value::as_str).map(str::to_string);
    match kind {
        "agent_message_chunk" => {
            let text = update.get("content")?.get("text")?.as_str()?.to_string();
            Some(Update::AgentMessage { text })
        }
        "agent_thought_chunk" => {
            let text = update.get("content")?.get("text")?.as_str()?.to_string();
            Some(Update::AgentThought { text })
        }
        "tool_call" => Some(Update::ToolCall {
            tool_call_id: str_field("toolCallId").unwrap_or_default(),
            title: str_field("title").unwrap_or_default(),
            status: str_field("status"),
            diff: parse_tool_diff(update),
            output: parse_tool_output(update),
        }),
        "tool_call_update" => Some(Update::ToolCallUpdate {
            tool_call_id: str_field("toolCallId").unwrap_or_default(),
            title: str_field("title"),
            status: str_field("status"),
            output: parse_tool_output(update),
        }),
        other => Some(Update::Unknown {
            session_update: other.to_string(),
        }),
    }
}

/// Extract `contextUsagePercentage` from a `_kiro.dev/metadata` notification.
pub fn context_usage_of(params: &Value) -> Option<f64> {
    params.get("contextUsagePercentage").and_then(Value::as_f64)
}

/// Session metrics parsed from a `_kiro.dev/metadata` notification.
#[derive(Debug, Clone, PartialEq)]
pub struct Metadata {
    /// Context-window usage (0..100), when present.
    pub context_percent: Option<f64>,
    /// Total credits reported this update (summed across `meteringUsage`).
    pub credits: Option<f64>,
    /// Turn duration in milliseconds, present at turn end.
    pub turn_duration_ms: Option<u64>,
}

/// Parse the metrics from a `_kiro.dev/metadata` notification's params.
pub fn parse_metadata(params: &Value) -> Metadata {
    let credits = params
        .get("meteringUsage")
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter(|m| {
                    m.get("unit")
                        .and_then(Value::as_str)
                        .map(|u| u.contains("credit"))
                        .unwrap_or(false)
                })
                .filter_map(|m| m.get("value").and_then(Value::as_f64))
                .sum::<f64>()
        });
    Metadata {
        context_percent: context_usage_of(params),
        credits,
        turn_duration_ms: params.get("turnDurationMs").and_then(Value::as_u64),
    }
}

// ---- Permission requests --------------------------------------------------

/// A selectable option offered in a `session/request_permission` request,
/// e.g. `allow_once` / `allow_always` / `reject_once`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionOption {
    pub option_id: String,
    pub name: String,
    pub kind: String,
}

/// Parsed pieces of a `session/request_permission` request.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedPermission {
    pub tool_call_id: String,
    pub title: String,
    pub options: Vec<PermissionOption>,
}

/// Parse a `session/request_permission` request's params.
pub fn parse_permission_request(params: &Value) -> ParsedPermission {
    let tool_call = params.get("toolCall");
    let str_at = |v: Option<&Value>, key: &str| {
        v.and_then(|o| o.get(key))
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string()
    };
    let options = params
        .get("options")
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter_map(|o| {
                    Some(PermissionOption {
                        option_id: o.get("optionId")?.as_str()?.to_string(),
                        name: o
                            .get("name")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_string(),
                        kind: o
                            .get("kind")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_string(),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    ParsedPermission {
        tool_call_id: str_at(tool_call, "toolCallId"),
        title: str_at(tool_call, "title"),
        options,
    }
}

/// Stable string key for a JSON-RPC id (used to correlate held permission
/// requests with the frontend's decision).
pub fn id_key(id: &Id) -> String {
    match id {
        Id::Num(n) => n.to_string(),
        Id::Str(s) => s.clone(),
    }
}

// ---- Capability notifications --------------------------------------------
//
// The per-session capability inventory kiro-cli emits as `_kiro.dev/*`
// notifications around `session/new`. Shapes verified against a live
// kiro-cli 2.11.1 run — see `docs/acp-notes.md` "Capability notifications".
// All parsers are lenient: unknown/missing fields are tolerated so version
// drift doesn't break us (items missing a `name` are skipped).

/// A slash command, e.g. `/clear`. `name` INCLUDES the leading slash.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionCommand {
    pub name: String,
    pub description: String,
}

/// A prompt or skill. Skills surface here with `server_name = "skill:config"`.
/// `name` has NO leading slash.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionPrompt {
    pub name: String,
    pub description: String,
    pub server_name: Option<String>,
}

/// A tool available to the session. `source` is `"built-in"` or `"mcp:<server>"`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentTool {
    pub name: String,
    pub description: String,
    pub source: Option<String>,
}

/// An MCP server backing the session.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpServer {
    pub name: String,
    pub status: Option<String>,
    pub tool_count: Option<u64>,
}

/// A subagent available for fan-out. Per-item shape unconfirmed (observed
/// empty in the spike); parsed leniently — we keep whatever `name` we can find.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Subagent {
    pub name: String,
}

/// The full inventory from a `_kiro.dev/commands/available` notification.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Capabilities {
    pub commands: Vec<SessionCommand>,
    pub prompts: Vec<SessionPrompt>,
    pub tools: Vec<AgentTool>,
    pub mcp_servers: Vec<McpServer>,
}

/// Read a string field from an object, defaulting to `""`.
fn str_or_default(obj: &Value, key: &str) -> String {
    obj.get(key)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string()
}

/// Iterate the objects of an array field, skipping non-objects.
fn array_objects<'a>(params: &'a Value, key: &str) -> impl Iterator<Item = &'a Value> {
    params
        .get(key)
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|v| v.is_object())
}

/// Parse a `_kiro.dev/commands/available` notification's params into the
/// full [`Capabilities`] inventory. Items without a `name` are skipped.
pub fn parse_commands_available(params: &Value) -> Capabilities {
    let commands = array_objects(params, "commands")
        .filter_map(|c| {
            let name = c.get("name").and_then(Value::as_str)?;
            Some(SessionCommand {
                name: name.to_string(),
                description: str_or_default(c, "description"),
            })
        })
        .collect();

    let prompts = array_objects(params, "prompts")
        .filter_map(|p| {
            let name = p.get("name").and_then(Value::as_str)?;
            Some(SessionPrompt {
                name: name.to_string(),
                description: str_or_default(p, "description"),
                server_name: p
                    .get("serverName")
                    .and_then(Value::as_str)
                    .map(str::to_string),
            })
        })
        .collect();

    let tools = array_objects(params, "tools")
        .filter_map(|t| {
            let name = t.get("name").and_then(Value::as_str)?;
            Some(AgentTool {
                name: name.to_string(),
                description: str_or_default(t, "description"),
                source: t.get("source").and_then(Value::as_str).map(str::to_string),
            })
        })
        .collect();

    let mcp_servers = array_objects(params, "mcpServers")
        .filter_map(|m| {
            let name = m.get("name").and_then(Value::as_str)?;
            Some(McpServer {
                name: name.to_string(),
                status: m.get("status").and_then(Value::as_str).map(str::to_string),
                tool_count: m.get("toolCount").and_then(Value::as_u64),
            })
        })
        .collect();

    Capabilities {
        commands,
        prompts,
        tools,
        mcp_servers,
    }
}

/// Parse a `_kiro.dev/subagent/list_update` notification's `subagents[]`.
/// Lenient: accepts items that are either objects with a `name` field or bare
/// strings; anything without a usable name is skipped.
pub fn parse_subagent_update(params: &Value) -> Vec<Subagent> {
    params
        .get("subagents")
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter_map(|s| {
                    let name = s
                        .get("name")
                        .and_then(Value::as_str)
                        .or_else(|| s.as_str())?;
                    Some(Subagent {
                        name: name.to_string(),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

/// Parse the `serverName` from a `_kiro.dev/mcp/server_initialized` notification.
pub fn parse_mcp_initialized(params: &Value) -> Option<String> {
    params
        .get("serverName")
        .and_then(Value::as_str)
        .map(str::to_string)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_response_with_int_id() {
        let line = r#"{"jsonrpc":"2.0","result":{"stopReason":"end_turn"},"id":3}"#;
        match parse_incoming(line).unwrap() {
            Incoming::Response { id, result, error } => {
                assert_eq!(id, Id::Num(3));
                assert_eq!(result.unwrap()["stopReason"], "end_turn");
                assert!(error.is_none());
            }
            other => panic!("expected response, got {other:?}"),
        }
    }

    #[test]
    fn parses_permission_request_with_string_id() {
        let line = r#"{"jsonrpc":"2.0","method":"session/request_permission","params":{"sessionId":"s1"},"id":"c7-uuid"}"#;
        match parse_incoming(line).unwrap() {
            Incoming::Request { id, method, .. } => {
                assert_eq!(id, Id::Str("c7-uuid".into()));
                assert_eq!(method, "session/request_permission");
            }
            other => panic!("expected request, got {other:?}"),
        }
    }

    #[test]
    fn parses_notification_without_id() {
        let line = r#"{"jsonrpc":"2.0","method":"_kiro.dev/metadata","params":{"contextUsagePercentage":2.86}}"#;
        match parse_incoming(line).unwrap() {
            Incoming::Notification { method, params } => {
                assert_eq!(method, "_kiro.dev/metadata");
                assert_eq!(context_usage_of(&params), Some(2.86));
            }
            other => panic!("expected notification, got {other:?}"),
        }
    }

    #[test]
    fn rejects_message_without_id_or_method() {
        assert!(matches!(
            parse_incoming(r#"{"jsonrpc":"2.0"}"#),
            Err(ProtocolError::NotAMessage)
        ));
    }

    #[test]
    fn maps_agent_message_chunk() {
        let params = json!({
            "sessionId": "s1",
            "update": { "sessionUpdate": "agent_message_chunk", "content": { "type": "text", "text": "done" } }
        });
        assert_eq!(
            parse_update(&params),
            Some(Update::AgentMessage {
                text: "done".into()
            })
        );
        assert_eq!(session_id_of(&params), Some("s1".into()));
    }

    #[test]
    fn maps_agent_thought_chunk() {
        let params = json!({
            "sessionId": "s1",
            "update": { "sessionUpdate": "agent_thought_chunk", "content": { "type": "text", "text": "let me think" } }
        });
        assert_eq!(
            parse_update(&params),
            Some(Update::AgentThought {
                text: "let me think".into()
            })
        );
    }

    #[test]
    fn maps_tool_call() {
        let params = json!({
            "sessionId": "s1",
            "update": {
                "sessionUpdate": "tool_call",
                "toolCallId": "tooluse_x",
                "title": "Creating file.txt",
                "kind": "edit"
            }
        });
        assert_eq!(
            parse_update(&params),
            Some(Update::ToolCall {
                tool_call_id: "tooluse_x".into(),
                title: "Creating file.txt".into(),
                status: None,
                diff: None,
                output: None,
            })
        );
    }

    #[test]
    fn maps_tool_call_update_with_output() {
        let params = json!({
            "sessionId": "s1",
            "update": {
                "sessionUpdate": "tool_call_update",
                "toolCallId": "t1",
                "status": "completed",
                "rawOutput": { "items": [{ "Text": "Successfully created (1 lines)." }] }
            }
        });
        assert_eq!(
            parse_update(&params),
            Some(Update::ToolCallUpdate {
                tool_call_id: "t1".into(),
                title: None,
                status: Some("completed".into()),
                output: Some("Successfully created (1 lines).".into()),
            })
        );
    }

    #[test]
    fn maps_tool_call_with_diff() {
        let params = json!({
            "sessionId": "s1",
            "update": {
                "sessionUpdate": "tool_call",
                "toolCallId": "t1",
                "title": "Creating file.txt",
                "content": [{
                    "type": "diff",
                    "path": "/abs/file.txt",
                    "oldText": null,
                    "newText": "hi"
                }]
            }
        });
        match parse_update(&params).unwrap() {
            Update::ToolCall { diff: Some(d), .. } => {
                assert_eq!(d.path, "/abs/file.txt");
                assert_eq!(d.old_text, None);
                assert_eq!(d.new_text, "hi");
            }
            other => panic!("expected tool call with diff, got {other:?}"),
        }
    }

    #[test]
    fn unknown_update_is_captured() {
        let params = json!({ "update": { "sessionUpdate": "plan" } });
        assert_eq!(
            parse_update(&params),
            Some(Update::Unknown {
                session_update: "plan".into()
            })
        );
    }

    #[test]
    fn permission_response_selects_option() {
        let v = permission_response(&Id::Str("uuid-1".into()), "reject_once");
        assert_eq!(v["id"], "uuid-1");
        assert_eq!(v["result"]["outcome"]["optionId"], "reject_once");
        assert_eq!(v["result"]["outcome"]["outcome"], "selected");
    }

    #[test]
    fn prompt_request_has_text_block() {
        let v = prompt_request(3, "s1", "hi");
        assert_eq!(v["method"], "session/prompt");
        assert_eq!(v["params"]["sessionId"], "s1");
        assert_eq!(v["params"]["prompt"][0]["type"], "text");
        assert_eq!(v["params"]["prompt"][0]["text"], "hi");
    }

    #[test]
    fn prompt_request_with_images_appends_image_blocks() {
        let images = vec![
            ImageAttachment {
                mime_type: "image/png".into(),
                data_base64: "AAAA".into(),
            },
            ImageAttachment {
                mime_type: "image/jpeg".into(),
                data_base64: "BBBB".into(),
            },
        ];
        let v = prompt_request_with_images(7, "s1", "look", &images);
        let prompt = v["params"]["prompt"].as_array().unwrap();
        // text block first, then the two image blocks in order.
        assert_eq!(prompt.len(), 3);
        assert_eq!(prompt[0]["type"], "text");
        assert_eq!(prompt[0]["text"], "look");
        assert_eq!(prompt[1]["type"], "image");
        assert_eq!(prompt[1]["mimeType"], "image/png");
        assert_eq!(prompt[1]["data"], "AAAA");
        assert_eq!(prompt[2]["type"], "image");
        assert_eq!(prompt[2]["mimeType"], "image/jpeg");
        assert_eq!(prompt[2]["data"], "BBBB");
    }

    #[test]
    fn prompt_request_with_no_images_matches_text_only() {
        assert_eq!(
            prompt_request(3, "s1", "hi"),
            prompt_request_with_images(3, "s1", "hi", &[])
        );
    }

    #[test]
    fn parses_permission_request_options() {
        let params = json!({
            "sessionId": "s1",
            "toolCall": { "toolCallId": "tooluse_x", "title": "Creating file.txt" },
            "options": [
                { "optionId": "allow_once", "name": "Yes", "kind": "allow_once" },
                { "optionId": "allow_always", "name": "Always", "kind": "allow_always" },
                { "optionId": "reject_once", "name": "No", "kind": "reject_once" }
            ]
        });
        let parsed = parse_permission_request(&params);
        assert_eq!(parsed.tool_call_id, "tooluse_x");
        assert_eq!(parsed.title, "Creating file.txt");
        assert_eq!(parsed.options.len(), 3);
        assert_eq!(parsed.options[0].option_id, "allow_once");
        assert_eq!(parsed.options[2].kind, "reject_once");
    }

    #[test]
    fn id_key_stringifies_both_variants() {
        assert_eq!(id_key(&Id::Num(7)), "7");
        assert_eq!(id_key(&Id::Str("uuid-1".into())), "uuid-1");
    }

    #[test]
    fn parses_metadata_credits_and_duration() {
        let params = json!({
            "sessionId": "s1",
            "contextUsagePercentage": 2.866,
            "meteringUsage": [
                { "value": 0.195, "unit": "credit", "unitPlural": "credits" },
                { "value": 0.110, "unit": "credit", "unitPlural": "credits" }
            ],
            "turnDurationMs": 4894
        });
        let m = parse_metadata(&params);
        assert_eq!(m.context_percent, Some(2.866));
        assert_eq!(m.turn_duration_ms, Some(4894));
        let credits = m.credits.unwrap();
        assert!((credits - 0.305).abs() < 1e-9, "credits was {credits}");
    }

    #[test]
    fn parses_metadata_context_only() {
        let params = json!({ "contextUsagePercentage": 1.3 });
        let m = parse_metadata(&params);
        assert_eq!(m.context_percent, Some(1.3));
        assert_eq!(m.credits, None);
        assert_eq!(m.turn_duration_ms, None);
    }

    #[test]
    fn parses_commands_available_full_inventory() {
        // Shapes captured from a live kiro-cli 2.11.1 run (see acp-notes.md).
        let params = json!({
            "sessionId": "s1",
            "commands": [
                { "name": "/clear", "description": "Clear conversation history" },
                { "name": "/agent", "description": "Select or list available agents",
                  "meta": { "inputType": "selection", "subcommands": ["create","edit"] } }
            ],
            "prompts": [
                { "name": "autoreview", "description": "Pre-commit review",
                  "arguments": [], "serverName": "skill:config" }
            ],
            "tools": [
                { "name": "code", "description": "Code intel", "source": "built-in" },
                { "name": "take_screenshot", "description": "Shot", "source": "mcp:chrome-devtools" }
            ],
            "mcpServers": [
                { "name": "chrome-devtools", "status": "running", "toolCount": 29 }
            ]
        });
        let caps = parse_commands_available(&params);

        assert_eq!(caps.commands.len(), 2);
        assert_eq!(caps.commands[0].name, "/clear"); // leading slash preserved
        assert_eq!(
            caps.commands[1].description,
            "Select or list available agents"
        );

        assert_eq!(caps.prompts.len(), 1);
        assert_eq!(caps.prompts[0].name, "autoreview");
        assert_eq!(caps.prompts[0].server_name.as_deref(), Some("skill:config"));

        assert_eq!(caps.tools.len(), 2);
        assert_eq!(caps.tools[0].source.as_deref(), Some("built-in"));
        assert_eq!(caps.tools[1].source.as_deref(), Some("mcp:chrome-devtools"));

        assert_eq!(caps.mcp_servers.len(), 1);
        assert_eq!(caps.mcp_servers[0].name, "chrome-devtools");
        assert_eq!(caps.mcp_servers[0].tool_count, Some(29));
    }

    #[test]
    fn parse_commands_available_is_lenient() {
        // Missing arrays, items missing `name`, and missing optional fields.
        let params = json!({
            "sessionId": "s1",
            "commands": [
                { "description": "no name — skipped" },
                { "name": "/help" } // no description
            ],
            "tools": [ { "name": "t1" } ] // no description/source
            // prompts and mcpServers omitted entirely
        });
        let caps = parse_commands_available(&params);
        assert_eq!(caps.commands.len(), 1);
        assert_eq!(caps.commands[0].name, "/help");
        assert_eq!(caps.commands[0].description, "");
        assert!(caps.prompts.is_empty());
        assert!(caps.mcp_servers.is_empty());
        assert_eq!(caps.tools.len(), 1);
        assert_eq!(caps.tools[0].source, None);
    }

    #[test]
    fn parses_empty_capabilities() {
        let caps = parse_commands_available(&json!({ "sessionId": "s1" }));
        assert_eq!(caps, Capabilities::default());
    }

    #[test]
    fn parses_subagent_update_empty_and_named() {
        // Empty (as observed in the spike).
        assert!(parse_subagent_update(&json!({ "subagents": [], "pendingStages": [] })).is_empty());
        // Objects with a name, and a bare string — both accepted.
        let subs = parse_subagent_update(&json!({
            "subagents": [ { "name": "reviewer" }, "planner", { "noName": true } ]
        }));
        assert_eq!(subs.len(), 2);
        assert_eq!(subs[0].name, "reviewer");
        assert_eq!(subs[1].name, "planner");
    }

    #[test]
    fn parses_mcp_initialized_server_name() {
        let params = json!({ "sessionId": "s1", "serverName": "chrome-devtools" });
        assert_eq!(
            parse_mcp_initialized(&params).as_deref(),
            Some("chrome-devtools")
        );
        assert_eq!(parse_mcp_initialized(&json!({ "sessionId": "s1" })), None);
    }

    #[test]
    fn capabilities_serialize_camelcase() {
        let caps = Capabilities {
            mcp_servers: vec![McpServer {
                name: "srv".into(),
                status: Some("running".into()),
                tool_count: Some(3),
            }],
            ..Default::default()
        };
        let v = serde_json::to_value(&caps).unwrap();
        // field renamed to camelCase for the TS contract.
        assert_eq!(v["mcpServers"][0]["toolCount"], 3);
        assert_eq!(v["mcpServers"][0]["status"], "running");
    }
}
