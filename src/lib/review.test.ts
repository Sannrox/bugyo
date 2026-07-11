import { describe, expect, it } from "vitest";
import type { ReviewStage, WorkspaceReviewState } from "./bindings";
import { effectiveStatus } from "./review";

function review(stage: ReviewStage): WorkspaceReviewState {
  return {
    stage,
    hasChanges: stage !== "active",
    hasUncommittedChanges: false,
    changedFiles: [],
    lastCheck: null,
    pullRequestUrl: null,
  };
}

describe("effectiveStatus", () => {
  it.each([
    "needsReview",
    "checksFailed",
    "readyToLand",
    "pullRequestOpen",
    "merged",
  ] as const)("shows the %s lifecycle when the agent is idle", (stage) => {
    expect(effectiveStatus("idle", review(stage))).toBe(stage);
  });

  it("keeps active and urgent agent states above the review lifecycle", () => {
    const needsReview = review("needsReview");
    expect(effectiveStatus("working", needsReview)).toBe("working");
    expect(effectiveStatus("needsApproval", needsReview)).toBe("needsApproval");
    expect(effectiveStatus("error", needsReview)).toBe("error");
  });
});
