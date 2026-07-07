import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { useFleet } from "./lib/fleetStore";
import type { Workspace } from "./lib/bindings";
import CommandPalette from "./CommandPalette";

vi.mock("./lib/ipc", () => ({
  confirmDialog: vi.fn(async () => true),
  messageDialog: vi.fn(async () => {}),
  workspaceArchive: vi.fn(async () => {}),
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
  });
}

describe("CommandPalette", () => {
  beforeEach(reset);

  it("lists navigation commands and a jump per session", () => {
    const { addSession } = useFleet.getState();
    addSession({ sessionId: "a", workspace: ws("feat-a", "/repo1") });

    render(<CommandPalette onClose={() => {}} />);
    const list = screen.getByRole("listbox");
    expect(list).toHaveTextContent("New session");
    expect(list).toHaveTextContent("Fleet overview");
    expect(list).toHaveTextContent("Go to feat-a");
  });

  it("filters commands by query", () => {
    const { addSession } = useFleet.getState();
    addSession({ sessionId: "a", workspace: ws("feat-a", "/repo1") });

    render(<CommandPalette onClose={() => {}} />);
    fireEvent.change(screen.getByRole("combobox"), {
      target: { value: "feat-a" },
    });
    const options = screen.getAllByRole("option");
    expect(options).toHaveLength(1);
    expect(options[0]).toHaveTextContent("Go to feat-a");
  });

  it("selecting a session jump sets it active and closes", () => {
    const onClose = vi.fn();
    const { addSession } = useFleet.getState();
    addSession({ sessionId: "a", workspace: ws("feat-a", "/repo1") });
    addSession({ sessionId: "b", workspace: ws("feat-b", "/repo1") });
    useFleet.setState({ activeId: null });

    render(<CommandPalette onClose={onClose} />);
    fireEvent.change(screen.getByRole("combobox"), {
      target: { value: "feat-b" },
    });
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "Enter" });

    expect(useFleet.getState().activeId).toBe("b");
    expect(onClose).toHaveBeenCalled();
  });

  it("closes on Escape", () => {
    const onClose = vi.fn();
    render(<CommandPalette onClose={onClose} />);
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });
});
