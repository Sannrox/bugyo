import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { useFleet } from "./lib/fleetStore";
import { useBudget } from "./lib/budgetStore";
import type { Workspace } from "./lib/bindings";
import FleetGrid from "./FleetGrid";

vi.mock("./lib/ipc", () => ({
  orchEnqueue: vi.fn(async () => {}),
  workspaceArchive: vi.fn(async () => {}),
  confirmDialog: vi.fn(async () => true),
  messageDialog: vi.fn(async () => {}),
}));

const ws = (branch: string, repo: string): Workspace => ({
  task: branch,
  repoRoot: repo,
  baseBranch: "main",
  branch,
  worktreePath: `/wt/${branch}`,
});

function reset() {
  useFleet.setState({
    sessions: {},
    order: [],
    activeId: null,
    secondaryId: null,
    panel: null,
    projects: [
      {
        path: "/repo1",
        name: "repo1",
        isGitRepo: true,
        baseBranch: "main",
        setupScript: "",
        checkScript: "",
      },
    ],
  });
}

describe("FleetGrid", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    reset();
    useBudget.setState({ config: { sessionCap: null, projectCaps: [] } });
  });

  it("shows an empty state with no sessions", () => {
    render(<FleetGrid />);
    expect(screen.getByText(/no sessions yet/i)).toBeInTheDocument();
  });

  it("renders a card per session with status and project", () => {
    const { addSession, applyEvent } = useFleet.getState();
    addSession({ sessionId: "a", workspace: ws("feat-a", "/repo1") });
    addSession({ sessionId: "b", workspace: ws("feat-b", "/repo1") });
    applyEvent({ type: "status", sessionId: "b", status: "working" });

    render(<FleetGrid />);
    const grid = screen.getByLabelText("fleet overview");
    expect(grid).toHaveTextContent("feat-a");
    expect(grid).toHaveTextContent("feat-b");
    expect(grid).toHaveTextContent("repo1");
    expect(grid).toHaveTextContent("Working…");
  });

  it("shows the human task as the primary identity and keeps the branch visible", () => {
    const workspace = ws("improve-onboarding", "/repo1");
    workspace.task = "Improve onboarding";
    useFleet.getState().addSession({ sessionId: "a", workspace });

    render(<FleetGrid />);

    expect(screen.getByText("Improve onboarding")).toBeInTheDocument();
    expect(screen.getByText(/improve-onboarding/)).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "repo1" })).toBeInTheDocument();
  });

  it("surfaces workspace delivery state in the fleet summary and card", () => {
    useFleet.getState().addSession({
      sessionId: "a",
      workspace: ws("feat-a", "/repo1"),
      review: {
        stage: "needsReview",
        hasChanges: true,
        hasUncommittedChanges: false,
        changedFiles: ["src/main.rs"],
        lastCheck: null,
        checkCurrent: false,
      },
    });

    render(<FleetGrid />);

    expect(screen.getByText("Needs review")).toBeInTheDocument();
    expect(screen.getByLabelText("fleet summary")).toHaveTextContent(
      "1 review",
    );
  });

  it("filters a large fleet by text and lifecycle status", () => {
    const { addSession } = useFleet.getState();
    addSession({ sessionId: "a", workspace: ws("fix-search", "/repo1") });
    addSession({
      sessionId: "b",
      workspace: ws("review-billing", "/repo1"),
      review: {
        stage: "needsReview",
        hasChanges: true,
        hasUncommittedChanges: false,
        changedFiles: ["billing.ts"],
        lastCheck: null,
        checkCurrent: false,
      },
    });

    render(<FleetGrid />);
    fireEvent.change(screen.getByLabelText("search fleet"), {
      target: { value: "billing" },
    });
    expect(screen.getByText("review-billing")).toBeInTheDocument();
    expect(screen.queryByText("fix-search")).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("search fleet"), {
      target: { value: "" },
    });
    fireEvent.change(screen.getByLabelText("filter by status"), {
      target: { value: "review" },
    });
    expect(screen.getByText("review-billing")).toBeInTheDocument();
    expect(screen.queryByText("fix-search")).not.toBeInTheDocument();
  });

  it("focuses a session when its card open button is clicked", () => {
    const { addSession } = useFleet.getState();
    addSession({ sessionId: "a", workspace: ws("feat-a", "/repo1") });
    addSession({ sessionId: "b", workspace: ws("feat-b", "/repo1") });
    useFleet.setState({ activeId: null, panel: "fleet" });

    render(<FleetGrid />);
    fireEvent.click(screen.getByText("feat-a").closest("button")!);

    const s = useFleet.getState();
    expect(s.activeId).toBe("a");
    expect(s.panel).toBeNull();
  });

  it("bulk-dispatches a prompt to every selected session", async () => {
    const { addSession } = useFleet.getState();
    addSession({ sessionId: "a", workspace: ws("feat-a", "/repo1") });
    addSession({ sessionId: "b", workspace: ws("feat-b", "/repo1") });

    render(<FleetGrid />);
    fireEvent.click(screen.getByLabelText("select feat-a"));
    fireEvent.click(screen.getByLabelText("select feat-b"));

    fireEvent.change(screen.getByLabelText("bulk prompt"), {
      target: { value: "run the tests" },
    });
    fireEvent.click(screen.getByRole("button", { name: /dispatch to 2/i }));

    const { orchEnqueue } = await import("./lib/ipc");
    await waitFor(() => expect(orchEnqueue).toHaveBeenCalledTimes(2));
    expect(orchEnqueue).toHaveBeenCalledWith("a", "run the tests");
    expect(orchEnqueue).toHaveBeenCalledWith("b", "run the tests");
    expect(await screen.findByRole("status")).toHaveTextContent(
      /queued for all 2/i,
    );
    expect(useFleet.getState().sessions.a.queued).toBe(1);
    expect(useFleet.getState().sessions.b.queued).toBe(1);
  });

  it("reports partial bulk dispatch and keeps only failures selected for retry", async () => {
    const { orchEnqueue } = await import("./lib/ipc");
    vi.mocked(orchEnqueue).mockImplementation(async (id) => {
      if (id === "b") throw new Error("agent unavailable");
    });
    const { addSession } = useFleet.getState();
    addSession({ sessionId: "a", workspace: ws("feat-a", "/repo1") });
    addSession({ sessionId: "b", workspace: ws("feat-b", "/repo1") });

    render(<FleetGrid />);
    fireEvent.click(screen.getByLabelText("select feat-a"));
    fireEvent.click(screen.getByLabelText("select feat-b"));
    fireEvent.change(screen.getByLabelText("bulk prompt"), {
      target: { value: "run the tests" },
    });
    fireEvent.click(screen.getByRole("button", { name: /dispatch to 2/i }));

    expect(await screen.findByRole("status")).toHaveTextContent(
      /queued for 1; 1 failed.*retry/i,
    );
    expect(screen.getByLabelText("select feat-a")).not.toBeChecked();
    expect(screen.getByLabelText("select feat-b")).toBeChecked();
    expect(screen.getByLabelText("bulk prompt")).toHaveValue("run the tests");
  });

  it("bulk-archives selected workspaces after a single confirm", async () => {
    const { addSession } = useFleet.getState();
    addSession({ sessionId: "a", workspace: ws("feat-a", "/repo1") });
    addSession({ sessionId: "b", workspace: ws("feat-b", "/repo1") });

    render(<FleetGrid />);
    fireEvent.click(screen.getByLabelText("select feat-a"));
    fireEvent.click(screen.getByLabelText("select feat-b"));
    fireEvent.click(screen.getByRole("button", { name: /archive 2/i }));

    const { confirmDialog, workspaceArchive } = await import("./lib/ipc");
    await waitFor(() => expect(workspaceArchive).toHaveBeenCalledTimes(2));
    expect(confirmDialog).toHaveBeenCalledTimes(1); // one confirm for the batch
    expect(useFleet.getState().order).toEqual([]);
    expect(await screen.findByRole("status")).toHaveTextContent(
      /archived 2 workspaces/i,
    );
  });

  it("continues a bulk archive after one failure and selects the retry", async () => {
    const { workspaceArchive } = await import("./lib/ipc");
    vi.mocked(workspaceArchive).mockImplementation(async (id) => {
      if (id === "a") throw new Error("worktree busy");
    });
    const { addSession } = useFleet.getState();
    addSession({ sessionId: "a", workspace: ws("feat-a", "/repo1") });
    addSession({ sessionId: "b", workspace: ws("feat-b", "/repo1") });

    render(<FleetGrid />);
    fireEvent.click(screen.getByLabelText("select feat-a"));
    fireEvent.click(screen.getByLabelText("select feat-b"));
    fireEvent.click(screen.getByRole("button", { name: /archive 2/i }));

    expect(await screen.findByRole("status")).toHaveTextContent(
      /1 archived; 1 failed.*retry/i,
    );
    expect(useFleet.getState().sessions.a).toBeDefined();
    expect(useFleet.getState().sessions.b).toBeUndefined();
    expect(screen.getByLabelText("select feat-a")).toBeChecked();
  });

  it("flags a session that is over its budget cap", () => {
    useBudget.setState({ config: { sessionCap: 10, projectCaps: [] } });
    const { addSession, applyEvent } = useFleet.getState();
    addSession({ sessionId: "a", workspace: ws("feat-a", "/repo1") });
    applyEvent({
      type: "metrics",
      sessionId: "a",
      contextPercent: null,
      credits: 12,
      turnDurationMs: null,
    });

    render(<FleetGrid />);
    expect(screen.getByText(/over budget/i)).toBeInTheDocument();
  });
});
