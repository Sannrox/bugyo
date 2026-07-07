import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
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
}));

vi.mock("./lib/sessionMeta", () => ({
  persistMeta: vi.fn(async () => {}),
  persistOrder: vi.fn(async () => {}),
}));

import Sidebar from "./Sidebar";

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
});
