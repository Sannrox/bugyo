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
  workspaceMerge: vi.fn(async () => {}),
  workspaceMergePreview: vi.fn(),
  workspaceOpenPr: vi.fn(async () => "https://example.test/pr/1"),
  workspaceReviewState: vi.fn(),
}));

import ReviewPanel from "./ReviewPanel";
import {
  workspaceCommit,
  workspaceMerge,
  workspaceMergePreview,
  workspaceOpenPr,
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
    pullRequestUrl: null,
    ...overrides,
  };
}

describe("ReviewPanel — durable delivery workflow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(workspaceReviewState).mockReset();
    vi.mocked(workspaceMergePreview).mockReset();
    useFleet.setState({ projects: [], sessions: {}, order: [], panel: null });
  });

  it("links directly to check configuration when a project has no check command", async () => {
    vi.mocked(workspaceReviewState).mockResolvedValue(review("needsReview"));
    vi.mocked(workspaceMergePreview).mockResolvedValue({
      clean: true,
      conflictedFiles: [],
    });

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
    vi.mocked(workspaceMergePreview).mockResolvedValue({
      clean: true,
      conflictedFiles: [],
    });

    render(<ReviewPanel sessionId="s1" />);
    fireEvent.click(await screen.findByRole("button", { name: /run checks/i }));

    const { workspaceCheck } = await import("./lib/ipc");
    await waitFor(() =>
      expect(workspaceCheck).toHaveBeenCalledWith("s1", "bun run test"),
    );
  });

  it("warns about predicted conflicts and blocks merge", async () => {
    vi.mocked(workspaceReviewState).mockResolvedValue(review("readyToLand"));
    vi.mocked(workspaceMergePreview).mockResolvedValue({
      clean: false,
      conflictedFiles: ["src/main.rs", "README.md"],
    });

    render(<ReviewPanel sessionId="s1" />);

    await screen.findByText(/merge conflict predicted/i);
    expect(screen.getAllByText("src/main.rs")).toHaveLength(2);
    expect(screen.getByText("README.md")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^merge$/i })).toBeDisabled();
    expect(workspaceMerge).not.toHaveBeenCalled();
  });

  it("refreshes durable review state and enables merge after checks pass", async () => {
    vi.mocked(workspaceReviewState)
      .mockResolvedValueOnce(
        review("needsReview", {
          lastCheck: {
            script: "cargo test",
            success: true,
            exitCode: 0,
            completedAt: "2026-07-10T12:00:00Z",
            changeFingerprint: "stale",
          },
        }),
      )
      .mockResolvedValueOnce(review("readyToLand"))
      .mockResolvedValueOnce(review("merged", { hasChanges: false }));
    vi.mocked(workspaceMergePreview).mockResolvedValue({
      clean: true,
      conflictedFiles: [],
    });

    render(<ReviewPanel sessionId="s1" />);
    const evidence = await screen.findByLabelText("verification evidence");
    expect(
      within(evidence).getByText(/verification is outdated/i),
    ).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: /rerun/i }));

    await waitFor(() =>
      expect(
        within(screen.getByLabelText("verification evidence")).getByText(
          /checks passed/i,
        ),
      ).toBeVisible(),
    );
    const merge = screen.getByRole("button", { name: /^merge$/i });
    expect(merge).toBeEnabled();
    fireEvent.click(merge);

    await waitFor(() => expect(workspaceMerge).toHaveBeenCalledWith("s1"));
  });

  it("fails closed when the final pre-merge check throws", async () => {
    vi.mocked(workspaceReviewState).mockResolvedValue(review("readyToLand"));
    vi.mocked(workspaceMergePreview)
      .mockResolvedValueOnce({ clean: true, conflictedFiles: [] })
      .mockRejectedValueOnce(new Error("git failed"));

    render(<ReviewPanel sessionId="s1" />);
    const merge = await screen.findByRole("button", { name: /^merge$/i });
    await waitFor(() => expect(merge).toBeEnabled());
    fireEvent.click(merge);

    await screen.findByText(/git failed/i);
    expect(workspaceMerge).not.toHaveBeenCalled();
  });

  it("does not offer landing while the workspace has uncommitted changes", async () => {
    vi.mocked(workspaceReviewState).mockResolvedValue(
      review("needsReview", { hasUncommittedChanges: true }),
    );
    vi.mocked(workspaceMergePreview).mockResolvedValue({
      clean: true,
      conflictedFiles: [],
    });

    render(<ReviewPanel sessionId="s1" />);

    await screen.findByText(/commit outstanding changes/i);
    expect(
      screen.getByRole("button", { name: /commit changes/i }),
    ).toBeDisabled();
    expect(screen.queryByRole("button", { name: /^merge$/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /open pr/i })).toBeNull();
    expect(workspaceOpenPr).not.toHaveBeenCalled();
  });

  it("lets the human commit only after verification passes", async () => {
    vi.mocked(workspaceReviewState)
      .mockResolvedValueOnce(
        review("readyToLand", { hasUncommittedChanges: true }),
      )
      .mockResolvedValueOnce(review("readyToLand"));
    vi.mocked(workspaceMergePreview).mockResolvedValue({
      clean: true,
      conflictedFiles: [],
    });

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

  it("replaces landing controls with cleanup after a merge", async () => {
    vi.mocked(workspaceReviewState).mockResolvedValue(
      review("merged", { hasChanges: false }),
    );
    vi.mocked(workspaceMergePreview).mockResolvedValue({
      clean: true,
      conflictedFiles: [],
    });

    render(<ReviewPanel sessionId="s1" />);

    await screen.findByText(/merged into the base branch/i);
    expect(screen.queryByRole("button", { name: /^merge$/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /open pr/i })).toBeNull();
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
      review("merged", { hasChanges: false }),
    );
    vi.mocked(workspaceMergePreview).mockResolvedValue({
      clean: true,
      conflictedFiles: [],
    });
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

  it("shows the pull-request outcome instead of disabled landing controls", async () => {
    vi.mocked(workspaceReviewState).mockResolvedValue(
      review("pullRequestOpen", {
        pullRequestUrl: "https://example.test/pr/1",
      }),
    );
    vi.mocked(workspaceMergePreview).mockResolvedValue({
      clean: true,
      conflictedFiles: [],
    });

    render(<ReviewPanel sessionId="s1" />);

    await screen.findByText(/pull request opened/i);
    expect(screen.queryByRole("button", { name: /open pr/i })).toBeNull();
    expect(
      screen.getByRole("button", { name: /archive workspace/i }),
    ).toBeEnabled();
  });
});
