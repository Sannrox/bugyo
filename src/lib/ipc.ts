// Typed IPC layer. UI components call these functions rather than `invoke`
// with stringly-typed args directly (see AGENTS.md). Each function wraps one
// Tauri command; event streams are wrapped as typed subscriptions.

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";
import {
  confirm as dialogConfirm,
  message as dialogMessage,
  open as dialogOpen,
} from "@tauri-apps/plugin-dialog";
import type {
  AcpEvent,
  Automation,
  AutomationRun,
  BudgetConfig,
  CheckResult,
  HeartbeatReport,
  PingResponse,
  Project,
  QueueUpdate,
  SearchHit,
  SessionInfo,
  SessionMeta,
  Trigger,
  TriggerRun,
  TrustProfile,
  WorkspaceCreateArgs,
  WorkspaceReviewState,
  WorkspaceSession,
} from "./bindings";
import type { TranscriptEntry } from "./session";

/** The Tauri event channel ACP updates arrive on (matches `service::ACP_EVENT`). */
export const ACP_EVENT = "acp:event";
/** Queue-depth updates (matches `service::QUEUE_EVENT`). */
export const QUEUE_EVENT = "orch:queue";
/** Heartbeat pass reports (matches `service::HEARTBEAT_EVENT`). */
export const HEARTBEAT_EVENT = "orch:heartbeat";
/** Automation run reports (matches `service::AUTOMATION_EVENT`). */
export const AUTOMATION_EVENT = "automation:run";
/** Trigger run reports (matches `service::TRIGGER_EVENT`). */
export const TRIGGER_EVENT = "trigger:run";

/** Bridge smoke test: greet by name, returns the backend version. */
export function ping(name: string): Promise<PingResponse> {
  return invoke<PingResponse>("ping", { name });
}

/** Options for starting a plain (non-workspace) ACP session. */
export interface StartSessionOptions {
  /** Working directory for the session (defaults to the backend cwd). */
  cwd?: string;
  /** Legacy compatibility only. The backend safely ignores trust-all. */
  trustAll?: boolean;
  /** Trust only these tools (`--trust-tools`). Ignored if `trustAll`. */
  trustTools?: string[];
  /** Start with a specific agent (`--agent`), e.g. an orchestrator. */
  agent?: string;
  /** Start with a specific model (`--model`). */
  model?: string;
}

/** Start a plain `kiro-cli acp` session; returns the new session id. */
export function acpStartSession(
  opts: StartSessionOptions = {},
): Promise<string> {
  return invoke<string>("acp_start_session", {
    cwd: opts.cwd ?? null,
    trustAll: opts.trustAll ?? false,
    trustTools: opts.trustTools ?? [],
    agent: opts.agent ?? null,
    model: opts.model ?? null,
  });
}

/** Create a workspace (git worktree + branch) and start a session bound to it. */
export function workspaceCreate(
  params: WorkspaceCreateArgs,
): Promise<WorkspaceSession> {
  return invoke<WorkspaceSession>("workspace_create", { params });
}

/** Archive the workspace bound to a session (remove worktree + delete branch). */
export function workspaceArchive(
  sessionId: string,
  force = false,
): Promise<void> {
  return invoke<void>("workspace_archive", { sessionId, force });
}

/** Full patch of a workspace's changes vs its base branch (for review). */
export function workspaceDiff(sessionId: string): Promise<string> {
  return invoke<string>("workspace_diff", { sessionId });
}

/** Durable review/check/landing state derived from the live git workspace. */
export function workspaceReviewState(
  sessionId: string,
): Promise<WorkspaceReviewState> {
  return invoke<WorkspaceReviewState>("workspace_review_state", { sessionId });
}

/** Run a check/run script in the workspace; returns pass/fail + output. */
export function workspaceCheck(
  sessionId: string,
  script: string,
): Promise<CheckResult> {
  return invoke<CheckResult>("workspace_check", { sessionId, script });
}

/** Stage and commit every reviewed workspace change. */
export function workspaceCommit(
  sessionId: string,
  message: string,
): Promise<void> {
  return invoke<void>("workspace_commit", { sessionId, message });
}

/** Push the workspace's committed branch to `origin` (`git push -u`). */
export function workspacePush(sessionId: string): Promise<void> {
  return invoke<void>("workspace_push", { sessionId });
}

/** List active sessions (id + optional workspace) for reconciling the fleet. */
export function acpListSessions(): Promise<SessionInfo[]> {
  return invoke<SessionInfo[]>("acp_list_sessions");
}

/** Close a session: release its process but keep it (resumable). */
export function acpCloseSession(sessionId: string): Promise<void> {
  return invoke<void>("acp_close_session", { sessionId });
}

/** Delete a session entirely (removes it from the fleet + persisted list). */
export function acpDeleteSession(sessionId: string): Promise<void> {
  return invoke<void>("acp_delete_session", { sessionId });
}

