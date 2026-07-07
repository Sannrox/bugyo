// IPC contract types — the TypeScript side of the Rust ↔ TS boundary.
//
// Hand-written for now. In later phases these are generated from the Rust
// structs (e.g. via `ts-rs`); see AGENTS.md "types as contract". Keep field
// names in sync with the Rust `#[serde(rename_all = "camelCase")]` structs.

/** Mirrors `commands::PingResponse`. */
export interface PingResponse {
  message: string;
  appVersion: string;
}

/** Mirrors `config::Project` — a registered repository. */
export interface Project {
  path: string;
  name: string;
  isGitRepo: boolean;
}

/** Mirrors `workspace::Workspace`. */
export interface Workspace {
  repoRoot: string;
  baseBranch: string;
  branch: string;
  worktreePath: string;
}

/** Mirrors `service::WorkspaceSession`. */
export interface WorkspaceSession {
  sessionId: string;
  workspace: Workspace;
}

/** Mirrors `service::SessionInfo`. */
export interface SessionInfo {
  sessionId: string;
  workspace: Workspace | null;
  repo: string;
  queued: number;
}

/** Mirrors `config::SessionMeta` — durable per-session UI metadata. */
export interface SessionMeta {
  sessionId: string;
  pinned: boolean;
  name: string | null;
  /** Lower sorts earlier within a group; null keeps natural order. */
  order: number | null;
}

/** Mirrors `config::SearchHit` — one cross-session transcript search result. */
export interface SearchHit {
  sessionId: string;
  index: number;
  /** `user` | `agent` | `thought` | `tool` | `system`. */
  kind: string;
  snippet: string;
}

/** Mirrors `config::TrustProfile` — a named approval-rule preset. */
export interface TrustProfile {
  id: string;
  name: string;
  autoAllowTools: string[];
  alwaysAsk: string[];
}

/** Mirrors `config::ProjectCap` — a per-project credit cap. */
export interface ProjectCap {
  path: string;
  cap: number;
}

/** Mirrors `config::BudgetConfig` — credit caps (null = unlimited). */
export interface BudgetConfig {
  sessionCap: number | null;
  projectCaps: ProjectCap[];
}

/** Mirrors `orchestrator::Dispatched`. */
export interface Dispatched {
  sessionId: string;
  task: string;
}

/** Mirrors `orchestrator::HeartbeatReport`. */
export interface HeartbeatReport {
  ts: string;
  dryRun: boolean;
  dispatched: Dispatched[];
  queuedRemaining: number;
}

/** Payload of the `orch:queue` event. */
export interface QueueUpdate {
  sessionId: string;
  queued: number;
}

/** Mirrors `service::WorkspaceCreateArgs`. */
export interface WorkspaceCreateArgs {
  repoRoot: string;
  baseBranch: string;
  task: string;
  setupScript?: string;
  trustAll?: boolean;
  trustTools?: string[];
  agent?: string;
  model?: string;
}

/** Mirrors `workspace::CheckResult`. */
export interface CheckResult {
  success: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** Mirrors `workspace::MergePreview` — non-mutating pre-merge conflict check. */
export interface MergePreview {
  clean: boolean;
  conflictedFiles: string[];
}

/** Mirrors `acp::SessionStatus`. */
export type SessionStatus = "idle" | "working" | "needsApproval" | "error";

/** Mirrors `acp::protocol::PermissionOption`. */
export interface PermissionOption {
  optionId: string;
  name: string;
  kind: string;
}

/** Mirrors `acp::protocol::SessionCommand` — a slash command (`name` includes `/`). */
export interface SessionCommand {
  name: string;
  description: string;
}

/** Mirrors `acp::protocol::SessionPrompt` — a prompt/skill (`serverName` "skill:config" = skill). */
export interface SessionPrompt {
  name: string;
  description: string;
  serverName: string | null;
}

/** Mirrors `acp::protocol::AgentTool` — `source` is "built-in" or "mcp:<server>". */
export interface AgentTool {
  name: string;
  description: string;
  source: string | null;
}

/** Mirrors `acp::protocol::McpServer`. */
export interface McpServer {
  name: string;
  status: string | null;
  toolCount: number | null;
}

/** Mirrors `acp::protocol::Subagent`. */
export interface Subagent {
  name: string;
}

/** Mirrors `acp::protocol::ToolDiff` — a file edit from a tool call. */
export interface ToolDiff {
  path: string;
  oldText: string | null;
  newText: string;
}

/**
 * Mirrors `acp::AcpEvent` — a tagged union discriminated on `type`, emitted on
 * the `acp:event` Tauri channel.
 */
export type AcpEvent =
  | { type: "status"; sessionId: string | null; status: SessionStatus }
  | { type: "agentMessage"; sessionId: string; text: string }
  | { type: "agentThought"; sessionId: string; text: string }
  | {
      type: "toolCall";
      sessionId: string;
      toolCallId: string;
      title: string;
      status: string | null;
      diff: ToolDiff | null;
      output: string | null;
    }
  | {
      type: "permissionRequested";
      sessionId: string;
      requestId: string;
      toolCallId: string;
      title: string;
      options: PermissionOption[];
    }
  | {
      type: "metrics";
      sessionId: string;
      contextPercent: number | null;
      credits: number | null;
      turnDurationMs: number | null;
    }
  | {
      type: "capabilities";
      sessionId: string;
      commands: SessionCommand[];
      prompts: SessionPrompt[];
      tools: AgentTool[];
      mcpServers: McpServer[];
    }
  | { type: "subagents"; sessionId: string; subagents: Subagent[] }
  | { type: "mcpServerInitialized"; sessionId: string; serverName: string }
  | { type: "error"; message: string };

/** Mirrors `config::Schedule` — how often an automation fires. */
export type Schedule =
  { type: "intervalSecs"; secs: number } | { type: "cron"; expr: string };

/** Mirrors `config::AutomationTarget` — what an automation acts on. */
export type AutomationTarget =
  | { type: "existingSession"; sessionId: string }
  | {
      type: "newSession";
      cwd: string | null;
      agent: string | null;
      model: string | null;
    }
  | {
      type: "newWorkspace";
      projectPath: string;
      baseBranch: string;
      branchPrefix: string | null;
      agent: string | null;
      model: string | null;
    };

/** Mirrors `config::TrustMode` — per-automation trust (default `ask`). */
export type TrustMode =
  | { type: "ask" }
  | { type: "trustTools"; tools: string[] }
  | { type: "trustAll" };

/** Mirrors `config::Automation`. */
export interface Automation {
  id: string;
  name: string;
  enabled: boolean;
  prompt: string;
  schedule: Schedule;
  target: AutomationTarget;
  trust: TrustMode;
  lastRun: string | null;
  created: string;
}

/**
 * Mirrors `config::AutomationRun` — a recorded run, also the payload of the
 * `automation:run` Tauri event. `status` is one of `dispatched` | `created` |
 * `skipped` | `error`.
 */
export interface AutomationRun {
  ts: string;
  automationId: string;
  sessionId: string | null;
  status: string;
  message: string | null;
}
