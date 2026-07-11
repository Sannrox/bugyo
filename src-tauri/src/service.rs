//! Tauri-facing ACP service.
//!
//! Manages many concurrent sessions keyed by ACP session id, each optionally
//! bound to an isolated git worktree ([`crate::workspace`]) and driven by a
//! per-session task queue. The queue is stored on disk under Bugyo's home
//! ([`crate::state`]) as the single source of truth; the in-memory `busy` flag
//! guards dispatch.
//!
//! Enqueue → dispatch immediately if idle, else queue; when a turn finishes the
//! next queued task drains automatically. An in-app heartbeat is a periodic
//! safety-net pass over all sessions.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::Mutex;

use crate::acp::client::AcpClient;
use crate::acp::{AcpError, AcpEvent, EventSink};
use crate::config;
use crate::orchestrator::{Dispatched, HeartbeatReport};
use crate::state::{self, WorkerMeta};
use crate::workspace::{self, Workspace};

/// Tauri event channels.
pub const ACP_EVENT: &str = "acp:event";
pub const QUEUE_EVENT: &str = "orch:queue";
pub const HEARTBEAT_EVENT: &str = "orch:heartbeat";
/// Automation run reports (fired when an automation is triggered).
pub const AUTOMATION_EVENT: &str = "automation:run";
/// Budget-exceeded reports (fired when dispatch is paused for a capped session).
pub const BUDGET_EVENT: &str = "budget:exceeded";
/// Heartbeat pass interval (seconds).
pub const HEARTBEAT_SECS: u64 = 10;

/// Automation scheduler pass interval (seconds). Governs the finest cadence at
/// which due automations are noticed (interval/cron are still honoured).
pub const AUTOMATION_SECS: u64 = 30;

struct TauriEventSink {
    app: AppHandle,
    /// Shared with [`Inner::spent`]; accumulates per-session credit spend.
    spent: Arc<std::sync::Mutex<HashMap<String, f64>>>,
}

/// Filters history notifications replayed by ACP `session/load`. The frontend
/// has already restored that transcript from Bugyo's durable store, so
/// forwarding the replay would duplicate every message and recount historical
/// credits. Capability/error/permission state remains live, and the gate is
/// opened immediately after `session/load` completes for the new turn.
struct ResumeEventSink {
    inner: Arc<dyn EventSink>,
    replaying: AtomicBool,
}

impl ResumeEventSink {
    fn new(inner: Arc<dyn EventSink>) -> Self {
        Self {
            inner,
            replaying: AtomicBool::new(true),
        }
    }

    fn finish_replay(&self) {
        self.replaying.store(false, Ordering::Release);
    }
}

impl EventSink for ResumeEventSink {
    fn emit(&self, event: AcpEvent) {
        if self.replaying.load(Ordering::Acquire)
            && matches!(
                &event,
                AcpEvent::AgentMessage { .. }
                    | AcpEvent::AgentThought { .. }
                    | AcpEvent::ToolCall { .. }
                    | AcpEvent::Metrics { .. }
            )
        {
            return;
        }
        self.inner.emit(event);
    }
}

impl EventSink for TauriEventSink {
    fn emit(&self, event: AcpEvent) {
        // Accumulate credit spend so the dispatch path can enforce budget caps.
        if let AcpEvent::Metrics {
            session_id,
            credits: Some(c),
            ..
        } = &event
        {
            if let Ok(mut map) = self.spent.lock() {
                *map.entry(session_id.clone()).or_insert(0.0) += *c;
            }
        }
        let _ = self.app.emit(ACP_EVENT, event);
    }
}

struct SessionEntry {
    /// The live agent client, or `None` when the session is cold (no process).
    client: Option<Arc<AcpClient>>,
    /// Args to (re)spawn `kiro-cli acp` for this session.
    args: Vec<String>,
    workspace: Option<Workspace>,
    /// Durable backend-owned review/check/landing state for workspaces.
    review: workspace::ReviewRecord,
    /// Name used for the worker/queue files (branch, or session id).
    worker_name: String,
    repo: String,
    command: String,
    created: String,
    /// Dispatch reservation flag. An `Arc<AtomicBool>` (rather than a plain
    /// `bool` behind the sessions mutex) so a [`BusyGuard`] can reset it
    /// synchronously on drop — guaranteeing the reservation is released even if
    /// a turn's future is dropped (cancelled) or panics.
    busy: Arc<AtomicBool>,
    /// The automation that created this session, if any (enables reuse).
    automation_id: Option<String>,
}

/// RAII reset for a session's `busy` reservation. Dropping it clears the flag,
/// so an aborted/panicked turn can never leave a session permanently
/// un-dispatchable. On the normal path the flag is already cleared, making the
/// drop a harmless no-op. (The worker.json "idle" marking on an abnormal drop
/// is reconciled by the next heartbeat pass.)
struct BusyGuard(Arc<AtomicBool>);

impl Drop for BusyGuard {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}

#[derive(Default)]
struct Inner {
    sessions: Mutex<HashMap<String, SessionEntry>>,
    /// Per-worker locks serializing the read-modify-write on each worker's
    /// on-disk queue file, keyed by worker name. Without this, a concurrent
    /// `append_queue` (open+append) and `pop_queue` (read-all → rewrite) can
    /// interleave and drop an enqueued task. In-process only; cross-process
    /// contention with the `kiro-orch` CLI remains (advisory file locks would
    /// be the fix there — future hardening).
    queue_locks: Mutex<HashMap<String, Arc<Mutex<()>>>>,
    /// Accumulated credit spend per session, summed from `Metrics` events as
    /// they pass through the event sink. A `std::sync::Mutex` (not tokio) so the
    /// synchronous [`EventSink::emit`] can update it without awaiting. Used to
    /// enforce budget caps in the dispatch path.
    spent: Arc<std::sync::Mutex<HashMap<String, f64>>>,
    app: OnceLock<AppHandle>,
}

/// Fleet manager. Cheaply cloneable (shared `Arc`) so a background heartbeat
/// task and the Tauri commands share the same state.
#[derive(Clone, Default)]
pub struct AcpManager {
    inner: Arc<Inner>,
}

/// Queue-depth event payload.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct QueueUpdate {
    session_id: String,
    queued: usize,
}

/// `budget:exceeded` event payload — dispatch was paused for a capped session.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct BudgetExceeded {
    session_id: String,
    spent: f64,
    cap: f64,
}

impl AcpManager {
    /// Store the app handle (once) so background work can emit events.
    pub fn register_app(&self, app: AppHandle) {
        let _ = self.inner.app.set(app);
    }

    fn emit<S: Serialize + Clone>(&self, event: &str, payload: S) {
        if let Some(app) = self.inner.app.get() {
            let _ = app.emit(event, payload);
        }
    }

    /// Persist the in-memory per-session credit-spend map so budget caps survive
    /// app restarts. Best-effort; called at low-frequency turn boundaries rather
    /// than on every streamed metrics event.
    fn persist_spend(&self) {
        if let Ok(map) = self.inner.spent.lock() {
            let _ = config::save_spend(&config::config_home(), &map);
        }
    }

    /// Drop a session's accumulated spend (on delete/archive) so the map doesn't
    /// grow unbounded and a recycled id can't inherit a stale tally. Persists.
    fn forget_spend(&self, session_id: &str) {
        if let Ok(mut map) = self.inner.spent.lock() {
            map.remove(session_id);
        }
        self.persist_spend();
    }

    /// The live client for a session, or an error if it isn't currently active.
    async fn client(&self, session_id: &str) -> Result<Arc<AcpClient>, String> {
        let guard = self.inner.sessions.lock().await;
        let entry = guard
            .get(session_id)
            .ok_or_else(|| format!("no session: {session_id}"))?;
        entry
            .client
            .clone()
            .ok_or_else(|| format!("session not active: {session_id}"))
    }

    /// Ensure a live client exists for a session, spawning + resuming
    /// (`session/load`) on demand if the session is cold. This is the heart of
    /// the lazy lifecycle: idle sessions hold no process; prompting one loads it.
    async fn ensure_client(&self, session_id: &str) -> Result<Arc<AcpClient>, String> {
        // Fast path: already warm.
        {
            let guard = self.inner.sessions.lock().await;
            if let Some(entry) = guard.get(session_id) {
                if let Some(client) = &entry.client {
                    return Ok(client.clone());
                }
            } else {
                return Err(format!("no session: {session_id}"));
            }
        }

        let (args, cwd) = {
            let guard = self.inner.sessions.lock().await;
            let entry = guard
                .get(session_id)
                .ok_or_else(|| format!("no session: {session_id}"))?;
            (entry.args.clone(), entry.repo.clone())
        };

        // Reclaim a stale lock from a prior (killed) process, then resume.
        crate::acp::reclaim_stale_lock(session_id);
        let app = self
            .inner
            .app
            .get()
            .ok_or("app handle not initialised")?
            .clone();
        let sink: Arc<dyn EventSink> = Arc::new(TauriEventSink {
            app,
            spent: self.inner.spent.clone(),
        });
        let resume_sink = Arc::new(ResumeEventSink::new(sink));
        let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
        let program = crate::acp::resolve_kiro_cli();
        let client =
            AcpClient::spawn(program, &arg_refs, resume_sink.clone()).map_err(|e| e.to_string())?;
        client.initialize().await.map_err(|e| e.to_string())?;
        client
            .load_session(session_id, &cwd)
            .await
            .map_err(|e| e.to_string())?;
        resume_sink.finish_replay();
        let client = Arc::new(client);

        let mut guard = self.inner.sessions.lock().await;
        if let Some(entry) = guard.get_mut(session_id) {
            entry.client = Some(client.clone());
        }
        Ok(client)
    }

    /// Release a session's process when it goes idle (frees the kiro lock).
    async fn release_client(&self, session_id: &str) {
        if let Some(entry) = self.inner.sessions.lock().await.get_mut(session_id) {
            entry.client = None;
        }
    }

    async fn worker_name(&self, session_id: &str) -> Option<String> {
        self.inner
            .sessions
            .lock()
            .await
            .get(session_id)
            .map(|e| e.worker_name.clone())
    }

    /// The id of an existing session created by `automation_id`, if one is
    /// still known (in-memory, including cold sessions rehydrated at startup).
    /// Enables bounded reuse for recurring `New*` automations.
    async fn session_for_automation(&self, automation_id: &str) -> Option<String> {
        self.inner
            .sessions
            .lock()
            .await
            .iter()
            .find(|(_, e)| e.automation_id.as_deref() == Some(automation_id))
            .map(|(id, _)| id.clone())
    }

    /// The workspace bound to a session, or an error if none.
    async fn workspace_of(&self, session_id: &str) -> Result<Workspace, String> {
        self.inner
            .sessions
            .lock()
            .await
            .get(session_id)
            .and_then(|e| e.workspace.clone())
            .ok_or_else(|| format!("no workspace session: {session_id}"))
    }

    async fn review_record_of(&self, session_id: &str) -> Result<workspace::ReviewRecord, String> {
        self.inner
            .sessions
            .lock()
            .await
            .get(session_id)
            .map(|entry| entry.review.clone())
            .ok_or_else(|| format!("unknown session: {session_id}"))
    }

