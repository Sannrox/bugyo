#!/usr/bin/env python3
"""
Phase 0 ACP spike: drive `kiro-cli acp` over newline-delimited JSON-RPC and
capture the real message shapes. Every line sent/received is logged with a
direction marker so we can transcribe the protocol into docs/acp-notes.md.

This is a throwaway probe, not production code.
"""
import json
import os
import subprocess
import sys
import threading
import time

LOG = []


def log(direction, obj):
    line = f"{direction} {json.dumps(obj)}"
    print(line, flush=True)
    LOG.append(line)


def main():
    cmd = ["kiro-cli", "acp", "--trust-all-tools"]
    proc = subprocess.Popen(
        cmd,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        bufsize=1,
        cwd=os.getcwd(),
    )

    stop = threading.Event()

    def reader(stream, marker):
        for line in iter(stream.readline, ""):
            if stop.is_set():
                break
            line = line.rstrip("\n")
            if line.strip() == "":
                continue
            print(f"{marker} {line}", flush=True)
            LOG.append(f"{marker} {line}")

    t_out = threading.Thread(target=reader, args=(proc.stdout, "<-- OUT"), daemon=True)
    t_err = threading.Thread(target=reader, args=(proc.stderr, "!!  ERR"), daemon=True)
    t_out.start()
    t_err.start()

    def send(obj):
        log("--> IN ", obj)
        proc.stdin.write(json.dumps(obj) + "\n")
        proc.stdin.flush()

    # 1) initialize
    send({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "initialize",
        "params": {
            "protocolVersion": 1,
            "clientCapabilities": {
                "fs": {"readTextFile": True, "writeTextFile": True}
            },
        },
    })
    time.sleep(3)

    # 2) session/new
    send({
        "jsonrpc": "2.0",
        "id": 2,
        "method": "session/new",
        "params": {
            "cwd": os.getcwd(),
            "mcpServers": [],
        },
    })
    time.sleep(4)

    # We do not know the sessionId yet at compose time; the reader logs it.
    # A second pass (acp_probe2) will use it. Give things a moment, then quit.
    time.sleep(2)

    stop.set()
    try:
        proc.stdin.close()
    except Exception:
        pass
    proc.terminate()
    try:
        proc.wait(timeout=5)
    except Exception:
        proc.kill()

    with open(os.path.join(os.path.dirname(__file__), "acp_probe.log"), "w") as f:
        f.write("\n".join(LOG) + "\n")


if __name__ == "__main__":
    main()
