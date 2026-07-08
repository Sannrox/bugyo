import { useEffect, useState } from "react";
import { GitBranch, Pin, SquareTerminal } from "lucide-react";
import { useFleet } from "./lib/fleetStore";
import { useBudget } from "./lib/budgetStore";
import type { SessionState } from "./lib/session";
import { projectName, relativeTime } from "./lib/format";
import { budgetLevel, effectiveCap } from "./lib/budget";
import type { Project } from "./lib/bindings";
import {
  confirmDialog,
  messageDialog,
  orchEnqueue,
  workspaceArchive,
} from "./lib/ipc";

const STATUS_LABEL: Record<SessionState["status"], string> = {
  disconnected: "Disconnected",
  idle: "Idle",
  working: "Working…",
  needsApproval: "Needs approval",
  error: "Error",
};

const DOT_CLASS: Record<SessionState["status"], string> = {
  disconnected: "dot--disconnected",
  idle: "dot--idle",
  working: "dot--working",
  needsApproval: "dot--needsApproval",
  error: "dot--error",
};

/** Most recent agent message text, for the card snippet. */
function lastAgentSnippet(transcript: SessionState["transcript"]): string {
  for (let i = transcript.length - 1; i >= 0; i--) {
    const e = transcript[i];
    if (e.kind === "agent") return e.text;
  }
  return "";
}

/**
 * One fleet card. Subscribes to its own session slice(s) so a busy sibling's
 * event stream never re-renders the rest of the grid (see AGENTS.md).
 */
function FleetCard({
  sessionId,
  now,
  projects,
  selected,
  onToggleSelect,
}: {
  sessionId: string;
  now: number;
  projects: Project[];
  selected: boolean;
  onToggleSelect: () => void;
}) {
  const workspace = useFleet((s) => s.sessions[sessionId]?.workspace ?? null);
  const customName = useFleet((s) => s.sessions[sessionId]?.name ?? null);
  const pinned = useFleet((s) => s.sessions[sessionId]?.pinned ?? false);
  const repoRoot = useFleet((s) => s.sessions[sessionId]?.repoRoot ?? null);
  const status = useFleet(
    (s) => s.sessions[sessionId]?.state.status ?? "disconnected",
  );
  const queued = useFleet((s) => s.sessions[sessionId]?.queued ?? 0);
  const credits = useFleet((s) => s.sessions[sessionId]?.state.credits ?? 0);
  const contextPercent = useFleet(
    (s) => s.sessions[sessionId]?.state.contextPercent ?? null,
  );
  const lastActivity = useFleet(
    (s) => s.sessions[sessionId]?.lastActivity ?? 0,
  );
  const snippet = useFleet((s) =>
    lastAgentSnippet(s.sessions[sessionId]?.state.transcript ?? []),
  );
  const setActive = useFleet((s) => s.setActive);

  const name = customName ?? workspace?.branch ?? "plain session";
  const project = projectName(repoRoot, projects);
  const Icon = workspace ? GitBranch : SquareTerminal;
  const budgetConfig = useBudget((s) => s.config);
  const level = budgetLevel(credits, effectiveCap(budgetConfig, repoRoot));

  return (
    <div className={`fleetcard${selected ? " fleetcard--selected" : ""}`}>
      <input
        type="checkbox"
        className="fleetcard__check"
        checked={selected}
        onChange={onToggleSelect}
        aria-label={`select ${name}`}
      />
      <button
        type="button"
        className="fleetcard__open"
        onClick={() => setActive(sessionId)}
      >
        <div className="fleetcard__head">
          <Icon className="fleetcard__icon" size={15} aria-hidden />
          {pinned && (
            <Pin className="fleetcard__pin" size={12} aria-label="pinned" />
          )}
          <span className="fleetcard__name">{name}</span>
          <span
            className={`dot ${DOT_CLASS[status]}`}
            aria-label={`status ${status}`}
            title={status}
          >
            ●
          </span>
        </div>

        {project && <p className="fleetcard__project muted">{project}</p>}

        <div className="fleetcard__meta">
          <span className="badge">{STATUS_LABEL[status]}</span>
          {lastActivity > 0 && (
            <span
              className="fleetcard__age muted"
              title={`Last active ${new Date(lastActivity).toLocaleString()}`}
            >
              {relativeTime(lastActivity, now)}
            </span>
          )}
          {queued > 0 && (
            <span className="badge" aria-label={`${queued} queued`}>
              queued {queued}
            </span>
          )}
          {contextPercent !== null && (
            <span className="badge" aria-label="context usage">
              ctx {contextPercent.toFixed(1)}%
            </span>
          )}
          {credits > 0 && (
            <span className="badge" aria-label="credits spent">
              {credits.toFixed(2)} cr
            </span>
          )}
          {level !== "ok" && (
            <span
              className={`badge budget-badge budget-badge--${level}`}
              aria-label={`budget ${level}`}
            >
              {level === "over" ? "over budget" : "near budget"}
            </span>
          )}
        </div>

        {snippet && <p className="fleetcard__snippet muted">{snippet}</p>}
      </button>
    </div>
  );
}

