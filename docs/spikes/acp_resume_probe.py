#!/usr/bin/env python3
"""Verify ACP session resume: create+prompt a session, kill the process, then a
fresh `kiro-cli acp` process attempts session/load with the same id."""
import json, os, subprocess, threading, queue, time

def spawn():
    return subprocess.Popen(
        ["kiro-cli", "acp"],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        text=True, bufsize=1, cwd="/tmp",
    )

def reader(stream, q):
    for line in iter(stream.readline, ""):
        if line.strip():
            q.put(line.strip())

def start(proc):
    q = queue.Queue()
    threading.Thread(target=reader, args=(proc.stdout, q), daemon=True).start()
    threading.Thread(target=reader, args=(proc.stderr, queue.Queue()), daemon=True).start()
    return q

def send(proc, obj):
    proc.stdin.write(json.dumps(obj) + "\n"); proc.stdin.flush()

def wait_id(q, want, timeout=20):
    end = time.time() + timeout
    while time.time() < end:
        try:
            line = q.get(timeout=end - time.time())
        except Exception:
            return None
        try:
            m = json.loads(line)
        except Exception:
            continue
        if m.get("id") == want and ("result" in m or "error" in m):
            return m

# --- process A: create + prompt ---
a = spawn(); qa = start(a)
send(a, {"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1,"clientCapabilities":{"fs":{"readTextFile":True,"writeTextFile":True}}}})
wait_id(qa, 1)
send(a, {"jsonrpc":"2.0","id":2,"method":"session/new","params":{"cwd":"/tmp","mcpServers":[]}})
res = wait_id(qa, 2)
sid = res["result"]["sessionId"] if res and "result" in res else None
print("sessionId:", sid)
send(a, {"jsonrpc":"2.0","id":3,"method":"session/prompt","params":{"sessionId":sid,"prompt":[{"type":"text","text":"Remember the codeword BUGYO42. Reply ok."}]}})
wait_id(qa, 3, timeout=60)
print("process A prompt done")
a.kill()
try: a.wait(timeout=5)
except Exception: pass
time.sleep(5)
print("process A killed:", a.poll())

# --- process B: try to resume ---
# Clear the stale lock left by the killed process A (its PID is dead).
lock = os.path.expanduser(f"~/.kiro/sessions/cli/{sid}.lock")
if os.path.exists(lock):
    print("removing stale lock:", lock)
    os.remove(lock)

b = spawn(); qb = start(b)
send(b, {"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1,"clientCapabilities":{"fs":{"readTextFile":True,"writeTextFile":True}}}})
wait_id(qb, 1)
send(b, {"jsonrpc":"2.0","id":2,"method":"session/load","params":{"sessionId":sid,"cwd":"/tmp","mcpServers":[]}})
loaded = wait_id(qb, 2, timeout=20)
print("session/load response:", json.dumps(loaded) if loaded else "NONE/timeout")
b.terminate()
try: b.wait(timeout=5)
except Exception: b.kill()