    /// Update review state in memory and in the persisted session descriptor.
    async fn save_review_record(
        &self,
        session_id: &str,
        review: workspace::ReviewRecord,
    ) -> Result<(), String> {
        let persisted = {
            let mut guard = self.inner.sessions.lock().await;
            let entry = guard
                .get_mut(session_id)
                .ok_or_else(|| format!("unknown session: {session_id}"))?;
            entry.review = review.clone();
            config::PersistedSession {
                session_id: session_id.to_string(),
                repo: entry.repo.clone(),
                workspace: entry
                    .workspace
                    .as_ref()
                    .and_then(|workspace| serde_json::to_value(workspace).ok()),
                review: serde_json::to_value(review).ok(),
                worker_name: entry.worker_name.clone(),
                args: entry.args.clone(),
                command: entry.command.clone(),
                created: entry.created.clone(),
                automation_id: entry.automation_id.clone(),
            }
        };
        config::save_session(&config::config_home(), &persisted).map_err(|error| error.to_string())
    }

    /// Emit the current queue depth for a session.
    async fn emit_queue(&self, session_id: &str) {
        let depth = match self.worker_name(session_id).await {
            Some(name) => state::read_queue(&state::orch_home(), &name)
                .map(|q| q.len())
                .unwrap_or(0),
            None => 0,
        };
        self.emit(
            QUEUE_EVENT,
            QueueUpdate {
                session_id: session_id.to_string(),
                queued: depth,
            },
        );
    }

    /// The per-worker queue lock (created on first use), serializing all
    /// read-modify-write mutations of that worker's on-disk queue file.
    async fn queue_lock(&self, worker: &str) -> Arc<Mutex<()>> {
        self.inner
            .queue_locks
            .lock()
            .await
            .entry(worker.to_string())
            .or_default()
            .clone()
    }

    /// Enqueue a task (persisted to the CLI-compatible queue) and dispatch it
    /// immediately if the session is idle.
    pub async fn enqueue(&self, session_id: &str, task: &str) -> Result<(), String> {
        let name = self
            .worker_name(session_id)
            .await
            .ok_or_else(|| format!("no session: {session_id}"))?;
        {
            // Serialize with any concurrent pop on this worker's queue.
            let lock = self.queue_lock(&name).await;
            let _g = lock.lock().await;
            state::append_queue(&state::orch_home(), &name, task).map_err(|e| e.to_string())?;
        }
        self.emit_queue(session_id).await;
        self.dispatch_one(session_id).await;
        Ok(())
    }

    /// Read the ordered durable queue for a session.
    pub async fn queue_tasks(&self, session_id: &str) -> Result<Vec<String>, String> {
        let name = self
            .worker_name(session_id)
            .await
            .ok_or_else(|| format!("no session: {session_id}"))?;
        let lock = self.queue_lock(&name).await;
        let _queue_guard = lock.lock().await;
        state::read_queue(&state::orch_home(), &name).map_err(|error| error.to_string())
    }

    /// Replace a session queue while holding the same lock used by heartbeat
    /// dispatch, so UI edits cannot race a pop/append and lose work.
    pub async fn replace_queue(&self, session_id: &str, tasks: Vec<String>) -> Result<(), String> {
        let name = self
            .worker_name(session_id)
            .await
            .ok_or_else(|| format!("no session: {session_id}"))?;
        let lock = self.queue_lock(&name).await;
        let queue_guard = lock.lock().await;
        state::replace_queue(&state::orch_home(), &name, &tasks)
            .map_err(|error| error.to_string())?;
        drop(queue_guard);
        self.emit_queue(session_id).await;
        self.log(&format!(
            "queue edited -> {session_id}: {} task(s)",
            tasks.iter().filter(|task| !task.trim().is_empty()).count()
        ))
        .await;
        Ok(())
    }

    /// Put a task back at the **head** of a session's queue (retry semantics),
    /// under the per-worker queue lock. Used when a turn stalls (inactivity
    /// timeout) so the in-flight task is retried by a fresh client rather than
    /// dropped. Returns silently if the session is gone.
    async fn requeue_front(&self, session_id: &str, task: &str) {
        let Some(name) = self.worker_name(session_id).await else {
            return;
        };
        let lock = self.queue_lock(&name).await;
        let _g = lock.lock().await;
        let _ = state::prepend_queue(&state::orch_home(), &name, task);
    }

    /// The stored app handle, or an error if the app hasn't initialised yet.
    fn app_handle(&self) -> Result<AppHandle, String> {
        self.inner
            .app
            .get()
            .cloned()
            .ok_or_else(|| "app handle not initialised".to_string())
    }

    /// Fire an automation now: route by target to enqueue (existing session) or
    /// start/workspace-create (new session), deliver the durable prompt, then
    /// record + emit an [`AutomationRun`]. Does **not** advance `last_run` — the
    /// scheduler owns that, and a manual "run now" is a test that shouldn't move
    /// the schedule (matches the Codex "test before scheduling" flow).
    pub async fn run_automation(&self, automation: &config::Automation) -> config::AutomationRun {
        let run = match self.run_automation_inner(automation).await {
            Ok((session_id, status)) => config::AutomationRun {
                ts: state::now_ts(),
                automation_id: automation.id.clone(),
                session_id,
                status: status.to_string(),
                message: None,
            },
            Err(e) => config::AutomationRun {
                ts: state::now_ts(),
                automation_id: automation.id.clone(),
                session_id: None,
                status: "error".to_string(),
                message: Some(e),
            },
        };
        self.log(&format!(
            "automation \"{}\" -> {}",
            automation.name, run.status
        ))
        .await;
        self.emit(AUTOMATION_EVENT, run.clone());
        run
    }

    /// One automation scheduler pass: fire every enabled automation that is due
    /// (advancing its `last_run`), and seed a fresh cron's `last_run` so it
    /// begins tracking from now. Returns the runs performed this pass.
    pub async fn automation_tick(&self) -> Vec<config::AutomationRun> {
        let home = config::config_home();
        let automations = config::list_automations(&home).unwrap_or_default();
        let now = chrono::Local::now().fixed_offset();
        let due: std::collections::HashSet<String> =
            crate::orchestrator::schedule::due_automation_ids(&automations, now)
                .into_iter()
                .collect();

        let mut runs = Vec::new();
        for automation in &automations {
            if !automation.enabled {
                continue;
            }
            if due.contains(&automation.id) {
                let run = self.run_automation(automation).await;
                // Advance last_run so interval/cron measure from this pass.
                let mut updated = automation.clone();
                updated.last_run = Some(state::now_ts());
                let _ = config::save_automation(&home, &updated);
                runs.push(run);
            } else if automation.last_run.is_none() {
                // A fresh automation that did not fire this pass starts tracking
                // now: intervals measure "every N" from here, and crons anchor
                // their next occurrence — so neither fires instantly on the
                // first pass, and app restarts don't re-fire never-run ones.
                let mut updated = automation.clone();
                updated.last_run = Some(state::now_ts());
                let _ = config::save_automation(&home, &updated);
            }
        }
        runs
    }

    /// Route an automation to its action. Returns `(session_id, status)` where
    /// status is `"dispatched"` (existing) or `"created"` (new).
    async fn run_automation_inner(
        &self,
        automation: &config::Automation,
    ) -> Result<(Option<String>, &'static str), String> {
        let prompt = automation.prompt.clone();
        let (trust_all, trust_tools) = trust_args(&automation.trust);
        match &automation.target {
            config::AutomationTarget::ExistingSession { session_id } => {
                self.enqueue(session_id, &prompt).await?;
                Ok((Some(session_id.clone()), "dispatched"))
            }
            config::AutomationTarget::NewSession { cwd, agent, model } => {
                // Bounded reuse: a recurring automation reuses the session it
                // created on its first fire instead of spawning a new process
                // every time. Recreates only if that session is gone.
                if let Some(existing) = self.session_for_automation(&automation.id).await {
                    self.enqueue(&existing, &prompt).await?;
                    return Ok((Some(existing), "dispatched"));
                }
                let app = self.app_handle()?;
                let cwd = match cwd.clone() {
                    Some(c) => c,
                    None => std::env::current_dir()
                        .map_err(|e| e.to_string())?
                        .to_string_lossy()
                        .into_owned(),
                };
                let args = build_args(trust_all, trust_tools, agent.clone(), model.clone());
                let (client, id) =
                    start_client(&app, &cwd, &args, self.inner.spent.clone()).await?;
                self.insert(
                    id.clone(),
                    client,
                    args.clone(),
                    None,
                    cwd,
                    format!("kiro-cli {}", args.join(" ")),
                    Some(automation.id.clone()),
                )
                .await;
                self.enqueue(&id, &prompt).await?;
                Ok((Some(id), "created"))
            }
            config::AutomationTarget::NewWorkspace {
                project_path,
                base_branch,
                branch_prefix,
                agent,
                model,
            } => {
                // Bounded reuse: reuse the workspace created on the first fire
                // rather than accumulating a new worktree/branch/process each
                // time this recurring automation runs.
                if let Some(existing) = self.session_for_automation(&automation.id).await {
                    self.enqueue(&existing, &prompt).await?;
                    return Ok((Some(existing), "dispatched"));
                }
                let app = self.app_handle()?;
                // The branch label is derived from the prefix (or the automation
                // name); the durable prompt is delivered separately via enqueue.
                let label = branch_prefix
                    .clone()
                    .filter(|s| !s.trim().is_empty())
                    .unwrap_or_else(|| automation.name.clone());
                let repo_root = project_path.clone();
                let base = base_branch.clone();
                let ws = tokio::task::spawn_blocking(move || -> Result<Workspace, String> {
                    let repo = PathBuf::from(&repo_root);
                    let wt_root = workspace::default_worktrees_root(&repo);
                    workspace::create(&repo, &base, &label, &wt_root).map_err(|e| e.to_string())
                })
                .await
                .map_err(|e| e.to_string())??;

                let args = build_args(trust_all, trust_tools, agent.clone(), model.clone());
                let (client, id) =
                    start_client(&app, &ws.worktree_path, &args, self.inner.spent.clone()).await?;
                self.insert(
                    id.clone(),
                    client,
                    args.clone(),
                    Some(ws.clone()),
                    ws.repo_root.clone(),
                    format!("kiro-cli {}", args.join(" ")),
                    Some(automation.id.clone()),
                )
                .await;
                self.enqueue(&id, &prompt).await?;
                Ok((Some(id), "created"))
            }
        }
    }

