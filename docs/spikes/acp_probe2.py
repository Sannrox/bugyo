#!/usr/bin/env python3
"""
Phase 0 ACP spike, pass 2: full prompt turn.

No --trust-all-tools, so a file-write tool call should surface a
`session/request_permission` request we must answer. Captures session/update
streaming, the permission request shape, and the final prompt stopReason.

Reactive: parses the sessionId from the session/new result before prompting.
Writes the full transcript to acp_probe2.log.
"""
import json
import os
import queue
import subprocess
import threading
import time

LOG = []
INCOMING = queue.Queue()


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
                    INCOMING.put(json.loads(line))
                except Exception:
                    pass

    threading.Thread(target=reader, args=(proc.stdout, "OUT"), daemon=True).start()
    threading.Thread(target=reader, args=(proc.stderr, "ERR"), daemon=True).start()

    def send(obj):
        record(f"IN  {json.dumps(obj)}")
        proc.stdin.write(json.dumps(obj) + "\n")
        proc.stdin.flush()

    def wait_for_id(target_id, timeout=15):
        end = time.time() + timeout
        while time.time() < end:
            try:
                msg = INCOMING.get(timeout=end - time.time())
            except Exception:
                break
            if msg.get("id") == target_id and "result" in msg:
                return msg
        return None

    # initialize
    send({"jsonrpc": "2.0", "id": 1, "method": "initialize",
          "params": {"protocolVersion": 1,
                     "clientCapabilities": {"fs": {"readTextFile": True, "writeTextFile": True}}}})
    wait_for_id(1)

    # session/new
    send({"jsonrpc": "2.0", "id": 2, "method": "session/new",
          "params": {"cwd": os.getcwd(), "mcpServers": []}})
    res = wait_for_id(2)
    session_id = res["result"]["sessionId"] if res else None
    record(f"### sessionId = {session_id}")

    # session/prompt — ask for a file write to force a permission request
    send({"jsonrpc": "2.0", "id": 3, "method": "session/prompt",
          "params": {"sessionId": session_id,
                     "prompt": [{"type": "text",
                                 "text": "Create a file named acp_spike_hello.txt containing exactly the word hi. Then say done."}]}})

    # Drain messages for a while; answer any permission request we see.
    end = time.time() + 60
    answered = False
    while time.time() < end:
        try:
            msg = INCOMING.get(timeout=end - time.time())
        except Exception:
            break
        method = msg.get("method")
        # Agent -> client request needing a response (has id + method)
        if method and "id" in msg:
            record(f"### AGENT REQUEST method={method} id={msg['id']}")
            if "permission" in method.lower() and not answered:
                # Inspect params to choose an option id; log then approve.
                record(f"### PERMISSION PARAMS = {json.dumps(msg.get('params'))}")
                opts = (msg.get("params") or {}).get("options") or []
                allow = next((o for o in opts if "allow" in json.dumps(o).lower()), None)
                outcome = {"outcome": "selected", "optionId": allow.get("optionId")} if allow else {"outcome": "cancelled"}
                send({"jsonrpc": "2.0", "id": msg["id"],
                      "result": {"outcome": outcome}})
                answered = True
            else:
                # Answer other agent requests generically so we don't hang.
                send({"jsonrpc": "2.0", "id": msg["id"], "result": {}})
        if msg.get("id") == 3 and "result" in msg:
            record(f"### PROMPT RESULT = {json.dumps(msg['result'])}")
            break

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

    with open(os.path.join(os.path.dirname(__file__), "acp_probe2.log"), "w") as f:
        f.write("\n".join(LOG) + "\n")


if __name__ == "__main__":
    main()
