import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import type { AcpEvent } from "./lib/bindings";
import { useFleet } from "./lib/fleetStore";
import { useSettings } from "./lib/settingsStore";

vi.mock("./lib/ipc", () => ({
  orchEnqueue: vi.fn(async () => {}),
  orchQueue: vi.fn(async () => []),
  orchQueueReplace: vi.fn(async () => {}),
  acpCloseSession: vi.fn(async () => {}),
  acpDeleteSession: vi.fn(async () => {}),
  acpPromptWithScreenshot: vi.fn(async () => "end_turn"),
  acpRespondPermission: vi.fn(async () => {}),
  workspaceArchive: vi.fn(async () => {}),
  workspaceCommit: vi.fn(async () => {}),
  confirmDialog: vi.fn(async () => true),
  notify: vi.fn(async () => {}),
  sessionTranscript: vi.fn(async () => []),
}));

import SessionPane from "./SessionPane";

/** Seed a plain (workspace-less) session with a capability inventory. */
function seedSession() {
  vi.clearAllMocks();
  useSettings.setState({ showReasoning: true, toolDisplay: "all" });
  useFleet.setState({ sessions: {}, order: [], activeId: null });
  const { addSession, applyEvent } = useFleet.getState();
  addSession({ sessionId: "s1" });
  const caps: AcpEvent = {
    type: "capabilities",
    sessionId: "s1",
    commands: [
      { name: "/clear", description: "Clear conversation history" },
      { name: "/compact", description: "Compact conversation history" },
    ],
    prompts: [
      {
        name: "autoreview",
        description: "Pre-commit review",
        serverName: "skill:config",
      },
    ],
    tools: [{ name: "code", description: "Code intel", source: "built-in" }],
    mcpServers: [{ name: "chrome-devtools", status: "running", toolCount: 29 }],
  };
  applyEvent(caps);
  applyEvent({
    type: "subagents",
    sessionId: "s1",
    subagents: [{ name: "reviewer" }],
  });
}

function promptBox() {
  return screen.getByLabelText("prompt");
}

describe("SessionPane — capability palette", () => {
  beforeEach(seedSession);

  it("opens a palette of commands and prompts when typing '/'", () => {
    render(<SessionPane sessionId="s1" />);
    fireEvent.change(promptBox(), { target: { value: "/" } });

    const list = screen.getByRole("listbox", { name: /commands and prompts/i });
    expect(list).toHaveTextContent("/clear");
    expect(list).toHaveTextContent("/compact");
    expect(list).toHaveTextContent("autoreview"); // a skill (prompt)
  });

  it("filters the palette as the query narrows", () => {
    render(<SessionPane sessionId="s1" />);
    fireEvent.change(promptBox(), { target: { value: "/cl" } });

    const options = screen.getAllByRole("option");
    expect(options).toHaveLength(1);
    expect(options[0]).toHaveTextContent("/clear");
  });

  it("selects with arrow keys + Enter, filling the input and closing the palette", () => {
    render(<SessionPane sessionId="s1" />);
    const box = promptBox();
    fireEvent.change(box, { target: { value: "/" } });

    // Highlight the second item (/compact) then select it.
    fireEvent.keyDown(box, { key: "ArrowDown" });
    fireEvent.keyDown(box, { key: "Enter" });

    expect((box as HTMLTextAreaElement).value).toBe("/compact ");
    expect(screen.queryByRole("listbox")).toBeNull(); // palette closed
  });

  it("closes the palette on Escape without changing the input", () => {
    render(<SessionPane sessionId="s1" />);
    const box = promptBox();
    fireEvent.change(box, { target: { value: "/" } });
    expect(screen.getByRole("listbox")).toBeInTheDocument();

    fireEvent.keyDown(box, { key: "Escape" });
    expect(screen.queryByRole("listbox")).toBeNull();
    expect((box as HTMLTextAreaElement).value).toBe("/");
  });

  it("sends a selected command through orchEnqueue (actionable)", async () => {
    render(<SessionPane sessionId="s1" />);
    const box = promptBox();
    fireEvent.change(box, { target: { value: "/cl" } });
    fireEvent.keyDown(box, { key: "Enter" }); // select the only match, /clear
    expect((box as HTMLTextAreaElement).value).toBe("/clear ");

    fireEvent.click(screen.getByRole("button", { name: /^send$/i }));

    const { orchEnqueue } = await import("./lib/ipc");
    await waitFor(() =>
      expect(orchEnqueue).toHaveBeenCalledWith("s1", "/clear"),
    );
  });

  it("submits a command with arguments via Enter without wiping the args", async () => {
    render(<SessionPane sessionId="s1" />);
    const box = promptBox();

    // Select /clear from the palette, then type arguments after it.
    fireEvent.change(box, { target: { value: "/cl" } });
    fireEvent.keyDown(box, { key: "Enter" }); // fills "/clear "
    fireEvent.change(box, {
      target: { value: "/clear keep the last message" },
    });

    // Palette must not be open once the user is typing arguments…
    expect(screen.queryByRole("listbox")).toBeNull();

    // …and Enter must submit the full command instead of re-selecting it.
    fireEvent.keyDown(box, { key: "Enter" });
    expect((box as HTMLTextAreaElement).value).toBe(""); // input cleared on send

    const { orchEnqueue } = await import("./lib/ipc");
    await waitFor(() =>
      expect(orchEnqueue).toHaveBeenCalledWith(
        "s1",
        "/clear keep the last message",
      ),
    );
  });
});

