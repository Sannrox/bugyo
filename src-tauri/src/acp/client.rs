//! Transport-generic ACP JSON-RPC client.
//!
//! The client is generic over any async reader/writer so it can be driven by a
//! real `kiro-cli acp` child process in production and by an in-memory duplex
//! (with a scripted fake peer) in tests — no network, fully deterministic.

use std::collections::HashMap;
use std::process::Stdio;
use std::sync::atomic::{AtomicI64, AtomicU64, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;

use serde_json::Value;
use tokio::io::{AsyncBufRead, AsyncBufReadExt, AsyncRead, AsyncWrite, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::{mpsc, oneshot};

use super::protocol::{self, Id, Incoming, Update};
use super::{AcpError, AcpEvent, EventSink, SessionStatus};

type Pending = Arc<StdMutex<HashMap<i64, oneshot::Sender<Result<Value, Value>>>>>;
/// Held permission requests awaiting a frontend decision, keyed by the request
/// id's string form → (original id, session id).
type PendingPermissions = Arc<StdMutex<HashMap<String, (Id, String)>>>;

const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
/// Inactivity budget for a prompt turn. A turn is only abandoned when the agent
/// produces **no** output — and holds no pending approval — for this long.
/// Unlike a fixed whole-turn cap, this resets on every inbound message, so a
/// healthy long-running turn that keeps streaming (or is paused awaiting a
/// human decision) never times out; only a genuinely stalled agent does.
const INACTIVITY_TIMEOUT: Duration = Duration::from_secs(180);

/// A live ACP client connected to one agent process/transport.
pub struct AcpClient {
    writer_tx: mpsc::Sender<String>,
    pending: Pending,
    pending_permissions: PendingPermissions,
    next_id: AtomicI64,
    sink: Arc<dyn EventSink>,
    // Keep the child alive for the client's lifetime; killed on drop.
    child: StdMutex<Option<Child>>,
    /// Bumped by the reader loop on every inbound message from the agent; a
    /// prompt's inactivity timeout resets whenever this changes (each message
    /// is proof the agent is alive and working).
    activity: Arc<AtomicU64>,
    /// Inactivity budget for prompt turns (see [`INACTIVITY_TIMEOUT`]);
    /// overridable in tests via [`AcpClient::set_inactivity_timeout`].
    inactivity: Duration,
}

impl AcpClient {
    /// Build a client over arbitrary async transport halves (used by tests).
    pub fn new<R, W>(reader: R, writer: W, sink: Arc<dyn EventSink>) -> Self
    where
        R: AsyncRead + Unpin + Send + 'static,
        W: AsyncWrite + Unpin + Send + 'static,
    {
        let (writer_tx, writer_rx) = mpsc::channel::<String>(64);
        let pending: Pending = Arc::new(StdMutex::new(HashMap::new()));
        let pending_permissions: PendingPermissions = Arc::new(StdMutex::new(HashMap::new()));
        let activity = Arc::new(AtomicU64::new(0));

        tokio::spawn(writer_loop(writer, writer_rx));
        tokio::spawn(reader_loop(
            BufReader::new(reader),
            pending.clone(),
            pending_permissions.clone(),
            sink.clone(),
            writer_tx.clone(),
            activity.clone(),
        ));

        Self {
            writer_tx,
            pending,
            pending_permissions,
            next_id: AtomicI64::new(1),
            sink,
            child: StdMutex::new(None),
            activity,
            inactivity: INACTIVITY_TIMEOUT,
        }
    }

    /// Spawn `kiro-cli acp` (or a compatible agent) and connect over its stdio.
    pub fn spawn(program: &str, args: &[&str], sink: Arc<dyn EventSink>) -> Result<Self, AcpError> {
        let mut child = Command::new(program)
            .args(args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .spawn()?;

        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| AcpError::Unexpected("agent has no stdout".into()))?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| AcpError::Unexpected("agent has no stdin".into()))?;

        let client = Self::new(stdout, stdin, sink);
        *client.child.lock().expect("child mutex poisoned") = Some(child);
        Ok(client)
    }

    fn next_id(&self) -> i64 {
        self.next_id.fetch_add(1, Ordering::Relaxed)
    }

    async fn request(&self, req: Value, id: i64, timeout: Duration) -> Result<Value, AcpError> {
        let (tx, rx) = oneshot::channel();
        self.pending
            .lock()
            .expect("pending mutex poisoned")
            .insert(id, tx);

        self.writer_tx
            .send(req.to_string())
            .await
            .map_err(|_| AcpError::TransportClosed)?;

        match tokio::time::timeout(timeout, rx).await {
            Err(_) => {
                self.pending
                    .lock()
                    .expect("pending mutex poisoned")
                    .remove(&id);
                Err(AcpError::Timeout)
            }
            Ok(Err(_)) => Err(AcpError::TransportClosed),
            Ok(Ok(Err(e))) => Err(AcpError::Agent(e.to_string())),
            Ok(Ok(Ok(v))) => Ok(v),
        }
    }

    /// Await a prompt turn's response using an **inactivity** timeout instead of
    /// a fixed whole-turn cap. The deadline resets on every inbound agent
    /// message (via `activity`) and never fires while a tool-call permission for
    /// this session is awaiting a human decision. A healthy, streaming — or
    /// human-blocked — turn therefore runs as long as it needs; only an agent
    /// that goes completely silent for `self.inactivity` yields
    /// [`AcpError::Timeout`]. On timeout the pending waiter is removed but the
    /// live client is left intact — the caller re-queues (never drops) the task.
    async fn request_prompt(
        &self,
        req: Value,
        id: i64,
        session_id: &str,
    ) -> Result<Value, AcpError> {
        let (tx, mut rx) = oneshot::channel();
        self.pending
            .lock()
            .expect("pending mutex poisoned")
            .insert(id, tx);

        self.writer_tx
            .send(req.to_string())
            .await
            .map_err(|_| AcpError::TransportClosed)?;

        loop {
            let before = self.activity.load(Ordering::Acquire);
            tokio::select! {
                res = &mut rx => {
                    return match res {
                        Err(_) => Err(AcpError::TransportClosed),
                        Ok(Err(e)) => Err(AcpError::Agent(e.to_string())),
                        Ok(Ok(v)) => Ok(v),
                    };
                }
                _ = tokio::time::sleep(self.inactivity) => {
                    // Reset the deadline if the agent produced any output during
                    // the window, or is legitimately paused on a human approval
                    // prompt; only a truly silent turn is abandoned.
                    if self.activity.load(Ordering::Acquire) != before
                        || self.has_pending_permission(session_id)
                    {
                        continue;
                    }
                    self.pending
                        .lock()
                        .expect("pending mutex poisoned")
                        .remove(&id);
                    return Err(AcpError::Timeout);
                }
            }
        }
    }

    /// Whether a tool-call permission request for `session_id` is still awaiting
    /// a human decision (so its paused turn must not be treated as stalled).
    fn has_pending_permission(&self, session_id: &str) -> bool {
        self.pending_permissions
            .lock()
            .expect("pending permissions poisoned")
            .values()
            .any(|(_, sid)| sid == session_id)
    }

    /// Override the prompt inactivity budget. Test-only so unit tests can force
    /// a stall quickly without waiting the production [`INACTIVITY_TIMEOUT`].
    #[cfg(test)]
    fn set_inactivity_timeout(&mut self, d: Duration) {
        self.inactivity = d;
    }

    /// Perform the `initialize` handshake; returns the agent's result object.
    pub async fn initialize(&self) -> Result<Value, AcpError> {
        let id = self.next_id();
        self.request(protocol::initialize_request(id), id, REQUEST_TIMEOUT)
            .await
    }

    /// Create a new session rooted at `cwd`; returns the `sessionId`.
    pub async fn new_session(&self, cwd: &str) -> Result<String, AcpError> {
        let id = self.next_id();
        let res = self
            .request(protocol::new_session_request(id, cwd), id, REQUEST_TIMEOUT)
            .await?;
        res.get("sessionId")
            .and_then(Value::as_str)
            .map(str::to_string)
            .ok_or_else(|| AcpError::Unexpected("session/new missing sessionId".into()))
    }

    /// Resume a persisted session by id (`session/load`).
    pub async fn load_session(&self, session_id: &str, cwd: &str) -> Result<(), AcpError> {
        let id = self.next_id();
        self.request(
            protocol::load_session_request(id, session_id, cwd),
            id,
            REQUEST_TIMEOUT,
        )
        .await?;
        Ok(())
    }

    /// Send a prompt and await the turn; returns the `stopReason`.
    /// Emits Working before the turn and Idle/Error after.
    pub async fn prompt(&self, session_id: &str, text: &str) -> Result<String, AcpError> {
        self.prompt_with_images(session_id, text, &[]).await
    }

    /// Send a prompt with a text block plus image content blocks (e.g. a
    /// screenshot of the running app, Codex-style) and await the turn; returns
    /// the `stopReason`. Emits Working before the turn and Idle/Error after.
    pub async fn prompt_with_images(
        &self,
        session_id: &str,
        text: &str,
        images: &[protocol::ImageAttachment],
    ) -> Result<String, AcpError> {
        self.sink.emit(AcpEvent::Status {
            session_id: Some(session_id.to_string()),
            status: SessionStatus::Working,
        });

        let id = self.next_id();
        let res = self
            .request_prompt(
                protocol::prompt_request_with_images(id, session_id, text, images),
                id,
                session_id,
            )
            .await;

        match &res {
            Ok(_) => self.sink.emit(AcpEvent::Status {
                session_id: Some(session_id.to_string()),
                status: SessionStatus::Idle,
            }),
            Err(_) => self.sink.emit(AcpEvent::Status {
                session_id: Some(session_id.to_string()),
                status: SessionStatus::Error,
            }),
        }

        let res = res?;
        Ok(res
            .get("stopReason")
            .and_then(Value::as_str)
            .unwrap_or("end_turn")
            .to_string())
    }

    /// Request cancellation of the current turn (notification; see protocol note).
    pub async fn cancel(&self, session_id: &str) -> Result<(), AcpError> {
        self.writer_tx
            .send(protocol::cancel_notification(session_id).to_string())
            .await
            .map_err(|_| AcpError::TransportClosed)?;
        Ok(())
    }

    /// Resolve a held permission request by selecting one of its options
    /// (e.g. `allow_once` / `allow_always` / `reject_once`). Sends the outcome
    /// back to the agent so the paused turn resumes.
    pub async fn respond_permission(
        &self,
        request_id: &str,
        option_id: &str,
    ) -> Result<(), AcpError> {
        let entry = self
            .pending_permissions
            .lock()
            .expect("pending permissions poisoned")
            .remove(request_id);

        let (id, session_id) = entry.ok_or_else(|| {
            AcpError::Unexpected(format!("unknown permission request: {request_id}"))
        })?;

        self.writer_tx
            .send(protocol::permission_response(&id, option_id).to_string())
            .await
            .map_err(|_| AcpError::TransportClosed)?;

        // The turn resumes once the agent has the decision.
        self.sink.emit(AcpEvent::Status {
            session_id: Some(session_id),
            status: SessionStatus::Working,
        });
        Ok(())
    }
}

async fn writer_loop<W>(mut writer: W, mut rx: mpsc::Receiver<String>)
where
    W: AsyncWrite + Unpin,
{
    while let Some(line) = rx.recv().await {
        if writer.write_all(line.as_bytes()).await.is_err()
            || writer.write_all(b"\n").await.is_err()
            || writer.flush().await.is_err()
        {
            break;
        }
    }
}

async fn reader_loop<R>(
    mut reader: R,
    pending: Pending,
    pending_permissions: PendingPermissions,
    sink: Arc<dyn EventSink>,
    writer_tx: mpsc::Sender<String>,
    activity: Arc<AtomicU64>,
) where
    R: AsyncBufRead + Unpin,
{
    let mut line = String::new();
    loop {
        line.clear();
        match reader.read_line(&mut line).await {
            Ok(0) | Err(_) => break, // EOF or transport error
            Ok(_) => {}
        }
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let incoming = match protocol::parse_incoming(trimmed) {
            Ok(incoming) => incoming,
            // Ignore malformed lines; stay resilient to version drift.
            Err(_) => continue,
        };
        // Any well-formed message is proof the agent is alive and working:
        // reset the inactivity deadline of any in-flight prompt turn.
        activity.fetch_add(1, Ordering::Release);
        match incoming {
            Incoming::Response { id, result, error } => {
                if let Id::Num(n) = id {
                    if let Some(tx) = pending.lock().expect("pending poisoned").remove(&n) {
                        let outcome = match error {
                            Some(e) => Err(e),
                            None => Ok(result.unwrap_or(Value::Null)),
                        };
                        let _ = tx.send(outcome);
                    }
                }
            }
            Incoming::Request { id, method, params } => {
                handle_agent_request(
                    &id,
                    &method,
                    &params,
                    &pending_permissions,
                    &sink,
                    &writer_tx,
                )
                .await;
            }
            Incoming::Notification { method, params } => {
                handle_notification(&method, &params, &sink);
            }
        }
    }

    // The transport closed (agent exited / stdout EOF or a read error). Fail
    // every in-flight request immediately instead of leaving its waiter to
    // block until `PROMPT_TIMEOUT`: dropping the pending senders makes each
    // `request()` observe a cancelled receiver, which it maps to
    // `AcpError::TransportClosed`. Also clear any held permission requests and
    // nudge those sessions out of `NeedsApproval` so the UI doesn't stay stuck
    // awaiting a decision that can no longer be delivered.
    let stranded: Vec<String> = {
        let mut perms = pending_permissions
            .lock()
            .expect("pending permissions poisoned");
        perms
            .drain()
            .map(|(_, (_id, session_id))| session_id)
            .collect()
    };
    {
        let mut map = pending.lock().expect("pending poisoned");
        map.clear(); // drop all senders → waiters resolve as TransportClosed
    }
    for session_id in stranded {
        sink.emit(AcpEvent::Status {
            session_id: Some(session_id),
            status: SessionStatus::Error,
        });
    }
}

async fn handle_agent_request(
    id: &Id,
    method: &str,
    params: &Value,
    pending_permissions: &PendingPermissions,
    sink: &Arc<dyn EventSink>,
    writer_tx: &mpsc::Sender<String>,
) {
    if method == "session/request_permission" {
        let session_id = protocol::session_id_of(params).unwrap_or_default();
        let parsed = protocol::parse_permission_request(params);
        let request_id = protocol::id_key(id);

        // Hold the request; the turn stays paused until the frontend responds
        // via `respond_permission`. Nothing is auto-approved or auto-denied —
        // this is the human-in-the-loop guarantee (destructive actions always
        // require an explicit owner decision).
        pending_permissions
            .lock()
            .expect("pending permissions poisoned")
            .insert(request_id.clone(), (id.clone(), session_id.clone()));

        sink.emit(AcpEvent::PermissionRequested {
            session_id: session_id.clone(),
            request_id,
            tool_call_id: parsed.tool_call_id,
            title: parsed.title,
            options: parsed.options,
        });
        sink.emit(AcpEvent::Status {
            session_id: Some(session_id),
            status: SessionStatus::NeedsApproval,
        });
    } else {
        // Answer unrecognized agent requests so the turn doesn't stall.
        let _ = writer_tx
            .send(protocol::empty_response(id).to_string())
            .await;
    }
}

fn handle_notification(method: &str, params: &Value, sink: &Arc<dyn EventSink>) {
    match method {
        "session/update" | "_kiro.dev/session/update" => {
            let Some(update) = protocol::parse_update(params) else {
                return;
            };
            let session_id = protocol::session_id_of(params).unwrap_or_default();
            match update {
                Update::AgentMessage { text } => {
                    sink.emit(AcpEvent::AgentMessage { session_id, text })
                }
                Update::AgentThought { text } => {
                    sink.emit(AcpEvent::AgentThought { session_id, text })
                }
                Update::ToolCall {
                    tool_call_id,
                    title,
                    status,
                    diff,
                    output,
                } => sink.emit(AcpEvent::ToolCall {
                    session_id,
                    tool_call_id,
                    title,
                    status,
                    diff,
                    output,
                }),
                Update::ToolCallUpdate {
                    tool_call_id,
                    title,
                    status,
                    output,
                } => sink.emit(AcpEvent::ToolCall {
                    session_id,
                    tool_call_id,
                    title: title.unwrap_or_default(),
                    status,
                    diff: None,
                    output,
                }),
                Update::Unknown { .. } => {}
            }
        }
        "_kiro.dev/metadata" => {
            let meta = protocol::parse_metadata(params);
            if meta.context_percent.is_some()
                || meta.credits.is_some()
                || meta.turn_duration_ms.is_some()
            {
                sink.emit(AcpEvent::Metrics {
                    session_id: protocol::session_id_of(params).unwrap_or_default(),
                    context_percent: meta.context_percent,
                    credits: meta.credits,
                    turn_duration_ms: meta.turn_duration_ms,
                });
            }
        }
        "_kiro.dev/commands/available" => {
            let caps = protocol::parse_commands_available(params);
            sink.emit(AcpEvent::Capabilities {
                session_id: protocol::session_id_of(params).unwrap_or_default(),
                commands: caps.commands,
                prompts: caps.prompts,
                tools: caps.tools,
                mcp_servers: caps.mcp_servers,
            });
        }
        "_kiro.dev/subagent/list_update" => {
            sink.emit(AcpEvent::Subagents {
                session_id: protocol::session_id_of(params).unwrap_or_default(),
                subagents: protocol::parse_subagent_update(params),
            });
        }
        "_kiro.dev/mcp/server_initialized" => {
            if let Some(server_name) = protocol::parse_mcp_initialized(params) {
                sink.emit(AcpEvent::McpServerInitialized {
                    session_id: protocol::session_id_of(params).unwrap_or_default(),
                    server_name,
                });
            }
        }
        _ => {}
    }
}

// Bring the trait into scope for `reader_loop`'s `R: AsyncBufRead` bound.

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use tokio::io::{AsyncWrite, AsyncWriteExt};

    struct VecSink(Arc<StdMutex<Vec<AcpEvent>>>);
    impl EventSink for VecSink {
        fn emit(&self, event: AcpEvent) {
            self.0.lock().unwrap().push(event);
        }
    }

    async fn reply<W: AsyncWrite + Unpin>(writer: &mut W, v: Value) {
        writer.write_all(v.to_string().as_bytes()).await.unwrap();
        writer.write_all(b"\n").await.unwrap();
        writer.flush().await.unwrap();
    }

    /// Scripted fake agent: answers initialize/session.new, and streams a
    /// message chunk before responding to a prompt.
    async fn fake_peer<R, W>(reader: R, mut writer: W)
    where
        R: AsyncRead + Unpin,
        W: AsyncWrite + Unpin,
    {
        let mut lines = BufReader::new(reader).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let v: Value = serde_json::from_str(&line).unwrap();
            let id = v.get("id").cloned();
            let method = v.get("method").and_then(Value::as_str).unwrap_or("");
            match method {
                "initialize" => {
                    reply(
                        &mut writer,
                        json!({"jsonrpc":"2.0","id":id,"result":{"protocolVersion":1,"agentInfo":{"name":"fake"}}}),
                    )
                    .await;
                }
                "session/new" => {
                    reply(
                        &mut writer,
                        json!({"jsonrpc":"2.0","id":id,"result":{"sessionId":"sess-1"}}),
                    )
                    .await;
                }
                "session/prompt" => {
                    reply(
                        &mut writer,
                        json!({"jsonrpc":"2.0","method":"session/update","params":{
                            "sessionId":"sess-1",
                            "update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"hi there"}}
                        }}),
                    )
                    .await;
                    reply(
                        &mut writer,
                        json!({"jsonrpc":"2.0","id":id,"result":{"stopReason":"end_turn"}}),
                    )
                    .await;
                }
                _ => {}
            }
        }
    }

    #[tokio::test]
    async fn full_prompt_turn_over_duplex() {
        let (client_io, peer_io) = tokio::io::duplex(8192);
        let (client_r, client_w) = tokio::io::split(client_io);
        let (peer_r, peer_w) = tokio::io::split(peer_io);
        tokio::spawn(fake_peer(peer_r, peer_w));

        let events = Arc::new(StdMutex::new(Vec::new()));
        let sink = Arc::new(VecSink(events.clone()));
        let client = AcpClient::new(client_r, client_w, sink);

        let init = client.initialize().await.unwrap();
        assert_eq!(init["protocolVersion"], 1);

        let sid = client.new_session("/tmp").await.unwrap();
        assert_eq!(sid, "sess-1");

        let stop = client.prompt(&sid, "hello").await.unwrap();
        assert_eq!(stop, "end_turn");

        let evs = events.lock().unwrap();
        assert!(
            evs.iter().any(|e| matches!(
                e,
                AcpEvent::AgentMessage { text, .. } if text == "hi there"
            )),
            "expected streamed agent message, got {evs:?}"
        );
        assert!(evs.iter().any(|e| matches!(
            e,
            AcpEvent::Status {
                status: SessionStatus::Working,
                ..
            }
        )));
        assert!(evs.iter().any(|e| matches!(
            e,
            AcpEvent::Status {
                status: SessionStatus::Idle,
                ..
            }
        )));
    }

    #[tokio::test]
    async fn new_session_without_id_errors() {
        // Peer that returns a session/new result missing sessionId.
        let (client_io, peer_io) = tokio::io::duplex(4096);
        let (client_r, client_w) = tokio::io::split(client_io);
        let (peer_r, peer_w) = tokio::io::split(peer_io);
        tokio::spawn(async move {
            let mut w = peer_w;
            let mut lines = BufReader::new(peer_r).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let v: Value = serde_json::from_str(&line).unwrap();
                let id = v.get("id").cloned();
                reply(&mut w, json!({"jsonrpc":"2.0","id":id,"result":{}})).await;
            }
        });

        let events = Arc::new(StdMutex::new(Vec::new()));
        let client = AcpClient::new(client_r, client_w, Arc::new(VecSink(events)));
        let err = client.new_session("/tmp").await.unwrap_err();
        assert!(matches!(err, AcpError::Unexpected(_)));
    }

    /// Poll the captured events for a PermissionRequested and return its id.
    async fn wait_for_permission(events: &Arc<StdMutex<Vec<AcpEvent>>>) -> String {
        for _ in 0..200 {
            let found = events.lock().unwrap().iter().find_map(|e| match e {
                AcpEvent::PermissionRequested { request_id, .. } => Some(request_id.clone()),
                _ => None,
            });
            if let Some(rid) = found {
                return rid;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        panic!("permission request was not observed");
    }

    #[tokio::test]
    async fn interactive_permission_flow() {
        let (client_io, peer_io) = tokio::io::duplex(8192);
        let (client_r, client_w) = tokio::io::split(client_io);
        let (peer_r, peer_w) = tokio::io::split(peer_io);

        // Fake peer: on prompt, request permission; when it receives the
        // decision, finish the turn.
        tokio::spawn(async move {
            let mut w = peer_w;
            let mut lines = BufReader::new(peer_r).lines();
            let mut prompt_id: Option<Value> = None;
            while let Ok(Some(line)) = lines.next_line().await {
                let v: Value = serde_json::from_str(&line).unwrap();
                let id = v.get("id").cloned();
                let method = v.get("method").and_then(Value::as_str).unwrap_or("");
                match method {
                    "initialize" => {
                        reply(
                            &mut w,
                            json!({"jsonrpc":"2.0","id":id,"result":{"protocolVersion":1}}),
                        )
                        .await;
                    }
                    "session/new" => {
                        reply(
                            &mut w,
                            json!({"jsonrpc":"2.0","id":id,"result":{"sessionId":"sess-1"}}),
                        )
                        .await;
                    }
                    "session/prompt" => {
                        prompt_id = id.clone();
                        reply(&mut w, json!({"jsonrpc":"2.0","id":"perm-1","method":"session/request_permission","params":{
                            "sessionId":"sess-1",
                            "toolCall":{"toolCallId":"tc1","title":"Write file"},
                            "options":[
                                {"optionId":"allow_once","name":"Yes","kind":"allow_once"},
                                {"optionId":"reject_once","name":"No","kind":"reject_once"}
                            ]
                        }})).await;
                    }
                    _ => {
                        // The permission response: a result addressed to "perm-1".
                        if id == Some(json!("perm-1")) && v.get("result").is_some() {
                            if let Some(pid) = prompt_id.clone() {
                                reply(&mut w, json!({"jsonrpc":"2.0","id":pid,"result":{"stopReason":"end_turn"}})).await;
                            }
                        }
                    }
                }
            }
        });

        let events = Arc::new(StdMutex::new(Vec::new()));
        let client = Arc::new(AcpClient::new(
            client_r,
            client_w,
            Arc::new(VecSink(events.clone())),
        ));
        client.initialize().await.unwrap();
        client.new_session("/tmp").await.unwrap();

        // The prompt stays pending until we approve the tool call.
        let cp = client.clone();
        let prompt_task = tokio::spawn(async move { cp.prompt("sess-1", "write a file").await });

        let request_id = wait_for_permission(&events).await;
        client
            .respond_permission(&request_id, "allow_once")
            .await
            .unwrap();

        let stop = prompt_task.await.unwrap().unwrap();
        assert_eq!(stop, "end_turn");

        let evs = events.lock().unwrap();
        assert!(
            evs.iter().any(|e| matches!(
                e,
                AcpEvent::PermissionRequested { options, .. } if options.len() == 2
            )),
            "expected a permission request with 2 options, got {evs:?}"
        );
        assert!(evs.iter().any(|e| matches!(
            e,
            AcpEvent::Status {
                status: SessionStatus::NeedsApproval,
                ..
            }
        )));
    }

    #[test]
    fn capability_notifications_emit_events() {
        let events = Arc::new(StdMutex::new(Vec::new()));
        let sink: Arc<dyn EventSink> = Arc::new(VecSink(events.clone()));

        handle_notification(
            "_kiro.dev/commands/available",
            &json!({
                "sessionId": "s1",
                "commands": [{ "name": "/clear", "description": "Clear conversation history" }],
                "prompts": [{ "name": "autoreview", "description": "review", "serverName": "skill:config" }],
                "tools": [{ "name": "code", "description": "intel", "source": "built-in" }],
                "mcpServers": [{ "name": "chrome-devtools", "status": "running", "toolCount": 29 }]
            }),
            &sink,
        );
        handle_notification(
            "_kiro.dev/subagent/list_update",
            &json!({ "sessionId": "s1", "subagents": [{ "name": "reviewer" }], "pendingStages": [] }),
            &sink,
        );
        handle_notification(
            "_kiro.dev/mcp/server_initialized",
            &json!({ "sessionId": "s1", "serverName": "chrome-devtools" }),
            &sink,
        );

        let evs = events.lock().unwrap();
        assert!(
            evs.iter().any(|e| matches!(
                e,
                AcpEvent::Capabilities { session_id, commands, prompts, tools, mcp_servers }
                    if session_id == "s1"
                        && commands.len() == 1
                        && commands[0].name == "/clear"
                        && prompts.len() == 1
                        && tools.len() == 1
                        && mcp_servers.len() == 1
            )),
            "expected Capabilities event, got {evs:?}"
        );
        assert!(
            evs.iter().any(|e| matches!(
                e,
                AcpEvent::Subagents { session_id, subagents }
                    if session_id == "s1" && subagents.len() == 1 && subagents[0].name == "reviewer"
            )),
            "expected Subagents event, got {evs:?}"
        );
        assert!(
            evs.iter().any(|e| matches!(
                e,
                AcpEvent::McpServerInitialized { session_id, server_name }
                    if session_id == "s1" && server_name == "chrome-devtools"
            )),
            "expected McpServerInitialized event, got {evs:?}"
        );
    }

    #[tokio::test]
    async fn respond_to_unknown_permission_errors() {
        let (client_io, _peer_io) = tokio::io::duplex(1024);
        let (client_r, client_w) = tokio::io::split(client_io);
        let events = Arc::new(StdMutex::new(Vec::new()));
        let client = AcpClient::new(client_r, client_w, Arc::new(VecSink(events)));
        let err = client
            .respond_permission("nope", "allow_once")
            .await
            .unwrap_err();
        assert!(matches!(err, AcpError::Unexpected(_)));
    }

    /// Peer that answers the handshake, then closes its transport when a prompt
    /// arrives — without ever replying to the prompt. Models a `kiro-cli`
    /// process dying mid-turn.
    async fn closing_peer<R, W>(reader: R, mut writer: W)
    where
        R: AsyncRead + Unpin,
        W: AsyncWrite + Unpin,
    {
        let mut lines = BufReader::new(reader).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let v: Value = serde_json::from_str(&line).unwrap();
            let id = v.get("id").cloned();
            match v.get("method").and_then(Value::as_str).unwrap_or("") {
                "initialize" => {
                    reply(
                        &mut writer,
                        json!({"jsonrpc":"2.0","id":id,"result":{"protocolVersion":1}}),
                    )
                    .await;
                }
                "session/new" => {
                    reply(
                        &mut writer,
                        json!({"jsonrpc":"2.0","id":id,"result":{"sessionId":"sess-1"}}),
                    )
                    .await;
                }
                // Drop the transport instead of responding to the prompt.
                "session/prompt" => return,
                _ => {}
            }
        }
    }

    #[tokio::test]
    async fn transport_close_fails_in_flight_prompt_fast() {
        let (client_io, peer_io) = tokio::io::duplex(8192);
        let (client_r, client_w) = tokio::io::split(client_io);
        let (peer_r, peer_w) = tokio::io::split(peer_io);
        tokio::spawn(closing_peer(peer_r, peer_w));

        let events = Arc::new(StdMutex::new(Vec::new()));
        let client = AcpClient::new(client_r, client_w, Arc::new(VecSink(events)));
        client.initialize().await.unwrap();
        client.new_session("/tmp").await.unwrap();

        // Must resolve quickly (transport close fails the in-flight prompt
        // immediately; it must not hang until the inactivity timeout).
        let outcome = tokio::time::timeout(Duration::from_secs(5), client.prompt("sess-1", "hi"))
            .await
            .expect("prompt should return promptly on transport close, not time out");
        assert!(
            matches!(outcome, Err(AcpError::TransportClosed)),
            "expected TransportClosed, got {outcome:?}"
        );
    }

    #[tokio::test]
    async fn transport_close_clears_held_permission() {
        let (client_io, peer_io) = tokio::io::duplex(8192);
        let (client_r, client_w) = tokio::io::split(client_io);
        let (peer_r, peer_w) = tokio::io::split(peer_io);

        // Peer: on prompt, request a permission and then close the transport.
        tokio::spawn(async move {
            let mut w = peer_w;
            let mut lines = BufReader::new(peer_r).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let v: Value = serde_json::from_str(&line).unwrap();
                let id = v.get("id").cloned();
                match v.get("method").and_then(Value::as_str).unwrap_or("") {
                    "initialize" => {
                        reply(
                            &mut w,
                            json!({"jsonrpc":"2.0","id":id,"result":{"protocolVersion":1}}),
                        )
                        .await;
                    }
                    "session/new" => {
                        reply(
                            &mut w,
                            json!({"jsonrpc":"2.0","id":id,"result":{"sessionId":"sess-1"}}),
                        )
                        .await;
                    }
                    "session/prompt" => {
                        reply(&mut w, json!({"jsonrpc":"2.0","id":"perm-1","method":"session/request_permission","params":{
                            "sessionId":"sess-1",
                            "toolCall":{"toolCallId":"tc1","title":"Write file"},
                            "options":[{"optionId":"allow_once","name":"Yes","kind":"allow_once"}]
                        }})).await;
                        return; // close after issuing the permission request
                    }
                    _ => {}
                }
            }
        });

        let events = Arc::new(StdMutex::new(Vec::new()));
        let client = Arc::new(AcpClient::new(
            client_r,
            client_w,
            Arc::new(VecSink(events.clone())),
        ));
        client.initialize().await.unwrap();
        client.new_session("/tmp").await.unwrap();

        let cp = client.clone();
        tokio::spawn(async move {
            let _ = cp.prompt("sess-1", "write").await;
        });

        let request_id = wait_for_permission(&events).await;

        // Once the transport closes, the held permission is cleared: resolving
        // it now reports "unknown". Poll to allow the reader loop to observe EOF.
        let mut cleared = false;
        for _ in 0..200 {
            if let Err(AcpError::Unexpected(_)) =
                client.respond_permission(&request_id, "allow_once").await
            {
                cleared = true;
                break;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        assert!(
            cleared,
            "held permission should be cleared on transport close"
        );
    }

    /// A streaming turn that keeps emitting `session/update` chunks well past
    /// the inactivity window must NOT time out: each chunk resets the deadline.
    #[tokio::test]
    async fn inactivity_timeout_resets_on_agent_activity() {
        let (client_io, peer_io) = tokio::io::duplex(8192);
        let (client_r, client_w) = tokio::io::split(client_io);
        let (peer_r, peer_w) = tokio::io::split(peer_io);

        // Peer: on prompt, stream 6 chunks spaced 80ms apart (~480ms total,
        // well beyond the 200ms window) before finally answering the prompt.
        tokio::spawn(async move {
            let mut w = peer_w;
            let mut lines = BufReader::new(peer_r).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let v: Value = serde_json::from_str(&line).unwrap();
                let id = v.get("id").cloned();
                match v.get("method").and_then(Value::as_str).unwrap_or("") {
                    "initialize" => {
                        reply(
                            &mut w,
                            json!({"jsonrpc":"2.0","id":id,"result":{"protocolVersion":1}}),
                        )
                        .await;
                    }
                    "session/new" => {
                        reply(
                            &mut w,
                            json!({"jsonrpc":"2.0","id":id,"result":{"sessionId":"sess-1"}}),
                        )
                        .await;
                    }
                    "session/prompt" => {
                        for _ in 0..6 {
                            tokio::time::sleep(Duration::from_millis(80)).await;
                            reply(&mut w, json!({"jsonrpc":"2.0","method":"session/update","params":{
                                "sessionId":"sess-1",
                                "update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"working"}}
                            }})).await;
                        }
                        reply(
                            &mut w,
                            json!({"jsonrpc":"2.0","id":id,"result":{"stopReason":"end_turn"}}),
                        )
                        .await;
                    }
                    _ => {}
                }
            }
        });

        let events = Arc::new(StdMutex::new(Vec::new()));
        let mut client = AcpClient::new(client_r, client_w, Arc::new(VecSink(events)));
        client.set_inactivity_timeout(Duration::from_millis(200));
        client.initialize().await.unwrap();
        client.new_session("/tmp").await.unwrap();

        let stop = client.prompt("sess-1", "long task").await.unwrap();
        assert_eq!(
            stop, "end_turn",
            "a turn that keeps streaming must not time out even past the window"
        );
    }

    /// A turn whose agent goes completely silent (no updates, no response) while
    /// the transport stays open must time out via the inactivity budget.
    #[tokio::test]
    async fn inactivity_timeout_fires_when_agent_goes_silent() {
        let (client_io, peer_io) = tokio::io::duplex(8192);
        let (client_r, client_w) = tokio::io::split(client_io);
        let (peer_r, peer_w) = tokio::io::split(peer_io);

        // Peer answers the handshake, then never responds to the prompt but
        // keeps its transport open (parks on the next read) — modelling a
        // wedged, silent agent rather than a crashed one.
        tokio::spawn(async move {
            let mut w = peer_w;
            let mut lines = BufReader::new(peer_r).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let v: Value = serde_json::from_str(&line).unwrap();
                let id = v.get("id").cloned();
                match v.get("method").and_then(Value::as_str).unwrap_or("") {
                    "initialize" => {
                        reply(
                            &mut w,
                            json!({"jsonrpc":"2.0","id":id,"result":{"protocolVersion":1}}),
                        )
                        .await;
                    }
                    "session/new" => {
                        reply(
                            &mut w,
                            json!({"jsonrpc":"2.0","id":id,"result":{"sessionId":"sess-1"}}),
                        )
                        .await;
                    }
                    // Deliberately silent on prompt; loop back and park on read.
                    _ => {}
                }
            }
        });

        let events = Arc::new(StdMutex::new(Vec::new()));
        let mut client = AcpClient::new(client_r, client_w, Arc::new(VecSink(events)));
        client.set_inactivity_timeout(Duration::from_millis(150));
        client.initialize().await.unwrap();
        client.new_session("/tmp").await.unwrap();

        let outcome = tokio::time::timeout(Duration::from_secs(3), client.prompt("sess-1", "hi"))
            .await
            .expect("a silent turn must resolve via the inactivity timeout");
        assert!(
            matches!(outcome, Err(AcpError::Timeout)),
            "expected Timeout on a silent stalled turn, got {outcome:?}"
        );
    }

    /// Live smoke test against the real agent. Ignored by default (requires
    /// `kiro-cli` on PATH and hits the real binary); run with:
    /// `cargo test --all-features -- --ignored live_initialize_and_new_session`
    #[tokio::test]
    #[ignore = "requires kiro-cli on PATH"]
    async fn live_initialize_and_new_session() {
        let events = Arc::new(StdMutex::new(Vec::new()));
        let client = AcpClient::spawn("kiro-cli", &["acp"], Arc::new(VecSink(events))).unwrap();

        let init = client.initialize().await.unwrap();
        assert_eq!(init["protocolVersion"], 1);

        let cwd = std::env::temp_dir().to_string_lossy().into_owned();
        let session_id = client.new_session(&cwd).await.unwrap();
        assert!(!session_id.is_empty());
    }

    /// Live smoke test: a real session emits its capability inventory
    /// (`_kiro.dev/commands/available`). Ignored by default (requires
    /// `kiro-cli` on PATH). Run with:
    /// `cargo test --all-features -- --ignored live_session_emits_capabilities`
    #[tokio::test]
    #[ignore = "requires kiro-cli on PATH"]
    async fn live_session_emits_capabilities() {
        let events = Arc::new(StdMutex::new(Vec::new()));
        let client =
            AcpClient::spawn("kiro-cli", &["acp"], Arc::new(VecSink(events.clone()))).unwrap();
        client.initialize().await.unwrap();
        let cwd = std::env::temp_dir().to_string_lossy().into_owned();
        client.new_session(&cwd).await.unwrap();

        // Capability notifications fire asynchronously around session creation.
        let mut found = false;
        for _ in 0..200 {
            if events.lock().unwrap().iter().any(
                |e| matches!(e, AcpEvent::Capabilities { commands, .. } if !commands.is_empty()),
            ) {
                found = true;
                break;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
        assert!(found, "expected a Capabilities event with commands");
    }
}
