import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { useFleet } from "./lib/fleetStore";

vi.mock("./lib/ipc", () => ({
  orchLog: vi.fn(async () => [
    "## 2026-07-07",
    "- 2026-07-07T10:00:00+0200 dispatch -> s1: fix the bug",
    '- 2026-07-07T10:05:00+0200 automation "nightly" -> s2',
  ]),
}));

import Timeline from "./Timeline";

describe("Timeline (event log page)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useFleet.setState({ sessions: {}, order: [], activeId: null });
  });

  it("shows loading and disables refresh while events are pending", async () => {
    const { orchLog } = await import("./lib/ipc");
    let resolveLog!: (value: string[]) => void;
    vi.mocked(orchLog).mockReturnValueOnce(
      new Promise((resolve) => {
        resolveLog = resolve;
      }),
    );
    render(<Timeline />);

    expect(screen.getByRole("status")).toHaveTextContent(/loading events/i);
    expect(screen.getByRole("button", { name: /refreshing/i })).toBeDisabled();

    resolveLog(["- 2026-07-07T10:00:00+0200 loaded"]);
    expect(await screen.findByText("loaded")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^refresh$/i })).toBeEnabled();
  });

  it("does not claim there are no events when loading fails", async () => {
    const { orchLog } = await import("./lib/ipc");
    vi.mocked(orchLog).mockRejectedValueOnce(new Error("log unavailable"));
    render(<Timeline />);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      /log unavailable/i,
    );
    expect(screen.queryByText(/no matching events/i)).not.toBeInTheDocument();
  });

  it("loads on mount, drops markdown headings, shows events", async () => {
    render(<Timeline />);
    await waitFor(() =>
      expect(
        screen.getByText(/dispatch -> s1: fix the bug/),
      ).toBeInTheDocument(),
    );
    expect(screen.getByText(/automation "nightly" -> s2/)).toBeInTheDocument();
    // The "## 2026-07-07" markdown heading is filtered out.
    expect(screen.queryByText(/^## /)).toBeNull();
  });

  it("filters events by the search query", async () => {
    render(<Timeline />);
    await screen.findByText(/dispatch -> s1/);

    fireEvent.change(screen.getByLabelText("search events"), {
      target: { value: "automation" },
    });
    expect(screen.queryByText(/dispatch -> s1/)).toBeNull();
    expect(screen.getByText(/automation "nightly" -> s2/)).toBeInTheDocument();
  });

  it("links an event back to a live session", async () => {
    useFleet.getState().addSession({ sessionId: "s1" });
    useFleet.setState({ activeId: null, panel: "eventlog" });
    render(<Timeline />);

    fireEvent.click(
      await screen.findByRole("button", { name: /open plain session/i }),
    );

    expect(useFleet.getState().activeId).toBe("s1");
    expect(useFleet.getState().panel).toBeNull();
  });
});
