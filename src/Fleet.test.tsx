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
import { useSettings } from "./lib/settingsStore";

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
        task: params.task === "feat a" ? "feat-a" : "feat-b",
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
  workspaceCommit: vi.fn(async () => {}),
  workspacePush: vi.fn(async () => {}),
  workspaceReviewState: vi.fn(async () => ({
    stage: "needsReview",
    hasChanges: true,
    hasUncommittedChanges: false,
    changedFiles: ["src/main.rs"],
    lastCheck: null,
  })),
  acpCloseSession: vi.fn(async () => {}),
  acpDeleteSession: vi.fn(async () => {}),
  orchEnqueue: vi.fn(async () => {}),
  orchQueue: vi.fn(async () => []),
  orchQueueReplace: vi.fn(async () => {}),
  orchPreview: vi.fn(async () => ({
    ts: "",
    dryRun: true,
    dispatched: [],
    queuedRemaining: 0,
  })),
  orchHeartbeatSecs: vi.fn(async () => 10),
  orchLog: vi.fn(async () => []),
  projectList: vi.fn(async () => [
    {
      path: "/repo1",
      name: "repo1",
      isGitRepo: true,
      baseBranch: "main",
      setupScript: "",
      checkScript: "",
    },
  ]),
  projectAdd: vi.fn(async (path: string) => ({
    path,
    name: path.split("/").pop() ?? path,
    isGitRepo: true,
    baseBranch: "main",
    setupScript: "",
    checkScript: "",
  })),
  projectRemove: vi.fn(async () => {}),
  trustProfileList: vi.fn(async () => []),
  trustProfileEffectiveTools: vi.fn(async () => []),
  sessionTranscript: vi.fn(async () => []),
  sessionSearch: vi.fn(async () => []),
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
  onTriggerRun: vi.fn(async () => () => {}),
}));

import Fleet from "./Fleet";

