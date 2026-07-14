import { useState } from "react";
import { GitBranch, LayoutGrid, SquareTerminal } from "lucide-react";
import { acpRespondPermission } from "./lib/ipc";
import { useFleet } from "./lib/fleetStore";
import { effectiveStatus, needsAttention } from "./lib/review";

/** Global owner-action view: approvals, failures, and workspaces awaiting review. */
export default function Inbox() {
  const sessions = useFleet((s) => s.sessions);
  const order = useFleet((s) => s.order);
  const setActive = useFleet((s) => s.setActive);
  const openFleet = useFleet((s) => s.openFleet);
  const [responding, setResponding] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});

  const items = order
    .map((id) => sessions[id])
    .filter((s) => !!s && needsAttention(s.state.status, s.review));

  async function respond(
    sessionId: string,
    requestId: string,
    optionId: string,
  ) {
    const key = `${sessionId}:${requestId}`;
    setResponding((current) => ({ ...current, [key]: optionId }));
    setErrors((current) => {
      const next = { ...current };
      delete next[key];
      return next;
    });
    try {
      await acpRespondPermission(sessionId, requestId, optionId);
    } catch (cause) {
      setResponding((current) => {
        const next = { ...current };
        delete next[key];
        return next;
      });
      setErrors((current) => ({ ...current, [key]: String(cause) }));
    }
  }

  return (
    <div className="inbox">
      <h1 className="inbox__title">Needs attention</h1>
      {items.length === 0 && (
        <div className="inbox__empty">
          <strong>You’re all caught up</strong>
          <p className="muted">Nothing needs your attention right now.</p>
          <button type="button" className="pane__action" onClick={openFleet}>
            <LayoutGrid size={14} aria-hidden /> Open fleet
          </button>
        </div>
      )}
      <ul className="inbox__list">
        {items.map((s) => {
          const label =
            s.workspace?.task || s.workspace?.branch || "Plain session";
          const Icon = s.workspace ? GitBranch : SquareTerminal;
          const perm = s.state.pendingPermission;
          const responseKey = perm ? `${s.sessionId}:${perm.requestId}` : "";
          const sentOption = responding[responseKey];
          const decisionSent = Boolean(sentOption);
          const status = effectiveStatus(s.state.status, s.review);
          const needsReview =
            status === "needsReview" || status === "readyToLand";
          return (
            <li key={s.sessionId} className="inbox__item">
              <button
                type="button"
                className="inbox__go"
                onClick={() => setActive(s.sessionId)}
              >
                <Icon size={15} aria-hidden />
                <span className="sidebar__label">{label}</span>
                {s.repoRoot && (
                  <span className="muted inbox__repo">
                    {s.repoRoot.split("/").filter(Boolean).pop()}
                  </span>
                )}
              </button>

              {perm ? (
                <div className="inbox__perm">
                  <p className="inbox__ask">
                    <strong>Permission:</strong> {perm.title}
                  </p>
                  <div className="permission__actions">
                    {perm.options.map((o) => (
                      <button
                        key={o.optionId}
                        type="button"
                        className={`permission__btn permission__btn--${o.kind}`}
                        disabled={decisionSent}
                        onClick={() =>
                          void respond(s.sessionId, perm.requestId, o.optionId)
                        }
                      >
                        {sentOption === o.optionId ? "Decision sent…" : o.name}
                      </button>
                    ))}
                  </div>
                  {decisionSent && (
                    <p className="inbox__response-state" role="status">
                      Waiting for the agent to continue…
                    </p>
                  )}
                  {errors[responseKey] && (
                    <p className="error" role="alert">
                      {errors[responseKey]} — choose again to retry.
                    </p>
                  )}
                </div>
              ) : needsReview ? (
                <div className="inbox__review">
                  <strong>
                    {status === "readyToLand"
                      ? "Ready to land"
                      : "Review changes"}
                  </strong>
                  <p>
                    {status === "readyToLand"
                      ? "Verification passed. Review the result and choose whether to land it."
                      : "The workspace has changes waiting for your review."}
                  </p>
                  <button
                    type="button"
                    className="pane__action"
                    onClick={() => setActive(s.sessionId)}
                  >
                    Open review
                  </button>
                </div>
              ) : (
                <div className="inbox__error" role="alert">
                  <strong>Agent error</strong>
                  <p>
                    {s.state.lastError ?? "The session stopped unexpectedly."}
                  </p>
                  <button
                    type="button"
                    className="pane__action"
                    onClick={() => setActive(s.sessionId)}
                  >
                    Open session
                  </button>
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