    /// Capture a screenshot and send it to a session as an image-annotated
    /// prompt (Codex-style visual input for a self-improvement loop). One-shot
    /// and synchronous: awaits the turn and returns its `stopReason`. Rejects
    /// if the session is already busy so it never races the dispatch loop or
    /// issues concurrent turns. Preserves the idle-holds-no-process invariant
    /// by releasing the client afterwards.
    pub async fn prompt_with_screenshot(
        &self,
        session_id: &str,
        text: &str,
        opts: crate::screenshot::ScreenshotOpts,
    ) -> Result<String, String> {
        // Enforce the budget cap here too: this command issues a full turn
        // outside the dispatch loop, so without this check a capped-out session
        // could still be driven via screenshot prompts.
        if let Some((spent, cap)) = self.budget_exceeded(session_id).await {
            self.emit(
                BUDGET_EVENT,
                BudgetExceeded {
                    session_id: session_id.to_string(),
                    spent,
                    cap,
                },
            );
            return Err(format!(
                "budget cap reached for {session_id}: spent {spent:.2} ≥ cap {cap:.2}"
            ));
        }
        // Reserve the session atomically (mirror the dispatch reservation). A
        // `BusyGuard` releases it on every exit path — including if this
        // command's future is dropped (cancelled) mid-turn.
        let busy = self
            .busy_flag(session_id)
            .await
            .ok_or_else(|| format!("no session: {session_id}"))?;
        if busy
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
        {
            return Err(format!("session busy: {session_id}"));
        }
        let _busy_guard = BusyGuard(busy);

        let outcome = async {
            // Capture off the async executor (spawns `screencapture`).
            let captured = tokio::task::spawn_blocking(move || crate::screenshot::capture(&opts))
                .await
                .map_err(|e| format!("capture task failed: {e}"))?
                .map_err(|e| e.to_string())?;

            let client = self.ensure_client(session_id).await?;
            self.mark_worker(session_id, "busy", true).await;
            self.log(&format!(
                "screenshot-prompt -> {session_id}: {text} ({} bytes)",
                captured.bytes
            ))
            .await;

            let images = [crate::acp::protocol::ImageAttachment {
                mime_type: captured.mime_type,
                data_base64: captured.data_base64,
            }];
            client
                .prompt_with_images(session_id, text, &images)
                .await
                .map_err(|e| e.to_string())
        }
        .await;

        // Release the process (frees the kiro lock); the next prompt lazily
        // reloads the session. `_busy_guard` clears the reservation on drop.
        self.mark_worker(session_id, "idle", false).await;
        self.release_client(session_id).await;
        // Checkpoint spend so this turn's credits survive an app restart.
        self.persist_spend();

        outcome
    }

    /// Reserve (mark busy) and pop the next task for a session if idle & queued.
    /// For `dry_run`, peeks without reserving/popping. Returns the task text.
    async fn reserve_and_pop(&self, session_id: &str, dry_run: bool) -> Option<String> {
        let home = state::orch_home();
        let (busy, name) = {
            let guard = self.inner.sessions.lock().await;
            let entry = guard.get(session_id)?;
            (entry.busy.clone(), entry.worker_name.clone())
        };
        if busy.load(Ordering::Acquire) {
            return None;
        }
        let queued = state::read_queue(&home, &name).unwrap_or_default();
        if queued.is_empty() {
            return None;
        }
        if dry_run {
            return Some(queued[0].clone());
        }
        // Atomically claim the reservation: if another dispatch/heartbeat pass
        // slipped in between the load above and here, back off.
        if busy
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
        {
            return None;
        }

        // Sessions guard is released first, then the queue lock — consistent
        // ordering with `enqueue` (which only takes the queue lock), so the two
        // paths can't deadlock.
        let popped = {
            let lock = self.queue_lock(&name).await;
            let _g = lock.lock().await;
            state::pop_queue(&home, &name).ok().flatten()
        };

        match popped {
            Some(task) => Some(task),
            None => {
                // Nothing actually popped; release the reservation.
                busy.store(false, Ordering::Release);
                None
            }
        }
    }

    /// If the session is at or over its effective credit cap, returns
    /// `(spent, cap)`. Uncapped sessions (or caps ≤ 0) never block.
    async fn budget_exceeded(&self, session_id: &str) -> Option<(f64, f64)> {
        let cfg = config::get_budget(&config::config_home()).ok()?;
        let repo = {
            let guard = self.inner.sessions.lock().await;
            guard.get(session_id).map(|e| {
                e.workspace
                    .as_ref()
                    .map(|w| w.repo_root.clone())
                    .unwrap_or_else(|| e.repo.clone())
            })
        };
        let cap = config::effective_cap(&cfg, repo.as_deref())?;
        if cap <= 0.0 {
            return None;
        }
        let spent = self
            .inner
            .spent
            .lock()
            .ok()
            .and_then(|m| m.get(session_id).copied())
            .unwrap_or(0.0);
        matches!(
            config::budget_status(spent, Some(cap)),
            config::BudgetLevel::Over
        )
        .then_some((spent, cap))
    }

    /// Dispatch the next queued task for a session (if idle). Ensures a live
    /// client (spawning + `session/load` if cold), runs the turn, drains any
    /// further queued work, then **releases the process** when idle — so an
    /// idle session holds no process or lock.
    async fn dispatch_one(&self, session_id: &str) -> Option<String> {
        // Enforce budget caps before reserving work: a capped-out session keeps
        // its queue intact and simply isn't dispatched (autonomous heartbeat and
        // manual enqueue both funnel through here).
        if let Some((spent, cap)) = self.budget_exceeded(session_id).await {
            self.emit(
                BUDGET_EVENT,
                BudgetExceeded {
                    session_id: session_id.to_string(),
                    spent,
                    cap,
                },
            );
            self.log(&format!(
                "budget: skipping dispatch for {session_id} (spent {spent:.2} ≥ cap {cap:.2})"
            ))
            .await;
            return None;
        }
        let task = self.reserve_and_pop(session_id, false).await?;

        // Signal activity while the (possibly cold) session spins up.
        self.emit(
            ACP_EVENT,
            AcpEvent::Status {
                session_id: Some(session_id.to_string()),
                status: crate::acp::SessionStatus::Working,
            },
        );

        let client = match self.ensure_client(session_id).await {
            Ok(c) => c,
            Err(e) => {
                self.clear_busy(session_id).await;
                self.emit(ACP_EVENT, AcpEvent::Error { message: e });
                return None;
            }
        };

        self.emit_queue(session_id).await;
        self.mark_worker(session_id, "busy", true).await;
        self.log(&format!("dispatch -> {session_id}: {task}")).await;

        let mgr = self.clone();
        let sid = session_id.to_string();
        let first = task.clone();
        let busy = self.busy_flag(session_id).await;
        tokio::spawn(async move {
            // Safety net: if this task panics mid-turn, the guard still clears
            // the reservation so the session doesn't wedge. The normal drain
            // path clears `busy` itself, making the drop a no-op.
            let _busy_guard = busy.map(BusyGuard);

            let sid_run = sid.clone();
            let client_run = client.clone();
            mgr.drain_session(&sid, first, move |text| {
                let c = client_run.clone();
                let s = sid_run.clone();
                async move { c.prompt(&s, &text).await }
            })
            .await;
            // Queue drained (or the client died) → release the process (frees
            // the kiro lock); the next prompt will lazily reload the session.
            drop(client);
            mgr.release_client(&sid).await;
        });
        Some(task)
    }

    /// Clear a session's in-memory `busy` reservation (no-op if it's gone).
    async fn clear_busy(&self, session_id: &str) {
        if let Some(e) = self.inner.sessions.lock().await.get(session_id) {
            e.busy.store(false, Ordering::Release);
        }
    }

    /// The `busy` flag handle for a session (for a [`BusyGuard`] safety net).
    async fn busy_flag(&self, session_id: &str) -> Option<Arc<AtomicBool>> {
        self.inner
            .sessions
            .lock()
            .await
            .get(session_id)
            .map(|e| e.busy.clone())
    }

    /// Drain a session's queue, running each task through `run_prompt`, until
    /// the queue is empty or a turn fails. Generic over the prompt runner so it
    /// is unit-testable without spawning a real `kiro-cli` process.
    ///
    /// On a failed turn the just-run task (`current`) has already been popped
    /// off the persisted queue, so it is **lost**: we surface it loudly (log +
    /// `Error` event) and **stop** rather than pop-and-fail the remaining queue
    /// against what is almost certainly a dead client — draining a whole queue
    /// against a corpse would silently consume every task (see the compounding
    /// transport-close bug). Breaking here lets the caller release the client so
    /// the next enqueue re-spawns a fresh process.
    async fn drain_session<F, Fut>(&self, session_id: &str, first: String, mut run_prompt: F)
    where
        F: FnMut(String) -> Fut,
        Fut: std::future::Future<Output = Result<String, AcpError>>,
    {
        let mut current = first;
        loop {
            let result = run_prompt(current.clone()).await;

            // Turn finished (success or failure) → release the reservation.
            self.clear_busy(session_id).await;
            self.mark_worker(session_id, "idle", false).await;
            // Checkpoint accumulated spend now that a turn has completed, so a
            // per-session cap survives an app restart mid-drain.
            self.persist_spend();

            if let Err(err) = result {
                // A stalled turn (inactivity timeout) is recoverable: the agent
                // went silent but the task is not its fault, so re-queue it at
                // the head for a fresh client to retry rather than dropping it.
                // The drain still stops so `dispatch_one` releases the (possibly
                // wedged) process; the next heartbeat re-dispatches. Retries are
                // throttled to heartbeat cadence, so this can't busy-loop.
                if matches!(err, AcpError::Timeout) {
                    self.requeue_front(session_id, &current).await;
                    self.emit_queue(session_id).await;
                    self.log(&format!(
                        "dispatch STALLED -> {session_id}: turn timed out, re-queued: {current}"
                    ))
                    .await;
                    self.emit(
                        ACP_EVENT,
                        AcpEvent::Error {
                            message: format!(
                                "Session {session_id}: turn stalled (no activity) and was re-queued for retry: {current}"
                            ),
                        },
                    );
                    break;
                }
                self.log(&format!(
                    "dispatch FAILED -> {session_id}: {current} ({err})"
                ))
                .await;
                self.emit(
                    ACP_EVENT,
                    AcpEvent::Error {
                        message: format!(
                            "Session {session_id}: task failed and was dropped ({err}): {current}"
                        ),
                    },
                );
                break;
            }

            // Re-check the budget cap before draining further queued work: the
            // turn just run may have pushed the session over its cap, and
            // draining the rest of the queue would blow past it. Stop with the
            // queue intact (mirrors the pre-dispatch check in `dispatch_one`).
            if let Some((spent, cap)) = self.budget_exceeded(session_id).await {
                self.emit(
                    BUDGET_EVENT,
                    BudgetExceeded {
                        session_id: session_id.to_string(),
                        spent,
                        cap,
                    },
                );
                self.log(&format!(
                    "budget: pausing drain for {session_id} (spent {spent:.2} ≥ cap {cap:.2})"
                ))
                .await;
                break;
            }

            match self.reserve_and_pop(session_id, false).await {
                Some(next) => {
                    self.emit_queue(session_id).await;
                    self.mark_worker(session_id, "busy", true).await;
                    self.log(&format!("dispatch -> {session_id}: {next}")).await;
                    current = next;
                }
                None => break,
            }
        }
    }

    /// One heartbeat pass: dispatch queued work to idle sessions (or, for a dry
    /// run, report what would be dispatched).
    pub async fn tick(&self, dry_run: bool) -> HeartbeatReport {
        let ids: Vec<String> = self.inner.sessions.lock().await.keys().cloned().collect();
        let mut dispatched = Vec::new();

        for id in &ids {
            if dry_run {
                if let Some(task) = self.reserve_and_pop(id, true).await {
                    dispatched.push(Dispatched {
                        session_id: id.clone(),
                        task,
                    });
                }
            } else if let Some(task) = self.dispatch_one(id).await {
                dispatched.push(Dispatched {
                    session_id: id.clone(),
                    task,
                });
            }
        }

        // Total still-queued across sessions.
        let home = state::orch_home();
        let mut queued_remaining = 0;
        {
            let guard = self.inner.sessions.lock().await;
            for entry in guard.values() {
                queued_remaining += state::read_queue(&home, &entry.worker_name)
                    .map(|q| q.len())
                    .unwrap_or(0);
            }
        }

        HeartbeatReport {
            ts: state::now_ts(),
            dry_run,
            dispatched,
            queued_remaining,
        }
    }