/** Enqueue a prompt for a session (dispatches now if idle, else queues). */
export function orchEnqueue(sessionId: string, text: string): Promise<void> {
  return invoke<void>("orch_enqueue", { sessionId, text });
}

/** Read queued prompts in their dispatch order. */
export function orchQueue(sessionId: string): Promise<string[]> {
  return invoke<string[]>("orch_queue", { sessionId });
}

/** Save an explicitly ordered queue for a session. */
export function orchQueueReplace(
  sessionId: string,
  tasks: string[],
): Promise<void> {
  return invoke<void>("orch_queue_replace", { sessionId, tasks });
}

/** Dry-run: what the next heartbeat pass would dispatch. */
export function orchPreview(): Promise<HeartbeatReport> {
  return invoke<HeartbeatReport>("orch_preview");
}

/** The heartbeat interval in seconds. */
export function orchHeartbeatSecs(): Promise<number> {
  return invoke<number>("orch_heartbeat_secs");
}

/** Read the shared decision log (newest lines last). */
export function orchLog(): Promise<string[]> {
  return invoke<string[]>("orch_log");
}

/** List registered projects (repository paths). */
export function projectList(): Promise<Project[]> {
  return invoke<Project[]>("project_list");
}

/** Register a project by repository path (must be a git repo). */
export function projectAdd(path: string): Promise<Project> {
  return invoke<Project>("project_add", { path });
}

/** Save workspace defaults for a registered project. */
export function projectUpdate(project: Project): Promise<Project> {
  return invoke<Project>("project_update", {
    path: project.path,
    baseBranch: project.baseBranch,
    setupScript: project.setupScript,
    checkScript: project.checkScript,
  });
}

/** Remove a registered project by path. */
export function projectRemove(path: string): Promise<void> {
  return invoke<void>("project_remove", { path });
}

/** Reconstruct a session's transcript from kiro's persisted store (for resume). */
export function sessionTranscript(
  sessionId: string,
): Promise<TranscriptEntry[]> {
  return invoke<TranscriptEntry[]>("session_transcript", { sessionId });
}

/** List durable per-session UI metadata (pin / custom name / manual order). */
export function sessionMetaList(): Promise<SessionMeta[]> {
  return invoke<SessionMeta[]>("session_meta_list");
}

/** Upsert durable UI metadata for one session. */
export function sessionMetaSet(meta: SessionMeta): Promise<void> {
  return invoke<void>("session_meta_set", { meta });
}

/** Search every persisted session's transcript (case-insensitive). */
export function sessionSearch(query: string): Promise<SearchHit[]> {
  return invoke<SearchHit[]>("session_search", { query });
}

/** Set the OS dock/taskbar attention badge (0 clears it). Best-effort. */
export function setAttentionBadge(count: number): Promise<void> {
  return invoke<void>("set_attention_badge", { count });
}

/** Read the budget config (credit caps). */
export function budgetGet(): Promise<BudgetConfig> {
  return invoke<BudgetConfig>("budget_get");
}

/** Persist the budget config (credit caps). */
export function budgetSet(config: BudgetConfig): Promise<void> {
  return invoke<void>("budget_set", { config });
}

/** List trust profiles (approval-rule presets). */
export function trustProfileList(): Promise<TrustProfile[]> {
  return invoke<TrustProfile[]>("trust_profile_list");
}

/** Upsert a trust profile. */
export function trustProfileSet(profile: TrustProfile): Promise<void> {
  return invoke<void>("trust_profile_set", { profile });
}

/** Remove a trust profile by id. */
export function trustProfileRemove(id: string): Promise<void> {
  return invoke<void>("trust_profile_remove", { id });
}

/**
 * The tools a profile actually pre-trusts (destructive/always-ask stripped) —
 * pass these as `trustTools` when starting a session under the profile.
 */
export function trustProfileEffectiveTools(id: string): Promise<string[]> {
  return invoke<string[]>("trust_profile_effective_tools", { id });
}

/** Request cancellation of a session's current turn. */
export function acpCancel(sessionId: string): Promise<void> {
  return invoke<void>("acp_cancel", { sessionId });
}

/** Options for capturing a screenshot to attach to a prompt. */
export interface ScreenshotPromptOptions {
  /** Capture a specific display (1 = main). */
  display?: number;
  /** Capture an explicit rectangle, formatted as "x,y,w,h". */
  region?: string;
  /** Capture a specific window by CoreGraphics window id. */
  windowId?: number;
  /**
   * Capture Bugyo's own window (the default when no other target is given).
   * Set to false to capture the full main display instead.
   */
  ownWindow?: boolean;
}

/**
 * Capture a screenshot of the running app and send it to a session as an
 * image-annotated prompt (Codex-style visual input for a self-improvement
 * loop). Returns the turn's stop reason. By default captures Bugyo's own
 * window; pass `ownWindow: false` (and no other target) for full screen.
 * Requires the macOS Screen Recording permission.
 */
