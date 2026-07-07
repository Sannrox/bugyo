#!/usr/bin/env python3
"""
Capability spike: capture the exact wire shapes of the `_kiro.dev/*` capability
notifications, and test whether slash commands are invocable over ACP.

Captures, per session:
- `_kiro.dev/commands/available`  -> commands[], prompts[], tools[], mcpServers[]
- `_kiro.dev/subagent/list_update` -> subagents[], pendingStages[]
- `_kiro.dev/mcp/server_initialized` -> {sessionId, serverName}

Then sends a slash command (`/help` and `/clear`) as a `session/prompt` text
block to see whether the agent executes it or treats it as literal prose. The
answer decides whether the palette can be "actionable" over ACP.

Writes the full transcript to acp_capabilities_probe.log and prints a summary of
the first exemplar of each capability notification.
"""
import json
import os
import queue
import subprocess
import threading
import time

LOG = []
INCOMING = queue.Queue()
# First exemplar of each notification method we care about.
EXEMPLARS = {}
CAP_METHODS = {
    "_kiro.dev/commands/available",
    "_kiro.dev/subagent/list_update",
    "_kiro.dev/mcp/server_initialized",
}


def record(s):
    print(s, flush=True)
    LOG.append(s)


def main():
    proc = subprocess.Popen(
        ["kiro-cli", "acp"],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        text=True, bufsize=1, cwd=os.getcwd(),
    )

    def reader(stream, marker):
        for line in iter(stream.readline, ""):
            line = line.rstrip("\n")
            if not line.strip():
                continue
            record(f"{marker} {line}")
            if marker == "OUT":
                try:
                    msg = json.loads(line)
                except Exception:
                    continue
                INCOMING.put(msg)
                method = msg.get("method")
                if method in CAP_METHODS and method not in EXEMPLARS:
                    EXEMPLARS[method] = msg

    threading.Thread(target=reader, args=(proc.stdout, "OUT"), daemon=True).start()
    threading.Thread(target=reader, args=(proc.stderr, "ERR"), daemon=True).start()

    def send(obj):
        record(f"IN  {json.dumps(obj)}")
        proc.stdin.write(json.dumps(obj) + "\n")
        proc.stdin.flush()

    def wait_for_id(target_id, timeout=20):
        end = time.time() + timeout
        while time.time() < end:
            try:
                msg = INCOMING.get(timeout=max(0.01, end - time.time()))
            except Exception:
                break
            if msg.get("id") == target_id and ("result" in msg or "error" in msg):
                return msg
        return None

    # initialize
    send({"jsonrpc": "2.0", "id": 1, "method": "initialize",
          "params": {"protocolVersion": 1,
                     "clientCapabilities": {"fs": {"readTextFile": True, "writeTextFile": True}}}})
    wait_for_id(1)

    # session/new — capability notifications typically fire around here.
    send({"jsonrpc": "2.0", "id": 2, "method": "session/new",
          "params": {"cwd": os.getcwd(), "mcpServers": []}})
    res = wait_for_id(2)
    session_id = res["result"]["sessionId"] if res else None
    record(f"### sessionId = {session_id}")

    # Give notifications a moment to arrive after session creation.
    time.sleep(3)

    # ---- Invocability test: send a slash command as a prompt text block. ----
    # If the agent executes it, we should see command-specific output; if it
    # treats it as literal text, the assistant will respond in prose.
    def probe_slash(cmd, req_id):
        record(f"### SLASH PROBE: sending {cmd!r} as session/prompt")
        send({"jsonrpc": "2.0", "id": req_id, "method": "session/prompt",
              "params": {"sessionId": session_id,
                         "prompt": [{"type": "text", "text": cmd}]}})
        end = time.time() + 30
        while time.time() < end:
            try:
                msg = INCOMING.get(timeout=max(0.01, end - time.time()))
            except Exception:
                break
            method = msg.get("method")
            # Answer any agent->client request so we don't hang.
            if method and "id" in msg:
                if "permission" in (method or "").lower():
                    opts = (msg.get("params") or {}).get("options") or []
                    allow = next((o for o in opts if "allow" in json.dumps(o).lower()), None)
                    outcome = {"outcome": "selected", "optionId": allow["optionId"]} if allow else {"outcome": "cancelled"}
                    send({"jsonrpc": "2.0", "id": msg["id"], "result": {"outcome": outcome}})
                else:
                    send({"jsonrpc": "2.0", "id": msg["id"], "result": {}})
            if msg.get("id") == req_id and ("result" in msg or "error" in msg):
                record(f"### SLASH RESULT {cmd!r} = {json.dumps(msg.get('result') or msg.get('error'))}")
                return

    probe_slash("/help", 3)
    probe_slash("/clear", 4)

    time.sleep(1)
    try:
        proc.stdin.close()
    except Exception:
        pass
    proc.terminate()
    try:
        proc.wait(timeout=5)
    except Exception:
        proc.kill()

    # Summary of exemplars.
    record("\n==================== CAPABILITY EXEMPLARS ====================")
    for method in sorted(CAP_METHODS):
        ex = EXEMPLARS.get(method)
        if ex is None:
            record(f"### {method}: NOT OBSERVED")
        else:
            record(f"### {method}:\n{json.dumps(ex, indent=2)}")

    with open(os.path.join(os.path.dirname(__file__), "acp_capabilities_probe.log"), "w") as f:
        f.write("\n".join(LOG) + "\n")


if __name__ == "__main__":
    main()
