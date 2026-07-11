import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { useFleet } from "./lib/fleetStore";
import type { Workspace } from "./lib/bindings";

vi.mock("./lib/ipc", () => ({
  sessionSearch: vi.fn(),
}));

import SearchPanel from "./SearchPanel";
import { sessionSearch } from "./lib/ipc";

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
    panel: "search",
  });
}

describe("SearchPanel", () => {
  beforeEach(reset);

  it("shows results grouped by session and opens one on click", async () => {
    const { addSession } = useFleet.getState();
    addSession({ sessionId: "a", workspace: ws("feat-a", "/repo1") });
    useFleet.setState({ activeId: null, panel: "search" });

    vi.mocked(sessionSearch).mockResolvedValueOnce([
      { sessionId: "a", index: 2, kind: "agent", snippet: "running the tests" },
      { sessionId: "a", index: 5, kind: "tool", snippet: "all tests passed" },
    ]);

    render(<SearchPanel />);
    fireEvent.change(screen.getByLabelText("search query"), {
      target: { value: "tests" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: /search transcripts/i }),
    );

    await waitFor(() => expect(sessionSearch).toHaveBeenCalledWith("tests"));
    // Grouped under the session's branch name, both snippets shown.
    await screen.findByText("running the tests");
    expect(screen.getByText("all tests passed")).toBeInTheDocument();

    // Clicking the transcript group head focuses the session.
    fireEvent.click(
      screen
        .getByText("running the tests")
        .closest("section")!
        .querySelector("button")!,
    );
    expect(useFleet.getState().activeId).toBe("a");
  });

  it("filters sessions live and jumps on click (no transcript search needed)", () => {
    const { addSession } = useFleet.getState();
    addSession({ sessionId: "a", workspace: ws("feat-alpha", "/repo1") });
    addSession({ sessionId: "b", workspace: ws("feat-beta", "/repo1") });
    useFleet.setState({ activeId: null, panel: "search" });

    render(<SearchPanel />);
    fireEvent.change(screen.getByLabelText("search query"), {
      target: { value: "alpha" },
    });

    // The "Sessions" section filters to the matching branch, no grep run.
    expect(screen.getByText("feat-alpha")).toBeInTheDocument();
    expect(screen.queryByText("feat-beta")).toBeNull();
    expect(sessionSearch).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText("feat-alpha").closest("button")!);
    expect(useFleet.getState().activeId).toBe("a");
  });

  it("shows an empty state when there are no matches", async () => {
    vi.mocked(sessionSearch).mockResolvedValueOnce([]);
    render(<SearchPanel />);
    fireEvent.change(screen.getByLabelText("search query"), {
      target: { value: "zzz" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: /search transcripts/i }),
    );
    await screen.findByText(/no transcript matches/i);
  });

  it("clears transcript results when the query changes", async () => {
    vi.mocked(sessionSearch).mockResolvedValueOnce([
      {
        sessionId: "archived-session",
        index: 1,
        kind: "agent",
        snippet: "old query result",
      },
    ]);
    render(<SearchPanel />);
    const input = screen.getByLabelText("search query");
    fireEvent.change(input, { target: { value: "old" } });
    fireEvent.click(
      screen.getByRole("button", { name: /search transcripts/i }),
    );
    await screen.findByText("old query result");

    fireEvent.change(input, { target: { value: "new" } });
    expect(screen.queryByText("old query result")).not.toBeInTheDocument();
  });

  it("ignores an in-flight response after the query changes", async () => {
    let resolveSearch!: (
      value: Awaited<ReturnType<typeof sessionSearch>>,
    ) => void;
    vi.mocked(sessionSearch).mockReturnValueOnce(
      new Promise((resolve) => {
        resolveSearch = resolve;
      }),
    );
    render(<SearchPanel />);
    const input = screen.getByLabelText("search query");
    fireEvent.change(input, { target: { value: "old" } });
    fireEvent.click(
      screen.getByRole("button", { name: /search transcripts/i }),
    );
    fireEvent.change(input, { target: { value: "new" } });

    resolveSearch([
      {
        sessionId: "archived-session",
        index: 1,
        kind: "agent",
        snippet: "late old result",
      },
    ]);
    await Promise.resolve();
    expect(screen.queryByText("late old result")).not.toBeInTheDocument();
  });

  it("does not navigate to a transcript whose session is no longer loaded", async () => {
    vi.mocked(sessionSearch).mockResolvedValueOnce([
      {
        sessionId: "archived-session",
        index: 2,
        kind: "agent",
        snippet: "historical result",
      },
    ]);
    render(<SearchPanel />);
    fireEvent.change(screen.getByLabelText("search query"), {
      target: { value: "historical" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: /search transcripts/i }),
    );

    await screen.findByText("historical result");
    expect(screen.getByText("Archived")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /historical result/i }),
    ).toBeDisabled();
    expect(useFleet.getState().activeId).toBeNull();
  });
});
