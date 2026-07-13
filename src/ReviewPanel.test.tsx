import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type { ReviewStage, WorkspaceReviewState } from "./lib/bindings";

vi.mock("./lib/ipc", () => ({
  confirmDialog: vi.fn(async () => true),
  workspaceArchive: vi.fn(async () => {}),
  workspaceCheck: vi.fn(async () => ({
    success: true,
    exitCode: 0,
    stdout: "ok",
    stderr: "",
  })),
  workspaceCommit: vi.fn(async () => {}),
  workspaceDiff: vi.fn(async () => ""),
  workspacePush: vi.fn(async () => {}),
  workspaceReviewState: vi.fn(),
}));

import ReviewPanel from "./ReviewPanel";
import {
  workspaceCommit,
  workspacePush,
  workspaceReviewState,
} from "./lib/ipc";
import { useFleet } from "./lib/fleetStore";
import { initialSessionState } from "./lib/session";

function review(
  stage: ReviewStage,
  overrides: Partial<WorkspaceReviewState> = {},
): WorkspaceReviewState {
  return {
    stage,
    hasChanges: true,
    hasUncommittedChanges: false,
    changedFiles: ["src/main.rs"],
    lastCheck:
      stage === "readyToLand"
        ? {
            script: "cargo test",
            success: true,
            exitCode: 0,
            completedAt: "2026-07-10T12:00:00Z",
            changeFingerprint: "abc",
          }
        : null,
    ...overrides,
  };
}

