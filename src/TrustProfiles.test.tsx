import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

vi.mock("./lib/ipc", () => ({
  trustProfileList: vi.fn(),
  trustProfileSet: vi.fn(async () => {}),
  trustProfileRemove: vi.fn(async () => {}),
  messageDialog: vi.fn(async () => {}),
}));

import TrustProfiles from "./TrustProfiles";
import {
  trustProfileList,
  trustProfileSet,
  trustProfileRemove,
} from "./lib/ipc";

describe("TrustProfiles", () => {
  beforeEach(() => vi.clearAllMocks());

  it("lists profiles and states the destructive-always-ask guarantee", async () => {
    vi.mocked(trustProfileList).mockResolvedValue([
      {
        id: "p1",
        name: "Read-only",
        autoAllowTools: ["fs_read", "code"],
        alwaysAsk: [],
      },
    ]);

    render(<TrustProfiles />);
    await screen.findByText("Read-only");
    expect(screen.getByText(/auto-allow: fs_read, code/)).toBeInTheDocument();
    // Safety guarantee is surfaced to the user.
    expect(screen.getByText(/always require approval/i)).toBeInTheDocument();
  });

  it("creates a new profile", async () => {
    vi.mocked(trustProfileList).mockResolvedValue([]);
    render(<TrustProfiles />);
    await waitFor(() => expect(trustProfileList).toHaveBeenCalled());

    fireEvent.change(screen.getByLabelText("profile name"), {
      target: { value: "Docs" },
    });
    fireEvent.change(screen.getByLabelText("auto-allow tools"), {
      target: { value: "fs_read, code" },
    });
    fireEvent.click(screen.getByRole("button", { name: /add profile/i }));

    await waitFor(() => expect(trustProfileSet).toHaveBeenCalled());
    const arg = vi.mocked(trustProfileSet).mock.calls[0][0];
    expect(arg.name).toBe("Docs");
    expect(arg.autoAllowTools).toEqual(["fs_read", "code"]);
  });

  it("deletes a profile", async () => {
    vi.mocked(trustProfileList).mockResolvedValue([
      { id: "p1", name: "Read-only", autoAllowTools: [], alwaysAsk: [] },
    ]);
    render(<TrustProfiles />);
    await screen.findByText("Read-only");
    fireEvent.click(screen.getByRole("button", { name: /delete read-only/i }));
    await waitFor(() => expect(trustProfileRemove).toHaveBeenCalledWith("p1"));
  });
});
