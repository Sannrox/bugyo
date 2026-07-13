import { useEffect, useMemo, useRef, useState } from "react";
import {
  Archive,
  CheckCircle2,
  CircleAlert,
  FileDiff,
  GitCommitHorizontal,
  Info,
  Maximize2,
  Minimize2,
  RefreshCw,
  Upload,
  X,
} from "lucide-react";
import type {
  CheckResult,
  ReviewStage,
  WorkspaceReviewState,
} from "./lib/bindings";
import DiffView from "./DiffView";
import { parseUnifiedDiff } from "./lib/diff";
import {
  confirmDialog,
  workspaceArchive,
  workspaceCheck,
  workspaceCommit,
  workspaceDiff,
  workspacePush,
  workspaceReviewState,
} from "./lib/ipc";
import { useFleet } from "./lib/fleetStore";

const STAGE_LABEL: Record<ReviewStage, string> = {
  active: "In progress",
  needsReview: "Needs review",
  readyToLand: "Ready to land",
  pushed: "Pushed",
};

/** Codex-style review inspector: changes + verification evidence + landing. */
export default function ReviewPanel({
  sessionId,
  onClose,
  expanded = false,
  onToggleExpanded,
  fixture,
}: {
  sessionId: string;
  onClose?: () => void;
  expanded?: boolean;
  onToggleExpanded?: () => void;
  fixture?: { review: WorkspaceReviewState; diff: string };
}) {
  const storedReview = useFleet(
    (state) => state.sessions[sessionId]?.review ?? null,
  );
  const defaultCheckScript = useFleet((state) => {
    const repoRoot = state.sessions[sessionId]?.workspace?.repoRoot;
    return (
      state.projects.find((project) => project.path === repoRoot)
        ?.checkScript ?? ""
    );
  });
  const setStoredReview = useFleet((state) => state.setReview);
  const removeSession = useFleet((state) => state.removeSession);
  const openSettings = useFleet((state) => state.openSettings);
  const commitMessage = useFleet((state) => {
    const workspace = state.sessions[sessionId]?.workspace;
    return workspace?.task || workspace?.branch || "Bugyo workspace changes";
  });
  const [review, setReview] = useState<WorkspaceReviewState | null>(
    fixture?.review ?? storedReview,
  );
  const [diff, setDiff] = useState<string | null>(fixture?.diff ?? null);
  const [check, setCheck] = useState<CheckResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const pushing = useRef(false);
  const archiving = useRef(false);

  const files = useMemo(() => parseUnifiedDiff(diff ?? ""), [diff]);
  const additions = files.reduce((total, file) => total + file.additions, 0);
  const deletions = files.reduce((total, file) => total + file.deletions, 0);
  const checkScript = review?.lastCheck?.script || defaultCheckScript;
  const ready = review?.stage === "readyToLand";
  const landed = review?.stage === "pushed";

  async function refresh(): Promise<WorkspaceReviewState | null> {
    try {
      const next = await workspaceReviewState(sessionId);
      setReview(next);
      setStoredReview(sessionId, next);
      return next;
    } catch (cause) {
      setError(String(cause));
      return null;
    }
  }

  async function loadDiff() {
    try {
      setBusy(true);
      setError("");
      setDiff(await workspaceDiff(sessionId));
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    if (fixture) return;
    let active = true;
    Promise.all([workspaceReviewState(sessionId), workspaceDiff(sessionId)])
      .then(([next, patch]) => {
        if (!active) return;
        setReview(next);
        setStoredReview(sessionId, next);
        setDiff(patch);
      })
      .catch((cause) => {
        if (active) setError(String(cause));
      });
    return () => {
      active = false;
    };
  }, [fixture, sessionId, setStoredReview]);

  async function rerunChecks() {
    if (!checkScript.trim()) return;
    try {
      setBusy(true);
      setError("");
      setNote("");
      setCheck(await workspaceCheck(sessionId, checkScript.trim()));
      await refresh();
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBusy(false);
    }
  }

  async function push() {
    if (pushing.current || !ready) return;
    pushing.current = true;
    setBusy(true);
    setError("");
    try {
      await workspacePush(sessionId);
      await refresh();
      setNote("Pushed to origin. The workspace can be archived.");
    } catch (cause) {
      setError(String(cause));
    } finally {
      pushing.current = false;
      setBusy(false);
    }
  }

  async function commitChanges() {
    if (!review?.hasUncommittedChanges) return;
    try {
      setBusy(true);
      setError("");
      await workspaceCommit(sessionId, commitMessage);
      await Promise.all([refresh(), loadDiff()]);
      setNote("Reviewed changes committed. The workspace is ready to push.");
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBusy(false);
    }
  }

  async function archive() {
    if (archiving.current) return;
    archiving.current = true;
    setBusy(true);
    setError("");
    try {
      const ok = await confirmDialog(
        "Archive this workspace? Bugyo removes its local worktree. A branch already merged into its base is deleted; an unmerged branch (e.g. one you pushed for review) is retained.",
        "Archive workspace",
      );
      if (!ok) return;
      await workspaceArchive(sessionId, false);
      removeSession(sessionId);
    } catch (cause) {
      setError(String(cause));
    } finally {
      archiving.current = false;
      setBusy(false);
    }
  }

  function focusFile(index: number) {
    const element = document.getElementById(`diff-file-${index}`);
    if (element instanceof HTMLDetailsElement) element.open = true;
    element?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  // Verification is the agent's responsibility (its own tooling, or a Kiro hook
  // the user configures) — the harness never runs or grades checks, and none of
  // this blocks committing or landing. Any recorded check is surfaced purely as
  // informational evidence; the human is the final gate.
  const verification = review?.lastCheck
    ? review.lastCheck.success
      ? {
          kind: "passed",
          title: "Checks passed",
          body: "The most recent recorded check run succeeded.",
        }
      : {
          kind: "failed",
          title: "Checks failed",
          body: "The most recent recorded check run failed. This is evidence, not a gate — landing is your call.",
        }
    : {
        kind: "none",
        title: "No checks recorded",
        body: checkScript
          ? "The agent verifies its own work. Run the project check here if you want your own evidence — it won't block landing."
          : "The agent verifies its own work. Optionally configure a project check command for one-click evidence here.",
      };

  return (
    <section className="review-inspector" aria-label="workspace review">
      <header className="review-inspector__header">
        <div className="review-inspector__title">
          <FileDiff size={15} aria-hidden />
          <strong>Review</strong>
          <span
            className={`review-flow__stage review-flow__stage--${review?.stage ?? "active"}`}
          >
            {review ? STAGE_LABEL[review.stage] : "Loading…"}
          </span>
        </div>
        <div className="review-inspector__header-actions">
          {onToggleExpanded && (
            <button
              type="button"
              className="review-inspector__icon-button"
              aria-label={expanded ? "restore split review" : "expand review"}
              title={expanded ? "Restore split review" : "Expand review"}
              onClick={onToggleExpanded}
            >
              {expanded ? (
                <Minimize2 size={14} aria-hidden />
              ) : (
                <Maximize2 size={14} aria-hidden />
              )}
            </button>
          )}
          <button
            type="button"
            className="review-inspector__icon-button"
            aria-label="refresh review"
            title="Refresh changes and status"
            disabled={busy}
            onClick={() => {
              void loadDiff();
              void refresh();
            }}
          >
            <RefreshCw size={14} aria-hidden />
          </button>
          {onClose && (
            <button
              type="button"
              className="review-inspector__icon-button"
              aria-label="close review"
              onClick={onClose}
            >
              <X size={15} aria-hidden />
            </button>
          )}
        </div>
      </header>

      <div className="review-inspector__scroll">
        <details className="review-summary" open>
          <summary>
            <span>
              {review?.changedFiles.length ?? files.length} file
              {(review?.changedFiles.length ?? files.length) === 1
                ? ""
                : "s"}{" "}
              changed
            </span>
            <span className="review-summary__totals">
              <span className="diff__add">+{additions}</span>{" "}
              <span className="diff__del">−{deletions}</span>
            </span>
          </summary>
          <div className="review-summary__files">
            {(files.length > 0
              ? files.map((file) => file.path)
              : (review?.changedFiles ?? [])
            ).map((path, index) => {
              const file = files[index];
              return (
                <button
                  type="button"
                  key={`${path}-${index}`}
                  onClick={() => focusFile(index)}
                >
                  <span>{path}</span>
                  {file && (
                    <span>
                      <span className="diff__add">+{file.additions}</span>{" "}
                      <span className="diff__del">−{file.deletions}</span>
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </details>

        <section
          className={`review-verification review-verification--${verification.kind}`}
          aria-label="verification evidence"
        >
          {verification.kind === "passed" ? (
            <CheckCircle2 size={17} aria-hidden />
          ) : verification.kind === "failed" ? (
            <CircleAlert size={17} aria-hidden />
          ) : (
            <Info size={17} aria-hidden />
          )}
          <div>
            <strong>{verification.title}</strong>
            <p>{verification.body}</p>
            {checkScript && <code>{checkScript}</code>}
            {review?.lastCheck && (
              <span className="review-verification__meta">
                exit {review.lastCheck.exitCode} ·{" "}
                {new Date(review.lastCheck.completedAt).toLocaleString()}
              </span>
            )}
          </div>
          {checkScript && (
            <button
              type="button"
              className="pane__action"
              disabled={busy}
              onClick={() => void rerunChecks()}
            >
              {busy ? "Running…" : review?.lastCheck ? "Rerun" : "Run checks"}
            </button>
          )}
          {!checkScript && (
            <button
              type="button"
              className="pane__action"
              onClick={() => openSettings()}
            >
              Configure checks
            </button>
          )}
        </section>

        {diff === null ? (
          <p className="muted review-inspector__loading">Loading changes…</p>
        ) : diff.trim() ? (
          <DiffView patch={diff} />
        ) : (
          <p className="muted review-inspector__loading">
            No workspace changes versus the base branch.
          </p>
        )}

        {check && (check.stdout || check.stderr) && (
          <details
            className={`review__result review__result--${check.success ? "ok" : "fail"}`}
          >
            <summary>
              {check.success
                ? "Check output"
                : `Check failed (exit ${check.exitCode})`}
            </summary>
            <pre className="review__output">{check.stdout + check.stderr}</pre>
          </details>
        )}

        {review?.stage === "active" && (
          <details className="review-inspector__archive">
            <summary>Workspace actions</summary>
            <button
              type="button"
              className="pane__action pane__action--danger"
              disabled={busy}
              onClick={() => void archive()}
            >
              <Archive size={14} aria-hidden /> Archive workspace
            </button>
          </details>
        )}

        {note && <p className="review-flow__note">{note}</p>}
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
      </div>

      <footer className="review-inspector__landing">
        <div>
          <strong>
            {review?.stage === "pushed"
              ? "Pushed to origin"
              : ready
                ? "Ready to push"
                : review?.hasUncommittedChanges
                  ? "Commit your changes"
                  : "No changes yet"}
          </strong>
          <span>
            {review?.stage === "pushed"
              ? "The branch is on origin. Archive this workspace to clean up its worktree."
              : review?.hasUncommittedChanges
                ? "Commit the reviewed changes, then push the branch to origin."
                : ready
                  ? "Review the diff, then push the branch to origin."
                  : "Nothing to push until the agent makes changes."}
          </span>
        </div>
        <div className="review-inspector__landing-actions">
          {landed ? (
            <button
              type="button"
              className="review-flow__primary"
              disabled={busy}
              onClick={() => void archive()}
            >
              <Archive size={14} aria-hidden /> Archive workspace
            </button>
          ) : review?.hasUncommittedChanges ? (
            <button
              type="button"
              className="review-flow__primary"
              disabled={busy}
              onClick={() => void commitChanges()}
            >
              <GitCommitHorizontal size={14} aria-hidden /> Commit changes
            </button>
          ) : (
            <button
              type="button"
              className="review-flow__primary"
              disabled={busy || !ready}
              onClick={() => void push()}
            >
              <Upload size={14} aria-hidden /> Push
            </button>
          )}
        </div>
      </footer>
    </section>
  );
}
