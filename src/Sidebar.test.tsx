import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  render,
  screen,
  fireEvent,
  waitFor,
  within,
} from "@testing-library/react";
import { useFleet } from "./lib/fleetStore";
import type { Workspace } from "./lib/bindings";

vi.mock("./lib/ipc", () => ({
  acpDeleteSession: vi.fn(async () => {}),
  confirmDialog: vi.fn(async () => true),
  projectAdd: vi.fn(async () => ({})),
  pickDirectory: vi.fn(async () => null),
  messageDialog: vi.fn(async () => {}),
  workspaceArchive: vi.fn(async () => {}),
  orchLog: vi.fn(async () => []),
  orchHeartbeatSecs: vi.fn(async () => 10),
  orchPreview: vi.fn(async () => ({
    ts: "",
    dryRun: true,
    dispatched: [],
    queuedRemaining: 0,
  })),
}));

vi.mock("./lib/sessionMeta", () => ({
  persistMeta: vi.fn(async () => {}),
  persistOrder: vi.fn(async () => {}),
}));

import Sidebar from "./Sidebar";

const ws = (branch: string, repo: string): Workspace => ({
  task: branch,
  repoRoot: repo,
  baseBranch: "main",
  branch,
  worktreePath: `/wt/${branch}`,
});

function reset() {
  vi.clearAllMocks();
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

describe("Sidebar — pin & rename", () => {
  beforeEach(reset);

  it("shows a session's custom name over its branch", () => {
    const { addSession, renameSession } = useFleet.getState();
    addSession({ sessionId: "a", workspace: ws("feat-a", "/repo1") });
    renameSession("a", "Login flow");

    render(<Sidebar />);
    const nav = screen.getByRole("navigation", { name: /workspaces/i });
    expect(nav).toHaveTextContent("Login flow");
    expect(nav).not.toHaveTextContent("feat-a");
  });

  it("sorts pinned sessions to the top of their group", () => {
    const { addSession, togglePin } = useFleet.getState();
    addSession({ sessionId: "a", workspace: ws("feat-a", "/repo1") });
    addSession({ sessionId: "b", workspace: ws("feat-b", "/repo1") });
    addSession({ sessionId: "c", workspace: ws("feat-c", "/repo1") });
    togglePin("c"); // pin the last one

    render(<Sidebar />);
    const nav = screen.getByRole("navigation", { name: /workspaces/i });
    const labels = within(nav)
      .getAllByText(/feat-[abc]/)
      .map((el) => el.textContent);
    expect(labels[0]).toBe("feat-c"); // pinned first
  });

  it("enters inline rename mode from the context menu and commits", () => {
    const { addSession } = useFleet.getState();
    addSession({ sessionId: "a", workspace: ws("feat-a", "/repo1") });

    render(<Sidebar />);
    fireEvent.click(screen.getByRole("button", { name: /session actions/i }));
    fireEvent.click(screen.getByRole("menuitem", { name: /rename/i }));

    const input = screen.getByLabelText("rename session");
    fireEvent.change(input, { target: { value: "Renamed" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(useFleet.getState().sessions.a.name).toBe("Renamed");
  });

  it("reverts a rename when durable metadata persistence fails", async () => {
    const { persistMeta } = await import("./lib/sessionMeta");
    vi.mocked(persistMeta).mockRejectedValueOnce(new Error("disk full"));
    useFleet.getState().addSession({
      sessionId: "a",
      workspace: ws("feat-a", "/repo1"),
    });
    render(<Sidebar />);
    fireEvent.click(screen.getByRole("button", { name: /session actions/i }));
    fireEvent.click(screen.getByRole("menuitem", { name: /rename/i }));
    const input = screen.getByLabelText("rename session");
    fireEvent.change(input, { target: { value: "Unsaved name" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => expect(useFleet.getState().sessions.a.name).toBeNull());
    const { messageDialog } = await import("./lib/ipc");
    expect(messageDialog).toHaveBeenCalledWith(
      expect.stringMatching(/not saved.*reverted.*disk full/i),
    );
  });

  it("reverts pinning when durable metadata persistence fails", async () => {
    const { persistMeta } = await import("./lib/sessionMeta");
    vi.mocked(persistMeta).mockRejectedValueOnce(new Error("read only"));
    useFleet.getState().addSession({
      sessionId: "a",
      workspace: ws("feat-a", "/repo1"),
    });
    render(<Sidebar />);
    fireEvent.click(screen.getByRole("button", { name: /session actions/i }));
    fireEvent.click(screen.getByRole("menuitem", { name: /^pin$/i }));

    await waitFor(() =>
      expect(useFleet.getState().sessions.a.pinned).toBe(false),
    );
  });

  it("returns focus to the session action trigger when its menu is dismissed", async () => {
    useFleet.getState().addSession({
      sessionId: "a",
      workspace: ws("feat-a", "/repo1"),
    });
    render(<Sidebar />);
    const trigger = screen.getByRole("button", { name: /session actions/i });
    fireEvent.click(trigger);
    expect(screen.getByRole("menuitem", { name: /^pin$/i })).toHaveFocus();

    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(trigger).toHaveFocus());
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("marks the current top-level destination", () => {
    useFleet.getState().openFleet();
    render(<Sidebar />);

    expect(
      screen.getByRole("button", { name: /fleet overview/i }),
    ).toHaveAttribute("aria-current", "page");
    expect(
      screen.getByRole("button", { name: /new task/i }),
    ).not.toHaveAttribute("aria-current");
  });
});
