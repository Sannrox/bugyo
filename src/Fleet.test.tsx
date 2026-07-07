import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  render,
  screen,
  fireEvent,
  waitFor,
  act,
} from "@testing-library/react";
import type { AcpEvent } from "./lib/bindings";
import { useFleet } from "./lib/fleetStore";

const h = vi.hoisted(() => ({
  handler: null as null | ((e: AcpEvent) => void),
}));

vi.mock("./lib/ipc", () => ({
  ACP_EVENT: "acp:event",
  acpListSessions: vi.fn(async () => []),
  acpStartSession: vi.fn(async () => "sess-plain"),
  workspaceCreate: vi.fn(
    async (params: { task: string; repoRoot: string }) => ({
      sessionId: params.task === "feat a" ? "sess-a" : "sess-b",
      workspace: {
        repoRoot: params.repoRoot,
        baseBranch: "main",
        branch: params.task === "feat a" ? "feat-a" : "feat-b",
        worktreePath: `/wt/${params.task}`,
      },
    }),
  ),
  workspaceArchive: vi.fn(async () => {}),
  workspaceDiff: vi.fn(async () => "diff --git a/x b/x"),
  workspaceCheck: vi.fn(async () => ({
    success: true,
    exitCode: 0,
    stdout: "ok",
    stderr: "",
  })),
  workspaceMerge: vi.fn(async () => {}),
  workspaceMergePreview: vi.fn(async () => ({
    clean: true,
    conflictedFiles: [],
  })),
  workspaceOpenPr: vi.fn(async () => "https://example/pr/1"),
  acpCloseSession: vi.fn(async () => {}),
  acpDeleteSession: vi.fn(async () => {}),
  orchEnqueue: vi.fn(async () => {}),
  orchPreview: vi.fn(async () => ({
    ts: "",
    dryRun: true,
    dispatched: [],
    queuedRemaining: 0,
  })),
  orchHeartbeatSecs: vi.fn(async () => 10),
  orchLog: vi.fn(async () => []),
  projectList: vi.fn(async () => [
    { path: "/repo1", name: "repo1", isGitRepo: true },
  ]),
  projectAdd: vi.fn(async (path: string) => ({
    path,
    name: path.split("/").pop() ?? path,
    isGitRepo: true,
  })),
  projectRemove: vi.fn(async () => {}),
  trustProfileList: vi.fn(async () => []),
  trustProfileEffectiveTools: vi.fn(async () => []),
  sessionTranscript: vi.fn(async () => []),
  setAttentionBadge: vi.fn(async () => {}),
  budgetGet: vi.fn(async () => ({ sessionCap: null, projectCaps: [] })),
  pickDirectory: vi.fn(async () => null),
  confirmDialog: vi.fn(async () => true),
  messageDialog: vi.fn(async () => {}),
  acpCancel: vi.fn(async () => {}),
  acpRespondPermission: vi.fn(async () => {}),
  notify: vi.fn(async () => {}),
  onAcpEvent: vi.fn(async (cb: (e: AcpEvent) => void) => {
    h.handler = cb;
    return () => {};
  }),
  onOrchQueue: vi.fn(async () => () => {}),
  onOrchHeartbeat: vi.fn(async () => () => {}),
  onAutomationRun: vi.fn(async () => () => {}),
}));

import Fleet from "./Fleet";

async function createWorkspace(repo: string, task: string) {
  fireEvent.click(screen.getByRole("button", { name: /new session/i }));
  // The project must be registered (seeded via the projectList mock).
  await screen.findByRole("option", { name: "repo1" });
  fireEvent.change(screen.getByLabelText("project"), {
    target: { value: repo },
  });
  fireEvent.change(screen.getByLabelText("task"), { target: { value: task } });
  fireEvent.click(screen.getByRole("button", { name: /create workspace/i }));
}

