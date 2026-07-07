import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import {
  Activity,
  Archive,
  ChevronDown,
  ChevronUp,
  Clock,
  Folder,
  GitBranch,
  Inbox,
  LayoutGrid,
  MoreVertical,
  Pencil,
  Pin,
  PinOff,
  Plus,
  ScrollText,
  Settings as SettingsIcon,
  SplitSquareHorizontal,
  SquareTerminal,
  Trash2,
} from "lucide-react";
import {
  acpDeleteSession,
  confirmDialog,
  projectAdd,
  pickDirectory,
  messageDialog,
  workspaceArchive,
} from "./lib/ipc";
import { useFleet, type FleetStore } from "./lib/fleetStore";
import type { SessionState } from "./lib/session";
import { relativeTime } from "./lib/format";
import { persistMeta, persistOrder } from "./lib/sessionMeta";

const DOT_CLASS: Record<SessionState["status"], string> = {
  disconnected: "dot--disconnected",
  idle: "dot--idle",
  working: "dot--working",
  needsApproval: "dot--needsApproval",
  error: "dot--error",
};

const NO_REPO = "(no repository)";
const SEP = "\u0000";

function repoLabel(repoRoot: string): string {
  if (repoRoot === NO_REPO) return "Plain sessions";
  return repoRoot.split("/").filter(Boolean).pop() ?? repoRoot;
}

/** One session row; subscribes to its own slice so siblings don't re-render it. */
function SidebarItem({
  sessionId,
  now,
  renaming,
  onCommitRename,
  onCancelRename,
  onContext,
}: {
  sessionId: string;
  /** Shared clock (epoch-ms) so all rows recompute their age off one interval. */
  now: number;
  /** Whether this row is in inline-rename mode. */
  renaming: boolean;
  /** Commit a new custom name (empty clears it). */
  onCommitRename: (name: string) => void;
  /** Leave rename mode without changing the name. */
  onCancelRename: () => void;
  /** Open the row's action menu at viewport coords (x, y). */
  onContext: (sessionId: string, x: number, y: number) => void;
}) {
  const label = useFleet(
    (s) =>
      s.sessions[sessionId]?.name ??
      s.sessions[sessionId]?.workspace?.branch ??
      "plain session",
  );
  const pinned = useFleet((s) => s.sessions[sessionId]?.pinned ?? false);
  const isWorkspace = useFleet((s) => s.sessions[sessionId]?.workspace != null);
  const status = useFleet(
    (s) => s.sessions[sessionId]?.state.status ?? "disconnected",
  );
  const queued = useFleet((s) => s.sessions[sessionId]?.queued ?? 0);
  const lastActivity = useFleet(
    (s) => s.sessions[sessionId]?.lastActivity ?? 0,
  );
  const active = useFleet((s) => s.activeId === sessionId);
  const secondary = useFleet((s) => s.secondaryId === sessionId);
  const canSplit = useFleet(
    (s) => s.activeId != null && s.activeId !== sessionId,
  );
  const setActive = useFleet((s) => s.setActive);
  const openSplit = useFleet((s) => s.openSplit);

  const Icon = isWorkspace ? GitBranch : SquareTerminal;

  if (renaming) {
    return (
      <li className="sidebar__row">
        <input
          className="sidebar__rename"
          aria-label="rename session"
          autoFocus
          defaultValue={label}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              onCommitRename(e.currentTarget.value);
            } else if (e.key === "Escape") {
              e.preventDefault();
              onCancelRename();
            }
          }}
          onBlur={(e) => onCommitRename(e.currentTarget.value)}
        />
      </li>
    );
  }

  return (
    <li
      className="sidebar__row"
      onContextMenu={(e) => {
        e.preventDefault();
        onContext(sessionId, e.clientX, e.clientY);
      }}
    >
      <button
        type="button"
        className={`sidebar__item${active || secondary ? " sidebar__item--active" : ""}`}
        aria-current={active || secondary}
        onClick={() => setActive(sessionId)}
      >
        <Icon className="sidebar__icon" size={15} aria-hidden />
        {pinned && (
          <Pin className="sidebar__pin" size={11} aria-label="pinned" />
        )}
        <span className="sidebar__label">{label}</span>
        {secondary && (
          <span className="sidebar__split-tag" title="in split view">
            split
          </span>
        )}
        {queued > 0 && (
          <span className="badge badge--sm" aria-label={`${queued} queued`}>
            {queued}
          </span>
        )}
        {lastActivity > 0 && (
          <span
            className="sidebar__age"
            title={`Last active ${new Date(lastActivity).toLocaleString()}`}
          >
            {relativeTime(lastActivity, now)}
          </span>
        )}
        <span
          className={`dot ${DOT_CLASS[status]}`}
          aria-label={`status ${status}`}
          title={status}
        >
          ●
        </span>
      </button>
      {canSplit && !secondary && (
        <button
          type="button"
          className="sidebar__split-btn"
          onClick={() => openSplit(sessionId)}
          aria-label="open in split view"
          title="Open in split view"
        >
          <SplitSquareHorizontal size={13} aria-hidden />
        </button>
      )}
      <button
        type="button"
        className="sidebar__more"
        // Keyboard/click-reachable equivalent of the right-click menu: anchor
        // it to the button's bottom-right corner.
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          onContext(sessionId, r.right, r.bottom);
        }}
        aria-label="session actions"
        title="Session actions"
      >
        <MoreVertical size={13} aria-hidden />
      </button>
    </li>
  );
}

