import type { WorkspaceReviewState } from "./bindings";
import type { SessionState } from "./session";

export type DisplayStatus =
  SessionState["status"] | "needsReview" | "readyToLand" | "pushed";

export const DISPLAY_STATUS_LABEL: Record<DisplayStatus, string> = {
  disconnected: "Disconnected",
  idle: "Idle",
  working: "Working…",
  needsApproval: "Needs approval",
  error: "Error",
  needsReview: "Needs review",
  readyToLand: "Ready to land",
  pushed: "Pushed",
};

/**
 * Agent activity and urgent intervention take precedence. Once an agent is
 * idle/cold, the workspace lifecycle becomes the status users act on.
 */
export function effectiveStatus(
  agent: SessionState["status"],
  review: WorkspaceReviewState | null,
): DisplayStatus {
  if (agent === "working" || agent === "needsApproval" || agent === "error") {
    return agent;
  }
  switch (review?.stage) {
    case "needsReview":
    case "readyToLand":
    case "pushed":
      return review.stage;
    default:
      return agent;
  }
}