async function createWorkspace(repo: string, task: string) {
  fireEvent.click(screen.getByRole("button", { name: /new chat/i }));
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
    vi.clearAllMocks();
    h.handler = null;
    useFleet.setState({
      sessions: {},
      order: [],
      activeId: null,
      secondaryId: null,
      panel: null,
      projects: [],
      errors: [],
    });
    useSettings.setState({ sidebarCollapsed: false });
  });

  it("removes the collapsed sidebar from keyboard and accessibility navigation", () => {
    render(<Fleet />);

    expect(
      screen.getByRole("navigation", { name: /workspaces/i }),
    ).toBeInTheDocument();
    act(() => useSettings.setState({ sidebarCollapsed: true }));

    expect(
      screen.queryByRole("navigation", { name: /workspaces/i }),
    ).not.toBeInTheDocument();
  });

  it("surfaces startup failures and retries hydration in place", async () => {
    const { projectList } = await import("./lib/ipc");
    vi.mocked(projectList).mockRejectedValueOnce(
      new Error("project store offline"),
    );
    render(<Fleet />);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      /unable to load projects.*project store offline/i,
    );
    fireEvent.click(
      screen.getByRole("button", { name: /retry startup loads/i }),
    );

    await waitFor(() => expect(projectList).toHaveBeenCalledTimes(2));
    expect(
      await screen.findByRole("option", { name: "repo1" }),
    ).toBeInTheDocument();
  });

  it("surfaces event subscription failures instead of losing live updates silently", async () => {
    const { onOrchQueue } = await import("./lib/ipc");
    vi.mocked(onOrchQueue).mockRejectedValueOnce(
      new Error("event bridge down"),
    );
    render(<Fleet />);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      /unable to subscribe to queue updates.*event bridge down/i,
    );
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
    await waitFor(() =>
      expect(useFleet.getState().sessions["sess-a"]?.review?.stage).toBe(
        "needsReview",
      ),
    );
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

    // Secondary lifecycle actions stay available without crowding the compact
    // split header.
    fireEvent.click(
      screen.getAllByRole("button", { name: /more session actions/i })[0],
    );
    fireEvent.click(
      screen.getByRole("menuitem", { name: /close split view/i }),
    );
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

  it("keeps follow-up conversation visible beside backend-derived review", async () => {
    render(<Fleet />);
    await waitFor(() => expect(h.handler).not.toBeNull());

    await createWorkspace("/repo1", "feat a");
    await screen.findByRole("button", { name: /feat-a/i });

    const { workspaceReviewState } = await import("./lib/ipc");
    vi.mocked(workspaceReviewState)
      .mockResolvedValueOnce({
        stage: "needsReview",
        hasChanges: true,
        hasUncommittedChanges: false,
        changedFiles: ["src/main.rs"],
        lastCheck: null,
        checkCurrent: false,
      })
      .mockResolvedValueOnce({
        stage: "readyToLand",
        hasChanges: true,
        hasUncommittedChanges: false,
        changedFiles: ["src/main.rs"],
        lastCheck: {
          script: "cargo test",
          success: true,
          exitCode: 0,
          completedAt: "2026-07-10T12:00:00Z",
          changeFingerprint: "abc",
        },
        checkCurrent: true,
      });

    // Open the inspector without replacing the conversation or composer.
    fireEvent.click(screen.getByRole("button", { name: /^review$/i }));
    await screen.findByRole("region", { name: /workspace review/i });
    expect(screen.getByLabelText("transcript")).toBeInTheDocument();
    expect(screen.getByLabelText("prompt")).toBeInTheDocument();

    // Push is disabled until the changes are committed (ready to land) — this
    // is gated on commit state, not on checks.
    const pushBtn = screen.getByRole("button", { name: /^push$/i });
    expect(pushBtn).toBeDisabled();

    // A refresh observes the committed, ready-to-land state (and the agent's
    // own recorded check surfaces as informational evidence).
    fireEvent.click(screen.getByRole("button", { name: /refresh review/i }));
    await screen.findByText(/checks passed/i);

    // Now push is enabled.
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /^push$/i })).toBeEnabled(),
    );
  });

  it("resolves review state when the agent finishes, without running or grading checks", async () => {
    render(<Fleet />);
    await waitFor(() => expect(h.handler).not.toBeNull());

    await createWorkspace("/repo1", "feat a");
    await screen.findByRole("button", { name: /feat-a/i });
    // Even with a check command configured, the harness must not run it: the
    // agent verifies its own work (its own tooling or a Kiro hook).
    const project = useFleet.getState().projects[0];
    useFleet.getState().updateProject({
      ...project,
      checkScript: "cargo test",
    });

    const { orchEnqueue, workspaceCheck, workspaceReviewState } =
      await import("./lib/ipc");
    vi.mocked(workspaceReviewState)
      .mockReset()
      .mockResolvedValue({
        stage: "needsReview",
        hasChanges: true,
        hasUncommittedChanges: true,
        changedFiles: ["src/main.rs"],
        lastCheck: null,
        checkCurrent: false,
      });

    act(() => {
      h.handler!({ type: "status", sessionId: "sess-a", status: "idle" });
    });

    // The backend-owned lifecycle is resolved so the fleet shows "Needs review"...
    await waitFor(() =>
      expect(useFleet.getState().sessions["sess-a"].review?.stage).toBe(
        "needsReview",
      ),
    );
    // ...but the harness neither runs the check nor nags the agent about it.
    expect(workspaceCheck).not.toHaveBeenCalled();
    expect(orchEnqueue).not.toHaveBeenCalled();
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

  it("opens global search with the standard desktop shortcut", async () => {
    render(<Fleet />);

    fireEvent.keyDown(document, { key: "f", metaKey: true });

    expect(
      await screen.findByRole("heading", { name: /^search$/i }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("search query")).toHaveFocus();
  });

  it("moves focus into the session menu and restores it on Escape", async () => {
    render(<Fleet />);
    await waitFor(() => expect(h.handler).not.toBeNull());

    await createWorkspace("/repo1", "feat a");
    const trigger = screen.getByRole("button", {
      name: /more session actions/i,
    });
    fireEvent.click(trigger);

    const menu = screen.getByRole("menu", { name: /session actions/i });
    expect(menu).toBeInTheDocument();
    await waitFor(() =>
      expect(
        screen.getByRole("menuitem", { name: /stop agent/i }),
      ).toHaveFocus(),
    );

    fireEvent.keyDown(document, { key: "Escape" });
    expect(menu).not.toBeInTheDocument();
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it("stops in place so the session remains reviewable; delete removes it", async () => {
    render(<Fleet />);
    await waitFor(() => expect(h.handler).not.toBeNull());

    await createWorkspace("/repo1", "feat a");
    await screen.findByRole("button", { name: /feat-a/i });

    // Stop lives in the pane overflow. It releases the process but keeps the
    // session in the sidebar.
    fireEvent.click(
      screen.getByRole("button", { name: /more session actions/i }),
    );
    fireEvent.click(screen.getByRole("menuitem", { name: /stop agent/i }));
    const { acpCloseSession, acpDeleteSession } = await import("./lib/ipc");
    await waitFor(() => expect(acpCloseSession).toHaveBeenCalledWith("sess-a"));
    expect(useFleet.getState().sessions["sess-a"].state.status).toBe(
      "disconnected",
    );
    // The session stays selected so transcript and review remain available.
    expect(screen.getByLabelText("transcript")).toBeInTheDocument();
    expect(screen.getByText(/agent is stopped/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /feat-a/i })).toBeInTheDocument();

    // Delete via the sidebar row's action menu → removed.
    fireEvent.click(screen.getByRole("button", { name: /^session actions$/i }));
    fireEvent.click(screen.getByRole("menuitem", { name: /delete session/i }));
    await waitFor(() =>
      expect(acpDeleteSession).toHaveBeenCalledWith("sess-a"),
    );
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: /feat-a/i })).toBeNull(),
    );
  });
});
