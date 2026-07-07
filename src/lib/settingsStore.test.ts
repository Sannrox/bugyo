import { describe, it, expect, beforeEach } from "vitest";
import { useSettings } from "./settingsStore";

describe("settingsStore", () => {
  beforeEach(() => {
    useSettings.setState({
      showReasoning: true,
      toolDisplay: "all",
      sidebarCollapsed: false,
    });
  });

  it("defaults to showing reasoning and all tool calls", () => {
    const s = useSettings.getState();
    expect(s.showReasoning).toBe(true);
    expect(s.toolDisplay).toBe("all");
  });

  it("updates reasoning visibility and tool display", () => {
    useSettings.getState().setShowReasoning(false);
    useSettings.getState().setToolDisplay("edits");
    const s = useSettings.getState();
    expect(s.showReasoning).toBe(false);
    expect(s.toolDisplay).toBe("edits");
  });

  it("toggles the sidebar collapsed state", () => {
    useSettings.setState({ sidebarCollapsed: false });
    useSettings.getState().toggleSidebar();
    expect(useSettings.getState().sidebarCollapsed).toBe(true);
    useSettings.getState().toggleSidebar();
    expect(useSettings.getState().sidebarCollapsed).toBe(false);
  });
});
