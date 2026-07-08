import { useRef, useState } from "react";
import type { CheckResult, MergePreview } from "./lib/bindings";
import DiffView from "./DiffView";
import {
  confirmDialog,
  workspaceCheck,
  workspaceDiff,
  workspaceMerge,
  workspaceMergePreview,
  workspaceOpenPr,
} from "./lib/ipc";

/** Review, checks, and merge/PR for a workspace-bound session. Merge is gated
 * on a green check run and a clean pre-merge conflict check. */
export default function ReviewPanel({ sessionId }: { sessionId: string }) {
  const [diff, setDiff] = useState<string | null>(null);
  const [script, setScript] = useState("");
  const [check, setCheck] = useState<CheckResult | null>(null);
  const [preview, setPreview] = useState<MergePreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  // Synchronous guard against a double-click re-entering merge() before the
  // `busy` state (and thus the disabled button) has re-rendered.
  const merging = useRef(false);

  const checksPassed = check?.success === true;
  const hasConflicts = preview?.clean === false;

  async function run<T>(fn: () => Promise<T>, after?: (v: T) => void) {
    try {
      setError("");
      setBusy(true);
      const v = await fn();
      after?.(v);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  // Non-mutating pre-merge check. Run lazily when the panel opens and before a
  // merge, so the user is warned about conflicts before touching the base.
  async function refreshPreview(): Promise<MergePreview | null> {
    try {
      const p = await workspaceMergePreview(sessionId);
      setPreview(p);
      return p;
    } catch (e) {
      setError(String(e));
      return null;
    }
  }

  async function merge() {
    if (!checksPassed || merging.current) return;
    // Hold the in-flight guard across the *entire* flow — including the
    // pre-merge conflict check and the confirm dialog — so the Merge button is
    // disabled the moment merging starts. Previously `busy` was only set inside
    // the final `run()`, leaving the button clickable during the preview
    // round-trip and letting a double-click launch two full merge flows.
    merging.current = true;
    setBusy(true);
    setError("");
    try {
      // Always re-check for conflicts right before merging, and fail *closed*:
      // a stale cached preview or a failed conflict check must never let a
      // merge through into the base branch.
      const p = await refreshPreview();
      if (!p) {
        setError(
          "Could not verify merge safety — the conflict check failed. Merge aborted.",
        );
        return;
      }
      if (!p.clean) {
        setError(
          `Merge would conflict in: ${p.conflictedFiles.join(", ") || "unknown files"}. Resolve before merging.`,
        );
        return;
      }
      const ok = await confirmDialog(
        "Merge this workspace branch into the base branch?",
        "Merge workspace",
      );
      if (!ok) return;
      await workspaceMerge(sessionId);
      setNote("Merged into the base branch.");
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
      merging.current = false;
    }
  }

  return (
    <details
      className="review"
      onToggle={(e) => {
        // Fetch the conflict preview the first time the panel is opened.
        if ((e.currentTarget as HTMLDetailsElement).open && preview === null) {
          void refreshPreview();
        }
      }}
    >
      <summary>Review &amp; merge</summary>

      <div className="review__actions">
        <button
          type="button"
          className="pane__action"
          disabled={busy}
          onClick={() => void run(() => workspaceDiff(sessionId), setDiff)}
        >
          Show diff
        </button>
      </div>

      {diff !== null && (
        <div className="review__diff-wrap" aria-label="diff">
          {diff.trim() === "" ? (
            <p className="muted">(no committed changes vs base)</p>
          ) : (
            <DiffView patch={diff} />
          )}
        </div>
      )}

      <form
        className="review__checks"
        onSubmit={(e) => {
          e.preventDefault();
          if (!script.trim()) return;
          void run(() => workspaceCheck(sessionId, script), setCheck);
        }}
      >
        <input
          aria-label="check script"
          placeholder="Check script (e.g. cargo test, bun run test)"
          value={script}
          onChange={(e) => setScript(e.currentTarget.value)}
        />
        <button type="submit" disabled={busy}>
          Run checks
        </button>
      </form>

      {check && (
        <div
          className={`review__result review__result--${check.success ? "ok" : "fail"}`}
        >
          <p aria-label="check result">
            {check.success
              ? "✓ Checks passed"
              : `✕ Checks failed (exit ${check.exitCode})`}
          </p>
          {(check.stdout || check.stderr) && (
            <pre className="review__output">{check.stdout + check.stderr}</pre>
          )}
        </div>
      )}

      {hasConflicts && (
        <div className="review__conflict" role="alert">
          <p>
            <strong>⚠ Merge conflict predicted.</strong> These files would
            conflict when merging into the base branch:
          </p>
          <ul>
            {preview!.conflictedFiles.map((f) => (
              <li key={f}>
                <code>{f}</code>
              </li>
            ))}
          </ul>
        </div>
      )}
      {preview?.clean && (
        <p className="review__clean muted">✓ Merges cleanly into the base.</p>
      )}

      <div className="review__actions">
        <button
          type="button"
          className="pane__action"
          disabled={busy || !checksPassed || hasConflicts}
          title={
            !checksPassed
              ? "Run checks (green) to enable merge"
              : hasConflicts
                ? "Resolve predicted conflicts before merging"
                : ""
          }
          onClick={() => void merge()}
        >
          Merge
        </button>
        <button
          type="button"
          className="pane__action"
          disabled={busy}
          onClick={() =>
            void run(
              () => workspaceOpenPr(sessionId),
              (url) => setNote(url ? `PR: ${url}` : "PR opened."),
            )
          }
        >
          Open PR
        </button>
      </div>

      {!checksPassed && (
        <p className="muted">Merge is enabled once checks pass.</p>
      )}
      {note && <p className="muted">{note}</p>}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
    </details>
  );
}