describe("ReviewPanel — git-only push workflow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(workspaceReviewState).mockReset();
    useFleet.setState({ projects: [], sessions: {}, order: [], panel: null });
  });

  it("links directly to check configuration when a project has no check command", async () => {
    vi.mocked(workspaceReviewState).mockResolvedValue(review("needsReview"));

    render(<ReviewPanel sessionId="s1" />);
    const configure = await screen.findByRole("button", {
      name: /configure checks/i,
    });
    fireEvent.click(configure);

    expect(useFleet.getState().panel).toBe("settings");
  });

  it("lets the reviewer run a configured check for the first time", async () => {
    useFleet.setState({
      projects: [
        {
          path: "/repo",
          name: "repo",
          isGitRepo: true,
          baseBranch: "main",
          setupScript: "",
          checkScript: "bun run test",
        },
      ],
      sessions: {
        s1: {
          sessionId: "s1",
          repoRoot: "/repo",
          workspace: {
            task: "Improve review",
            repoRoot: "/repo",
            baseBranch: "main",
            branch: "improve-review",
            worktreePath: "/wt/improve-review",
          },
          review: null,
          state: { ...initialSessionState, status: "idle" },
          queued: 0,
          lastActivity: 0,
          pinned: false,
          name: null,
        },
      },
    });
    vi.mocked(workspaceReviewState)
      .mockResolvedValueOnce(review("needsReview"))
      .mockResolvedValueOnce(review("readyToLand"));

    render(<ReviewPanel sessionId="s1" />);
    fireEvent.click(await screen.findByRole("button", { name: /run checks/i }));

    const { workspaceCheck } = await import("./lib/ipc");
    await waitFor(() =>
      expect(workspaceCheck).toHaveBeenCalledWith("s1", "bun run test"),
    );
  });

  it("surfaces a recorded check as evidence and enables push once ready to land", async () => {
    // A recorded check is informational only: while the workspace still needs
    // review, push stays blocked on commit state, not on checks.
    vi.mocked(workspaceReviewState)
      .mockResolvedValueOnce(
        review("needsReview", {
          lastCheck: {
            script: "cargo test",
            success: true,
            exitCode: 0,
            completedAt: "2026-07-10T12:00:00Z",
            changeFingerprint: "abc",
          },
        }),
      )
      .mockResolvedValueOnce(review("readyToLand"))
      .mockResolvedValueOnce(review("pushed", { hasChanges: false }));

    render(<ReviewPanel sessionId="s1" />);
    const evidence = await screen.findByLabelText("verification evidence");
    expect(within(evidence).getByText(/checks passed/i)).toBeVisible();
    // Not ready to land yet: push is gated on commit state, not the check.
    expect(screen.getByRole("button", { name: /^push$/i })).toBeDisabled();

    // Refreshing observes the committed, ready-to-land state.
    fireEvent.click(screen.getByRole("button", { name: /refresh review/i }));

    const push = await screen.findByRole("button", { name: /^push$/i });
    await waitFor(() => expect(push).toBeEnabled());
    fireEvent.click(push);

    await waitFor(() => expect(workspacePush).toHaveBeenCalledWith("s1"));
  });

  it("surfaces a push failure without recording a landing", async () => {
    vi.mocked(workspaceReviewState).mockResolvedValue(review("readyToLand"));
    vi.mocked(workspacePush).mockRejectedValueOnce(
      new Error("git push failed"),
    );

    render(<ReviewPanel sessionId="s1" />);
    const push = await screen.findByRole("button", { name: /^push$/i });
    await waitFor(() => expect(push).toBeEnabled());
    fireEvent.click(push);

    await screen.findByText(/git push failed/i);
  });

  it("offers commit (not push) while the workspace has uncommitted changes", async () => {
    vi.mocked(workspaceReviewState).mockResolvedValue(
      review("needsReview", { hasUncommittedChanges: true }),
    );

    render(<ReviewPanel sessionId="s1" />);

    // The push control is replaced by commit until changes are committed, but
    // committing itself is never gated on verification — the human decides.
    await screen.findByText(/commit the reviewed changes/i);
    expect(
      screen.getByRole("button", { name: /commit changes/i }),
    ).toBeEnabled();
    expect(screen.queryByRole("button", { name: /^push$/i })).toBeNull();
    expect(workspacePush).not.toHaveBeenCalled();
  });

  it("lets the human commit without any verification", async () => {
    // No check has ever run (lastCheck: null) and no check command is
    // configured — the commit button is still enabled.
    vi.mocked(workspaceReviewState)
      .mockResolvedValueOnce(
        review("needsReview", { hasUncommittedChanges: true }),
      )
      .mockResolvedValueOnce(review("readyToLand"));

    render(<ReviewPanel sessionId="s1" />);

    const commit = await screen.findByRole("button", {
      name: /commit changes/i,
    });
    expect(commit).toBeEnabled();
    fireEvent.click(commit);

    await waitFor(() =>
      expect(workspaceCommit).toHaveBeenCalledWith(
        "s1",
        "Bugyo workspace changes",
      ),
    );
    await screen.findByText(/reviewed changes committed/i);
  });

  it("replaces the push control with cleanup after a push", async () => {
    vi.mocked(workspaceReviewState).mockResolvedValue(
      review("pushed", { hasChanges: false }),
    );

    render(<ReviewPanel sessionId="s1" />);

    await screen.findByText(/pushed to origin/i);
    expect(screen.queryByRole("button", { name: /^push$/i })).toBeNull();
    expect(
      screen.getByRole("button", { name: /archive workspace/i }),
    ).toBeEnabled();
  });

  it("opens only one archive confirmation while the decision is pending", async () => {
    const { confirmDialog, workspaceArchive } = await import("./lib/ipc");
    let resolveConfirm!: (value: boolean) => void;
    vi.mocked(confirmDialog).mockReturnValueOnce(
      new Promise((resolve) => {
        resolveConfirm = resolve;
      }),
    );
    vi.mocked(workspaceReviewState).mockResolvedValue(
      review("pushed", { hasChanges: false }),
    );
    render(<ReviewPanel sessionId="s1" />);
    const archive = await screen.findByRole("button", {
      name: /archive workspace/i,
    });

    fireEvent.click(archive);
    fireEvent.click(archive);
    expect(confirmDialog).toHaveBeenCalledTimes(1);
    expect(archive).toBeDisabled();
    expect(workspaceArchive).not.toHaveBeenCalled();

    resolveConfirm(false);
    await waitFor(() => expect(archive).toBeEnabled());
  });
});
