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
    projects: [{ path: "/repo1", name: "repo1", isGitRepo: true }],
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