// Structural projection: `id\0repo\0label\0pinned`. `label` prefers the custom
// name (so search + display use it). Changes only on add/remove, workspace
// identity, rename, or pin — not on every streamed event.
const selectStructure = (s: FleetStore) =>
  s.order.map((id) => {
    const sess = s.sessions[id];
    const label = sess?.name ?? sess?.workspace?.branch ?? "plain session";
    const pinned = sess?.pinned ? "1" : "0";
    return `${id}${SEP}${sess?.repoRoot ?? NO_REPO}${SEP}${label}${SEP}${pinned}`;
  });

export default function Sidebar() {
  const structure = useFleet(useShallow(selectStructure));
  const projects = useFleet((s) => s.projects);
  const setActive = useFleet((s) => s.setActive);
  const openInbox = useFleet((s) => s.openInbox);
  const openAutomations = useFleet((s) => s.openAutomations);
  const openSettings = useFleet((s) => s.openSettings);
  const openEventLog = useFleet((s) => s.openEventLog);
  const openFleet = useFleet((s) => s.openFleet);
  const addProjectToStore = useFleet((s) => s.addProject);
  const removeSession = useFleet((s) => s.removeSession);
  const togglePin = useFleet((s) => s.togglePin);
  const renameSession = useFleet((s) => s.renameSession);
  const moveSession = useFleet((s) => s.moveSession);
  const attention = useFleet(
    (s) =>
      Object.values(s.sessions).filter(
        (x) => x.state.status === "needsApproval" || x.state.status === "error",
      ).length,
  );
  // Shared clock for relative "last active" labels — one interval for all rows.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);
  // Row action menu (right-click or the ⋯ button), anchored at viewport coords.
  const [menu, setMenu] = useState<{
    sessionId: string;
    x: number;
    y: number;
  } | null>(null);
  // Which row (if any) is in inline-rename mode.
  const [renamingId, setRenamingId] = useState<string | null>(null);

  const menuIsWorkspace = menu
    ? useFleet.getState().sessions[menu.sessionId]?.workspace != null
    : false;
  const menuPinned = menu
    ? (useFleet.getState().sessions[menu.sessionId]?.pinned ?? false)
    : false;

  function pin(sessionId: string) {
    setMenu(null);
    togglePin(sessionId);
    void persistMeta(sessionId).catch(() => {});
  }

  function move(sessionId: string, dir: "up" | "down") {
    setMenu(null);
    moveSession(sessionId, dir);
    void persistOrder().catch(() => {});
  }

  function commitRename(sessionId: string, name: string) {
    setRenamingId(null);
    renameSession(sessionId, name);
    void persistMeta(sessionId).catch(() => {});
  }

  async function deleteSession(sessionId: string) {
    setMenu(null);
    const ok = await confirmDialog(
      "Delete this session? It will be removed from the fleet. " +
        "(The kiro transcript on disk is kept.)",
      "Delete session",
    );
    if (!ok) return;
    try {
      await acpDeleteSession(sessionId);
      removeSession(sessionId);
    } catch (e) {
      await messageDialog(String(e));
    }
  }

  async function archiveWorkspace(sessionId: string) {
    setMenu(null);
    const ok = await confirmDialog(
      "Archive this workspace? This removes the git worktree and deletes its " +
        "branch. Uncommitted changes will be discarded.",
      "Archive workspace",
    );
    if (!ok) return;
    try {
      await workspaceArchive(sessionId, true);
      removeSession(sessionId);
    } catch (e) {
      await messageDialog(String(e));
    }
  }

  const q = "";

  // Sessions grouped by repo path.
  const byRepo = new Map<string, string[]>();
  const pinnedOf = new Map<string, boolean>();
  for (const entry of structure) {
    const [id, repo, label, pinnedFlag] = entry.split(SEP);
    pinnedOf.set(id, pinnedFlag === "1");
    const matches =
      !q ||
      label.toLowerCase().includes(q) ||
      repoLabel(repo).toLowerCase().includes(q);
    if (!matches) continue;
    const list = byRepo.get(repo) ?? [];
    list.push(id);
    byRepo.set(repo, list);
  }
  // Pinned sessions sort to the top of each group (stable within each subset).
  for (const ids of byRepo.values()) {
    ids.sort((a, b) => Number(pinnedOf.get(b)) - Number(pinnedOf.get(a)));
  }

  // Ordered groups: registered projects first (even when empty), then repos
  // with sessions that aren't registered, then plain sessions.
  const registered = new Set(projects.map((p) => p.path));
  const groups: { key: string; name: string; ids: string[] }[] = [];

  for (const p of projects) {
    const ids = byRepo.get(p.path) ?? [];
    if (!q || p.name.toLowerCase().includes(q) || ids.length > 0) {
      groups.push({ key: p.path, name: p.name, ids });
    }
  }
  for (const [repo, ids] of byRepo) {
    if (repo !== NO_REPO && !registered.has(repo)) {
      groups.push({ key: repo, name: repoLabel(repo), ids });
    }
  }
  if (byRepo.has(NO_REPO)) {
    groups.push({
      key: NO_REPO,
      name: "Plain sessions",
      ids: byRepo.get(NO_REPO)!,
    });
  }

  async function addProjectFlow() {
    try {
      const path = await pickDirectory("Select a repository");
      if (!path) return;
      addProjectToStore(await projectAdd(path));
    } catch (e) {
      await messageDialog(String(e));
    }
  }

  return (
    <nav className="sidebar" aria-label="workspaces">
      <button
        type="button"
        className="sidebar__new"
        onClick={() => setActive(null)}
      >
        <Plus size={16} aria-hidden /> New session
      </button>

      <button
        type="button"
        className="sidebar__new"
        onClick={() => openFleet()}
        aria-label="fleet overview"
      >
        <LayoutGrid size={16} aria-hidden /> Fleet
      </button>

      <button
        type="button"
        className="sidebar__new"
        onClick={() => openInbox()}
        aria-label="attention inbox"
      >
        <Inbox size={16} aria-hidden /> Attention
        {attention > 0 && (
          <span
            className="badge badge--attn"
            aria-label={`${attention} need attention`}
          >
            {attention}
          </span>
        )}
      </button>

      <button
        type="button"
        className="sidebar__new"
        onClick={() => openAutomations()}
        aria-label="automations"
      >
        <Clock size={16} aria-hidden /> Automations
      </button>

      <div className="sidebar__section">
        <span>Projects</span>
        <button
          type="button"
          className="sidebar__add"
          onClick={() => void addProjectFlow()}
          aria-label="add project"
          title="Add a project"
        >
          <Plus size={13} aria-hidden />
        </button>
      </div>

      <div className="sidebar__scroll">
        {groups.length === 0 && (
          <p className="muted sidebar__empty">
            No projects yet. Add one to get started.
          </p>
        )}
        {groups.map((g) => (
          <div key={g.key} className="sidebar__group">
            <h3 className="sidebar__project">
              <Folder size={14} aria-hidden />
              {g.name}
            </h3>
            {g.ids.length === 0 ? (
              <p className="muted sidebar__noworkspaces">No workspaces</p>
            ) : (
              <ul>
                {g.ids.map((id) => (
                  <SidebarItem
                    key={id}
                    sessionId={id}
                    now={now}
                    renaming={renamingId === id}
                    onCommitRename={(name) => commitRename(id, name)}
                    onCancelRename={() => setRenamingId(null)}
                    onContext={(sid, x, y) => setMenu({ sessionId: sid, x, y })}
                  />
                ))}
              </ul>
            )}
          </div>
        ))}
      </div>

      <ActivityFooter />

      <div className="sidebar__corner">
        <button
          type="button"
          className="sidebar__corner-btn"
          onClick={() => openEventLog()}
          aria-label="event log"
          title="Event log"
        >
          <ScrollText size={16} aria-hidden />
        </button>
        <button
          type="button"
          className="sidebar__corner-btn"
          onClick={() => openSettings()}
          aria-label="settings"
          title="Settings"
        >
          <SettingsIcon size={16} aria-hidden />
        </button>
      </div>

      {menu && (
        <SessionContextMenu
          x={menu.x}
          y={menu.y}
          isWorkspace={menuIsWorkspace}
          pinned={menuPinned}
          onPin={() => pin(menu.sessionId)}
          onRename={() => {
            const id = menu.sessionId;
            setMenu(null);
            setRenamingId(id);
          }}
          onMoveUp={() => move(menu.sessionId, "up")}
          onMoveDown={() => move(menu.sessionId, "down")}
          onDelete={() => void deleteSession(menu.sessionId)}
          onArchive={() => void archiveWorkspace(menu.sessionId)}
          onClose={() => setMenu(null)}
        />
      )}
    </nav>
  );
}

