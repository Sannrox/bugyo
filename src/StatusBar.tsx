import { useShallow } from "zustand/react/shallow";
import { useFleet } from "./lib/fleetStore";
import { effectiveStatus } from "./lib/review";

/**
 * A persistent one-line fleet summary shown at the bottom of the main area:
 * status counts + total spend. Clicking the needs-approval count opens the
 * attention inbox. Derives everything from the store via a shallow selector so
 * a busy session's stream doesn't thrash it.
 */
export default function StatusBar() {
  const openInbox = useFleet((s) => s.openInbox);
  const stats = useFleet(
    useShallow((s) => {
      let working = 0;
      let idle = 0;
      let stopped = 0;
      let needsApproval = 0;
      let error = 0;
      let review = 0;
      let credits = 0;
      for (const x of Object.values(s.sessions)) {
        credits += x.state.credits;
        const status = effectiveStatus(x.state.status, x.review);
        switch (status) {
          case "working":
            working += 1;
            break;
          case "needsApproval":
            needsApproval += 1;
            break;
          case "error":
            error += 1;
            break;
          case "disconnected":
            stopped += 1;
            break;
          case "needsReview":
          case "readyToLand":
            review += 1;
            break;
          default:
            idle += 1;
        }
      }
      return {
        total: s.order.length,
        working,
        idle,
        stopped,
        needsApproval,
        error,
        review,
        credits,
      };
    }),
  );

  if (stats.total === 0) return null;

  return (
    <div className="statusbar" aria-label="fleet status">
      <span className="statusbar__item">
        <span className="dot dot--working" aria-hidden>
          ●
        </span>{" "}
        {stats.working} working
      </span>
      <span className="statusbar__item">
        <span className="dot dot--idle" aria-hidden>
          ●
        </span>{" "}
        {stats.idle} idle
      </span>
      {stats.stopped > 0 && (
        <span className="statusbar__item">
          <span className="dot dot--disconnected" aria-hidden>
            ●
          </span>{" "}
          {stats.stopped} stopped
        </span>
      )}
      <button
        type="button"
        className="statusbar__item statusbar__attn"
        onClick={() => openInbox()}
        disabled={stats.needsApproval === 0}
        title={
          stats.needsApproval > 0
            ? "Open the attention inbox"
            : "Nothing needs approval"
        }
      >
        <span className="dot dot--needsApproval" aria-hidden>
          ●
        </span>{" "}
        {stats.needsApproval} needs approval
      </button>
      {stats.error > 0 && (
        <span className="statusbar__item">
          <span className="dot dot--error" aria-hidden>
            ●
          </span>{" "}
          {stats.error} error
        </span>
      )}
      {stats.review > 0 && (
        <span className="statusbar__item">
          <span className="dot dot--needsReview" aria-hidden>
            ●
          </span>{" "}
          {stats.review} review
        </span>
      )}
      <span className="statusbar__spacer" />
      <span className="statusbar__item statusbar__credits">
        {stats.credits.toFixed(2)} cr
      </span>
    </div>
  );
}
