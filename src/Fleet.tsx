import { useEffect, useState } from "react";
import type { UnlistenFn } from "@tauri-apps/api/event";
import type { AcpEvent } from "./lib/bindings";
import {
  acpListSessions,
  onAcpEvent,
  onAutomationRun,
  onOrchHeartbeat,
  onOrchQueue,
  notify,
  projectList,
  setAttentionBadge,
  budgetGet,
} from "./lib/ipc";
import { useFleet } from "./lib/fleetStore";
import { useBudget } from "./lib/budgetStore";
import { useSettings } from "./lib/settingsStore";
import { hydrateSessionMeta } from "./lib/sessionMeta";
import Sidebar from "./Sidebar";
import SessionPane from "./SessionPane";
import NewSessionForm from "./NewSessionForm";
import Inbox from "./Inbox";
import Automations from "./Automations";
import Settings from "./Settings";
import FleetGrid from "./FleetGrid";
import CommandPalette from "./CommandPalette";
import SearchPanel from "./SearchPanel";
import StatusBar from "./StatusBar";
import Timeline from "./Timeline";
import UpdateBanner from "./UpdateBanner";

export default function Fleet() {
  const activeId = useFleet((s) => s.activeId);
  const secondaryId = useFleet((s) => s.secondaryId);
  const panel = useFleet((s) => s.panel);
  const sidebarCollapsed = useSettings((s) => s.sidebarCollapsed);
  const applyEvents = useFleet((s) => s.applyEvents);
  const addSession = useFleet((s) => s.addSession);
  const setQueued = useFleet((s) => s.setQueued);
  const setHeartbeat = useFleet((s) => s.setHeartbeat);
  const setProjects = useFleet((s) => s.setProjects);
  const errors = useFleet((s) => s.errors);
  const dismissError = useFleet((s) => s.dismissError);
  // Mirror the attention count to the OS dock/taskbar badge.
  const attentionCount = useFleet(
    (s) =>
      Object.values(s.sessions).filter(
        (x) => x.state.status === "needsApproval" || x.state.status === "error",
      ).length,
  );
  useEffect(() => {
    void setAttentionBadge(attentionCount).catch(() => {});
  }, [attentionCount]);

  // ⌘K / Ctrl-K opens the command palette.
  const [paletteOpen, setPaletteOpen] = useState(false);
  const openSearch = useFleet((s) => s.openSearch);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === "k" || e.key === "K")) {
        e.preventDefault();
        setPaletteOpen((v) => !v);
      } else if (
        (e.metaKey || e.ctrlKey) &&
        e.shiftKey &&
        (e.key === "f" || e.key === "F")
      ) {
        // ⌘⇧F / Ctrl-Shift-F opens cross-session transcript search.
        e.preventDefault();
        openSearch();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [openSearch]);

  // Subscriptions to the backend event streams (routed by session id).
  useEffect(() => {
    let active = true;
    const unlisteners: UnlistenFn[] = [];
    const track = (p: Promise<UnlistenFn>) =>
      p.then((fn) => {
        if (active) unlisteners.push(fn);
        else fn();
      });

    // Coalesce high-frequency `session/update` events: buffer them and commit
    // once per animation frame (microtask fallback in non-DOM/test env) so a
    // fast multi-session stream doesn't thrash the store (see AGENTS.md).
    let buffer: AcpEvent[] = [];
    let scheduled = false;
    const flush = () => {
      scheduled = false;
      if (buffer.length === 0) return;
      const batch = buffer;
      buffer = [];
      applyEvents(batch);
    };
    const schedule = () => {
      if (scheduled) return;
      scheduled = true;
      if (typeof requestAnimationFrame === "function") {
        requestAnimationFrame(flush);
      } else {
        queueMicrotask(flush);
      }
    };

    void track(
      onAcpEvent((event) => {
        // Backend errors have no session id; surface them immediately as an OS
        // notification (they're also collected into the in-app banner via
        // applyEvents) so a failure isn't silently swallowed.
        if (event.type === "error") {
          void notify("Backend error", event.message);
        }
        buffer.push(event);
        schedule();
      }),
    );
    void track(onOrchQueue((u) => setQueued(u.sessionId, u.queued)));
    void track(onOrchHeartbeat((r) => setHeartbeat(r)));
    void track(
      onAutomationRun((run) => {
        void notify(
          run.status === "error" ? "Automation failed" : "Automation ran",
          run.status === "error"
            ? (run.message ?? "unknown error")
            : `${run.status}${run.sessionId ? ` · ${run.sessionId.slice(0, 8)}` : ""}`,
        );
      }),
    );

    return () => {
      active = false;
      flush(); // commit any buffered events before tearing down
      unlisteners.forEach((fn) => fn());
    };
  }, [applyEvents, setQueued, setHeartbeat]);

  // Reconcile with any sessions the backend already holds (e.g. after reload).
  useEffect(() => {
    acpListSessions()
      .then((sessions) => {
        for (const info of sessions) {
          addSession({
            sessionId: info.sessionId,
            workspace: info.workspace,
            queued: info.queued,
            repoRoot: info.workspace ? info.workspace.repoRoot : info.repo,
          });
        }
        // Apply durable pin/name/order once the sessions exist in the store.
        return hydrateSessionMeta();
      })
      .catch(() => {
        /* best-effort reconciliation */
      });
  }, [addSession]);

  // Load the registered projects.
  useEffect(() => {
    projectList()
      .then(setProjects)
      .catch(() => {
        /* best-effort */
      });
  }, [setProjects]);

  // Load budget caps so sessions can be flagged near/over their limit.
  useEffect(() => {
    budgetGet()
      .then((c) => useBudget.getState().setConfig(c))
      .catch(() => {
        /* best-effort */
      });
  }, []);

  return (
    <div
      className={`fleet${sidebarCollapsed ? " fleet--sidebar-collapsed" : ""}`}
    >
      <Sidebar />
      <main className="fleet__main">
        <UpdateBanner />
        {errors.length > 0 && (
          <div
            className="error-banner"
            role="alert"
            aria-label="backend errors"
          >
            {errors.map((msg, i) => (
              <div key={`${i}:${msg}`} className="error-banner__item">
                <span className="error-banner__msg">{msg}</span>
                <button
                  type="button"
                  className="error-banner__dismiss"
                  aria-label="dismiss error"
                  onClick={() => dismissError(i)}
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        )}
        {panel === "inbox" ? (
          <Inbox />
        ) : panel === "automations" ? (
          <Automations />
        ) : panel === "settings" ? (
          <Settings />
        ) : panel === "fleet" ? (
          <FleetGrid />
        ) : panel === "search" ? (
          <SearchPanel />
        ) : panel === "eventlog" ? (
          <Timeline />
        ) : activeId ? (
          secondaryId ? (
            <div className="panes">
              <div className="panes__col">
                <SessionPane sessionId={activeId} />
              </div>
              <div className="panes__col">
                <SessionPane sessionId={secondaryId} />
              </div>
            </div>
          ) : (
            <SessionPane sessionId={activeId} />
          )
        ) : (
          <NewSessionForm />
        )}
        <StatusBar />
      </main>
      {paletteOpen && <CommandPalette onClose={() => setPaletteOpen(false)} />}
    </div>
  );
}