describe("SessionPane — screenshot prompt", () => {
  beforeEach(seedSession);

  it("sends the typed prompt with a screenshot via acpPromptWithScreenshot", async () => {
    render(<SessionPane sessionId="s1" />);
    fireEvent.change(promptBox(), { target: { value: "critique the layout" } });

    fireEvent.click(screen.getByRole("button", { name: /^screenshot$/i }));

    const { acpPromptWithScreenshot } = await import("./lib/ipc");
    await waitFor(() =>
      expect(acpPromptWithScreenshot).toHaveBeenCalledWith(
        "s1",
        "critique the layout",
      ),
    );
  });

  it("falls back to a default critique prompt when the input is empty", async () => {
    render(<SessionPane sessionId="s1" />);

    fireEvent.click(screen.getByRole("button", { name: /^screenshot$/i }));

    const { acpPromptWithScreenshot } = await import("./lib/ipc");
    await waitFor(() => expect(acpPromptWithScreenshot).toHaveBeenCalled());
    const text = (acpPromptWithScreenshot as ReturnType<typeof vi.fn>).mock
      .lastCall?.[1];
    expect(String(text).toLowerCase()).toContain("screenshot");
  });
});

describe("SessionPane — capabilities reference panel", () => {
  beforeEach(seedSession);

  it("lists tools, MCP servers, and subagents with counts", () => {
    render(<SessionPane sessionId="s1" />);
    const details = screen.getByText(/Capabilities/i).closest("details")!;
    expect(details).toHaveTextContent("1 tools");
    expect(details).toHaveTextContent("1 MCP");
    expect(details).toHaveTextContent("1 subagents");
    expect(details).toHaveTextContent("code"); // tool
    expect(details).toHaveTextContent("chrome-devtools"); // mcp server
    expect(details).toHaveTextContent("reviewer"); // subagent
  });

  it("toggles open on summary click", () => {
    render(<SessionPane sessionId="s1" />);
    const summary = screen.getByText(/Capabilities/i).closest("summary")!;
    const details = summary.closest("details")!;
    expect(details.open).toBe(false);
    fireEvent.click(summary);
    expect(details.open).toBe(true);
  });
});

