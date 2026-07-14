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
  it("shows a truthful loading state instead of flashing an empty list", async () => {
    const { automationList } = await import("./lib/ipc");
    let resolveList!: (value: Automation[]) => void;
    vi.mocked(automationList).mockReturnValueOnce(
      new Promise((resolve) => {
        resolveList = resolve;
      }),
    );

    render(<Automations />);
    expect(screen.getByRole("status")).toHaveTextContent(
      /loading automations/i,
    );
    expect(screen.queryByText(/no automations yet/i)).not.toBeInTheDocument();

    resolveList([existing]);
    expect(await screen.findByText("nightly triage")).toBeInTheDocument();
  });

  it("does not claim the list is empty when loading fails", async () => {
    const { automationList } = await import("./lib/ipc");
    vi.mocked(automationList).mockRejectedValueOnce(new Error("offline"));
    render(<Automations />);

    expect(await screen.findByRole("alert")).toHaveTextContent(/offline/i);
    expect(screen.queryByText(/no automations yet/i)).not.toBeInTheDocument();
  });

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

  it("prevents duplicate run-now submissions while a run is pending", async () => {
    const { automationRunNow } = await import("./lib/ipc");
    let resolveRun!: (value: AutomationRun) => void;
    vi.mocked(automationRunNow).mockReturnValueOnce(
      new Promise((resolve) => {
        resolveRun = resolve;
      }),
    );
    render(<Automations />);
    await screen.findByText("nightly triage");

    const runButton = screen.getByLabelText("run nightly triage now");
    fireEvent.click(runButton);
    fireEvent.click(runButton);
    expect(automationRunNow).toHaveBeenCalledTimes(1);
    expect(runButton).toBeDisabled();
    expect(runButton).toHaveTextContent(/running/i);

    resolveRun({
      ts: "2026-07-07T12:00:00+0200",
      automationId: "a1",
      sessionId: "sess-1234abcd",
      status: "dispatched",
      message: null,
    });
    await waitFor(() => expect(runButton).not.toBeDisabled());
  });

  it("creates a new automation from the form", async () => {
    useFleet.getState().addSession({ sessionId: "target-session" });
    render(<Automations />);
    await waitFor(() => screen.getByText("nightly triage"));

    fireEvent.click(screen.getByRole("button", { name: /new automation/i }));

    fireEvent.change(screen.getByLabelText("automation name"), {
      target: { value: "morning brief" },
    });
    fireEvent.change(screen.getByLabelText("durable prompt"), {
      target: { value: "Summarise overnight commits." },
    });
    fireEvent.click(screen.getByRole("button", { name: /^create$/i }));

    const { automationCreate } = await import("./lib/ipc");
    await waitFor(() =>
      expect(automationCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          name: "morning brief",
          prompt: "Summarise overnight commits.",
          schedule: { type: "intervalSecs", secs: 3600 },
          trust: { type: "ask" },
          target: {
            type: "existingSession",
            sessionId: "target-session",
          },
        }),
      ),
    );
  });

  it("prevents duplicate automation creation before the disabled state paints", async () => {
    const { automationCreate } = await import("./lib/ipc");
    let resolveCreate!: (value: Automation) => void;
    vi.mocked(automationCreate).mockReturnValueOnce(
      new Promise((resolve) => {
        resolveCreate = resolve;
      }),
    );
    useFleet.getState().addSession({ sessionId: "target-session" });
    render(<Automations />);
    await screen.findByText("nightly triage");
    fireEvent.click(screen.getByRole("button", { name: /new automation/i }));
    fireEvent.change(screen.getByLabelText("automation name"), {
      target: { value: "single create" },
    });
    fireEvent.change(screen.getByLabelText("durable prompt"), {
      target: { value: "Run exactly once." },
    });
    const form = screen
      .getByRole("button", { name: /^create$/i })
      .closest("form")!;

    fireEvent.submit(form);
    fireEvent.submit(form);
    expect(automationCreate).toHaveBeenCalledTimes(1);

    resolveCreate({
      ...existing,
      id: "new-id",
      name: "single create",
      prompt: "Run exactly once.",
      target: { type: "existingSession", sessionId: "target-session" },
    });
    await waitFor(() =>
      expect(screen.queryByText("Create automation")).not.toBeInTheDocument(),
    );
  });

  it("explains and blocks an automation with no valid target", async () => {
    render(<Automations />);
    await waitFor(() => screen.getByText("nightly triage"));
    fireEvent.click(screen.getByRole("button", { name: /new automation/i }));

    await waitFor(() =>
      expect(screen.getByLabelText("automation name")).toHaveFocus(),
    );

    fireEvent.change(screen.getByLabelText("automation name"), {
      target: { value: "morning brief" },
    });
    fireEvent.change(screen.getByLabelText("durable prompt"), {
      target: { value: "Summarise overnight commits." },
    });

    expect(screen.getByText(/choose a valid target/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^create$/i })).toBeDisabled();
  });

  it("explains and blocks invalid interval values", async () => {
    useFleet.getState().addSession({ sessionId: "target-session" });
    render(<Automations />);
    await screen.findByText("nightly triage");
    fireEvent.click(screen.getByRole("button", { name: /new automation/i }));
    fireEvent.change(screen.getByLabelText("automation name"), {
      target: { value: "fast loop" },
    });
    fireEvent.change(screen.getByLabelText("durable prompt"), {
      target: { value: "Check continuously." },
    });

    const interval = screen.getByLabelText("interval seconds");
    fireEvent.change(interval, { target: { value: "0" } });

    expect(interval).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByText(/at least 1 whole second/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^create$/i })).toBeDisabled();
  });

  it("does not offer unsafe trust-all and explains the approval boundary", async () => {
    render(<Automations />);
    await waitFor(() => screen.getByText("nightly triage"));
    fireEvent.click(screen.getByRole("button", { name: /new automation/i }));

    expect(
      screen.queryByRole("option", { name: /trust all/i }),
    ).not.toBeInTheDocument();
    expect(screen.getByText(/always require approval/i)).toBeInTheDocument();
  });

  it("labels persisted legacy trust-all automations as safely disabled", async () => {
    const { automationList } = await import("./lib/ipc");
    vi.mocked(automationList).mockResolvedValueOnce([
      { ...existing, trust: { type: "trustAll" } },
    ]);
    render(<Automations />);

    expect(
      await screen.findByText(/legacy trust-all disabled; approvals required/i),
    ).toBeInTheDocument();
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
