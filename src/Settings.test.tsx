import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import Settings from "./Settings";
import { useSettings } from "./lib/settingsStore";

describe("Settings", () => {
  beforeEach(() => {
    useSettings.setState({ showReasoning: true, toolDisplay: "all" });
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
});
