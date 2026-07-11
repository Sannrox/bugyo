import { useEffect, useRef, useState } from "react";
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
  orchEnqueue,
  workspaceCheck,
  workspaceReviewState,
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
import Plugins from "./Plugins";

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
  const setReview = useFleet((s) => s.setReview);
  const errors = useFleet((s) => s.errors);
  const dismissError = useFleet((s) => s.dismissError);
  const reportError = useFleet((s) => s.reportError);
  const [hydrationVersion, setHydrationVersion] = useState(0);
  const [hydrationFailed, setHydrationFailed] = useState(false);
  const verifying = useRef(new Set<string>());
  const autoFixAttempts = useRef(new Map<string, number>());
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
      } else if ((e.metaKey || e.ctrlKey) && (e.key === "f" || e.key === "F")) {
        // ⌘F / Ctrl-F is the expected desktop search gesture. ⌘⇧F remains
        // compatible because it satisfies the same condition.
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
    const track = (label: string, p: Promise<UnlistenFn>) =>
      p
        .then((fn) => {
          if (active) unlisteners.push(fn);
          else fn();
        })
        .catch((cause) => {
          if (active)
            reportError(`Unable to subscribe to ${label}: ${String(cause)}`);
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

    const verifyAfterTurn = async (sessionId: string) => {
      if (verifying.current.has(sessionId)) return;
      verifying.current.add(sessionId);
      try {
        const review = await workspaceReviewState(sessionId);
        if (active) setReview(sessionId, review);
        if (review.stage !== "needsReview" || !review.hasChanges) return;

        const fleet = useFleet.getState();
        const session = fleet.sessions[sessionId];
        const script = fleet.projects.find(
          (project) => project.path === session?.workspace?.repoRoot,
        )?.checkScript;
        if (!script?.trim()) return;

        const result = await workspaceCheck(sessionId, script.trim());
        const checked = await workspaceReviewState(sessionId);
        if (active) setReview(sessionId, checked);
        if (result.success) {
          autoFixAttempts.current.delete(sessionId);
          return;
        }

        const attempts = autoFixAttempts.current.get(sessionId) ?? 0;
        if (attempts >= 2) {
          void notify(
            "Agent verification needs attention",
            `Checks still fail for ${session?.workspace?.task || sessionId}.`,
          );
          return;
        }
        autoFixAttempts.current.set(sessionId, attempts + 1);
        const output = `${result.stdout}\n${result.stderr}`.trim().slice(-6000);
        await orchEnqueue(
          sessionId,
          `Bugyo ran the configured verification command:\n\n${script.trim()}\n\nIt failed with exit ${result.exitCode}. Fix the root cause, run the relevant checks yourself, and keep iterating until they pass.\n\nFailure output:\n${output || "(no output)"}`,
        );
      } catch {
        // Plain sessions have no workspace review state. Verification command
        // failures are persisted and surfaced by the review inspector.
      } finally {
        verifying.current.delete(sessionId);
      }
    };

    void track(
      "agent events",
      onAcpEvent((event) => {
        // Backend errors have no session id; surface them immediately as an OS
        // notification (they're also collected into the in-app banner via
        // applyEvents) so a failure isn't silently swallowed.
        if (event.type === "error") {
          void notify("Backend error", event.message);
        }
        // A completed turn may have changed files. Resolve the backend-owned
        // lifecycle immediately so the fleet shows "Needs review" without the
        // user first opening the review panel.
        if (
          event.type === "status" &&
          event.status === "idle" &&
          event.sessionId
        ) {
          void verifyAfterTurn(event.sessionId);
        }
        buffer.push(event);
        schedule();
      }),
    );
    void track(
      "queue updates",
      onOrchQueue((u) => setQueued(u.sessionId, u.queued)),
    );
    void track(
      "heartbeat updates",
      onOrchHeartbeat((r) => setHeartbeat(r)),
    );
    void track(
      "automation runs",
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
  }, [applyEvents, reportError, setQueued, setHeartbeat, setReview]);

  // Reconcile with any sessions the backend already holds (e.g. after reload).
  useEffect(() => {
    acpListSessions()
      .then((sessions) => {
        for (const info of sessions) {
          addSession({
            sessionId: info.sessionId,
            workspace: info.workspace,
            review: info.review,
            connected: info.connected,
            queued: info.queued,
            repoRoot: info.workspace ? info.workspace.repoRoot : info.repo,
          });
        }
        // Apply durable pin/name/order once the sessions exist in the store.
        return hydrateSessionMeta().catch((cause) => {
          setHydrationFailed(true);
          reportError(
            `Unable to load session names and ordering: ${String(cause)}`,
          );
        });
      })
      .catch((cause) => {
        setHydrationFailed(true);
        reportError(`Unable to restore sessions: ${String(cause)}`);
      });
  }, [addSession, hydrationVersion, reportError]);

  // Load the registered projects.
  useEffect(() => {
    projectList()
      .then(setProjects)
      .catch((cause) => {
        setHydrationFailed(true);
        reportError(`Unable to load projects: ${String(cause)}`);
      });
  }, [hydrationVersion, reportError, setProjects]);

  // Load budget caps so sessions can be flagged near/over their limit.
  useEffect(() => {
    budgetGet()
      .then((c) => useBudget.getState().setConfig(c))
      .catch((cause) => {
        setHydrationFailed(true);
        reportError(`Unable to load budget caps: ${String(cause)}`);
      });
  }, [hydrationVersion, reportError]);

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
        {hydrationFailed && (
          <div className="startup-retry" role="status">
            <span>Some startup data could not be loaded.</span>
            <button
              type="button"
              onClick={() => {
                setHydrationFailed(false);
                setHydrationVersion((version) => version + 1);
              }}
            >
              Retry startup loads
            </button>
          </div>
        )}
        {panel === "inbox" ? (
          <Inbox />
        ) : panel === "automations" ? (
          <Automations />
        ) : panel === "settings" ? (
          <Settings />
        ) : panel === "plugins" ? (
          <Plugins />
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
