#!/usr/bin/env python3
"""
Image content-block spike: verify the exact wire shape kiro-cli's ACP accepts
for an IMAGE block on `session/prompt`, so Bugyo can inject screenshots
(Codex-style) without an MCP.

`initialize` advertises `promptCapabilities.image: true` (see acp-notes.md), so
this confirms the concrete field names. We capture a real screenshot with
macOS `screencapture`, base64 it, and try candidate block shapes in order until
one is accepted (prompt resolves with a result, not an error). We also print any
assistant text so we can eyeball whether the model actually "saw" the image.

Writes a transcript to acp_image_probe.log and prints the winning shape.
"""
import base64
import json
import os
import queue
import subprocess
import tempfile
import threading
import time

LOG = []
INCOMING = queue.Queue()


def record(s):
    print(s, flush=True)
    LOG.append(s)


def grab_screenshot_b64():
    """Capture the main display to a temp PNG and return base64 (best-effort).

    Without Screen Recording permission this still yields a valid PNG (desktop
    picture), which is enough to test wire-format acceptance.
    """
    fd, path = tempfile.mkstemp(suffix=".png")
    os.close(fd)
    try:
        subprocess.run(["screencapture", "-x", "-t", "png", "-m", path], check=True)
        with open(path, "rb") as f:
            data = f.read()
        return base64.b64encode(data).decode("ascii"), len(data)
    finally:
        try:
            os.remove(path)
        except OSError:
            pass


def candidate_blocks(b64):
    """Candidate image-block shapes to try, most-likely first.

    ACP spec image content block is {type, mimeType, data}; the others are
    fallbacks in case kiro-cli expects a different key.
    """
    return [
        ("acp-standard mimeType+data",
         {"type": "image", "mimeType": "image/png", "data": b64}),
        ("mediaType+data",
         {"type": "image", "mediaType": "image/png", "data": b64}),
        ("nested source",
         {"type": "image", "source": {"type": "base64", "mediaType": "image/png", "data": b64}}),
    ]


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
            # Avoid dumping huge base64 echoes into the log.
            logged = line if len(line) < 400 else line[:400] + f"...<+{len(line) - 400}b>"
            record(f"{marker} {logged}")
            if marker == "OUT":
                try:
                    msg = json.loads(line)
                except Exception:
                    continue
                INCOMING.put(msg)

    threading.Thread(target=reader, args=(proc.stdout, "OUT"), daemon=True).start()
    threading.Thread(target=reader, args=(proc.stderr, "ERR"), daemon=True).start()

    def send(obj):
        raw = json.dumps(obj)
        preview = raw if len(raw) < 300 else raw[:300] + f"...<+{len(raw) - 300}b>"
        record(f"IN  {preview}")
        proc.stdin.write(raw + "\n")
        proc.stdin.flush()

    def wait_for_id(target_id, timeout=30):
        end = time.time() + timeout
        while time.time() < end:
            try:
                msg = INCOMING.get(timeout=max(0.01, end - time.time()))
            except Exception:
                break
            # Answer any agent->client request so we don't hang.
            method = msg.get("method")
            if method and "id" in msg and "result" not in msg and "error" not in msg:
                if "permission" in method.lower():
                    opts = (msg.get("params") or {}).get("options") or []
                    allow = next((o for o in opts if "allow" in json.dumps(o).lower()), None)
                    outcome = ({"outcome": "selected", "optionId": allow["optionId"]}
                               if allow else {"outcome": "cancelled"})
                    send({"jsonrpc": "2.0", "id": msg["id"], "result": {"outcome": outcome}})
                else:
                    send({"jsonrpc": "2.0", "id": msg["id"], "result": {}})
                continue
            if msg.get("id") == target_id and ("result" in msg or "error" in msg):
                return msg
        return None

    def collect_text(target_id, timeout=40):
        """Wait for the prompt result, collecting assistant text chunks."""
        end = time.time() + timeout
        text = []
        while time.time() < end:
            try:
                msg = INCOMING.get(timeout=max(0.01, end - time.time()))
            except Exception:
                break
            method = msg.get("method")
            if method and "id" in msg and "result" not in msg and "error" not in msg:
                if "permission" in method.lower():
                    opts = (msg.get("params") or {}).get("options") or []
                    allow = next((o for o in opts if "allow" in json.dumps(o).lower()), None)
                    outcome = ({"outcome": "selected", "optionId": allow["optionId"]}
                               if allow else {"outcome": "cancelled"})
                    send({"jsonrpc": "2.0", "id": msg["id"], "result": {"outcome": outcome}})
                else:
                    send({"jsonrpc": "2.0", "id": msg["id"], "result": {}})
                continue
            if method in ("session/update", "_kiro.dev/session/update"):
                upd = (msg.get("params") or {}).get("update") or {}
                if upd.get("sessionUpdate") == "agent_message_chunk":
                    t = (upd.get("content") or {}).get("text")
                    if t:
                        text.append(t)
            if msg.get("id") == target_id and ("result" in msg or "error" in msg):
                return msg, "".join(text)
        return None, "".join(text)

    send({"jsonrpc": "2.0", "id": 1, "method": "initialize",
          "params": {"protocolVersion": 1,
                     "clientCapabilities": {"fs": {"readTextFile": True, "writeTextFile": True}}}})
    init = wait_for_id(1)
    caps = ((init or {}).get("result") or {}).get("agentCapabilities", {})
    record(f"### promptCapabilities = {json.dumps(caps.get('promptCapabilities'))}")

    send({"jsonrpc": "2.0", "id": 2, "method": "session/new",
          "params": {"cwd": os.getcwd(), "mcpServers": []}})
    res = wait_for_id(2)
    session_id = res["result"]["sessionId"] if res and "result" in res else None
    record(f"### sessionId = {session_id}")
    if not session_id:
        record("### ABORT: no session")
        proc.kill()
        return

    b64, nbytes = grab_screenshot_b64()
    record(f"### screenshot bytes = {nbytes} (b64 len {len(b64)})")

    winner = None
    req_id = 10
    for label, block in candidate_blocks(b64):
        req_id += 1
        record(f"\n### TRY shape: {label}")
        send({"jsonrpc": "2.0", "id": req_id, "method": "session/prompt",
              "params": {"sessionId": session_id,
                         "prompt": [
                             {"type": "text",
                              "text": "This is a screenshot. In ONE short sentence, say what you see."},
                             block,
                         ]}})
        result, text = collect_text(req_id)
        if result is None:
            record(f"### {label}: TIMEOUT / no result")
            continue
        if "error" in result:
            record(f"### {label}: REJECTED error={json.dumps(result['error'])}")
            continue
        record(f"### {label}: ACCEPTED result={json.dumps(result.get('result'))}")
        record(f"### {label}: assistant said: {text!r}")
        winner = (label, block)
        break

    record("\n==================== IMAGE BLOCK SHAPE ====================")
    if winner:
        shape_keys = {k: ("<base64>" if k == "data" else v)
                      for k, v in winner[1].items()}
        record(f"### ACCEPTED SHAPE: {winner[0]}")
        record(f"### KEYS: {json.dumps(shape_keys)}")
    else:
        record("### NO SHAPE ACCEPTED — inspect log")

    try:
        proc.stdin.close()
    except Exception:
        pass
    proc.terminate()
    try:
        proc.wait(timeout=5)
    except Exception:
        proc.kill()

    with open(os.path.join(os.path.dirname(__file__), "acp_image_probe.log"), "w") as f:
        f.write("\n".join(LOG) + "\n")


if __name__ == "__main__":
    main()
