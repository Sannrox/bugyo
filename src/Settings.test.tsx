import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import Settings from "./Settings";
import { useSettings } from "./lib/settingsStore";
import { useFleet } from "./lib/fleetStore";
import { getAppVersion } from "./lib/update";

vi.mock("./lib/update", () => ({
  getAppVersion: vi.fn().mockResolvedValue(null),
  checkForUpdate: vi.fn(),
  installUpdate: vi.fn(),
  restartApp: vi.fn(),
}));

describe("Settings", () => {
  beforeEach(() => {
    useSettings.setState({ showReasoning: true, toolDisplay: "all" });
    useFleet.setState({ projects: [] });
    vi.mocked(getAppVersion).mockResolvedValue(null);
  });

  it("toggles reasoning visibility through the store", () => {
    render(<Settings />);
    const toggle = screen.getByRole("switch", { name: /show reasoning/i });
    expect(toggle).toBeChecked();
    fireEvent.click(toggle);
    expect(useSettings.getState().showReasoning).toBe(false);
  });

  it("changes the tool-call display mode", () => {
    render(<Settings />);
    fireEvent.change(screen.getByLabelText(/tool calls/i), {
      target: { value: "edits" },
    });
    expect(useSettings.getState().toolDisplay).toBe("edits");
  });

  it("shows the running app version so users can report it", async () => {
    vi.mocked(getAppVersion).mockResolvedValue("0.3.1");
    render(<Settings />);
    await waitFor(() =>
      expect(screen.getByLabelText(/current version/i)).toHaveTextContent(
        "v0.3.1",
      ),
    );
  });
});
