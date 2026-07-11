import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

vi.mock("./lib/ipc", () => ({
  trustProfileList: vi.fn(),
  trustProfileSet: vi.fn(async () => {}),
  trustProfileRemove: vi.fn(async () => {}),
  messageDialog: vi.fn(async () => {}),
  confirmDialog: vi.fn(async () => true),
}));

import TrustProfiles from "./TrustProfiles";
import {
  trustProfileList,
  trustProfileSet,
  trustProfileRemove,
  confirmDialog,
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

  it("moves destructive tools out of auto-allow instead of silently trusting them", async () => {
    vi.mocked(trustProfileList).mockResolvedValue([]);
    render(<TrustProfiles />);
    await waitFor(() => expect(trustProfileList).toHaveBeenCalled());

    fireEvent.change(screen.getByLabelText("profile name"), {
      target: { value: "Safe edits" },
    });
    fireEvent.change(screen.getByLabelText("auto-allow tools"), {
      target: { value: "fs_read, fs_write, fs_read" },
    });

    expect(screen.getByRole("status")).toHaveTextContent(
      /fs_write.*always require approval/i,
    );
    fireEvent.click(screen.getByRole("button", { name: /add profile/i }));

    await waitFor(() => expect(trustProfileSet).toHaveBeenCalled());
    const profile = vi.mocked(trustProfileSet).mock.calls[0][0];
    expect(profile.autoAllowTools).toEqual(["fs_read"]);
    expect(profile.alwaysAsk).toContain("fs_write");
  });

  it("deletes a profile after confirmation", async () => {
    vi.mocked(confirmDialog).mockResolvedValue(true);
    vi.mocked(trustProfileList).mockResolvedValue([
      { id: "p1", name: "Read-only", autoAllowTools: [], alwaysAsk: [] },
    ]);
    render(<TrustProfiles />);
    await screen.findByText("Read-only");
    fireEvent.click(screen.getByRole("button", { name: /delete read-only/i }));
    await waitFor(() => expect(confirmDialog).toHaveBeenCalled());
    await waitFor(() => expect(trustProfileRemove).toHaveBeenCalledWith("p1"));
  });

  it("does not delete a profile when the confirmation is cancelled", async () => {
    vi.mocked(confirmDialog).mockResolvedValueOnce(false);
    vi.mocked(trustProfileList).mockResolvedValue([
      { id: "p1", name: "Read-only", autoAllowTools: [], alwaysAsk: [] },
    ]);
    render(<TrustProfiles />);
    await screen.findByText("Read-only");
    fireEvent.click(screen.getByRole("button", { name: /delete read-only/i }));
    await waitFor(() => expect(confirmDialog).toHaveBeenCalled());
    expect(trustProfileRemove).not.toHaveBeenCalled();
  });
});
