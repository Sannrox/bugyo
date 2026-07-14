import { useEffect, useState } from "react";
import { GitBranch, Pin, Plus, SquareTerminal } from "lucide-react";
import { useFleet } from "./lib/fleetStore";
import { useBudget } from "./lib/budgetStore";
import type { SessionState } from "./lib/session";
import { projectName, relativeTime } from "./lib/format";
import { budgetLevel, effectiveCap } from "./lib/budget";
import type { Project } from "./lib/bindings";
import {
  DISPLAY_STATUS_LABEL,
  effectiveStatus,
  type DisplayStatus,
} from "./lib/review";
import { confirmDialog, orchEnqueue, workspaceArchive } from "./lib/ipc";

const DOT_CLASS: Record<DisplayStatus, string> = {
  disconnected: "dot--disconnected",
  idle: "dot--idle",
  working: "dot--working",
  needsApproval: "dot--needsApproval",
  error: "dot--error",
  needsReview: "dot--needsReview",
  readyToLand: "dot--readyToLand",
  pushed: "dot--pushed",
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
  const status = useFleet((s) =>
    effectiveStatus(
      s.sessions[sessionId]?.state.status ?? "disconnected",
      s.sessions[sessionId]?.review ?? null,
    ),
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

  const name =
    (customName ?? workspace?.task) || workspace?.branch || "Plain session";
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

        <p className="fleetcard__project muted">
          {project ?? "Unassigned"}
          {workspace && <span> · {workspace.branch}</span>}
        </p>

        <div className="fleetcard__meta">
          <span className="badge">{DISPLAY_STATUS_LABEL[status]}</span>
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
  const setActive = useFleet((s) => s.setActive);
  const setQueued = useFleet((s) => s.setQueued);
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
  const [query, setQuery] = useState("");
  const [projectFilter, setProjectFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState("all");

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
      const results = await Promise.allSettled(
        selectedLive.map((id) => orchEnqueue(id, text)),
      );
      const succeeded = selectedLive.filter(
        (_, index) => results[index].status === "fulfilled",
      );
      const failed = selectedLive.filter(
        (_, index) => results[index].status === "rejected",
      );
      for (const id of succeeded) {
        setQueued(id, (useFleet.getState().sessions[id]?.queued ?? 0) + 1);
      }
      if (failed.length === 0) {
        setNote(`Queued for all ${succeeded.length} selected sessions.`);
        setDispatchText("");
      } else {
        setSelected(new Set(failed));
        setNote(
          succeeded.length > 0
            ? `Queued for ${succeeded.length}; ${failed.length} failed and remain selected for retry.`
            : `Dispatch failed for all ${failed.length} selected sessions. Nothing was queued.`,
        );
      }
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
        "worktree and discards uncommitted changes. Safely merged branches are deleted; unmerged branches are retained.",
      "Archive workspaces",
    );
    if (!ok) return;
    setBusy(true);
    const failed: string[] = [];
    let archived = 0;
    for (const id of workspaces) {
      try {
        await workspaceArchive(id, true);
        removeSession(id);
        archived += 1;
      } catch {
        failed.push(id);
      }
    }
    setBusy(false);
    setSelected(new Set(failed));
    setDispatchText("");
    setNote(
      failed.length === 0
        ? `Archived ${archived} workspace${archived === 1 ? "" : "s"}.`
        : `${archived} archived; ${failed.length} failed and remain selected for retry.`,
    );
  }

  const wsSelectedCount = selectedLive.filter(
    (id) => useFleet.getState().sessions[id]?.workspace,
  ).length;
  const sessions = useFleet((s) => s.sessions);
  const visibleOrder = order.filter((id) => {
    const session = sessions[id];
    if (!session) return false;
    if (projectFilter !== "all" && session.repoRoot !== projectFilter) {
      return false;
    }
    const status = effectiveStatus(session.state.status, session.review);
    if (statusFilter === "working" && status !== "working") {
      return false;
    }
    if (
      statusFilter === "attention" &&
      status !== "needsApproval" &&
      status !== "error"
    ) {
      return false;
    }
    if (
      statusFilter === "review" &&
      status !== "needsReview" &&
      status !== "readyToLand"
    ) {
      return false;
    }
    if (
      statusFilter === "available" &&
      status !== "idle" &&
      status !== "disconnected"
    ) {
      return false;
    }
    if (statusFilter === "landed" && status !== "pushed") {
      return false;
    }
    const needle = query.trim().toLowerCase();
    if (!needle) return true;
    const identity = [
      session.name,
      session.workspace?.task,
      session.workspace?.branch,
      projectName(session.repoRoot, projects),
      lastAgentSnippet(session.state.transcript),
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    return identity.includes(needle);
  });
  const workingCount = order.filter(
    (id) => sessions[id]?.state.status === "working",
  ).length;
  const attentionCount = order.filter((id) => {
    const status = sessions[id]?.state.status;
    return status === "needsApproval" || status === "error";
  }).length;
  const idleCount = order.filter(
    (id) =>
      effectiveStatus(
        sessions[id]?.state.status ?? "disconnected",
        sessions[id]?.review ?? null,
      ) === "idle",
  ).length;
  const stoppedCount = order.filter(
    (id) => sessions[id]?.state.status === "disconnected",
  ).length;
  const reviewCount = order.filter((id) => {
    const status = effectiveStatus(
      sessions[id]?.state.status ?? "disconnected",
      sessions[id]?.review ?? null,
    );
    return status === "needsReview" || status === "readyToLand";
  }).length;
  const groups = visibleOrder.reduce<
    Array<{ key: string; label: string; ids: string[] }>
  >((all, id) => {
    const repoRoot = sessions[id]?.repoRoot ?? null;
    const label = projectName(repoRoot, projects) ?? "Unassigned";
    const key = repoRoot ?? "__unassigned__";
    const existing = all.find((group) => group.key === key);
    if (existing) existing.ids.push(id);
    else all.push({ key, label, ids: [id] });
    return all;
  }, []);

  return (
    <div className="fleetgrid" aria-label="fleet overview">
      <header className="fleetgrid__header">
        <div>
          <p className="fleetgrid__eyebrow">COMMAND CENTER</p>
          <h1 className="fleetgrid__title">Fleet</h1>
          <p className="fleetgrid__subtitle muted">
            Every task, its state, and where you are needed.
          </p>
        </div>
        <button
          type="button"
          className="fleetgrid__new"
          onClick={() => setActive(null)}
        >
          <Plus size={15} aria-hidden /> New task
        </button>
      </header>

      <div className="fleetstats" aria-label="fleet summary">
        <span>
          <strong>{order.length}</strong> total
        </span>
        <span>
          <strong>{workingCount}</strong> working
        </span>
        <span className={attentionCount > 0 ? "fleetstats__attention" : ""}>
          <strong>{attentionCount}</strong> need you
        </span>
        <span className={reviewCount > 0 ? "fleetstats__review" : ""}>
          <strong>{reviewCount}</strong> review
        </span>
        <span>
          <strong>{idleCount}</strong> idle
        </span>
        {stoppedCount > 0 && (
          <span>
            <strong>{stoppedCount}</strong> stopped
          </span>
        )}
      </div>

      <div className="fleetfilters" aria-label="fleet filters">
        <input
          type="search"
          aria-label="search fleet"
          placeholder="Search tasks, branches, or recent output…"
          value={query}
          onChange={(event) => {
            clearSelection();
            setQuery(event.currentTarget.value);
          }}
        />
        <select
          aria-label="filter by project"
          value={projectFilter}
          onChange={(event) => {
            clearSelection();
            setProjectFilter(event.currentTarget.value);
          }}
        >
          <option value="all">All projects</option>
          {projects.map((project) => (
            <option key={project.path} value={project.path}>
              {project.name}
            </option>
          ))}
        </select>
        <select
          aria-label="filter by status"
          value={statusFilter}
          onChange={(event) => {
            clearSelection();
            setStatusFilter(event.currentTarget.value);
          }}
        >
          <option value="all">All statuses</option>
          <option value="working">Working</option>
          <option value="attention">Needs attention</option>
          <option value="review">Review and land</option>
          <option value="available">Idle or stopped</option>
          <option value="landed">Landed</option>
        </select>
        {(query || projectFilter !== "all" || statusFilter !== "all") && (
          <button
            type="button"
            className="pane__action"
            onClick={() => {
              clearSelection();
              setQuery("");
              setProjectFilter("all");
              setStatusFilter("all");
            }}
          >
            Clear filters
          </button>
        )}
      </div>

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
        </div>
      )}

      {note && (
        <div className="fleetgrid__notice" role="status">
          {note}
          <button
            type="button"
            onClick={() => setNote("")}
            aria-label="dismiss notice"
          >
            ×
          </button>
        </div>
      )}

      {order.length === 0 ? (
        <p className="muted fleetgrid__empty">
          No sessions yet. Start one to see it here.
        </p>
      ) : visibleOrder.length === 0 ? (
        <p className="muted fleetgrid__empty">
          No sessions match these filters.
        </p>
      ) : (
        <div className="fleetgrid__groups">
          {groups.map((group) => (
            <section
              key={group.key}
              className="fleetgroup"
              aria-labelledby={`fleetgroup-${group.key}`}
            >
              <div className="fleetgroup__heading">
                <h2 id={`fleetgroup-${group.key}`}>{group.label}</h2>
                <span>
                  {group.ids.length}{" "}
                  {group.ids.length === 1 ? "session" : "sessions"}
                </span>
              </div>
              <div className="fleetgrid__cards">
                {group.ids.map((id) => (
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
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