describe("Fleet", () => {
  beforeEach(() => {
    h.handler = null;
    useFleet.setState({
      sessions: {},
      order: [],
      activeId: null,
      secondaryId: null,
    });
  });

  it("manages two workspaces and routes events to the active pane", async () => {
    render(<Fleet />);
    await waitFor(() => expect(h.handler).not.toBeNull());

    await createWorkspace("/repo1", "feat a");
    await screen.findByRole("button", { name: /feat-a/i });
    await createWorkspace("/repo1", "feat b");
    await screen.findByRole("button", { name: /feat-b/i });

    // Both appear in the sidebar under the project.
    const sidebar = screen.getByRole("navigation", { name: /workspaces/i });
    expect(sidebar).toHaveTextContent("feat-a");
    expect(sidebar).toHaveTextContent("feat-b");

    // Stream a message to session A while B is active — routed to A's state.
    act(() => {
      h.handler!({ type: "agentMessage", sessionId: "sess-a", text: "hi A" });
      h.handler!({ type: "status", sessionId: "sess-a", status: "idle" });
    });
    // B is active; its transcript is empty.
    expect(screen.getByLabelText("transcript")).not.toHaveTextContent("hi A");

    // Switch to A → its message is shown.
    fireEvent.click(screen.getByRole("button", { name: /feat-a/i }));
    await waitFor(() =>
      expect(screen.getByLabelText("transcript")).toHaveTextContent("hi A"),
    );
  });

  it("shows two sessions side by side in a split view", async () => {
    render(<Fleet />);
    await waitFor(() => expect(h.handler).not.toBeNull());

    await createWorkspace("/repo1", "feat a");
    await screen.findByRole("button", { name: /feat-a/i });
    await createWorkspace("/repo1", "feat b");
    await screen.findByRole("button", { name: /feat-b/i });

    // Active is sess-b; open sess-a alongside it via the split affordance.
    fireEvent.click(
      screen.getByRole("button", { name: /open in split view/i }),
    );
    await waitFor(() =>
      expect(screen.getAllByLabelText("transcript")).toHaveLength(2),
    );

    // Each pane reflects its own session's stream. Events are batched and
    // flushed on an animation frame, so await the committed update.
    act(() => {
      h.handler!({ type: "agentMessage", sessionId: "sess-a", text: "from A" });
      h.handler!({ type: "agentMessage", sessionId: "sess-b", text: "from B" });
    });
    await waitFor(() => {
      const text = screen
        .getAllByLabelText("transcript")
        .map((p) => p.textContent)
        .join(" ");
      expect(text).toContain("from A");
      expect(text).toContain("from B");
    });

    // Unsplit collapses back to a single pane.
    fireEvent.click(screen.getByRole("button", { name: /^unsplit$/i }));
    await waitFor(() =>
      expect(screen.getAllByLabelText("transcript")).toHaveLength(1),
    );
  });

  it("enqueues a prompt to the active session", async () => {
    render(<Fleet />);
    await waitFor(() => expect(h.handler).not.toBeNull());

    await createWorkspace("/repo1", "feat a");
    await screen.findByRole("button", { name: /feat-a/i });

    fireEvent.change(screen.getByLabelText("prompt"), {
      target: { value: "do the thing" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^send$/i }));

    const { orchEnqueue } = await import("./lib/ipc");
    await waitFor(() =>
      expect(orchEnqueue).toHaveBeenCalledWith("sess-a", "do the thing"),
    );
  });

  it("gates merge on a green check run", async () => {
    render(<Fleet />);
    await waitFor(() => expect(h.handler).not.toBeNull());

    await createWorkspace("/repo1", "feat a");
    await screen.findByRole("button", { name: /feat-a/i });

    // Open the review panel.
    fireEvent.click(screen.getByText(/review & merge/i));

    // Merge is disabled before checks pass.
    const mergeBtn = screen.getByRole("button", { name: /^merge$/i });
    expect(mergeBtn).toBeDisabled();

    // Run checks (mock returns success).
    fireEvent.change(screen.getByLabelText("check script"), {
      target: { value: "cargo test" },
    });
    fireEvent.click(screen.getByRole("button", { name: /run checks/i }));

    const { workspaceCheck } = await import("./lib/ipc");
    await waitFor(() =>
      expect(workspaceCheck).toHaveBeenCalledWith("sess-a", "cargo test"),
    );
    await screen.findByText(/checks passed/i);

    // Now merge is enabled.
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /^merge$/i })).toBeEnabled(),
    );
  });

  it("restores a resumed session's transcript from kiro", async () => {
    const { sessionTranscript } = await import("./lib/ipc");
    vi.mocked(sessionTranscript).mockResolvedValueOnce([
      { kind: "user", text: "earlier question" },
      { kind: "agent", text: "earlier answer" },
    ]);

    render(<Fleet />);
    await waitFor(() => expect(h.handler).not.toBeNull());

    await createWorkspace("/repo1", "feat a");
    await screen.findByRole("button", { name: /feat-a/i });

    await waitFor(() =>
      expect(screen.getByLabelText("transcript")).toHaveTextContent(
        "earlier question",
      ),
    );
    expect(screen.getByLabelText("transcript")).toHaveTextContent(
      "earlier answer",
    );
  });

  it("surfaces a pending approval in the attention inbox", async () => {
    render(<Fleet />);
    await waitFor(() => expect(h.handler).not.toBeNull());

    await createWorkspace("/repo1", "feat a");
    await screen.findByRole("button", { name: /feat-a/i });

    // A tool call pauses the session.
    act(() => {
      h.handler!({
        type: "permissionRequested",
        sessionId: "sess-a",
        requestId: "req-1",
        toolCallId: "tc1",
        title: "Write file.txt",
        options: [
          { optionId: "allow_once", name: "Yes", kind: "allow_once" },
          { optionId: "reject_once", name: "No", kind: "reject_once" },
        ],
      });
      h.handler!({
        type: "status",
        sessionId: "sess-a",
        status: "needsApproval",
      });
    });

    // The Attention item shows a count; open it and approve from there.
    const attention = screen.getByRole("button", { name: /attention/i });
    await waitFor(() => expect(attention).toHaveTextContent("1"));
    fireEvent.click(attention);

    expect(screen.getByText("Needs attention")).toBeInTheDocument();
    expect(screen.getByText(/Write file\.txt/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Yes" }));

    const { acpRespondPermission } = await import("./lib/ipc");
    await waitFor(() =>
      expect(acpRespondPermission).toHaveBeenCalledWith(
        "sess-a",
        "req-1",
        "allow_once",
      ),
    );
  });

  it("updates the OS attention badge when a session needs approval", async () => {
    render(<Fleet />);
    await waitFor(() => expect(h.handler).not.toBeNull());

    await createWorkspace("/repo1", "feat a");
    await screen.findByRole("button", { name: /feat-a/i });

    act(() => {
      h.handler!({
        type: "status",
        sessionId: "sess-a",
        status: "needsApproval",
      });
    });

    const { setAttentionBadge } = await import("./lib/ipc");
    await waitFor(() => expect(setAttentionBadge).toHaveBeenCalledWith(1));
  });

  it("shows a Stop button while working and cancels the turn", async () => {
    render(<Fleet />);
    await waitFor(() => expect(h.handler).not.toBeNull());

    await createWorkspace("/repo1", "feat a");
    await screen.findByRole("button", { name: /feat-a/i });

    act(() => {
      h.handler!({ type: "status", sessionId: "sess-a", status: "working" });
    });

    // Status arrives via the batched flush; wait for the Stop affordance.
    fireEvent.click(await screen.findByRole("button", { name: /^stop$/i }));
    const { acpCancel } = await import("./lib/ipc");
    await waitFor(() => expect(acpCancel).toHaveBeenCalledWith("sess-a"));
  });

  it("close keeps the session (resumable); delete removes it", async () => {
    render(<Fleet />);
    await waitFor(() => expect(h.handler).not.toBeNull());

    await createWorkspace("/repo1", "feat a");
    await screen.findByRole("button", { name: /feat-a/i });

    // Close releases the process but keeps the session in the sidebar.
    fireEvent.click(screen.getByRole("button", { name: /^close$/i }));
    const { acpCloseSession, acpDeleteSession } = await import("./lib/ipc");
    await waitFor(() => expect(acpCloseSession).toHaveBeenCalledWith("sess-a"));
    // Deselected → composer shown, but the session is still listed.
    await screen.findByRole("heading", { name: /what should bugyo run/i });
    expect(screen.getByRole("button", { name: /feat-a/i })).toBeInTheDocument();

    // Reselect and delete via the sidebar row's action menu → removed.
    fireEvent.click(screen.getByRole("button", { name: /feat-a/i }));
    fireEvent.click(screen.getByRole("button", { name: /session actions/i }));
    fireEvent.click(screen.getByRole("menuitem", { name: /delete session/i }));
    await waitFor(() =>
      expect(acpDeleteSession).toHaveBeenCalledWith("sess-a"),
    );
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: /feat-a/i })).toBeNull(),
    );
  });
});
