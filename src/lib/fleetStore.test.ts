import { describe, it, expect, beforeEach } from "vitest";
import { useFleet } from "./fleetStore";
import type { Workspace } from "./bindings";

const ws = (branch: string, repo: string): Workspace => ({
  task: branch,
  repoRoot: repo,
  baseBranch: "main",
  branch,
  worktreePath: `/wt/${branch}`,
});

function reset() {
  useFleet.setState({
    sessions: {},
    order: [],
    activeId: null,
    secondaryId: null,
    errors: [],
  });
}

describe("fleetStore", () => {
  beforeEach(reset);

  it("adds sessions, tracks order, and sets the new one active", () => {
    const { addSession } = useFleet.getState();
    addSession({ sessionId: "a", workspace: ws("feat-a", "/repo1") });
    addSession({ sessionId: "b", workspace: ws("feat-b", "/repo2") });

    const s = useFleet.getState();
    expect(s.order).toEqual(["a", "b"]);
    expect(s.activeId).toBe("b");
    expect(s.sessions.a.repoRoot).toBe("/repo1");
    expect(s.sessions.a.state.status).toBe("idle");
  });

  it("keeps startup-hydrated sessions visibly disconnected until resumed", () => {
    useFleet.getState().addSession({ sessionId: "cold", connected: false });
    expect(useFleet.getState().sessions.cold.state.status).toBe("disconnected");

    useFleet.getState().setConnected("cold", true);
    expect(useFleet.getState().sessions.cold.state.status).toBe("idle");
  });

  it("routes events to the correct session only", () => {
    const { addSession, applyEvent } = useFleet.getState();
    addSession({ sessionId: "a", workspace: ws("feat-a", "/repo1") });
    addSession({ sessionId: "b", workspace: ws("feat-b", "/repo1") });

    applyEvent({ type: "agentMessage", sessionId: "a", text: "hello A" });
    applyEvent({ type: "status", sessionId: "b", status: "working" });

    const s = useFleet.getState();
    expect(s.sessions.a.state.transcript).toEqual([
      { kind: "agent", text: "hello A" },
    ]);
    expect(s.sessions.a.state.status).toBe("idle"); // untouched
    expect(s.sessions.b.state.status).toBe("working");
    expect(s.sessions.b.state.transcript).toEqual([]); // untouched
  });

  it("ignores events for unknown sessions", () => {
    const { applyEvent } = useFleet.getState();
    applyEvent({ type: "agentMessage", sessionId: "ghost", text: "x" });
    expect(useFleet.getState().order).toEqual([]);
  });

  it("applyEvents coalesces a batch into a single committed update", () => {
    const { addSession, applyEvents } = useFleet.getState();
    addSession({ sessionId: "a", workspace: ws("feat-a", "/repo1") });
    addSession({ sessionId: "b", workspace: ws("feat-b", "/repo1") });

    // Track store commits: a batch must commit once, not once per event.
    let commits = 0;
    const unsub = useFleet.subscribe(() => {
      commits += 1;
    });

    applyEvents([
      { type: "agentMessage", sessionId: "a", text: "hello " },
      { type: "agentMessage", sessionId: "a", text: "world" },
      { type: "status", sessionId: "b", status: "working" },
      { type: "agentMessage", sessionId: "ghost", text: "dropped" },
    ]);
    unsub();

    expect(commits).toBe(1); // one set() for the whole batch

    const s = useFleet.getState();
    // Streamed chunks for A are concatenated into one agent message.
    expect(s.sessions.a.state.transcript).toEqual([
      { kind: "agent", text: "hello world" },
    ]);
    expect(s.sessions.b.state.status).toBe("working");
    // The unknown-session event is skipped without creating anything.
    expect(s.order).toEqual(["a", "b"]);
  });

  it("applyEvents leaves the sessions map untouched for a no-op batch", () => {
    const { addSession, applyEvents } = useFleet.getState();
    addSession({ sessionId: "a", workspace: ws("feat-a", "/repo1") });
    const before = useFleet.getState().sessions;

    // Empty batch and unknown-session-only batch change nothing: the sessions
    // map keeps its identity (no wasted re-render of subscribers).
    applyEvents([]);
    expect(useFleet.getState().sessions).toBe(before);
    applyEvents([{ type: "agentMessage", sessionId: "ghost", text: "x" }]);
    expect(useFleet.getState().sessions).toBe(before);
  });

  it("routes a capabilities event to the right session only", () => {
    const { addSession, applyEvent } = useFleet.getState();
    addSession({ sessionId: "a", workspace: ws("feat-a", "/repo1") });
    addSession({ sessionId: "b", workspace: ws("feat-b", "/repo1") });

    applyEvent({
      type: "capabilities",
      sessionId: "a",
      commands: [{ name: "/clear", description: "Clear history" }],
      prompts: [],
      tools: [],
      mcpServers: [],
    });

    const s = useFleet.getState();
    expect(s.sessions.a.state.capabilities.commands).toEqual([
      { name: "/clear", description: "Clear history" },
    ]);
    // sibling untouched
    expect(s.sessions.b.state.capabilities.commands).toEqual([]);
  });

  it("removes a session and reassigns active", () => {
    const { addSession, removeSession } = useFleet.getState();
    addSession({ sessionId: "a" });
    addSession({ sessionId: "b" });
    removeSession("b");
    const s = useFleet.getState();
    expect(s.order).toEqual(["a"]);
    expect(s.activeId).toBe("a");
  });

  it("opens a second session in the split pane", () => {
    const { addSession, setActive, openSplit } = useFleet.getState();
    addSession({ sessionId: "a" });
    addSession({ sessionId: "b" });
    setActive("a");
    openSplit("b");
    const s = useFleet.getState();
    expect(s.activeId).toBe("a");
    expect(s.secondaryId).toBe("b");
  });

  it("does not split a session against itself", () => {
    const { addSession, setActive, openSplit } = useFleet.getState();
    addSession({ sessionId: "a" });
    setActive("a");
    openSplit("a");
    expect(useFleet.getState().secondaryId).toBeNull();
  });

  it("clears the split when the split session becomes active", () => {
    const { addSession, setActive, openSplit } = useFleet.getState();
    addSession({ sessionId: "a" });
    addSession({ sessionId: "b" });
    setActive("a");
    openSplit("b");
    setActive("b");
    expect(useFleet.getState().secondaryId).toBeNull();
    expect(useFleet.getState().activeId).toBe("b");
  });

  it("clears the split when opening the new-task composer", () => {
    const { addSession, setActive, openSplit } = useFleet.getState();
    addSession({ sessionId: "a" });
    addSession({ sessionId: "b" });
    setActive("a");
    openSplit("b");
    setActive(null);
    expect(useFleet.getState().activeId).toBeNull();
    expect(useFleet.getState().secondaryId).toBeNull();
    expect(useFleet.getState().panel).toBeNull();
  });

  it("clears the split when the split session is removed", () => {
    const { addSession, setActive, openSplit, removeSession } =
      useFleet.getState();
    addSession({ sessionId: "a" });
    addSession({ sessionId: "b" });
    setActive("a");
    openSplit("b");
    removeSession("b");
    expect(useFleet.getState().secondaryId).toBeNull();
  });

  it("closeSplit keeps the active session", () => {
    const { addSession, setActive, openSplit, closeSplit } =
      useFleet.getState();
    addSession({ sessionId: "a" });
    addSession({ sessionId: "b" });
    setActive("a");
    openSplit("b");
    closeSplit();
    const s = useFleet.getState();
    expect(s.secondaryId).toBeNull();
    expect(s.activeId).toBe("a");
  });

  it("openFleet shows the fleet panel", () => {
    useFleet.getState().openFleet();
    expect(useFleet.getState().panel).toBe("fleet");
  });

  it("toggles a session's pinned flag", () => {
    const { addSession, togglePin } = useFleet.getState();
    addSession({ sessionId: "a" });
    expect(useFleet.getState().sessions.a.pinned).toBe(false);
    togglePin("a");
    expect(useFleet.getState().sessions.a.pinned).toBe(true);
    togglePin("a");
    expect(useFleet.getState().sessions.a.pinned).toBe(false);
  });

  it("renames a session and clears the name on empty input", () => {
    const { addSession, renameSession } = useFleet.getState();
    addSession({ sessionId: "a" });
    renameSession("a", "  Nightly triage  ");
    expect(useFleet.getState().sessions.a.name).toBe("Nightly triage");
    renameSession("a", "   ");
    expect(useFleet.getState().sessions.a.name).toBeNull();
  });

  it("moves a session up and down in the order, clamping at the ends", () => {
    const { addSession, moveSession } = useFleet.getState();
    addSession({ sessionId: "a" });
    addSession({ sessionId: "b" });
    addSession({ sessionId: "c" });
    expect(useFleet.getState().order).toEqual(["a", "b", "c"]);

    moveSession("c", "up");
    expect(useFleet.getState().order).toEqual(["a", "c", "b"]);

    moveSession("a", "up"); // already first — no-op
    expect(useFleet.getState().order).toEqual(["a", "c", "b"]);

    moveSession("b", "down"); // already last — no-op
    expect(useFleet.getState().order).toEqual(["a", "c", "b"]);
  });

  it("applies persisted metadata (pin/name) and reorders by order", () => {
    const { addSession, applySessionMeta } = useFleet.getState();
    addSession({ sessionId: "a" });
    addSession({ sessionId: "b" });
    addSession({ sessionId: "c" });

    applySessionMeta([
      { sessionId: "a", pinned: false, name: null, order: 2 },
      { sessionId: "b", pinned: true, name: "beta", order: 0 },
      { sessionId: "c", pinned: false, name: null, order: 1 },
    ]);

    const s = useFleet.getState();
    expect(s.order).toEqual(["b", "c", "a"]);
    expect(s.sessions.b.pinned).toBe(true);
    expect(s.sessions.b.name).toBe("beta");
  });

  it("collects session-less error events into the banner list", () => {
    const { applyEvents, dismissError } = useFleet.getState();
    applyEvents([
      { type: "error", message: "task failed and was dropped" },
      { type: "error", message: "transport closed" },
    ]);
    expect(useFleet.getState().errors).toEqual([
      "task failed and was dropped",
      "transport closed",
    ]);

    dismissError(0);
    expect(useFleet.getState().errors).toEqual(["transport closed"]);
  });

  it("routes session events while still capturing errors in one batch", () => {
    const { addSession, applyEvents } = useFleet.getState();
    addSession({ sessionId: "a", workspace: ws("feat-a", "/repo1") });
    applyEvents([
      { type: "agentMessage", sessionId: "a", text: "hi" },
      { type: "error", message: "boom" },
    ]);
    const s = useFleet.getState();
    expect(s.errors).toEqual(["boom"]);
    const last = s.sessions.a.state.transcript.at(-1);
    expect(last).toEqual({ kind: "agent", text: "hi" });
  });

  it("bounds explicitly reported backend errors", () => {
    const { reportError } = useFleet.getState();
    for (let index = 0; index < 12; index += 1) {
      reportError(`failure ${index}`);
    }

    expect(useFleet.getState().errors).toHaveLength(10);
    expect(useFleet.getState().errors[0]).toBe("failure 2");
    expect(useFleet.getState().errors.at(-1)).toBe("failure 11");
  });
});