/** Grid overview of the whole fleet — status at a glance, click to focus. */
export default function FleetGrid() {
  const order = useFleet((s) => s.order);
  const projects = useFleet((s) => s.projects);
  const removeSession = useFleet((s) => s.removeSession);
  // Shared clock for relative "last active" labels — one interval for the whole
  // grid, so idle cards' ages keep advancing instead of freezing at render time
  // (mirrors the Sidebar's tick).
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);

  // Selection is local to the grid (not global store state).
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [dispatchText, setDispatchText] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");

  // Drop ids that no longer exist (archived/deleted elsewhere).
  const live = new Set(order);
  const selectedLive = [...selected].filter((id) => live.has(id));

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function clearSelection() {
    setSelected(new Set());
    setDispatchText("");
    setNote("");
  }

  async function dispatchToSelected(e: React.FormEvent) {
    e.preventDefault();
    const text = dispatchText.trim();
    if (!text || selectedLive.length === 0) return;
    setBusy(true);
    setNote("");
    try {
      await Promise.all(selectedLive.map((id) => orchEnqueue(id, text)));
      setNote(`Dispatched to ${selectedLive.length} session(s).`);
      setDispatchText("");
    } catch (err) {
      await messageDialog(String(err));
    } finally {
      setBusy(false);
    }
  }

  async function archiveSelected() {
    const sessions = useFleet.getState().sessions;
    const workspaces = selectedLive.filter((id) => sessions[id]?.workspace);
    if (workspaces.length === 0) return;
    const ok = await confirmDialog(
      `Archive ${workspaces.length} workspace(s)? This removes each git ` +
        "worktree and deletes its branch. Uncommitted changes are discarded.",
      "Archive workspaces",
    );
    if (!ok) return;
    setBusy(true);
    try {
      for (const id of workspaces) {
        await workspaceArchive(id, true);
        removeSession(id);
      }
      clearSelection();
    } catch (err) {
      await messageDialog(String(err));
    } finally {
      setBusy(false);
    }
  }

  const wsSelectedCount = selectedLive.filter(
    (id) => useFleet.getState().sessions[id]?.workspace,
  ).length;

  return (
    <div className="fleetgrid" aria-label="fleet overview">
      <h1 className="fleetgrid__title">Fleet</h1>

      {selectedLive.length > 0 && (
        <div className="fleetbulk" aria-label="bulk actions">
          <span className="fleetbulk__count">
            {selectedLive.length} selected
          </span>
          <form className="fleetbulk__dispatch" onSubmit={dispatchToSelected}>
            <input
              aria-label="bulk prompt"
              placeholder="Dispatch a prompt to all selected…"
              value={dispatchText}
              onChange={(e) => setDispatchText(e.currentTarget.value)}
              disabled={busy}
            />
            <button type="submit" disabled={busy || !dispatchText.trim()}>
              Dispatch to {selectedLive.length}
            </button>
          </form>
          <button
            type="button"
            className="pane__action pane__action--danger"
            disabled={busy || wsSelectedCount === 0}
            title={wsSelectedCount === 0 ? "No workspaces selected" : "Archive"}
            onClick={() => void archiveSelected()}
          >
            Archive {wsSelectedCount}
          </button>
          <button
            type="button"
            className="pane__action"
            onClick={clearSelection}
          >
            Clear
          </button>
          {note && <span className="muted">{note}</span>}
        </div>
      )}

      {order.length === 0 ? (
        <p className="muted fleetgrid__empty">
          No sessions yet. Start one to see it here.
        </p>
      ) : (
        <div className="fleetgrid__cards">
          {order.map((id) => (
            <FleetCard
              key={id}
              sessionId={id}
              now={now}
              projects={projects}
              selected={selected.has(id)}
              onToggleSelect={() => toggle(id)}
            />
          ))}
        </div>
      )}
    </div>
  );
}