describe("SessionPane — compact split header", () => {
  beforeEach(() => {
    seedSession();
    useFleet.getState().addSession({ sessionId: "s2" });
    useFleet.getState().setActive("s1");
    useFleet.getState().openSplit("s2");
  });

  it("keeps lifecycle actions in the overflow menu", () => {
    const { container } = render(<SessionPane sessionId="s1" />);

    expect(container.querySelector(".pane--split")).not.toBeNull();
    expect(
      screen.queryByRole("button", { name: /close split view/i }),
    ).toBeNull();
    expect(screen.queryByRole("button", { name: /stop agent/i })).toBeNull();

    fireEvent.click(
      screen.getByRole("button", { name: /more session actions/i }),
    );

    expect(
      screen.getByRole("menuitem", { name: /close split view/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("menuitem", { name: /stop agent/i }),
    ).toBeInTheDocument();
  });

  it("closes split view from the overflow action", () => {
    render(<SessionPane sessionId="s1" />);
    fireEvent.click(
      screen.getByRole("button", { name: /more session actions/i }),
    );
    fireEvent.click(
      screen.getByRole("menuitem", { name: /close split view/i }),
    );

    expect(useFleet.getState().secondaryId).toBeNull();
  });
});

describe("SessionPane — per-message actions", () => {
  beforeEach(seedSession);

  it("copies a message to the clipboard", async () => {
    const writeText = vi.fn(async () => {});
    Object.assign(navigator, { clipboard: { writeText } });

    const { appendUserMessage } = useFleet.getState();
    appendUserMessage("s1", "hello world");

    render(<SessionPane sessionId="s1" />);
    fireEvent.click(screen.getByRole("button", { name: /copy message/i }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("hello world"));
  });

  it("retries (re-sends) a previous user prompt", async () => {
    const { appendUserMessage } = useFleet.getState();
    appendUserMessage("s1", "run the tests");

    render(<SessionPane sessionId="s1" />);
    fireEvent.click(screen.getByRole("button", { name: /retry message/i }));

    const { orchEnqueue } = await import("./lib/ipc");
    await waitFor(() =>
      expect(orchEnqueue).toHaveBeenCalledWith("s1", "run the tests"),
    );
  });
});

describe("SessionPane — tool output", () => {
  beforeEach(seedSession);

  it("renders a tool call's output in a collapsible block", () => {
    const { applyEvent } = useFleet.getState();
    applyEvent({
      type: "toolCall",
      sessionId: "s1",
      toolCallId: "t1",
      title: "Running ls",
      status: "completed",
      diff: null,
      output: "file-a.txt\nfile-b.txt",
    });

    render(<SessionPane sessionId="s1" />);
    const details = screen.getByText("Output").closest("details")!;
    expect(details).toHaveTextContent("file-a.txt");
    expect(details).toHaveTextContent("file-b.txt");
  });
});

describe("SessionPane — reasoning (thinking)", () => {
  beforeEach(seedSession);

  it("renders agent reasoning in a collapsible Thinking block", () => {
    useFleet.getState().applyEvent({
      type: "agentThought",
      sessionId: "s1",
      text: "weighing options",
    });

    render(<SessionPane sessionId="s1" />);
    const details = screen.getByText(/thinking/i).closest("details")!;
    expect(details).toHaveTextContent("weighing options");
  });
});

describe("SessionPane — global display settings", () => {
  beforeEach(() => {
    seedSession();
    useSettings.setState({ showReasoning: true, toolDisplay: "all" });
  });

  function emitThoughtAndTools() {
    const { applyEvent } = useFleet.getState();
    applyEvent({ type: "agentThought", sessionId: "s1", text: "reasoning" });
    applyEvent({
      type: "toolCall",
      sessionId: "s1",
      toolCallId: "read1",
      title: "Read a.txt",
      status: "completed",
      diff: null,
      output: null,
    });
    applyEvent({
      type: "toolCall",
      sessionId: "s1",
      toolCallId: "edit1",
      title: "Edit b.txt",
      status: "completed",
      diff: { path: "b.txt", oldText: "x", newText: "y" },
      output: null,
    });
  }

  it("hides reasoning when showReasoning is off", () => {
    useSettings.setState({ showReasoning: false });
    emitThoughtAndTools();
    render(<SessionPane sessionId="s1" />);
    expect(screen.queryByText(/thinking/i)).toBeNull();
  });

  it("shows only file edits when toolDisplay is 'edits'", () => {
    useSettings.setState({ toolDisplay: "edits" });
    emitThoughtAndTools();
    render(<SessionPane sessionId="s1" />);
    expect(screen.getByText("Edit b.txt")).toBeInTheDocument();
    expect(screen.queryByText("Read a.txt")).toBeNull();
  });

  it("hides all tool calls when toolDisplay is 'hidden'", () => {
    useSettings.setState({ toolDisplay: "hidden" });
    emitThoughtAndTools();
    render(<SessionPane sessionId="s1" />);
    expect(screen.queryByText("Edit b.txt")).toBeNull();
    expect(screen.queryByText("Read a.txt")).toBeNull();
    // Reasoning is still shown (independent setting).
    expect(screen.getByText(/thinking/i)).toBeInTheDocument();
  });
});

describe("SessionPane — tool call grouping", () => {
  beforeEach(seedSession);

  function emitTool(id: string, title: string, status: string | null) {
    useFleet.getState().applyEvent({
      type: "toolCall",
      sessionId: "s1",
      toolCallId: id,
      title,
      status,
      diff: null,
      output: null,
    });
  }

  it("collapses a run of consecutive tool calls under one summary", () => {
    emitTool("t1", "Read a.txt", "completed");
    emitTool("t2", "Read b.txt", "completed");
    emitTool("t3", "Read c.txt", "completed");

    render(<SessionPane sessionId="s1" />);

    // A single group summary with the count; collapsed by default (all done).
    const summary = screen.getByText(/3 tool calls/i);
    const details = summary.closest("details")!;
    expect(details.open).toBe(false);

    // Expanding reveals each individual tool call.
    fireEvent.click(summary);
    expect(details).toHaveTextContent("Read a.txt");
    expect(details).toHaveTextContent("Read b.txt");
    expect(details).toHaveTextContent("Read c.txt");
  });

  it("stays expanded while a call in the run is still running", () => {
    emitTool("t1", "Read a.txt", "completed");
    emitTool("t2", "Editing b.txt", null); // in progress

    render(<SessionPane sessionId="s1" />);
    const details = screen.getByText(/2 tool calls/i).closest("details")!;
    expect(details.open).toBe(true);
    expect(details).toHaveTextContent("running");
  });

  it("renders a lone tool call inline, without a group wrapper", () => {
    emitTool("t1", "Read only.txt", "completed");

    render(<SessionPane sessionId="s1" />);
    expect(screen.queryByText(/tool calls/i)).toBeNull();
    expect(screen.getByText("Read only.txt")).toBeInTheDocument();
  });
});