export function acpPromptWithScreenshot(
  sessionId: string,
  text: string,
  opts: ScreenshotPromptOptions = {},
): Promise<string> {
  return invoke<string>("acp_prompt_with_screenshot", {
    sessionId,
    text,
    args: {
      display: opts.display ?? null,
      region: opts.region ?? null,
      windowId: opts.windowId ?? null,
      ownWindow: opts.ownWindow ?? null,
    },
  });
}

/** Resolve a held permission request for a session by selecting an option. */
export function acpRespondPermission(
  sessionId: string,
  requestId: string,
  optionId: string,
): Promise<void> {
  return invoke<void>("acp_respond_permission", {
    sessionId,
    requestId,
    optionId,
  });
}

/** Subscribe to ACP events. Returns a promise resolving to an unsubscribe fn. */
export function onAcpEvent(
  handler: (event: AcpEvent) => void,
): Promise<UnlistenFn> {
  return listen<AcpEvent>(ACP_EVENT, (e) => handler(e.payload));
}

/** Subscribe to queue-depth updates. */
export function onOrchQueue(
  handler: (update: QueueUpdate) => void,
): Promise<UnlistenFn> {
  return listen<QueueUpdate>(QUEUE_EVENT, (e) => handler(e.payload));
}

/** Subscribe to heartbeat pass reports. */
export function onOrchHeartbeat(
  handler: (report: HeartbeatReport) => void,
): Promise<UnlistenFn> {
  return listen<HeartbeatReport>(HEARTBEAT_EVENT, (e) => handler(e.payload));
}

/** List all persisted automations. */
export function automationList(): Promise<Automation[]> {
  return invoke<Automation[]>("automation_list");
}

/** Create an automation; the backend assigns id/created and validates it. */
export function automationCreate(automation: Automation): Promise<Automation> {
  return invoke<Automation>("automation_create", { automation });
}

/** Update an existing automation (upsert by id). */
export function automationUpdate(automation: Automation): Promise<Automation> {
  return invoke<Automation>("automation_update", { automation });
}

/** Remove an automation by id. */
export function automationRemove(id: string): Promise<void> {
  return invoke<void>("automation_remove", { id });
}

/** Run an automation now (a manual test that does not advance its schedule). */
export function automationRunNow(id: string): Promise<AutomationRun> {
  return invoke<AutomationRun>("automation_run_now", { id });
}

/** Subscribe to automation run reports. */
export function onAutomationRun(
  handler: (run: AutomationRun) => void,
): Promise<UnlistenFn> {
  return listen<AutomationRun>(AUTOMATION_EVENT, (e) => handler(e.payload));
}

/** List all persisted triggers. */
export function triggerList(): Promise<Trigger[]> {
  return invoke<Trigger[]>("trigger_list");
}

/** Create a trigger; the backend assigns id/created, validates it, and resets
 * internal dedup state. */
export function triggerCreate(trigger: Trigger): Promise<Trigger> {
  return invoke<Trigger>("trigger_create", { trigger });
}

/** Update an existing trigger (upsert by id); dedup state is preserved. */
export function triggerUpdate(trigger: Trigger): Promise<Trigger> {
  return invoke<Trigger>("trigger_update", { trigger });
}

/** Remove a trigger by id. */
export function triggerRemove(id: string): Promise<void> {
  return invoke<void>("trigger_remove", { id });
}

/** Run a trigger now (a manual test: polls + fires new items without advancing
 * its dedup state, so it's safe to run repeatedly while configuring). */
export function triggerRunNow(id: string): Promise<TriggerRun> {
  return invoke<TriggerRun>("trigger_run_now", { id });
}

/** Subscribe to trigger run reports. */
export function onTriggerRun(
  handler: (run: TriggerRun) => void,
): Promise<UnlistenFn> {
  return listen<TriggerRun>(TRIGGER_EVENT, (e) => handler(e.payload));
}

/**
 * Show an OS notification, requesting permission on first use. Best-effort:
 * if permission is denied the call is a no-op.
 */
export async function notify(title: string, body: string): Promise<void> {
  let granted = await isPermissionGranted();
  if (!granted) {
    granted = (await requestPermission()) === "granted";
  }
  if (granted) {
    sendNotification({ title, body });
  }
}

/** Native folder picker; returns the chosen absolute path or null if cancelled.
 * (Uses the dialog plugin — `window.prompt` does not work in the webview.) */
export async function pickDirectory(title: string): Promise<string | null> {
  const res = await dialogOpen({ directory: true, multiple: false, title });
  return typeof res === "string" ? res : null;
}

/** Native confirmation dialog (webview `window.confirm` is unreliable). */
export function confirmDialog(
  message: string,
  title?: string,
): Promise<boolean> {
  return dialogConfirm(message, title ? { title } : undefined);
}

/** Native message/alert dialog. */
export async function messageDialog(message: string): Promise<void> {
  await dialogMessage(message);
}