    /// Write/update the worker.json for a session and log to the decision log.
    async fn mark_worker(&self, session_id: &str, worker_state: &str, dispatched: bool) {
        let guard = self.inner.sessions.lock().await;
        let Some(entry) = guard.get(session_id) else {
            return;
        };
        let meta = WorkerMeta {
            name: entry.worker_name.clone(),
            repo: entry.repo.clone(),
            command: entry.command.clone(),
            created: entry.created.clone(),
            last_dispatch: if dispatched {
                Some(state::now_ts())
            } else {
                None
            },
            state: worker_state.to_string(),
        };
        let _ = state::write_worker(&state::orch_home(), &meta);
    }

    async fn log(&self, message: &str) {
        let _ = state::append_log(&state::orch_home(), message);
    }

    /// Register a newly-created session and mirror it to the state dir.
    // The parameters are a cohesive session descriptor (id + spawn args +
    // workspace + provenance); grouping them into a struct would only move the
    // same fields around without improving clarity.
    #[allow(clippy::too_many_arguments)]
    async fn insert(
        &self,
        session_id: String,
        client: Arc<AcpClient>,
        args: Vec<String>,
        workspace: Option<Workspace>,
        repo: String,
        command: String,
        automation_id: Option<String>,
    ) {
        // Key the worker (its durable queue file + queue lock) by the globally
        // unique session id, never the branch name — see `worker_key`.
        let worker_name = worker_key(&session_id);
        let created = state::now_ts();
        let meta = WorkerMeta {
            name: worker_name.clone(),
            repo: repo.clone(),
            command: command.clone(),
            created: created.clone(),
            last_dispatch: None,
            state: "idle".to_string(),
        };
        let _ = state::write_worker(&state::orch_home(), &meta);

        // Persist the descriptor so the session survives close / app restart.
        let persisted = config::PersistedSession {
            session_id: session_id.clone(),
            repo: repo.clone(),
            workspace: workspace
                .as_ref()
                .and_then(|w| serde_json::to_value(w).ok()),
            review: serde_json::to_value(workspace::ReviewRecord::default()).ok(),
            worker_name: worker_name.clone(),
            args: args.clone(),
            command: command.clone(),
            created: created.clone(),
            automation_id: automation_id.clone(),
        };
        let _ = config::save_session(&config::config_home(), &persisted);

        self.inner.sessions.lock().await.insert(
            session_id,
            SessionEntry {
                client: Some(client),
                args,
                workspace,
                review: workspace::ReviewRecord::default(),
                worker_name,
                repo,
                command,
                created,
                busy: Arc::new(AtomicBool::new(false)),
                automation_id,
            },
        );
    }

    /// Load persisted session descriptors as cold entries (no process) at
    /// startup, so the fleet survives close and app restarts.
    pub async fn hydrate(&self) {
        let sessions = config::list_sessions(&config::config_home()).unwrap_or_default();
        // Restore accumulated credit spend so per-session budget caps survive
        // an app restart (otherwise the tally resets to zero on every launch).
        if let Ok(mut spent) = self.inner.spent.lock() {
            *spent = config::get_spend(&config::config_home());
        }
        let mut guard = self.inner.sessions.lock().await;
        for s in sessions {
            if guard.contains_key(&s.session_id) {
                continue;
            }
            let workspace = s
                .workspace
                .and_then(|v| serde_json::from_value::<Workspace>(v).ok());
            let review = s
                .review
                .and_then(|value| serde_json::from_value(value).ok())
                .unwrap_or_default();
            guard.insert(
                s.session_id.clone(),
                SessionEntry {
                    client: None,
                    args: s.args,
                    workspace,
                    review,
                    // Re-derive the queue key from the session id rather than
                    // trusting the persisted `worker_name`, which may be an old
                    // branch-keyed value from before the collision fix.
                    worker_name: worker_key(&s.session_id),
                    repo: s.repo,
                    command: s.command,
                    created: s.created,
                    busy: Arc::new(AtomicBool::new(false)),
                    automation_id: s.automation_id,
                },
            );
        }
    }
}

/// A workspace bound to a freshly-created ACP session.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceSession {
    session_id: String,
    workspace: Workspace,
}

/// Summary of an active session for the fleet view.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionInfo {
    session_id: String,
    workspace: Option<Workspace>,
    review: Option<workspace::ReviewState>,
    /// Whether an ACP process is currently attached. Hydrated sessions are
    /// intentionally cold after restart and must not be presented as idle.
    connected: bool,
    /// The session's working directory (project path or worktree).
    repo: String,
    queued: usize,
}

/// The durable queue/worker key for a session.
///
/// Keyed by the globally-unique **session id** — deliberately *not* the branch
/// name. Branch names are only deduped within a single repo (`unique_branch`),
/// so two workspaces in different repos that pick the same branch (e.g. a "fix
/// tests" task in two projects) would otherwise collide on the same
/// `queue/<branch>.jsonl` file and queue lock — cross-contaminating queue
/// depths and dispatching one repo's queued prompt into the other's session.
fn worker_key(session_id: &str) -> String {
    session_id.to_string()
}

/// Map a per-automation [`config::TrustMode`] to `(trust_all, trust_tools)` for
/// [`build_args`]. `Ask` widens nothing (the default human-in-the-loop flow).
fn trust_args(trust: &config::TrustMode) -> (bool, Vec<String>) {
    match trust {
        config::TrustMode::Ask => (false, Vec::new()),
        config::TrustMode::TrustTools { tools } => (false, tools.clone()),
        // Legacy configs may still contain TrustAll. Downgrade them to the
        // approval-required default: destructive tools must never bypass the
        // owner decision surface.
        config::TrustMode::TrustAll => (false, Vec::new()),
    }
}

fn build_args(
    _trust_all: bool,
    trust_tools: Vec<String>,
    agent: Option<String>,
    model: Option<String>,
) -> Vec<String> {
    let mut args = vec!["acp".to_string()];
    if let Some(a) = agent.filter(|s| !s.trim().is_empty()) {
        args.push("--agent".to_string());
        args.push(a.trim().to_string());
    }
    if let Some(m) = model.filter(|s| !s.trim().is_empty()) {
        args.push("--model".to_string());
        args.push(m.trim().to_string());
    }
    let tools: Vec<String> = trust_tools
        .into_iter()
        .map(|t| t.trim().to_string())
        .filter(|t| {
            !t.is_empty()
                && !config::ALWAYS_ASK_TOOLS
                    .iter()
                    .any(|always_ask| t == always_ask)
        })
        .collect();
    if !tools.is_empty() {
        args.push("--trust-tools".to_string());
        args.push(tools.join(","));
    }
    args
}

async fn start_client(
    app: &AppHandle,
    cwd: &str,
    args: &[String],
    spent: Arc<std::sync::Mutex<HashMap<String, f64>>>,
) -> Result<(Arc<AcpClient>, String), String> {
    let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
    let sink = Arc::new(TauriEventSink {
        app: app.clone(),
        spent,
    });
    let client = AcpClient::spawn(crate::acp::resolve_kiro_cli(), &arg_refs, sink)
        .map_err(|e| e.to_string())?;
    client.initialize().await.map_err(|e| e.to_string())?;
    let id = client.new_session(cwd).await.map_err(|e| e.to_string())?;
    Ok((Arc::new(client), id))
}

/// Start a session rooted at `cwd` (defaults to the backend cwd), not bound to
/// a workspace. Returns the new session id.
#[tauri::command]
pub async fn acp_start_session(
    app: AppHandle,
    manager: State<'_, AcpManager>,
    cwd: Option<String>,
    trust_all: bool,
    trust_tools: Vec<String>,
    agent: Option<String>,
    model: Option<String>,
) -> Result<String, String> {
    let cwd = match cwd {
        Some(c) => c,
        None => std::env::current_dir()
            .map_err(|e| e.to_string())?
            .to_string_lossy()
            .into_owned(),
    };
    let args = build_args(trust_all, trust_tools, agent, model);
    let (client, id) = start_client(&app, &cwd, &args, manager.inner.spent.clone()).await?;
    manager
        .insert(
            id.clone(),
            client,
            args.clone(),
            None,
            cwd,
            format!("kiro-cli {}", args.join(" ")),
            None,
        )
        .await;
    Ok(id)
}

/// Arguments for [`workspace_create`], passed as one object from the frontend.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceCreateArgs {
    pub repo_root: String,
    pub base_branch: String,
    pub task: String,
    #[serde(default)]
    pub setup_script: Option<String>,
    #[serde(default)]
    pub trust_all: bool,
    #[serde(default)]
    pub trust_tools: Vec<String>,
    #[serde(default)]
    pub agent: Option<String>,
    #[serde(default)]
    pub model: Option<String>,
}

/// Create an isolated workspace (git worktree + branch off `base_branch`), run
/// an optional setup script in it, then start an ACP session bound to the
/// worktree. Returns the session id and workspace metadata.
#[tauri::command]
pub async fn workspace_create(
    app: AppHandle,
    manager: State<'_, AcpManager>,
    params: WorkspaceCreateArgs,
) -> Result<WorkspaceSession, String> {
    let WorkspaceCreateArgs {
        repo_root,
        base_branch,
        task,
        setup_script,
        trust_all,
        trust_tools,
        agent,
        model,
    } = params;

    let ws = tokio::task::spawn_blocking(move || -> Result<Workspace, String> {
        let repo = PathBuf::from(&repo_root);
        let wt_root = workspace::default_worktrees_root(&repo);
        let ws =
            workspace::create(&repo, &base_branch, &task, &wt_root).map_err(|e| e.to_string())?;
        if let Some(script) = setup_script {
            if let Err(error) =
                workspace::run_setup_script(PathBuf::from(&ws.worktree_path).as_path(), &script)
            {
                let cleanup = workspace::rollback_create(
                    PathBuf::from(&ws.repo_root).as_path(),
                    PathBuf::from(&ws.worktree_path).as_path(),
                    &ws.branch,
                );
                return Err(match cleanup {
                    Ok(()) => error.to_string(),
                    Err(cleanup_error) => {
                        format!("{error}; failed to roll back workspace: {cleanup_error}")
                    }
                });
            }
        }
        Ok(ws)
    })
    .await
    .map_err(|e| e.to_string())??;

    let args = build_args(trust_all, trust_tools, agent, model);
    let (client, id) =
        match start_client(&app, &ws.worktree_path, &args, manager.inner.spent.clone()).await {
            Ok(started) => started,
            Err(error) => {
                let failed_ws = ws.clone();
                let cleanup = match tokio::task::spawn_blocking(move || {
                    workspace::rollback_create(
                        PathBuf::from(&failed_ws.repo_root).as_path(),
                        PathBuf::from(&failed_ws.worktree_path).as_path(),
                        &failed_ws.branch,
                    )
                    .map_err(|cleanup_error| cleanup_error.to_string())
                })
                .await
                {
                    Ok(result) => result,
                    Err(join_error) => Err(format!("rollback task failed: {join_error}")),
                };
                return Err(match cleanup {
                    Ok(()) => error,
                    Err(cleanup_error) => {
                        format!("{error}; failed to roll back workspace: {cleanup_error}")
                    }
                });
            }
        };
    manager
        .insert(
            id.clone(),
            client,
            args.clone(),
            Some(ws.clone()),
            ws.repo_root.clone(),
            format!("kiro-cli {}", args.join(" ")),
            None,
        )
        .await;

    Ok(WorkspaceSession {
        session_id: id,
        workspace: ws,
    })
}

