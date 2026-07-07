import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

vi.mock("./lib/ipc", () => ({
  orchLog: vi.fn(async () => [
    "## 2026-07-07",
    "- 2026-07-07T10:00:00+0200 dispatch -> s1: fix the bug",
    '- 2026-07-07T10:05:00+0200 automation "nightly" -> s2',
  ]),
}));

import Timeline from "./Timeline";

describe("Timeline (event log page)", () => {
  beforeEach(() => vi.clearAllMocks());

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
});
