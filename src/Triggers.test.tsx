import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import type { Trigger, TriggerRun } from "./lib/bindings";
import { useFleet } from "./lib/fleetStore";

const existing: Trigger = {
  id: "t1",
  name: "new PRs",
  enabled: true,
  source: {
    type: "command",
    program: "gh",
    args: ["pr", "list", "--json", "number,title,url,updatedAt"],
    cwd: "/repo",
  },
  outputFormat: "json",
  schedule: { type: "intervalSecs", secs: 300 },
  action: {
    type: "inline",
    prompt: "Review this PR.",
    target: {
      type: "newWorkspace",
      projectPath: "/repo",
      baseBranch: "main",
      branchPrefix: null,
      agent: null,
      model: null,
    },
    trust: { type: "ask" },
  },
  mode: "fanOut",
  maxRunsPerTick: 5,
  dedup: { watermark: null, seen: [] },
  lastRun: null,
  created: "2026-07-07T10:00:00+0200",
};

let onRunHandler: ((run: TriggerRun) => void) | null = null;

vi.mock("./lib/ipc", () => ({
  triggerList: vi.fn(async () => [existing]),
  triggerCreate: vi.fn(async (t: Trigger) => ({ ...t, id: "new-id" })),
  triggerUpdate: vi.fn(async (t: Trigger) => t),
  triggerRemove: vi.fn(async () => {}),
  triggerRunNow: vi.fn(async () => ({
    ts: "2026-07-07T12:00:00+0200",
    triggerId: "t1",
    sessionId: "sess-1234abcd",
    status: "dispatched",
    matched: 2,
    message: null,
  })),
  automationList: vi.fn(async () => []),
  confirmDialog: vi.fn(async () => true),
  onTriggerRun: vi.fn(async (h: (run: TriggerRun) => void) => {
    onRunHandler = h;
    return () => {};
  }),
}));

import Triggers from "./Triggers";

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

