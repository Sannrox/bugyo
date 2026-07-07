import { GitBranch, SquareTerminal } from "lucide-react";
import { acpRespondPermission } from "./lib/ipc";
import { useFleet } from "./lib/fleetStore";

/** Global "needs attention" view: sessions awaiting an approval decision or in
 * an error state, with inline approve/deny — so a paused agent never hides. */
export default function Inbox() {
  const sessions = useFleet((s) => s.sessions);
  const order = useFleet((s) => s.order);
  const setActive = useFleet((s) => s.setActive);

  const items = order
    .map((id) => sessions[id])
    .filter(
      (s) =>
        !!s &&
        (s.state.status === "needsApproval" || s.state.status === "error"),
    );

  async function respond(
    sessionId: string,
    requestId: string,
    optionId: string,
  ) {
    try {
      await acpRespondPermission(sessionId, requestId, optionId);
    } catch {
      /* surfaced in the session pane */
    }
  }

  return (
    <div className="inbox">
      <h1 className="inbox__title">Needs attention</h1>
      {items.length === 0 && (
        <p className="muted inbox__empty">
          Nothing needs your attention right now.
        </p>
      )}
      <ul className="inbox__list">
        {items.map((s) => {
          const label = s.workspace?.branch ?? "plain session";
          const Icon = s.workspace ? GitBranch : SquareTerminal;
          const perm = s.state.pendingPermission;
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
                        onClick={() =>
                          void respond(s.sessionId, perm.requestId, o.optionId)
                        }
                      >
                        {o.name}
                      </button>
                    ))}
                  </div>
                </div>
              ) : (
                <p role="alert" className="error">
                  Error — open the session to inspect.
                </p>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