/**
 * A lightweight right-click / overflow action menu for a session row. Anchored
 * at viewport coords and clamped to stay on-screen; closes on outside click or
 * Escape. Destructive items still run through a confirm dialog before acting.
 */
function SessionContextMenu({
  x,
  y,
  isWorkspace,
  pinned,
  onPin,
  onRename,
  onMoveUp,
  onMoveDown,
  onDelete,
  onArchive,
  onClose,
}: {
  x: number;
  y: number;
  isWorkspace: boolean;
  pinned: boolean;
  onPin: () => void;
  onRename: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onDelete: () => void;
  onArchive: () => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLUListElement>(null);
  const [pos, setPos] = useState({ x, y });

  // Clamp inside the viewport and move keyboard focus to the first item.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const nx =
      x + r.width > window.innerWidth
        ? Math.max(4, window.innerWidth - r.width - 4)
        : x;
    const ny =
      y + r.height > window.innerHeight
        ? Math.max(4, window.innerHeight - r.height - 4)
        : y;
    setPos({ x: nx, y: ny });
    el.querySelector("button")?.focus();
  }, [x, y]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="ctxmenu__overlay"
      onClick={onClose}
      onContextMenu={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      <ul
        ref={ref}
        className="ctxmenu"
        role="menu"
        aria-label="session actions"
        style={{ top: pos.y, left: pos.x }}
        onClick={(e) => e.stopPropagation()}
      >
        <li role="none">
          <button
            type="button"
            role="menuitem"
            className="ctxmenu__item"
            onClick={onPin}
          >
            {pinned ? (
              <>
                <PinOff size={14} aria-hidden /> Unpin
              </>
            ) : (
              <>
                <Pin size={14} aria-hidden /> Pin
              </>
            )}
          </button>
        </li>
        <li role="none">
          <button
            type="button"
            role="menuitem"
            className="ctxmenu__item"
            onClick={onRename}
          >
            <Pencil size={14} aria-hidden /> Rename
          </button>
        </li>
        <li role="none">
          <button
            type="button"
            role="menuitem"
            className="ctxmenu__item"
            onClick={onMoveUp}
          >
            <ChevronUp size={14} aria-hidden /> Move up
          </button>
        </li>
        <li role="none">
          <button
            type="button"
            role="menuitem"
            className="ctxmenu__item"
            onClick={onMoveDown}
          >
            <ChevronDown size={14} aria-hidden /> Move down
          </button>
        </li>
        {isWorkspace && (
          <li role="none">
            <button
              type="button"
              role="menuitem"
              className="ctxmenu__item ctxmenu__item--danger"
              onClick={onArchive}
            >
              <Archive size={14} aria-hidden /> Archive workspace
            </button>
          </li>
        )}
        <li role="none">
          <button
            type="button"
            role="menuitem"
            className="ctxmenu__item ctxmenu__item--danger"
            onClick={onDelete}
          >
            <Trash2 size={14} aria-hidden /> Delete session
          </button>
        </li>
      </ul>
    </div>
  );
}

/** Live fleet activity summary: how many sessions are working/queued/idle. */
function ActivityFooter() {
  const activity = useFleet(
    useShallow((s) => {
      let working = 0;
      let idle = 0;
      let attention = 0;
      let queued = 0;
      for (const x of Object.values(s.sessions)) {
        queued += x.queued;
        if (x.state.status === "working") working += 1;
        else if (
          x.state.status === "needsApproval" ||
          x.state.status === "error"
        )
          attention += 1;
        else idle += 1;
      }
      return { total: s.order.length, working, idle, attention, queued };
    }),
  );

  return (
    <div className="sidebar__footer" aria-label="fleet activity">
      <h3 className="sidebar__section">
        <Activity size={13} aria-hidden /> Activity
      </h3>
      {activity.total === 0 ? (
        <p className="muted">No sessions yet.</p>
      ) : (
        <p className="muted">
          {activity.working} working · {activity.queued} queued ·{" "}
          {activity.idle} idle
          {activity.attention > 0 && (
            <> · {activity.attention} need attention</>
          )}
        </p>
      )}
    </div>
  );
}
