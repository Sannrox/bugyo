import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import type { Automation, AutomationRun } from "./lib/bindings";
import { useFleet } from "./lib/fleetStore";

const existing: Automation = {
  id: "a1",
  name: "nightly triage",
  enabled: true,
  prompt: "Check CI and report failures.",
  schedule: { type: "intervalSecs", secs: 3600 },
  target: { type: "existingSession", sessionId: "sess-1234abcd" },
  trust: { type: "ask" },
  lastRun: null,
  created: "2026-07-07T10:00:00+0200",
};

let onRunHandler: ((run: AutomationRun) => void) | null = null;

vi.mock("./lib/ipc", () => ({
  automationList: vi.fn(async () => [existing]),
  automationCreate: vi.fn(async (a: Automation) => ({ ...a, id: "new-id" })),
  automationUpdate: vi.fn(async (a: Automation) => a),
  automationRemove: vi.fn(async () => {}),
  automationRunNow: vi.fn(async () => ({
    ts: "2026-07-07T12:00:00+0200",
    automationId: "a1",
    sessionId: "sess-1234abcd",
    status: "dispatched",
    message: null,
  })),
  confirmDialog: vi.fn(async () => true),
  onAutomationRun: vi.fn(async (h: (run: AutomationRun) => void) => {
    onRunHandler = h;
    return () => {};
  }),
}));

import Automations from "./Automations";

beforeEach(() => {
  vi.clearAllMocks();
  onRunHandler = null;
  useFleet.setState({
    sessions: {},
    order: [],
    activeId: null,
    projects: [],
  });
});

describe("Automations panel", () => {
  it("lists existing automations with schedule + target summary", async () => {
    render(<Automations />);
    await waitFor(() => screen.getByText("nightly triage"));
    expect(screen.getByText(/every 3600s/)).toBeInTheDocument();
    expect(screen.getByText(/session sess-123/)).toBeInTheDocument();
  });

  it("toggles enable through automationUpdate", async () => {
    render(<Automations />);
    await waitFor(() => screen.getByText("nightly triage"));

    fireEvent.click(screen.getByLabelText("enable nightly triage"));
    const { automationUpdate } = await import("./lib/ipc");
    await waitFor(() =>
      expect(automationUpdate).toHaveBeenCalledWith(
        expect.objectContaining({ id: "a1", enabled: false }),
      ),
    );
  });

  it("runs an automation now through automationRunNow and shows it in history", async () => {
    render(<Automations />);
    await waitFor(() => screen.getByText("nightly triage"));

    fireEvent.click(screen.getByLabelText("run nightly triage now"));
    const { automationRunNow } = await import("./lib/ipc");
    await waitFor(() => expect(automationRunNow).toHaveBeenCalledWith("a1"));

    // The returned run appears in the history list.
    await waitFor(() =>
      expect(screen.getByText("dispatched")).toBeInTheDocument(),
    );
  });

  it("creates a new automation from the form", async () => {
    render(<Automations />);
    await waitFor(() => screen.getByText("nightly triage"));

    fireEvent.click(screen.getByRole("button", { name: /new automation/i }));

    fireEvent.change(screen.getByLabelText("automation name"), {
      target: { value: "morning brief" },
    });
    fireEvent.change(screen.getByLabelText("durable prompt"), {
      target: { value: "Summarise overnight commits." },
    });
    // Default target is existingSession; pick a session id (none in store) —
    // leave empty is allowed, but set schedule to interval (default).
    fireEvent.click(screen.getByRole("button", { name: /^create$/i }));

    const { automationCreate } = await import("./lib/ipc");
    await waitFor(() =>
      expect(automationCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          name: "morning brief",
          prompt: "Summarise overnight commits.",
          schedule: { type: "intervalSecs", secs: 3600 },
          trust: { type: "ask" },
        }),
      ),
    );
  });

  it("warns when trust-all is selected in the form", async () => {
    render(<Automations />);
    await waitFor(() => screen.getByText("nightly triage"));
    fireEvent.click(screen.getByRole("button", { name: /new automation/i }));

    fireEvent.change(screen.getByLabelText("trust mode"), {
      target: { value: "trustAll" },
    });
    expect(screen.getByRole("alert")).toHaveTextContent(
      /auto-approve every tool/i,
    );
  });

  it("appends run-history entries from the automation event stream", async () => {
    render(<Automations />);
    await waitFor(() => screen.getByText("nightly triage"));
    expect(onRunHandler).toBeTypeOf("function");

    onRunHandler?.({
      ts: "2026-07-07T13:30:00+0200",
      automationId: "a1",
      sessionId: "sess-1234abcd",
      status: "created",
      message: null,
    });

    await waitFor(() =>
      expect(screen.getByText("created")).toBeInTheDocument(),
    );
  });

  it("deletes an automation only after confirmation", async () => {
    const { confirmDialog, automationRemove } = await import("./lib/ipc");
    vi.mocked(confirmDialog).mockResolvedValue(true);

    render(<Automations />);
    await waitFor(() => screen.getByText("nightly triage"));

    fireEvent.click(screen.getByLabelText("delete nightly triage"));
    await waitFor(() => expect(confirmDialog).toHaveBeenCalled());
    await waitFor(() => expect(automationRemove).toHaveBeenCalledWith("a1"));
  });

  it("does not delete an automation when confirmation is cancelled", async () => {
    const { confirmDialog, automationRemove } = await import("./lib/ipc");
    vi.mocked(confirmDialog).mockResolvedValueOnce(false);

    render(<Automations />);
    await waitFor(() => screen.getByText("nightly triage"));

    fireEvent.click(screen.getByLabelText("delete nightly triage"));
    await waitFor(() => expect(confirmDialog).toHaveBeenCalled());
    expect(automationRemove).not.toHaveBeenCalled();
  });
});
