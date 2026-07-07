// Pure session view-state reducer: folds backend `AcpEvent`s into the state the
// UI renders. Kept pure and framework-free so it is unit-testable and so the
// UI never re-implements status logic (see AGENTS.md).

import type {
  AcpEvent,
  AgentTool,
  McpServer,
  PermissionOption,
  SessionCommand,
  SessionPrompt,
  SessionStatus,
  Subagent,
  ToolDiff,
} from "./bindings";

export type TranscriptEntry =
  | { kind: "user"; text: string }
  | { kind: "agent"; text: string }
  | { kind: "thought"; text: string }
  | {
      kind: "tool";
      toolCallId: string;
      title: string;
      status: string | null;
      diff?: ToolDiff | null;
      output?: string | null;
    }
  | { kind: "system"; text: string };

export interface PendingPermission {
  requestId: string;
  toolCallId: string;
  title: string;
  options: PermissionOption[];
}

/** The per-session capability inventory, from the `_kiro.dev/*` notifications. */
export interface SessionCapabilities {
  commands: SessionCommand[];
  prompts: SessionPrompt[];
  tools: AgentTool[];
  mcpServers: McpServer[];
  subagents: Subagent[];
}

export const emptyCapabilities: SessionCapabilities = {
  commands: [],
  prompts: [],
  tools: [],
  mcpServers: [],
  subagents: [],
};

export interface SessionState {
  status: SessionStatus | "disconnected";
  transcript: TranscriptEntry[];
  contextPercent: number | null;
  pendingPermission: PendingPermission | null;
  /** Cumulative credits spent this session. */
  credits: number;
  /** Completed prompt turns (metadata with a turn duration). */
  turns: number;
  /** Cumulative turn time in milliseconds. */
  durationMs: number;
  /** What this session can do (commands, prompts/skills, tools, MCP, subagents). */
  capabilities: SessionCapabilities;
}

export const initialSessionState: SessionState = {
  status: "disconnected",
  transcript: [],
  contextPercent: null,
  pendingPermission: null,
  credits: 0,
  turns: 0,
  durationMs: 0,
  capabilities: emptyCapabilities,
};

/** Fold one event into the session state, returning a new state (immutable). */
export function reduceSession(
  state: SessionState,
  event: AcpEvent,
): SessionState {
  switch (event.type) {
    case "status":
      return {
        ...state,
        status: event.status,
        // Once the turn resumes (or ends), any pending approval is resolved.
        pendingPermission:
          event.status === "needsApproval" ? state.pendingPermission : null,
      };

    case "agentMessage": {
      // Coalesce consecutive assistant chunks into a single transcript entry.
      const last = state.transcript[state.transcript.length - 1];
      if (last && last.kind === "agent") {
        const transcript = state.transcript.slice(0, -1);
        transcript.push({ kind: "agent", text: last.text + event.text });
        return { ...state, transcript };
      }
      return {
        ...state,
        transcript: [...state.transcript, { kind: "agent", text: event.text }],
      };
    }

    case "agentThought": {
      // Coalesce consecutive reasoning chunks into a single thought entry.
      const last = state.transcript[state.transcript.length - 1];
      if (last && last.kind === "thought") {
        const transcript = state.transcript.slice(0, -1);
        transcript.push({ kind: "thought", text: last.text + event.text });
        return { ...state, transcript };
      }
      return {
        ...state,
        transcript: [
          ...state.transcript,
          { kind: "thought", text: event.text },
        ],
      };
    }

    case "toolCall": {
      const idx = state.transcript.findIndex(
        (e) => e.kind === "tool" && e.toolCallId === event.toolCallId,
      );
      const prior = idx >= 0 ? state.transcript[idx] : undefined;
      const priorDiff = prior && prior.kind === "tool" ? prior.diff : undefined;
      const priorOutput =
        prior && prior.kind === "tool" ? prior.output : undefined;
      const entry: TranscriptEntry = {
        kind: "tool",
        toolCallId: event.toolCallId,
        title: event.title,
        status: event.status,
        // A later update event carries no diff/output — keep what we captured.
        diff: event.diff ?? priorDiff ?? null,
        output: event.output ?? priorOutput ?? null,
      };
      const transcript = [...state.transcript];
      if (idx >= 0) {
        transcript[idx] = entry;
      } else {
        transcript.push(entry);
      }
      return { ...state, transcript };
    }

    case "permissionRequested":
      return {
        ...state,
        pendingPermission: {
          requestId: event.requestId,
          toolCallId: event.toolCallId,
          title: event.title,
          options: event.options,
        },
        transcript: [
          ...state.transcript,
          { kind: "system", text: `Permission requested: ${event.title}` },
        ],
      };

    case "metrics":
      return {
        ...state,
        contextPercent: event.contextPercent ?? state.contextPercent,
        credits: state.credits + (event.credits ?? 0),
        turns: state.turns + (event.turnDurationMs != null ? 1 : 0),
        durationMs: state.durationMs + (event.turnDurationMs ?? 0),
      };

    case "capabilities":
      // A `commands/available` snapshot replaces the command-derived inventory;
      // subagents come from a separate notification, so they're preserved.
      return {
        ...state,
        capabilities: {
          ...state.capabilities,
          commands: event.commands,
          prompts: event.prompts,
          tools: event.tools,
          mcpServers: event.mcpServers,
        },
      };

    case "subagents":
      return {
        ...state,
        capabilities: { ...state.capabilities, subagents: event.subagents },
      };

    case "mcpServerInitialized": {
      // Augment: upsert the server as running (it may arrive before or after
      // the `commands/available` snapshot that lists it).
      const servers = state.capabilities.mcpServers;
      const idx = servers.findIndex((m) => m.name === event.serverName);
      const next =
        idx >= 0
          ? servers.map((m, i) => (i === idx ? { ...m, status: "running" } : m))
          : [
              ...servers,
              { name: event.serverName, status: "running", toolCount: null },
            ];
      return {
        ...state,
        capabilities: { ...state.capabilities, mcpServers: next },
      };
    }

    case "error":
      return {
        ...state,
        status: "error",
        transcript: [
          ...state.transcript,
          { kind: "system", text: `Error: ${event.message}` },
        ],
      };
  }
}
