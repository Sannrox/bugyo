// Fleet store: manages many sessions keyed by ACP session id. Backend events
// are tagged with `sessionId`; `applyEvent` routes each to the right session's
// per-session reducer (`reduceSession`), so the transcript logic is shared and
// unit-tested once. Components subscribe with selectors so a busy session's
// stream doesn't re-render the whole tree (see AGENTS.md).

import { create } from "zustand";
import type {
  AcpEvent,
  HeartbeatReport,
  Project,
  SessionMeta,
  Workspace,
} from "./bindings";
import {
  initialSessionState,
  reduceSession,
  type SessionState,
  type TranscriptEntry,
} from "./session";

export interface FleetSession {
  sessionId: string;
  /** Repository the session's workspace belongs to (for grouping). */
  repoRoot: string | null;
  workspace: Workspace | null;
  state: SessionState;
  /** Tasks queued behind the current turn for this session. */
  queued: number;
  /**
   * Epoch-ms of the last activity on this session (creation, a routed backend
   * event, or a user prompt). Drives the relative "last active" label in the
   * sidebar. Frontend-tracked only — not persisted across restarts.
   */
  lastActivity: number;
  /** Pinned sessions sort to the top of their group. Durable (SessionMeta). */
  pinned: boolean;
  /** Optional human-friendly name overriding the branch/label. Durable. */
  name: string | null;
}

export interface FleetStore {
  sessions: Record<string, FleetSession>;
  /** Insertion order of session ids. */
  order: string[];
  activeId: string | null;
  /** A second session shown side-by-side with the active one (split view). */
  secondaryId: string | null;
  /** Which main panel to show: a session (activeId), the composer (null), the inbox, automations, settings, the fleet grid, or search. */
  panel:
    | "inbox"
    | "automations"
    | "settings"
    | "fleet"
    | "search"
    | "eventlog"
    | null;
  /** Most recent heartbeat pass report. */
  heartbeat: HeartbeatReport | null;
  /** Registered projects (repository paths). */
  projects: Project[];
  /**
   * Backend `error` events (which carry no session id, so can't be routed to a
   * single session's transcript). Surfaced as a dismissible banner so failures
   * the backend emits — dropped queued tasks, dead agent processes, transport
   * errors — are visible rather than silently swallowed.
   */
  errors: string[];
  addSession: (input: {
    sessionId: string;
    workspace?: Workspace | null;
    queued?: number;
    repoRoot?: string | null;
  }) => void;
  removeSession: (sessionId: string) => void;
  setActive: (sessionId: string | null) => void;
  /** Open a session in the second (split) pane; promotes to active if none. */
  openSplit: (sessionId: string) => void;
  /** Close the split pane, keeping the active session. */
  closeSplit: () => void;
  openInbox: () => void;
  openAutomations: () => void;
  openSettings: () => void;
  openFleet: () => void;
  openSearch: () => void;
  openEventLog: () => void;
  setQueued: (sessionId: string, queued: number) => void;
  setHeartbeat: (report: HeartbeatReport) => void;
  /** Append the user's own prompt to a session's transcript (optimistic). */
  appendUserMessage: (sessionId: string, text: string) => void;
  /** Replace a session's transcript (e.g. restored on resume). */
  setTranscript: (sessionId: string, transcript: TranscriptEntry[]) => void;
  setProjects: (projects: Project[]) => void;
  addProject: (project: Project) => void;
  removeProject: (path: string) => void;
  /** Toggle a session's pinned flag (pure; persistence is a caller concern). */
  togglePin: (sessionId: string) => void;
  /** Set a session's custom name (empty string clears it). Pure. */
  renameSession: (sessionId: string, name: string) => void;
  /** Move a session one slot earlier/later in the manual order. Pure. */
  moveSession: (sessionId: string, dir: "up" | "down") => void;
  /** Apply persisted metadata (pin/name/order) loaded from the backend. */
  applySessionMeta: (metas: SessionMeta[]) => void;
  /** Apply a single backend event to its session's reducer. */
  applyEvent: (
    event: AcpEvent,
  ) => void; /** Apply a batch of backend events in a single store commit (coalesces
   * high-frequency `session/update` streams; see AGENTS.md). */
  applyEvents: (events: AcpEvent[]) => void;
  /** Dismiss one surfaced backend error by index. */
  dismissError: (index: number) => void;
}