/// Enqueue a prompt for a session (dispatches immediately if idle, else queues).
#[tauri::command]
pub async fn orch_enqueue(
    manager: State<'_, AcpManager>,
    session_id: String,
    text: String,
) -> Result<(), String> {
    manager.enqueue(&session_id, &text).await
}

/// Read a session's durable queued prompts in dispatch order.
#[tauri::command]
pub async fn orch_queue(
    manager: State<'_, AcpManager>,
    session_id: String,
) -> Result<Vec<String>, String> {
    manager.queue_tasks(&session_id).await
}

/// Replace a session's durable queue with an explicitly ordered list.
#[tauri::command]
pub async fn orch_queue_replace(
    manager: State<'_, AcpManager>,
    session_id: String,
    tasks: Vec<String>,
) -> Result<(), String> {
    manager.replace_queue(&session_id, tasks).await
}

/// Dry-run: report what the next heartbeat pass would dispatch.
#[tauri::command]
pub async fn orch_preview(manager: State<'_, AcpManager>) -> Result<HeartbeatReport, String> {
    Ok(manager.tick(true).await)
}

/// The heartbeat interval in seconds (for the UI's next-tick timer).
#[tauri::command]
pub fn orch_heartbeat_secs() -> u64 {
    HEARTBEAT_SECS
}

/// Read the decision log (`<bugyo home>/log.md`), last 500 lines.
#[tauri::command]
pub fn orch_log() -> Result<Vec<String>, String> {
    state::read_log(&state::orch_home(), 500).map_err(|e| e.to_string())
}

/// List registered projects (repository paths).
#[tauri::command]
pub fn project_list() -> Result<Vec<config::Project>, String> {
    config::list_projects(&config::config_home()).map_err(|e| e.to_string())
}

/// Register a project by repository path (validates it's a git repo).
#[tauri::command]
pub fn project_add(path: String) -> Result<config::Project, String> {
    config::add_project(&config::config_home(), &path).map_err(|e| e.to_string())
}

/// Persist the workspace setup/check defaults for a registered project.
#[tauri::command]
pub fn project_update(
    path: String,
    base_branch: String,
    setup_script: String,
    check_script: String,
) -> Result<config::Project, String> {
    config::update_project(
        &config::config_home(),
        &path,
        &base_branch,
        &setup_script,
        &check_script,
    )
    .map_err(|e| e.to_string())
}

/// Remove a registered project by path.
#[tauri::command]
pub fn project_remove(path: String) -> Result<(), String> {
    config::remove_project(&config::config_home(), &path).map_err(|e| e.to_string())
}

/// Reconstruct a session's transcript from kiro's persisted store (for resume).
#[tauri::command]
pub fn session_transcript(session_id: String) -> Vec<config::TranscriptEntry> {
    config::read_transcript(&session_id)
}

/// List durable per-session UI metadata (pin / custom name / manual order).
#[tauri::command]
pub fn session_meta_list() -> Result<Vec<config::SessionMeta>, String> {
    config::list_session_meta(&config::config_home()).map_err(|e| e.to_string())
}

/// Upsert durable UI metadata for one session.
#[tauri::command]
pub fn session_meta_set(meta: config::SessionMeta) -> Result<(), String> {
    config::save_session_meta(&config::config_home(), &meta).map_err(|e| e.to_string())
}

/// Search every persisted session's transcript for `query` (case-insensitive).
/// Runs off the main thread (`spawn_blocking`): it reads and parses every
/// persisted session's transcript from disk, work that scales with fleet size
/// and would otherwise stall the UI thread on a synchronous command.
#[tauri::command]
pub async fn session_search(query: String) -> Result<Vec<config::SearchHit>, String> {
    tokio::task::spawn_blocking(move || config::session_search(&config::config_home(), &query))
        .await
        .map_err(|e| e.to_string())
}

/// Read the budget config (credit caps).
#[tauri::command]
pub fn budget_get() -> Result<config::BudgetConfig, String> {
    config::get_budget(&config::config_home()).map_err(|e| e.to_string())
}

/// Persist the budget config (credit caps).
#[tauri::command]
pub fn budget_set(config: config::BudgetConfig) -> Result<(), String> {
    config::save_budget(&config::config_home(), &config).map_err(|e| e.to_string())
}

/// Set the OS dock/taskbar attention badge to `count` (0 clears it). Driven by
/// the frontend when the number of sessions needing attention changes.
#[tauri::command]
pub fn set_attention_badge(app: AppHandle, count: u32) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("main") {
        window
            .set_badge_count(if count > 0 { Some(count as i64) } else { None })
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// List persisted trust profiles (approval-rule presets).
#[tauri::command]
pub fn trust_profile_list() -> Result<Vec<config::TrustProfile>, String> {
    config::list_trust_profiles(&config::config_home()).map_err(|e| e.to_string())
}

/// Upsert a trust profile.
#[tauri::command]
pub fn trust_profile_set(profile: config::TrustProfile) -> Result<(), String> {
    config::save_trust_profile(&config::config_home(), &profile).map_err(|e| e.to_string())
}

/// Remove a trust profile by id.
#[tauri::command]
pub fn trust_profile_remove(id: String) -> Result<(), String> {
    config::remove_trust_profile(&config::config_home(), &id).map_err(|e| e.to_string())
}

/// The tools a profile actually pre-trusts once destructive/always-ask tools
/// are stripped — what the UI passes as `--trust-tools` at session start.
/// Returns an empty list for an unknown id.
#[tauri::command]
pub fn trust_profile_effective_tools(id: String) -> Result<Vec<String>, String> {
    let profiles =
        config::list_trust_profiles(&config::config_home()).map_err(|e| e.to_string())?;
    Ok(profiles
        .iter()
        .find(|p| p.id == id)
        .map(config::effective_trust_tools)
        .unwrap_or_default())
}

/// List all persisted automations.
#[tauri::command]
pub fn automation_list() -> Result<Vec<config::Automation>, String> {
    config::list_automations(&config::config_home()).map_err(|e| e.to_string())
}

/// Create an automation. The backend assigns the id + created timestamp and
/// validates the schedule; `last_run` starts unset. Returns the stored record.
#[tauri::command]
pub fn automation_create(mut automation: config::Automation) -> Result<config::Automation, String> {
    crate::orchestrator::schedule::validate(&automation.schedule).map_err(|e| e.to_string())?;
    if automation.id.trim().is_empty() {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        automation.id = format!("auto-{nanos}");
    }
    if automation.created.trim().is_empty() {
        automation.created = state::now_ts();
    }
    automation.last_run = None;
    config::save_automation(&config::config_home(), &automation).map_err(|e| e.to_string())?;
    Ok(automation)
}

/// Update an existing automation (upsert by id). Validates the schedule.
#[tauri::command]
pub fn automation_update(automation: config::Automation) -> Result<config::Automation, String> {
    crate::orchestrator::schedule::validate(&automation.schedule).map_err(|e| e.to_string())?;
    config::save_automation(&config::config_home(), &automation).map_err(|e| e.to_string())?;
    Ok(automation)
}

/// Remove an automation by id.
#[tauri::command]
pub fn automation_remove(id: String) -> Result<(), String> {
    config::remove_automation(&config::config_home(), &id).map_err(|e| e.to_string())
}

/// Run an automation now (a manual "test" that does not advance its schedule).
#[tauri::command]
pub async fn automation_run_now(
    manager: State<'_, AcpManager>,
    id: String,
) -> Result<config::AutomationRun, String> {
    let automation = config::list_automations(&config::config_home())
        .map_err(|e| e.to_string())?
        .into_iter()
        .find(|a| a.id == id)
        .ok_or_else(|| format!("no automation: {id}"))?;
    Ok(manager.run_automation(&automation).await)
}

/// Request cancellation of `session_id`'s current turn.
#[tauri::command]
pub async fn acp_cancel(manager: State<'_, AcpManager>, session_id: String) -> Result<(), String> {
    let client = manager.client(&session_id).await?;
    client.cancel(&session_id).await.map_err(|e| e.to_string())
}

/// Capture a screenshot of the running app and send it to `session_id` as an
/// image-annotated prompt (Codex-style visual input for a self-improvement
/// loop). Returns the turn's stop reason.
///
/// Capture target precedence: `region` ("x,y,w,h") > `window_id` (CoreGraphics
/// window id) > `display` (1 = main). When none is given and `own_window` is
/// not `false`, defaults to **Bugyo's own window** (focused, cheaper, avoids
/// capturing unrelated on-screen content); if that can't be resolved it falls
/// back to the full main display. Requires the Screen Recording permission.
/// Screenshot capture parameters for [`acp_prompt_with_screenshot`].
///
/// Target precedence: `region` > `window_id` > `display`. When none is set and
/// `own_window` is not `false`, defaults to Bugyo's own window.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScreenshotArgs {
    /// Capture a specific display (1 = main).
    pub display: Option<u32>,
    /// Capture an explicit rectangle, `"x,y,w,h"`.
    pub region: Option<String>,
    /// Capture a specific window by CoreGraphics window id.
    pub window_id: Option<u32>,
    /// Capture Bugyo's own window (defaults to true); `false` = full screen.
    pub own_window: Option<bool>,
}

/// Capture a screenshot of the running app and send it to `session_id` as an
/// image-annotated prompt (Codex-style visual input for a self-improvement
/// loop). Returns the turn's stop reason.
///
/// Capture target precedence: `region` ("x,y,w,h") > `window_id` (CoreGraphics
/// window id) > `display` (1 = main). When none is given and `own_window` is
/// not `false`, defaults to **Bugyo's own window** (focused, cheaper, avoids
/// capturing unrelated on-screen content); if that can't be resolved it falls
/// back to the full main display. Requires the Screen Recording permission.
#[tauri::command]
pub async fn acp_prompt_with_screenshot(
    app: AppHandle,
    manager: State<'_, AcpManager>,
    session_id: String,
    text: String,
    args: ScreenshotArgs,
) -> Result<String, String> {
    let region = match args.region {
        Some(s) => Some(crate::screenshot::Region::parse(&s).map_err(|e| e.to_string())?),
        None => None,
    };
    let mut opts = crate::screenshot::ScreenshotOpts {
        display: args.display,
        region,
        window_id: args.window_id,
    };
    // Default to Bugyo's own window unless an explicit target was given or the
    // caller opted out. Unresolved id → full screen (opts left untouched).
    if args.own_window.unwrap_or(true)
        && opts.region.is_none()
        && opts.window_id.is_none()
        && opts.display.is_none()
    {
        opts.window_id = resolve_own_window_id(&app);
    }
    manager
        .prompt_with_screenshot(&session_id, &text, opts)
        .await
}

