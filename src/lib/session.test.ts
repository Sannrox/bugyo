import { describe, it, expect } from "vitest";
import { initialSessionState, reduceSession } from "./session";
import type { AcpEvent } from "./bindings";

function fold(events: AcpEvent[]) {
  return events.reduce(reduceSession, initialSessionState);
}

describe("reduceSession", () => {
  it("tracks status changes", () => {
    const s = fold([
      { type: "status", sessionId: "s1", status: "working" },
      { type: "status", sessionId: "s1", status: "idle" },
    ]);
    expect(s.status).toBe("idle");
  });

  it("coalesces consecutive agent message chunks", () => {
    const s = fold([
      { type: "agentMessage", sessionId: "s1", text: "hel" },
      { type: "agentMessage", sessionId: "s1", text: "lo" },
    ]);
    expect(s.transcript).toEqual([{ kind: "agent", text: "hello" }]);
  });

  it("coalesces consecutive reasoning chunks into one thought entry", () => {
    const s = fold([
      { type: "agentThought", sessionId: "s1", text: "Let me " },
      { type: "agentThought", sessionId: "s1", text: "think about this." },
      { type: "agentMessage", sessionId: "s1", text: "Done." },
    ]);
    expect(s.transcript).toEqual([
      { kind: "thought", text: "Let me think about this." },
      { kind: "agent", text: "Done." },
    ]);
  });

  it("updates a tool call in place by id and preserves its diff and output", () => {
    const s = fold([
      {
        type: "toolCall",
        sessionId: "s1",
        toolCallId: "t1",
        title: "Creating x",
        status: null,
        diff: { path: "x.txt", oldText: null, newText: "hi" },
        output: null,
      },
      {
        type: "toolCall",
        sessionId: "s1",
        toolCallId: "t1",
        title: "Creating x",
        status: "completed",
        diff: null,
        output: "Successfully created x.txt.",
      },
    ]);
    expect(s.transcript).toHaveLength(1);
    expect(s.transcript[0]).toMatchObject({
      kind: "tool",
      toolCallId: "t1",
      status: "completed",
      diff: { path: "x.txt", newText: "hi" },
      output: "Successfully created x.txt.",
    });
  });

  it("records a pending permission with options and clears it on resume", () => {
    const withPerm = fold([
      {
        type: "permissionRequested",
        sessionId: "s1",
        requestId: "r1",
        toolCallId: "t1",
        title: "Write file",
        options: [{ optionId: "allow_once", name: "Yes", kind: "allow_once" }],
      },
      {
        type: "metrics",
        sessionId: "s1",
        contextPercent: 12.5,
        credits: 0.3,
        turnDurationMs: 4894,
      },
    ]);
    expect(withPerm.pendingPermission).toMatchObject({
      requestId: "r1",
      toolCallId: "t1",
      title: "Write file",
    });
    expect(withPerm.pendingPermission?.options).toHaveLength(1);
    expect(withPerm.contextPercent).toBe(12.5);
    expect(withPerm.credits).toBeCloseTo(0.3);
    expect(withPerm.turns).toBe(1);
    expect(withPerm.durationMs).toBe(4894);

    const resumed = reduceSession(withPerm, {
      type: "status",
      sessionId: "s1",
      status: "working",
    });
    expect(resumed.pendingPermission).toBeNull();
  });

  it("surfaces errors and sets error status", () => {
    const s = fold([{ type: "error", message: "boom" }]);
    expect(s.status).toBe("error");
    expect(s.lastError).toBe("boom");
    expect(s.transcript.at(-1)).toEqual({
      kind: "system",
      text: "Error: boom",
    });

    const recovered = reduceSession(s, {
      type: "status",
      sessionId: "s1",
      status: "idle",
    });
    expect(recovered.lastError).toBeNull();
  });

  it("stores a capabilities snapshot and preserves subagents", () => {
    const s = fold([
      { type: "subagents", sessionId: "s1", subagents: [{ name: "reviewer" }] },
      {
        type: "capabilities",
        sessionId: "s1",
        commands: [{ name: "/clear", description: "Clear history" }],
        prompts: [
          {
            name: "autoreview",
            description: "review",
            serverName: "skill:config",
          },
        ],
        tools: [{ name: "code", description: "intel", source: "built-in" }],
        mcpServers: [
          { name: "chrome-devtools", status: "running", toolCount: 29 },
        ],
      },
    ]);
    expect(s.capabilities.commands).toEqual([
      { name: "/clear", description: "Clear history" },
    ]);
    expect(s.capabilities.prompts[0].serverName).toBe("skill:config");
    expect(s.capabilities.tools[0].source).toBe("built-in");
    expect(s.capabilities.mcpServers[0].toolCount).toBe(29);
    // subagents from the earlier event are not clobbered by the snapshot.
    expect(s.capabilities.subagents).toEqual([{ name: "reviewer" }]);
  });

  it("replaces the command inventory on a new snapshot", () => {
    const s = fold([
      {
        type: "capabilities",
        sessionId: "s1",
        commands: [{ name: "/old", description: "" }],
        prompts: [],
        tools: [],
        mcpServers: [],
      },
      {
        type: "capabilities",
        sessionId: "s1",
        commands: [{ name: "/new", description: "" }],
        prompts: [],
        tools: [],
        mcpServers: [],
      },
    ]);
    expect(s.capabilities.commands).toEqual([
      { name: "/new", description: "" },
    ]);
  });

  it("upserts an MCP server as running on server_initialized", () => {
    // Arrives before any snapshot: appended as running.
    const added = fold([
      { type: "mcpServerInitialized", sessionId: "s1", serverName: "srv-a" },
    ]);
    expect(added.capabilities.mcpServers).toEqual([
      { name: "srv-a", status: "running", toolCount: null },
    ]);

    // Arrives for a server already in the snapshot: status updated in place.
    const updated = reduceSession(
      fold([
        {
          type: "capabilities",
          sessionId: "s1",
          commands: [],
          prompts: [],
          tools: [],
          mcpServers: [{ name: "srv-a", status: "starting", toolCount: 5 }],
        },
      ]),
      { type: "mcpServerInitialized", sessionId: "s1", serverName: "srv-a" },
    );
    expect(updated.capabilities.mcpServers).toEqual([
      { name: "srv-a", status: "running", toolCount: 5 },
    ]);
  });
});
