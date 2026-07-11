import { useEffect, useMemo, useRef, useState } from "react";
import {
  Archive,
  CheckCircle2,
  CircleAlert,
  FileDiff,
  GitCommitHorizontal,
  GitMerge,
  GitPullRequest,
  RefreshCw,
  X,
} from "lucide-react";
import type {
  CheckResult,
  MergePreview,
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
  workspaceMerge,
  workspaceMergePreview,
  workspaceOpenPr,
  workspaceReviewState,
} from "./lib/ipc";
import { useFleet } from "./lib/fleetStore";

const STAGE_LABEL: Record<ReviewStage, string> = {
  active: "In progress",
  needsReview: "Needs review",
  checksFailed: "Checks failed",
  readyToLand: "Ready to land",
  pullRequestOpen: "Pull request open",
  merged: "Merged",
};

/** Codex-style review inspector: changes + verification evidence + landing. */
export default function ReviewPanel({
  sessionId,
  onClose,
}: {
  sessionId: string;
  onClose?: () => void;
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
    storedReview,
  );
  const [diff, setDiff] = useState<string | null>(null);
  const [check, setCheck] = useState<CheckResult | null>(null);
  const [preview, setPreview] = useState<MergePreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const merging = useRef(false);
  const archiving = useRef(false);

  const files = useMemo(() => parseUnifiedDiff(diff ?? ""), [diff]);
  const additions = files.reduce((total, file) => total + file.additions, 0);
  const deletions = files.reduce((total, file) => total + file.deletions, 0);
  const checkScript = review?.lastCheck?.script || defaultCheckScript;
  const ready = review?.stage === "readyToLand";
  const landed =
    review?.stage === "merged" || review?.stage === "pullRequestOpen";
  const landingBlocked =
    !ready || review?.hasUncommittedChanges || preview?.clean === false;

  async function refresh(): Promise<WorkspaceReviewState | null> {
    try {
      const next = await workspaceReviewState(sessionId);
      setReview(next);
      setStoredReview(sessionId, next);
      if (next.hasChanges) {
        setPreview(await workspaceMergePreview(sessionId).catch(() => null));
      } else {
        setPreview(null);
      }
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
    let active = true;
    Promise.all([
      workspaceReviewState(sessionId),
      workspaceDiff(sessionId),
      workspaceMergePreview(sessionId).catch(() => null),
    ])
      .then(([next, patch, mergeState]) => {
        if (!active) return;
        setReview(next);
        setStoredReview(sessionId, next);
        setDiff(patch);
        setPreview(next.hasChanges ? mergeState : null);
      })
      .catch((cause) => {
        if (active) setError(String(cause));
      });
    return () => {
      active = false;
    };
  }, [sessionId, setStoredReview]);

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

  async function merge() {
    if (merging.current || landingBlocked) return;
    merging.current = true;
    setBusy(true);
    setError("");
    try {
      const mergeState = await workspaceMergePreview(sessionId);
      setPreview(mergeState);
      if (!mergeState.clean) {
        setError(
          `Merge would conflict in: ${mergeState.conflictedFiles.join(", ") || "unknown files"}.`,
        );
        return;
      }
      const ok = await confirmDialog(
        "Merge this verified workspace into its base branch?",
        "Merge workspace",
      );
      if (!ok) return;
      await workspaceMerge(sessionId);
      await refresh();
      setNote("Merged into the base branch. The workspace can be archived.");
    } catch (cause) {
      setError(String(cause));
    } finally {
      merging.current = false;
      setBusy(false);
    }
  }

  async function commitChanges() {
    if (!ready || !review?.hasUncommittedChanges) return;
    try {
      setBusy(true);
      setError("");
      await workspaceCommit(sessionId, commitMessage);
      await Promise.all([refresh(), loadDiff()]);
      setNote("Reviewed changes committed. The workspace is ready to land.");
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBusy(false);
    }
  }

  async function openPullRequest() {
    if (landingBlocked || !review?.hasChanges) return;
    try {
      setBusy(true);
      setError("");
      const url = await workspaceOpenPr(sessionId);
      await refresh();
      setNote(url ? `Pull request opened: ${url}` : "Pull request opened.");
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
        "Archive this workspace? Bugyo removes its local worktree. A safely merged branch is deleted; an unmerged pull-request branch is retained.",
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

  const verification =
    ready || (landed && review?.lastCheck?.success)
      ? {
          kind: "passed",
          title: "Checks passed",
          body: "Verified against the current workspace changes.",
        }
      : review?.stage === "checksFailed"
        ? {
            kind: "failed",
            title: "Checks failed",
            body: "The agent needs to fix the failure before this can land.",
          }
        : review?.lastCheck
          ? {
              kind: "stale",
              title: "Verification is outdated",
              body: "The workspace changed after the last check run.",
            }
          : {
              kind: "pending",
              title: "Agent verification pending",
              body: checkScript
                ? "The configured check should run before human review is complete."
                : "Configure a project check command so the agent can verify its work.",
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
          ) : (
            <CircleAlert size={17} aria-hidden />
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

        {preview?.clean === false && (
          <div className="review__conflict" role="alert">
            <strong>Merge conflict predicted</strong>
            <ul>
              {preview.conflictedFiles.map((file) => (
                <li key={file}>
                  <code>{file}</code>
                </li>
              ))}
            </ul>
          </div>
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
            {review?.stage === "merged"
              ? "Merged into the base branch"
              : review?.stage === "pullRequestOpen"
                ? "Pull request opened"
                : ready
                  ? "Ready for human review"
                  : verification.title}
          </strong>
          <span>
            {review?.stage === "merged"
              ? "The work is landed. Archive this workspace to clean up its worktree."
              : review?.stage === "pullRequestOpen"
                ? "Review continues in the pull request. The local worktree can now be archived."
                : review?.hasUncommittedChanges
                  ? "Commit outstanding changes before landing."
                  : preview?.clean === false
                    ? "Resolve conflicts before landing."
                    : ready
                      ? "Review the diff, then choose the outcome."
                      : "Landing unlocks after current checks pass."}
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
              disabled={busy || !ready}
              onClick={() => void commitChanges()}
            >
              <GitCommitHorizontal size={14} aria-hidden /> Commit changes
            </button>
          ) : (
            <>
              <button
                type="button"
                className="pane__action"
                disabled={busy || landingBlocked || !review?.hasChanges}
                onClick={() => void openPullRequest()}
              >
                <GitPullRequest size={14} aria-hidden /> Open PR
              </button>
              <button
                type="button"
                className="review-flow__primary"
                disabled={busy || landingBlocked}
                onClick={() => void merge()}
              >
                <GitMerge size={14} aria-hidden /> Merge
              </button>
            </>
          )}
        </div>
      </footer>
    </section>
  );
}