/// Resolve Bugyo's own main window as a CoreGraphics window id for
/// window-scoped capture. `None` if the window or its native handle can't be
/// obtained (caller then falls back to full-screen capture).
#[cfg(target_os = "macos")]
fn resolve_own_window_id(app: &AppHandle) -> Option<u32> {
    let win = app.get_webview_window("main")?;
    let ns_window = win.ns_window().ok()?;
    crate::screenshot::ns_window_number(ns_window)
}

#[cfg(not(target_os = "macos"))]
fn resolve_own_window_id(_app: &AppHandle) -> Option<u32> {
    None
}

/// Resolve a held permission request for `session_id`.
#[tauri::command]
pub async fn acp_respond_permission(
    manager: State<'_, AcpManager>,
    session_id: String,
    request_id: String,
    option_id: String,
) -> Result<(), String> {
    let client = manager.client(&session_id).await?;
    client
        .respond_permission(&request_id, &option_id)
        .await
        .map_err(|e| e.to_string())?;
    manager
        .log(&format!(
            "approval -> {session_id}: request {request_id}, decision {option_id}"
        ))
        .await;
    Ok(())
}

/// List active sessions (id + optional workspace + queue depth).
#[tauri::command]
pub async fn acp_list_sessions(manager: State<'_, AcpManager>) -> Result<Vec<SessionInfo>, String> {
    let home = state::orch_home();
    let entries = {
        let guard = manager.inner.sessions.lock().await;
        guard
            .iter()
            .map(|(id, entry)| {
                (
                    id.clone(),
                    entry.workspace.clone(),
                    entry.review.clone(),
                    entry.repo.clone(),
                    entry.worker_name.clone(),
                    entry.client.is_some(),
                )
            })
            .collect::<Vec<_>>()
    };
    let mut sessions = Vec::with_capacity(entries.len());
    for (session_id, workspace, review_record, repo, worker_name, connected) in entries {
        let review = if let Some(ws) = workspace.clone() {
            tokio::task::spawn_blocking(move || workspace::review_state(&ws, &review_record))
                .await
                .ok()
                .and_then(Result::ok)
        } else {
            None
        };
        sessions.push(SessionInfo {
            session_id,
            workspace,
            review,
            connected,
            repo,
            queued: state::read_queue(&home, &worker_name)
                .map(|queue| queue.len())
                .unwrap_or(0),
        });
    }
    Ok(sessions)
}

/// Close a session: release its `kiro-cli acp` process but **keep** the session
/// (persisted + cold). It stays in the fleet and can be resumed by prompting.
#[tauri::command]
pub async fn acp_close_session(
    manager: State<'_, AcpManager>,
    session_id: String,
) -> Result<(), String> {
    manager.release_client(&session_id).await;
    Ok(())
}

/// Delete a session entirely: drop it and remove its persisted descriptor.
/// (kiro's transcript on disk is left intact.)
#[tauri::command]
pub async fn acp_delete_session(
    manager: State<'_, AcpManager>,
    session_id: String,
) -> Result<(), String> {
    manager.inner.sessions.lock().await.remove(&session_id);
    let _ = config::remove_session(&config::config_home(), &session_id);
    let _ = config::remove_session_meta(&config::config_home(), &session_id);
    manager.forget_spend(&session_id);
    manager
        .log(&format!("delete -> {session_id}: session removed"))
        .await;
    Ok(())
}