describe("Triggers panel", () => {
  it("shows a truthful loading state instead of flashing an empty list", async () => {
    const { triggerList } = await import("./lib/ipc");
    let resolveList!: (value: Trigger[]) => void;
    vi.mocked(triggerList).mockReturnValueOnce(
      new Promise((resolve) => {
        resolveList = resolve;
      }),
    );

    render(<Triggers />);
    expect(screen.getByRole("status")).toHaveTextContent(/loading triggers/i);
    expect(screen.queryByText(/no triggers yet/i)).not.toBeInTheDocument();

    resolveList([existing]);
    expect(await screen.findByText("new PRs")).toBeInTheDocument();
  });

  it("does not claim the list is empty when loading fails", async () => {
    const { triggerList } = await import("./lib/ipc");
    vi.mocked(triggerList).mockRejectedValueOnce(new Error("offline"));
    render(<Triggers />);

    expect(await screen.findByRole("alert")).toHaveTextContent(/offline/i);
    expect(screen.queryByText(/no triggers yet/i)).not.toBeInTheDocument();
  });

  it("lists existing triggers with schedule + source + action summary", async () => {
    render(<Triggers />);
    await waitFor(() => screen.getByText("new PRs"));
    expect(screen.getByText(/every 300s/)).toBeInTheDocument();
    expect(screen.getByText(/command: gh pr list/)).toBeInTheDocument();
    expect(screen.getByText(/inline action/)).toBeInTheDocument();
  });

  it("toggles enable through triggerUpdate", async () => {
    render(<Triggers />);
    await waitFor(() => screen.getByText("new PRs"));

    fireEvent.click(screen.getByLabelText("enable new PRs"));
    const { triggerUpdate } = await import("./lib/ipc");
    await waitFor(() =>
      expect(triggerUpdate).toHaveBeenCalledWith(
        expect.objectContaining({ id: "t1", enabled: false }),
      ),
    );
  });

  it("confirms before firing and relies on the event stream for history", async () => {
    render(<Triggers />);
    await waitFor(() => screen.getByText("new PRs"));

    fireEvent.click(screen.getByLabelText("test and fire new PRs"));
    const { confirmDialog, triggerRunNow } = await import("./lib/ipc");
    await waitFor(() =>
      expect(confirmDialog).toHaveBeenCalledWith(
        expect.stringMatching(/spend tokens.*same work again/i),
        "Test & fire trigger",
      ),
    );
    await waitFor(() => expect(triggerRunNow).toHaveBeenCalledWith("t1"));
    expect(screen.queryByText("dispatched")).not.toBeInTheDocument();

    onRunHandler?.({
      ts: "2026-07-07T12:00:00+0200",
      triggerId: "t1",
      sessionId: "sess-1234abcd",
      status: "dispatched",
      matched: 2,
      message: null,
    });

    await waitFor(() =>
      expect(screen.getByText("dispatched")).toBeInTheDocument(),
    );
    expect(screen.getAllByText("dispatched")).toHaveLength(1);
  });

  it("does not fire when the test confirmation is cancelled", async () => {
    const { confirmDialog, triggerRunNow } = await import("./lib/ipc");
    vi.mocked(confirmDialog).mockResolvedValueOnce(false);
    render(<Triggers />);
    await waitFor(() => screen.getByText("new PRs"));

    fireEvent.click(screen.getByLabelText("test and fire new PRs"));
    await waitFor(() => expect(confirmDialog).toHaveBeenCalled());
    expect(triggerRunNow).not.toHaveBeenCalled();
  });

  it("creates a command trigger with an inline new-workspace action", async () => {
    useFleet.setState({
      projects: [
        {
          path: "/repo",
          name: "repo",
          isGitRepo: true,
          baseBranch: "main",
          setupScript: "",
          checkScript: "",
        },
      ],
    });
    render(<Triggers />);
    await waitFor(() => screen.getByText("new PRs"));

    fireEvent.click(screen.getByRole("button", { name: /new trigger/i }));

    await waitFor(() =>
      expect(screen.getByLabelText("trigger name")).toHaveFocus(),
    );

    fireEvent.change(screen.getByLabelText("trigger name"), {
      target: { value: "watch CI" },
    });
    fireEvent.change(screen.getByLabelText("program"), {
      target: { value: "gh" },
    });
    fireEvent.change(screen.getByLabelText("arguments"), {
      target: { value: "pr\nlist\n--json\nnumber" },
    });
    fireEvent.change(screen.getByLabelText("inline prompt"), {
      target: { value: "Look at this." },
    });

    fireEvent.click(screen.getByRole("button", { name: /^create$/i }));

    const { triggerCreate } = await import("./lib/ipc");
    await waitFor(() =>
      expect(triggerCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          name: "watch CI",
          source: {
            type: "command",
            program: "gh",
            args: ["pr", "list", "--json", "number"],
            cwd: "/repo",
          },
          outputFormat: "json",
          mode: "fanOut",
          maxRunsPerTick: 5,
          action: expect.objectContaining({
            type: "inline",
            prompt: "Look at this.",
            target: expect.objectContaining({
              type: "newWorkspace",
              projectPath: "/repo",
            }),
          }),
        }),
      ),
    );
  });

  it("builds an HTTP GET detector with an env-referencing header", async () => {
    useFleet.getState().addSession({ sessionId: "target-session" });
    render(<Triggers />);
    await waitFor(() => screen.getByText("new PRs"));
    fireEvent.click(screen.getByRole("button", { name: /new trigger/i }));

    fireEvent.change(screen.getByLabelText("trigger name"), {
      target: { value: "api watch" },
    });
    fireEvent.change(screen.getByLabelText("source kind"), {
      target: { value: "httpGet" },
    });
    fireEvent.change(screen.getByLabelText("url"), {
      target: { value: "https://api.example.com/items" },
    });
    fireEvent.change(screen.getByLabelText("headers"), {
      target: { value: "Authorization: Bearer ${TOKEN}" },
    });
    // Route to an existing session to keep the target simple.
    fireEvent.change(screen.getByLabelText("target kind"), {
      target: { value: "existingSession" },
    });
    fireEvent.change(screen.getByLabelText("session"), {
      target: { value: "target-session" },
    });
    fireEvent.change(screen.getByLabelText("inline prompt"), {
      target: { value: "Handle it." },
    });

    fireEvent.click(screen.getByRole("button", { name: /^create$/i }));

    const { triggerCreate } = await import("./lib/ipc");
    await waitFor(() =>
      expect(triggerCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          source: {
            type: "httpGet",
            url: "https://api.example.com/items",
            headers: [{ name: "Authorization", value: "Bearer ${TOKEN}" }],
          },
        }),
      ),
    );
  });

  it("blocks creation until a detector and action are configured", async () => {
    render(<Triggers />);
    await waitFor(() => screen.getByText("new PRs"));
    fireEvent.click(screen.getByRole("button", { name: /new trigger/i }));

    // Name given but no prompt yet → create disabled, guidance shown.
    fireEvent.change(screen.getByLabelText("trigger name"), {
      target: { value: "incomplete" },
    });
    expect(screen.getByText(/choose a valid action/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^create$/i })).toBeDisabled();
  });

  it("warns that command detectors run with the user's permissions", async () => {
    render(<Triggers />);
    await waitFor(() => screen.getByText("new PRs"));
    fireEvent.click(screen.getByRole("button", { name: /new trigger/i }));
    expect(
      screen.getByText(/runs in this directory.*with your permissions/i),
    ).toBeInTheDocument();
  });

  it("appends run-history entries from the trigger event stream", async () => {
    render(<Triggers />);
    await waitFor(() => screen.getByText("new PRs"));
    expect(onRunHandler).toBeTypeOf("function");

    onRunHandler?.({
      ts: "2026-07-07T13:30:00+0200",
      triggerId: "t1",
      sessionId: "sess-1234abcd",
      status: "created",
      matched: 1,
      message: null,
    });

    await waitFor(() =>
      expect(screen.getByText("created")).toBeInTheDocument(),
    );
  });

  it("deletes a trigger only after confirmation", async () => {
    const { confirmDialog, triggerRemove } = await import("./lib/ipc");
    vi.mocked(confirmDialog).mockResolvedValue(true);

    render(<Triggers />);
    await waitFor(() => screen.getByText("new PRs"));

    fireEvent.click(screen.getByLabelText("delete new PRs"));
    await waitFor(() => expect(confirmDialog).toHaveBeenCalled());
    await waitFor(() => expect(triggerRemove).toHaveBeenCalledWith("t1"));
  });

  it("does not delete a trigger when confirmation is cancelled", async () => {
    const { confirmDialog, triggerRemove } = await import("./lib/ipc");
    vi.mocked(confirmDialog).mockResolvedValueOnce(false);

    render(<Triggers />);
    await waitFor(() => screen.getByText("new PRs"));

    fireEvent.click(screen.getByLabelText("delete new PRs"));
    await waitFor(() => expect(confirmDialog).toHaveBeenCalled());
    expect(triggerRemove).not.toHaveBeenCalled();
  });
});