/** A freshly-created/known session is ready → start it as idle, not disconnected. */
function freshState(): SessionState {
  return { ...initialSessionState, status: "idle" };
}

/** Route an event to the session it belongs to; null = not routable. */
export function eventSessionId(event: AcpEvent): string | null {
  switch (event.type) {
    case "status":
      return event.sessionId;
    case "agentMessage":
    case "agentThought":
    case "toolCall":
    case "permissionRequested":
    case "metrics":
    case "capabilities":
    case "subagents":
    case "mcpServerInitialized":
      return event.sessionId;
    case "error":
      return null;
  }
}

export const useFleet = create<FleetStore>((set, get) => ({
  sessions: {},
  order: [],
  activeId: null,
  secondaryId: null,
  panel: null,
  heartbeat: null,
  projects: [],
  errors: [],

  addSession: ({ sessionId, workspace = null, queued = 0, repoRoot }) =>
    set((s) => {
      if (s.sessions[sessionId]) {
        return { activeId: sessionId };
      }
      const session: FleetSession = {
        sessionId,
        workspace,
        repoRoot: repoRoot ?? workspace?.repoRoot ?? null,
        state: freshState(),
        queued,
        lastActivity: Date.now(),
        pinned: false,
        name: null,
      };
      return {
        sessions: { ...s.sessions, [sessionId]: session },
        order: [...s.order, sessionId],
        activeId: sessionId,
      };
    }),

  removeSession: (sessionId) =>
    set((s) => {
      if (!s.sessions[sessionId]) return {};
      const sessions = { ...s.sessions };
      delete sessions[sessionId];
      const order = s.order.filter((id) => id !== sessionId);
      const activeId =
        s.activeId === sessionId
          ? (order[order.length - 1] ?? null)
          : s.activeId;
      const secondaryId = s.secondaryId === sessionId ? null : s.secondaryId;
      return { sessions, order, activeId, secondaryId };
    }),

  setActive: (sessionId) =>
    set((s) => ({
      activeId: sessionId,
      panel: null,
      // A session can't be both the active and the split pane.
      secondaryId: s.secondaryId === sessionId ? null : s.secondaryId,
    })),

  openSplit: (sessionId) =>
    set((s) => {
      if (!s.sessions[sessionId]) return {};
      if (s.activeId == null) return { activeId: sessionId, panel: null };
      if (s.activeId === sessionId) return { panel: null };
      return { secondaryId: sessionId, panel: null };
    }),

  closeSplit: () => set({ secondaryId: null }),

  openInbox: () => set({ panel: "inbox" }),

  openAutomations: () => set({ panel: "automations" }),

  openSettings: () => set({ panel: "settings" }),

  openFleet: () => set({ panel: "fleet" }),

  openSearch: () => set({ panel: "search" }),

  openEventLog: () => set({ panel: "eventlog" }),

  setQueued: (sessionId, queued) =>
    set((s) => {
      const existing = s.sessions[sessionId];
      if (!existing) return {};
      return {
        sessions: { ...s.sessions, [sessionId]: { ...existing, queued } },
      };
    }),

  setHeartbeat: (report) => set({ heartbeat: report }),

  appendUserMessage: (sessionId, text) =>
    set((s) => {
      const existing = s.sessions[sessionId];
      if (!existing) return {};
      return {
        sessions: {
          ...s.sessions,
          [sessionId]: {
            ...existing,
            lastActivity: Date.now(),
            state: {
              ...existing.state,
              transcript: [
                ...existing.state.transcript,
                { kind: "user", text },
              ],
            },
          },
        },
      };
    }),

  setTranscript: (sessionId, transcript) =>
    set((s) => {
      const existing = s.sessions[sessionId];
      if (!existing) return {};
      return {
        sessions: {
          ...s.sessions,
          [sessionId]: {
            ...existing,
            state: { ...existing.state, transcript },
          },
        },
      };
    }),

  setProjects: (projects) => set({ projects }),

  addProject: (project) =>
    set((s) =>
      s.projects.some((p) => p.path === project.path)
        ? {}
        : {
            projects: [...s.projects, project].sort((a, b) =>
              a.name.toLowerCase().localeCompare(b.name.toLowerCase()),
            ),
          },
    ),

  removeProject: (path) =>
    set((s) => ({ projects: s.projects.filter((p) => p.path !== path) })),

  togglePin: (sessionId) =>
    set((s) => {
      const e = s.sessions[sessionId];
      if (!e) return {};
      return {
        sessions: { ...s.sessions, [sessionId]: { ...e, pinned: !e.pinned } },
      };
    }),

  renameSession: (sessionId, name) =>
    set((s) => {
      const e = s.sessions[sessionId];
      if (!e) return {};
      const trimmed = name.trim();
      return {
        sessions: {
          ...s.sessions,
          [sessionId]: { ...e, name: trimmed === "" ? null : trimmed },
        },
      };
    }),

  moveSession: (sessionId, dir) =>
    set((s) => {
      const idx = s.order.indexOf(sessionId);
      if (idx < 0) return {};
      const swap = dir === "up" ? idx - 1 : idx + 1;
      if (swap < 0 || swap >= s.order.length) return {};
      const order = [...s.order];
      [order[idx], order[swap]] = [order[swap], order[idx]];
      return { order };
    }),

  applySessionMeta: (metas) =>
    set((s) => {
      const byId = new Map(metas.map((m) => [m.sessionId, m]));
      const sessions = { ...s.sessions };
      for (const id of Object.keys(sessions)) {
        const m = byId.get(id);
        if (m) {
          sessions[id] = { ...sessions[id], pinned: m.pinned, name: m.name };
        }
      }
      // Reorder by persisted `order` when present. Array.sort is stable, so
      // sessions without an order keep their relative position (after ordered
      // ones). Missing orders sort last.
      const order = [...s.order].sort((a, b) => {
        const oa = byId.get(a)?.order ?? null;
        const ob = byId.get(b)?.order ?? null;
        if (oa === null && ob === null) return 0;
        if (oa === null) return 1;
        if (ob === null) return -1;
        return oa - ob;
      });
      return { sessions, order };
    }),

  applyEvent: (event) => get().applyEvents([event]),

  applyEvents: (events) =>
    set((s) => {
      if (events.length === 0) return {};
      // Fold every event into one new sessions map so a burst of streamed
      // chunks commits once, not once per chunk. `next` is cloned lazily on
      // the first routable event, so a batch of no-ops changes nothing.
      let next: Record<string, FleetSession> | null = null;
      // Backend `error` events carry no session id, so they can't be routed to
      // a session reducer; collect them into the banner list instead of
      // silently dropping them.
      let errors: string[] | null = null;
      const now = Date.now();
      for (const event of events) {
        if (event.type === "error") {
          errors = [...(errors ?? s.errors), event.message];
          continue;
        }
        const id = eventSessionId(event);
        if (!id) continue;
        const base: Record<string, FleetSession> = next ?? s.sessions;
        const existing = base[id];
        if (!existing) continue;
        next = {
          ...base,
          [id]: {
            ...existing,
            lastActivity: now,
            state: reduceSession(existing.state, event),
          },
        };
      }
      const patch: Partial<FleetStore> = {};
      if (next) patch.sessions = next;
      if (errors) patch.errors = errors;
      return patch;
    }),

  dismissError: (index) =>
    set((s) => ({ errors: s.errors.filter((_, i) => i !== index) })),
}));