/// Archive the workspace bound to `session_id` and drop the session.
#[tauri::command]
pub async fn workspace_archive(
    manager: State<'_, AcpManager>,
    session_id: String,
    force: bool,
) -> Result<(), String> {
    let workspace = manager.workspace_of(&session_id).await?;
    tokio::task::spawn_blocking(move || -> Result<(), String> {
        workspace::archive(
            PathBuf::from(&workspace.repo_root).as_path(),
            PathBuf::from(&workspace.worktree_path).as_path(),
            &workspace.branch,
            force,
        )
        .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())??;

    manager.inner.sessions.lock().await.remove(&session_id);
    let _ = config::remove_session(&config::config_home(), &session_id);
    let _ = config::remove_session_meta(&config::config_home(), &session_id);
    manager.forget_spend(&session_id);
    manager
        .log(&format!("archive -> {session_id}: workspace retired"))
        .await;
    Ok(())
}

/// The full patch of a workspace's changes vs its base branch (for review).
#[tauri::command]
pub async fn workspace_diff(
    manager: State<'_, AcpManager>,
    session_id: String,
) -> Result<String, String> {
    let ws = manager.workspace_of(&session_id).await?;
    tokio::task::spawn_blocking(move || {
        workspace::diff(
            PathBuf::from(&ws.worktree_path).as_path(),
            &ws.base_branch,
            &ws.branch,
        )
        .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Backend-derived, durable review/check/landing state for a workspace.
#[tauri::command]
pub async fn workspace_review_state(
    manager: State<'_, AcpManager>,
    session_id: String,
) -> Result<workspace::ReviewState, String> {
    let ws = manager.workspace_of(&session_id).await?;
    let record = manager.review_record_of(&session_id).await?;
    tokio::task::spawn_blocking(move || workspace::review_state(&ws, &record))
        .await
        .map_err(|error| error.to_string())?
        .map_err(|error| error.to_string())
}

/// Run a check/run script in the workspace's worktree; returns pass/fail+output.
#[tauri::command]
pub async fn workspace_check(
    manager: State<'_, AcpManager>,
    session_id: String,
    script: String,
) -> Result<workspace::CheckResult, String> {
    let ws = manager.workspace_of(&session_id).await?;
    let check_ws = ws.clone();
    let check_script = script.clone();
    let result = tokio::task::spawn_blocking(move || {
        workspace::run_check(
            PathBuf::from(&check_ws.worktree_path).as_path(),
            &check_script,
        )
        .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())??;
    let mut record = manager.review_record_of(&session_id).await?;
    workspace::record_check(&ws, &mut record, script, &result, state::now_ts())
        .map_err(|error| error.to_string())?;
    manager.save_review_record(&session_id, record).await?;
    manager
        .log(&format!(
            "check -> {session_id}: {} (exit {})",
            if result.success { "passed" } else { "failed" },
            result.exit_code
        ))
        .await;
    Ok(result)
}

/// Commit every reviewed workspace change using the human task as the message.
#[tauri::command]
pub async fn workspace_commit(
    manager: State<'_, AcpManager>,
    session_id: String,
    message: String,
) -> Result<(), String> {
    let ws = manager.workspace_of(&session_id).await?;
    let path = PathBuf::from(&ws.worktree_path);
    tokio::task::spawn_blocking(move || {
        workspace::commit_all(path.as_path(), &message).map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| error.to_string())??;
    manager
        .log(&format!(
            "commit -> {session_id}: reviewed workspace changes"
        ))
        .await;
    Ok(())
}

/// Merge the workspace's branch into the base repo's current branch (--no-ff).
#[tauri::command]
pub async fn workspace_merge(
    manager: State<'_, AcpManager>,
    session_id: String,
) -> Result<(), String> {
    let ws = manager.workspace_of(&session_id).await?;
    let review_record = manager.review_record_of(&session_id).await?;
    let branch = ws.branch.clone();
    let msg = format!("merge {branch}");
    tokio::task::spawn_blocking(move || {
        let review_state =
            workspace::review_state(&ws, &review_record).map_err(|error| error.to_string())?;
        if review_state.stage != workspace::ReviewStage::ReadyToLand {
            return Err(
                "workspace is not ready to land; run checks against the current changes first"
                    .to_string(),
            );
        }
        if workspace::is_dirty(PathBuf::from(&ws.worktree_path).as_path())
            .map_err(|e| e.to_string())?
        {
            return Err(
                "workspace has uncommitted changes; commit them before merging".to_string(),
            );
        }
        workspace::merge(
            PathBuf::from(&ws.repo_root).as_path(),
            &ws.base_branch,
            &ws.branch,
        )
        .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())??;
    let mut review = manager.review_record_of(&session_id).await?;
    review.landing = Some(workspace::LandingState::Merged);
    manager.save_review_record(&session_id, review).await?;
    let _ = state::append_log(&state::orch_home(), &msg);
    Ok(())
}

/// Non-mutating pre-merge check: would merging this workspace's branch into its
/// base be clean, and which files would conflict? (Uses `git merge-tree`.)
#[tauri::command]
pub async fn workspace_merge_preview(
    manager: State<'_, AcpManager>,
    session_id: String,
) -> Result<workspace::MergePreview, String> {
    let ws = manager.workspace_of(&session_id).await?;
    tokio::task::spawn_blocking(move || {
        workspace::merge_preview(
            PathBuf::from(&ws.repo_root).as_path(),
            &ws.base_branch,
            &ws.branch,
        )
        .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Push the workspace branch and open a PR/MR via `gh`/`glab`. Returns the URL.
#[tauri::command]
pub async fn workspace_open_pr(
    manager: State<'_, AcpManager>,
    session_id: String,
    title: Option<String>,
) -> Result<String, String> {
    let ws = manager.workspace_of(&session_id).await?;
    let review_record = manager.review_record_of(&session_id).await?;
    let url = tokio::task::spawn_blocking(move || {
        let review_state =
            workspace::review_state(&ws, &review_record).map_err(|error| error.to_string())?;
        if review_state.stage != workspace::ReviewStage::ReadyToLand {
            return Err(
                "workspace is not ready to land; run checks against the current changes first"
                    .to_string(),
            );
        }
        if workspace::is_dirty(PathBuf::from(&ws.worktree_path).as_path())
            .map_err(|e| e.to_string())?
        {
            return Err(
                "workspace has uncommitted changes; commit them before opening a pull request"
                    .to_string(),
            );
        }
        workspace::open_pr(
            PathBuf::from(&ws.repo_root).as_path(),
            &ws.branch,
            title.as_deref(),
        )
        .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())??;
    let mut review = manager.review_record_of(&session_id).await?;
    review.landing = Some(workspace::LandingState::PullRequest { url: url.clone() });
    manager.save_review_record(&session_id, review).await?;
    manager
        .log(&format!("pull request -> {session_id}: {url}"))
        .await;
    Ok(url)
}

/// Spawn the in-app heartbeat: a periodic pass that drains queued work to idle
/// sessions and emits a report each tick.
pub fn spawn_heartbeat(manager: AcpManager) {
    // Use Tauri's managed runtime: `setup` runs outside a Tokio reactor context,
    // so `tokio::spawn` there would panic ("no reactor running").
    tauri::async_runtime::spawn(async move {
        let interval = Duration::from_secs(HEARTBEAT_SECS);
        loop {
            tokio::time::sleep(interval).await;
            let report = manager.tick(false).await;
            manager.emit(HEARTBEAT_EVENT, report);
        }
    });
}

/// Spawn the automation scheduler: a periodic pass that fires every enabled
/// automation whose schedule is due (see [`AcpManager::automation_tick`]).
/// Each run emits an [`AUTOMATION_EVENT`]; `last_run` is persisted per pass.
pub fn spawn_automation_scheduler(manager: AcpManager) {
    tauri::async_runtime::spawn(async move {
        let interval = Duration::from_secs(AUTOMATION_SECS);
        loop {
            tokio::time::sleep(interval).await;
            let _ = manager.automation_tick().await;
        }
    });
}

#[cfg(test)]
impl AcpManager {
    /// Append to a worker's queue under the per-worker lock (test harness for
    /// the concurrency guarantee).
    async fn locked_append_for_test(&self, worker: &str, task: &str) {
        let lock = self.queue_lock(worker).await;
        let _g = lock.lock().await;
        let _ = state::append_queue(&state::orch_home(), worker, task);
    }

    /// Pop a worker's queue under the per-worker lock (test harness).
    async fn locked_pop_for_test(&self, worker: &str) -> Option<String> {
        let lock = self.queue_lock(worker).await;
        let _g = lock.lock().await;
        state::pop_queue(&state::orch_home(), worker).ok().flatten()
    }

    /// Insert a cold (no process) session that is already **busy**, so a
    /// subsequent `enqueue` appends to the queue without popping/dispatching —
    /// letting a test deterministically assert the durable prompt was queued.
    async fn insert_cold_busy_for_test(&self, session_id: &str, worker_name: &str) {
        self.inner.sessions.lock().await.insert(
            session_id.to_string(),
            SessionEntry {
                client: None,
                args: vec!["acp".to_string()],
                workspace: None,
                review: workspace::ReviewRecord::default(),
                worker_name: worker_name.to_string(),
                repo: "/tmp/repo".to_string(),
                command: "kiro-cli acp".to_string(),
                created: state::now_ts(),
                busy: Arc::new(AtomicBool::new(true)),
                automation_id: None,
            },
        );
    }

    /// Like [`insert_cold_busy_for_test`] but tagged with an automation id, so
    /// reuse-by-automation can be asserted without spawning a real client.
    async fn insert_cold_busy_with_automation_for_test(
        &self,
        session_id: &str,
        worker_name: &str,
        automation_id: &str,
    ) {
        self.inner.sessions.lock().await.insert(
            session_id.to_string(),
            SessionEntry {
                client: None,
                args: vec!["acp".to_string()],
                workspace: None,
                review: workspace::ReviewRecord::default(),
                worker_name: worker_name.to_string(),
                repo: "/tmp/repo".to_string(),
                command: "kiro-cli acp".to_string(),
                created: state::now_ts(),
                busy: Arc::new(AtomicBool::new(true)),
                automation_id: Some(automation_id.to_string()),
            },
        );
    }

    /// Insert a cold, already-busy **workspaced** session, deriving its queue
    /// key exactly as [`AcpManager::insert`] does (`worker_key(session_id)`), so
    /// a test can assert two sessions sharing a branch across different repos do
    /// not collide on the same queue.
    async fn insert_cold_busy_workspaced_for_test(
        &self,
        session_id: &str,
        branch: &str,
        repo_root: &str,
    ) {
        let workspace = Workspace {
            task: branch.to_string(),
            repo_root: repo_root.to_string(),
            base_branch: "main".to_string(),
            branch: branch.to_string(),
            worktree_path: format!("{repo_root}/wt"),
        };
        self.inner.sessions.lock().await.insert(
            session_id.to_string(),
            SessionEntry {
                client: None,
                args: vec!["acp".to_string()],
                workspace: Some(workspace),
                review: workspace::ReviewRecord::default(),
                worker_name: worker_key(session_id),
                repo: repo_root.to_string(),
                command: "kiro-cli acp".to_string(),
                created: state::now_ts(),
                busy: Arc::new(AtomicBool::new(true)),
                automation_id: None,
            },
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{Automation, AutomationTarget, Schedule, TrustMode};

    #[derive(Default)]
    struct CaptureSink(std::sync::Mutex<Vec<AcpEvent>>);

    impl EventSink for CaptureSink {
        fn emit(&self, event: AcpEvent) {
            self.0.lock().unwrap().push(event);
        }
    }

    struct Tmp(PathBuf);
    impl Tmp {
        fn new() -> Self {
            use std::sync::atomic::{AtomicU64, Ordering};
            static COUNTER: AtomicU64 = AtomicU64::new(0);
            let n = COUNTER.fetch_add(1, Ordering::Relaxed);
            let p = std::env::temp_dir().join(format!(
                "bugyo-svc-{}-{}-{}",
                std::process::id(),
                n,
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
            std::fs::create_dir_all(&p).unwrap();
            Tmp(p)
        }
    }
    impl Drop for Tmp {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn trust_args_maps_modes() {
        assert_eq!(trust_args(&TrustMode::Ask), (false, Vec::<String>::new()));
        assert_eq!(
            trust_args(&TrustMode::TrustTools {
                tools: vec!["fs_read".into(), "fs_write".into()]
            }),
            (false, vec!["fs_read".to_string(), "fs_write".to_string()])
        );
        assert_eq!(
            trust_args(&TrustMode::TrustAll),
            (false, Vec::<String>::new())
        );
        assert_eq!(
            build_args(
                true,
                vec!["fs_read".into(), "fs_write".into(), "execute_bash".into()],
                None,
                None,
            ),
            vec!["acp", "--trust-tools", "fs_read"]
        );
    }

    #[test]
    fn resume_sink_suppresses_replayed_history_and_metrics_only_until_loaded() {
        let captured = Arc::new(CaptureSink::default());
        let inner: Arc<dyn EventSink> = captured.clone();
        let sink = ResumeEventSink::new(inner);

        sink.emit(AcpEvent::AgentMessage {
            session_id: "s1".into(),
            text: "old answer".into(),
        });
        sink.emit(AcpEvent::AgentThought {
            session_id: "s1".into(),
            text: "old reasoning".into(),
        });
        sink.emit(AcpEvent::ToolCall {
            session_id: "s1".into(),
            tool_call_id: "t1".into(),
            title: "old tool".into(),
            status: Some("completed".into()),
            diff: None,
            output: None,
        });
        sink.emit(AcpEvent::Metrics {
            session_id: "s1".into(),
            context_percent: Some(42.0),
            credits: Some(3.0),
            turn_duration_ms: Some(100),
        });
        sink.emit(AcpEvent::Error {
            message: "load warning".into(),
        });

        let during = captured.0.lock().unwrap().clone();
        assert_eq!(during.len(), 1);
        assert!(matches!(&during[0], AcpEvent::Error { .. }));

        sink.finish_replay();
        sink.emit(AcpEvent::AgentMessage {
            session_id: "s1".into(),
            text: "fresh answer".into(),
        });
        sink.emit(AcpEvent::Metrics {
            session_id: "s1".into(),
            context_percent: Some(43.0),
            credits: Some(0.5),
            turn_duration_ms: Some(50),
        });

        let after = captured.0.lock().unwrap();
        assert_eq!(after.len(), 3);
        assert!(matches!(&after[1], AcpEvent::AgentMessage { .. }));
        assert!(matches!(&after[2], AcpEvent::Metrics { .. }));
    }

    // Fix #1: two sessions sharing a branch name across different repos must
    // keep independent queues — the durable queue file is keyed by the unique
    // session id, not the branch. Before the fix both mapped to
    // `queue/<branch>.jsonl`, cross-contaminating depths and dispatching one
    // repo's queued prompt into the other's session.
    #[allow(clippy::await_holding_lock)]
    #[tokio::test]
    async fn same_branch_across_repos_do_not_share_a_queue() {
        let _guard = state::env_lock();
        let tmp = Tmp::new();
        std::env::set_var("BUGYO_CONFIG_HOME", &tmp.0);

        let mgr = AcpManager::default();
        mgr.insert_cold_busy_workspaced_for_test("sess-A", "fix-tests", "/repo/a")
            .await;
        mgr.insert_cold_busy_workspaced_for_test("sess-B", "fix-tests", "/repo/b")
            .await;

        // Both sessions are busy, so enqueue only appends (no dispatch/spawn).
        mgr.enqueue("sess-A", "task-for-A").await.unwrap();
        mgr.enqueue("sess-B", "task-for-B").await.unwrap();

        let key_a = mgr.worker_name("sess-A").await.unwrap();
        let key_b = mgr.worker_name("sess-B").await.unwrap();
        assert_ne!(
            key_a, key_b,
            "queue keys must be per-session, not per-branch"
        );
        assert_eq!(
            state::read_queue(&tmp.0, &key_a).unwrap(),
            vec!["task-for-A"]
        );
        assert_eq!(
            state::read_queue(&tmp.0, &key_b).unwrap(),
            vec!["task-for-B"]
        );

        std::env::remove_var("BUGYO_CONFIG_HOME");
    }

    // Fix #2: a stalled turn (inactivity timeout) must re-queue its in-flight
    // task at the head for retry, not silently drop it like a hard failure.
    #[allow(clippy::await_holding_lock)]
    #[tokio::test]
    async fn drain_requeues_task_on_timeout_instead_of_dropping() {
        let _guard = state::env_lock();
        let tmp = Tmp::new();
        std::env::set_var("BUGYO_CONFIG_HOME", &tmp.0);

        let mgr = AcpManager::default();
        mgr.insert_cold_busy_for_test("sess-1", "sess-1").await;
        state::append_queue(&tmp.0, "sess-1", "task-2").unwrap();

        // A runner that times out models an agent that stalled mid-turn.
        mgr.drain_session("sess-1", "task-1".to_string(), |_text| async {
            Err::<String, _>(AcpError::Timeout)
        })
        .await;

        // task-1 is re-queued at the head (retried first); task-2 preserved.
        assert_eq!(
            state::read_queue(&tmp.0, "sess-1").unwrap(),
            vec!["task-1", "task-2"],
            "a stalled turn must re-queue its task at the head, not drop it"
        );
        // busy was cleared so the next dispatch can retry the re-queued task.
        assert_eq!(
            mgr.reserve_and_pop("sess-1", true).await,
            Some("task-1".to_string())
        );

        std::env::remove_var("BUGYO_CONFIG_HOME");
    }

    // The env lock is held across awaits to keep KIRO_ORCH_HOME stable; see the
    // note on the automation tests below.
    #[allow(clippy::await_holding_lock)]
    #[tokio::test]
    async fn drain_stops_and_preserves_queue_when_prompt_fails() {
        let _guard = state::env_lock();
        let tmp = Tmp::new();
        std::env::set_var("BUGYO_CONFIG_HOME", &tmp.0);

        let mgr = AcpManager::default();
        // Session reserved busy, exactly as `dispatch_one` leaves it before
        // spawning the drain task; `first` ("task-1") is already popped.
        mgr.insert_cold_busy_for_test("sess-1", "sess-1").await;
        state::append_queue(&tmp.0, "sess-1", "task-2").unwrap();
        state::append_queue(&tmp.0, "sess-1", "task-3").unwrap();

        // A runner that fails immediately models a dead/exited client.
        mgr.drain_session("sess-1", "task-1".to_string(), |_text| async {
            Err::<String, _>(AcpError::TransportClosed)
        })
        .await;

        // The remaining tasks must NOT be drained against the dead client.
        assert_eq!(
            state::read_queue(&tmp.0, "sess-1").unwrap(),
            vec!["task-2", "task-3"]
        );
        // busy was cleared: a dry-run reservation now peeks the next task
        // (returns None if the session were still marked busy).
        assert_eq!(
            mgr.reserve_and_pop("sess-1", true).await,
            Some("task-2".to_string())
        );

        std::env::remove_var("BUGYO_CONFIG_HOME");
    }

    #[allow(clippy::await_holding_lock)]
    #[tokio::test]
    async fn drain_runs_all_queued_tasks_on_success() {
        let _guard = state::env_lock();
        let tmp = Tmp::new();
        std::env::set_var("BUGYO_CONFIG_HOME", &tmp.0);

        let mgr = AcpManager::default();
        mgr.insert_cold_busy_for_test("sess-1", "sess-1").await;
        state::append_queue(&tmp.0, "sess-1", "task-2").unwrap();
        state::append_queue(&tmp.0, "sess-1", "task-3").unwrap();

        let seen = std::sync::Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
        let seen2 = seen.clone();
        mgr.drain_session("sess-1", "task-1".to_string(), move |text| {
            let seen = seen2.clone();
            async move {
                seen.lock().unwrap().push(text);
                Ok("end_turn".to_string())
            }
        })
        .await;

        assert_eq!(
            *seen.lock().unwrap(),
            vec!["task-1", "task-2", "task-3"],
            "every queued task should run in order on success"
        );
        assert!(state::read_queue(&tmp.0, "sess-1").unwrap().is_empty());

        std::env::remove_var("BUGYO_CONFIG_HOME");
    }

    #[allow(clippy::await_holding_lock)]
    #[tokio::test]
    async fn drain_stops_when_budget_exceeded_and_keeps_queue() {
        let _guard = state::env_lock();
        let tmp = Tmp::new();
        std::env::set_var("BUGYO_CONFIG_HOME", &tmp.0);

        // A low per-session cap; the session's spend is already over it.
        config::save_budget(
            &tmp.0,
            &config::BudgetConfig {
                session_cap: Some(1.0),
                project_caps: vec![],
            },
        )
        .unwrap();

        let mgr = AcpManager::default();
        mgr.insert_cold_busy_for_test("sess-1", "sess-1").await;
        mgr.inner
            .spent
            .lock()
            .unwrap()
            .insert("sess-1".to_string(), 5.0);
        state::append_queue(&tmp.0, "sess-1", "task-2").unwrap();
        state::append_queue(&tmp.0, "sess-1", "task-3").unwrap();

        let seen = std::sync::Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
        let seen2 = seen.clone();
        mgr.drain_session("sess-1", "task-1".to_string(), move |text| {
            let seen = seen2.clone();
            async move {
                seen.lock().unwrap().push(text);
                Ok("end_turn".to_string())
            }
        })
        .await;

        // The already-dispatched first task ran; the cap stopped further drain.
        assert_eq!(*seen.lock().unwrap(), vec!["task-1"]);
        // The queue is preserved for when the cap is raised.
        assert_eq!(
            state::read_queue(&tmp.0, "sess-1").unwrap(),
            vec!["task-2", "task-3"]
        );

        std::env::remove_var("BUGYO_CONFIG_HOME");
    }

    #[allow(clippy::await_holding_lock)]
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn concurrent_queue_mutations_lose_no_tasks() {
        let _guard = state::env_lock();
        let tmp = Tmp::new();
        std::env::set_var("BUGYO_CONFIG_HOME", &tmp.0);

        let mgr = AcpManager::default();
        const N: usize = 100;

        // Phase 1: N concurrent appends of unique tasks.
        let mut appends = Vec::new();
        for i in 0..N {
            let m = mgr.clone();
            appends.push(tokio::spawn(async move {
                m.locked_append_for_test("w", &format!("task-{i}")).await;
            }));
        }
        for h in appends {
            h.await.unwrap();
        }
        let queued = state::read_queue(&tmp.0, "w").unwrap();
        assert_eq!(queued.len(), N, "every append must survive");
        let unique: std::collections::HashSet<_> = queued.iter().cloned().collect();
        assert_eq!(unique.len(), N, "no duplicates or clobbered writes");

        // Phase 2: N concurrent pops. Each read-modify-write is serialized, so
        // every task is popped exactly once (no loss, no double-pop).
        let mut pops = Vec::new();
        for _ in 0..N {
            let m = mgr.clone();
            pops.push(tokio::spawn(
                async move { m.locked_pop_for_test("w").await },
            ));
        }
        let mut popped = Vec::new();
        for h in pops {
            if let Some(t) = h.await.unwrap() {
                popped.push(t);
            }
        }
        assert_eq!(popped.len(), N, "every task popped exactly once");
        let popped_unique: std::collections::HashSet<_> = popped.into_iter().collect();
        assert_eq!(popped_unique.len(), N, "no task popped twice");
        assert!(state::read_queue(&tmp.0, "w").unwrap().is_empty());

        std::env::remove_var("BUGYO_CONFIG_HOME");
    }

    #[test]
    fn busy_guard_resets_flag_on_drop() {
        let flag = Arc::new(AtomicBool::new(true));
        {
            let _g = BusyGuard(flag.clone());
            assert!(flag.load(Ordering::Acquire));
        }
        assert!(
            !flag.load(Ordering::Acquire),
            "dropping the guard must clear the busy flag"
        );
    }

    #[allow(clippy::await_holding_lock)]
    #[tokio::test]
    async fn dropped_busy_guard_makes_session_dispatchable_again() {
        let _guard = state::env_lock();
        let tmp = Tmp::new();
        std::env::set_var("BUGYO_CONFIG_HOME", &tmp.0);

        let mgr = AcpManager::default();
        mgr.insert_cold_busy_for_test("sess-1", "sess-1").await;
        state::append_queue(&tmp.0, "sess-1", "task-1").unwrap();

        // While a guard holds the reservation, the session is not dispatchable.
        let flag = mgr.busy_flag("sess-1").await.unwrap();
        {
            let _g = BusyGuard(flag);
            assert_eq!(mgr.reserve_and_pop("sess-1", true).await, None);
        }
        // After the guard drops (mirrors an aborted/panicked turn), the
        // reservation is released and the queued task is dispatchable again.
        assert_eq!(
            mgr.reserve_and_pop("sess-1", true).await,
            Some("task-1".to_string())
        );

        std::env::remove_var("BUGYO_CONFIG_HOME");
    }

    #[allow(clippy::await_holding_lock)]
    #[tokio::test]
    async fn recurring_new_session_automation_reuses_existing_session() {
        let _guard = state::env_lock();
        let tmp = Tmp::new();
        std::env::set_var("BUGYO_CONFIG_HOME", &tmp.0);

        let mgr = AcpManager::default();
        // A session already created by a prior fire of automation "auto-1".
        mgr.insert_cold_busy_with_automation_for_test("auto-sess", "auto-sess", "auto-1")
            .await;

        // A recurring NewSession automation: the second (and later) fires must
        // reuse the existing session rather than spawn a new process.
        let automation = Automation {
            id: "auto-1".into(),
            name: "hourly triage".into(),
            enabled: true,
            prompt: "triage the queue".into(),
            schedule: Schedule::IntervalSecs { secs: 3600 },
            target: AutomationTarget::NewSession {
                cwd: Some("/tmp".into()),
                agent: None,
                model: None,
            },
            trust: TrustMode::Ask,
            last_run: None,
            created: state::now_ts(),
        };

        let run = mgr.run_automation(&automation).await;
        assert_eq!(run.status, "dispatched", "should reuse, not create");
        assert_eq!(run.session_id.as_deref(), Some("auto-sess"));

        // Exactly one session exists, and the prompt was queued to it.
        assert_eq!(mgr.inner.sessions.lock().await.len(), 1);
        assert_eq!(
            state::read_queue(&tmp.0, "auto-sess").unwrap(),
            vec!["triage the queue"]
        );

        std::env::remove_var("BUGYO_CONFIG_HOME");
    }

    // The env lock is a std Mutex intentionally held across awaits to keep
    // KIRO_ORCH_HOME stable for this test's duration; other env-touching tests
    // simply block until we finish. Holding it across `.await` is desired here.
    #[allow(clippy::await_holding_lock)]
    #[tokio::test]
    async fn existing_session_automation_enqueues_durable_prompt() {
        let _guard = state::env_lock();
        let tmp = Tmp::new();
        std::env::set_var("BUGYO_CONFIG_HOME", &tmp.0);

        let mgr = AcpManager::default();
        mgr.insert_cold_busy_for_test("sess-1", "sess-1").await;

        let automation = Automation {
            id: "a1".into(),
            name: "review loop".into(),
            enabled: true,
            prompt: "Check the CI status and report failures.".into(),
            schedule: Schedule::IntervalSecs { secs: 60 },
            target: AutomationTarget::ExistingSession {
                session_id: "sess-1".into(),
            },
            trust: TrustMode::Ask,
            last_run: None,
            created: state::now_ts(),
        };

        let run = mgr.run_automation(&automation).await;

        assert_eq!(run.status, "dispatched");
        assert_eq!(run.session_id.as_deref(), Some("sess-1"));
        assert_eq!(run.automation_id, "a1");

        // The busy session means the prompt stays queued (not popped/dispatched)
        // — proving the durable prompt was delivered to the session's queue.
        let queued = state::read_queue(&tmp.0, "sess-1").unwrap();
        assert_eq!(queued, vec!["Check the CI status and report failures."]);

        std::env::remove_var("BUGYO_CONFIG_HOME");
    }

    // See note above: the env lock is intentionally held across awaits.
    #[allow(clippy::await_holding_lock)]
    #[tokio::test]
    async fn fresh_interval_is_seeded_not_fired_by_tick() {
        let _guard = state::env_lock();
        let cfg = Tmp::new();
        std::env::set_var("BUGYO_CONFIG_HOME", &cfg.0);

        // A fresh interval automation targeting an absent session: if it fired
        // it would error; seeding means it does not fire this pass.
        let automation = Automation {
            id: "seed-me".into(),
            name: "seeded".into(),
            enabled: true,
            prompt: "p".into(),
            schedule: Schedule::IntervalSecs { secs: 3600 },
            target: AutomationTarget::ExistingSession {
                session_id: "absent".into(),
            },
            trust: TrustMode::Ask,
            last_run: None,
            created: state::now_ts(),
        };
        config::save_automation(&cfg.0, &automation).unwrap();

        let mgr = AcpManager::default();
        let runs = mgr.automation_tick().await;

        assert!(runs.is_empty(), "a fresh interval must not fire this pass");
        let stored = config::list_automations(&cfg.0).unwrap();
        assert_eq!(stored.len(), 1);
        assert!(
            stored[0].last_run.is_some(),
            "a fresh interval must be seeded (last_run set) by the tick"
        );

        std::env::remove_var("BUGYO_CONFIG_HOME");
    }

    // See note above: the env lock is intentionally held across awaits.
    #[allow(clippy::await_holding_lock)]
    #[tokio::test]
    async fn existing_session_automation_errors_for_unknown_session() {
        let _guard = state::env_lock();
        let tmp = Tmp::new();
        std::env::set_var("BUGYO_CONFIG_HOME", &tmp.0);

        let mgr = AcpManager::default();
        let automation = Automation {
            id: "a2".into(),
            name: "orphan".into(),
            enabled: true,
            prompt: "hello".into(),
            schedule: Schedule::IntervalSecs { secs: 60 },
            target: AutomationTarget::ExistingSession {
                session_id: "nope".into(),
            },
            trust: TrustMode::Ask,
            last_run: None,
            created: state::now_ts(),
        };

        let run = mgr.run_automation(&automation).await;
        assert_eq!(run.status, "error");
        assert!(run.message.unwrap().contains("no session"));

        std::env::remove_var("BUGYO_CONFIG_HOME");
    }
}
