# ACP notes — `kiro-cli acp`

Phase 0 spike. Captured from **kiro-cli 2.11.1** (`agentInfo.version`) by driving
`kiro-cli acp` over stdio with two probe scripts:

- `docs/spikes/acp_probe.py` → `acp_probe.log` (initialize + session/new)
- `docs/spikes/acp_probe2.py` → `acp_probe2.log` (full prompt turn + permission)

These are **observed shapes from a real run**, not the spec. Treat them as the
ground truth to model the Rust ACP client against, but re-verify on version bumps.

---

## Transport

- **Framing:** newline-delimited JSON (one JSON-RPC 2.0 object per line) over the
  process's **stdin/stdout**. No LSP-style `Content-Length` headers.
- **Direction markers below:** `-->` client→agent (what we write), `<--`
  agent→client (what we read).
- **IDs:** the client picks integer ids for its requests. **Agent→client requests
  use string UUID ids** (see `session/request_permission`). The client's JSON-RPC
  reader must accept both integer and string ids, and must distinguish:
  - a **response** = has `id` + (`result` | `error`), no `method`
  - an **agent request** = has `id` + `method` (we must reply)
  - a **notification** = has `method`, no `id`

---

## 1. `initialize`

```jsonc
--> {"jsonrpc":"2.0","id":1,"method":"initialize","params":{
      "protocolVersion":1,
      "clientCapabilities":{"fs":{"readTextFile":true,"writeTextFile":true}}}}

<-- {"jsonrpc":"2.0","id":1,"result":{
      "protocolVersion":1,
      "agentCapabilities":{
        "loadSession":true,
        "promptCapabilities":{"image":true,"audio":false,"embeddedContext":false},
        "mcpCapabilities":{"http":true,"sse":false},
        "sessionCapabilities":{},
        "auth":{}},
      "authMethods":[],
      "agentInfo":{"name":"Kiro CLI Agent","title":"Kiro CLI Agent","version":"2.11.1"}}}
```

- `protocolVersion` is an **integer** (`1`), on both sides.
- `authMethods: []` → no auth handshake needed for the local CLI.

---

## 2. `session/new`

```jsonc
--> {"jsonrpc":"2.0","id":2,"method":"session/new","params":{
      "cwd":"/abs/path","mcpServers":[]}}

<-- {"jsonrpc":"2.0","id":2,"result":{
      "sessionId":"6c255c9f-8ae0-4660-867a-6ab47463fd0c",
      "modes":{"currentModeId":"kiro_default","availableModes":[
        {"id":"kiro_default","name":"kiro_default","description":"..."},
        {"id":"kiro_planner", ...},
        {"id":"kiro_guide", ...}]},
      "models":{"currentModelId":"claude-opus-4.8","availableModels":[
        {"modelId":"auto", ...},{"modelId":"claude-opus-4.8", ...}, ...]}}}
```

- `cwd` **must be absolute**. This is where the session's tools operate → this is
  the hook for **worktree isolation** (point each workspace's session at its
  worktree path).
- `sessionId` is a UUID string; every subsequent message carries it.
- `modes` and `models` are **kiro extensions** to the standard result — gives us
  the agent list and model list to populate UI selectors.

### Notifications emitted around session creation (kiro extensions, `_kiro.dev/*`)

| method                             | params                                                                 | use                                                   |
| ---------------------------------- | ---------------------------------------------------------------------- | ----------------------------------------------------- |
| `_kiro.dev/mcp/server_initialized` | `{sessionId, serverName}`                                              | MCP server came up                                    |
| `_kiro.dev/commands/available`     | `{sessionId, commands[], prompts[], tools[], mcpServers[]}`            | slash commands, prompts, available tools, MCP servers |
| `_kiro.dev/subagent/list_update`   | `{subagents[], pendingStages[]}`                                       | subagent fan-out state                                |
| `_kiro.dev/metadata`               | `{sessionId, contextUsagePercentage, meteringUsage?, turnDurationMs?}` | context %, credit spend, turn timing                  |

---

## 3. `session/prompt` (a full turn)

```jsonc
--> {"jsonrpc":"2.0","id":3,"method":"session/prompt","params":{
      "sessionId":"...",
      "prompt":[{"type":"text","text":"Create a file named ... containing hi. Then say done."}]}}
```

`prompt` is an **array of content blocks** (`{type:"text", text}`); image/other
types are gated by `agentCapabilities.promptCapabilities`.

The turn streams as **`session/update` notifications**, then resolves the `id:3`
request. Observed `update.sessionUpdate` variants:

```jsonc
// (kiro-only chunk variant, method is _kiro.dev/session/update)
<-- {"method":"_kiro.dev/session/update","params":{"sessionId":"...","update":{
      "sessionUpdate":"tool_call_chunk","toolCallId":"tooluse_...","title":"write","kind":"edit"}}}

// standard ACP: full tool call, with a rendered diff
<-- {"method":"session/update","params":{"sessionId":"...","update":{
      "sessionUpdate":"tool_call","toolCallId":"tooluse_...",
      "title":"Creating acp_spike_hello.txt","kind":"edit",
      "content":[{"type":"diff","path":"/abs/acp_spike_hello.txt","oldText":null,"newText":"hi"}],
      "locations":[{"path":"acp_spike_hello.txt","line":1}],
      "rawInput":{"command":"create","path":"acp_spike_hello.txt","content":"hi"},
      "_meta":{"kiro":{"toolName":"write"}}}}}

// tool finished
<-- {"method":"session/update","params":{"sessionId":"...","update":{
      "sessionUpdate":"tool_call_update","toolCallId":"tooluse_...","kind":"edit",
      "status":"completed","title":"...","locations":[...],"rawInput":{...},
      "rawOutput":{"items":[{"Text":"Successfully created ... (1 lines)."}]}}}}

// assistant text
<-- {"method":"session/update","params":{"sessionId":"...","update":{
      "sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"done"}}}}

// final response to the prompt request
<-- {"jsonrpc":"2.0","id":3,"result":{"stopReason":"end_turn"}}
```

Key takeaways for the UI/state model:

- **Transcript** = ordered stream of `agent_message_chunk` (assistant text) and
  `tool_call` / `tool_call_update` (tool activity with diffs).
- **Status** is derivable: a `session/prompt` in flight = **working**; a
  `session/request_permission` = **needs-approval**; `stopReason:"end_turn"` on
  the prompt result = **idle**. No pane-hash heuristics needed.
- `content[].type:"diff"` with `path`/`oldText`/`newText` feeds the **diff review**
  UI directly.
- `_kiro.dev/metadata.meteringUsage` (credits) + `turnDurationMs` feed **spend /
  effectiveness reporting**.

---

## 4. `session/request_permission` (agent → client request)

Emitted when a tool needs approval (this run used **no** `--trust-all-tools`):

```jsonc
<-- {"jsonrpc":"2.0","id":"c7592e31-...(uuid)","method":"session/request_permission","params":{
      "sessionId":"...",
      "toolCall":{"toolCallId":"tooluse_...","title":"Creating acp_spike_hello.txt"},
      "options":[
        {"optionId":"allow_once","name":"Yes","kind":"allow_once"},
        {"optionId":"allow_always","name":"Always","kind":"allow_always"},
        {"optionId":"reject_once","name":"No","kind":"reject_once"}],
      "_meta":{"trustOptions":[
        {"label":"Specific paths","display":"acp_spike_hello.txt","setting_key":"runtime_write_paths","patterns":["/abs/acp_spike_hello.txt"]},
        {"label":"Complete directory","display":"/abs/dir","setting_key":"runtime_write_paths","patterns":["/abs/dir"]}]}}}
```

The client **must reply** with the chosen outcome:

```jsonc
--> {"jsonrpc":"2.0","id":"c7592e31-...(uuid)","result":{
      "outcome":{"outcome":"selected","optionId":"allow_once"}}}
```

- Note the request `id` is a **string UUID** (not an int) — echo it back exactly.
- Options map cleanly to the UI: **Yes / Always / No** →
  `allow_once` / `allow_always` / `reject_once`.
- `_meta.trustOptions` lets the UI offer scoped "always" choices (e.g. trust this
  path / this whole directory), which we persist as `runtime_write_paths`.
- To reply "deny", select `reject_once`. (Cancelling the whole turn is a separate
  `session/cancel` — not exercised in this spike; verify shape before relying on it.)

---

## Implications for the Rust ACP client (Phase 2/3)

1. Model messages as an enum: `Response { id, result|error }`,
   `AgentRequest { id, method, params }`, `Notification { method, params }`.
   Accept **both int and string ids** (`serde_json::Value` or an untagged enum).
2. Maintain a pending-request map keyed by our int ids for `initialize` /
   `session/new` / `session/prompt` correlation.
3. Handle two `session/update` streams: standard `session/update` **and**
   `_kiro.dev/session/update`. Treat unknown `_kiro.dev/*` notifications as
   non-fatal (log + ignore) so version drift doesn't break us.
4. Derive session status from prompt lifecycle + permission requests; surface
   `session/request_permission` as the inline Approve/Deny UI.
5. Point `session/new.cwd` at the workspace's **git worktree** path.
6. Capture `_kiro.dev/metadata` for context %, credits, and turn duration.

## Capability notifications — VERIFIED (`docs/spikes/acp_capabilities_probe.py`)

The per-session capability inventory kiro-cli emits as `_kiro.dev/*`
notifications around `session/new`. Exact per-item shapes captured from a live
kiro-cli 2.11.1 run (`acp_capabilities_probe.log`).

> **"Skills" note:** ACP has no first-class "skill" concept. Skills surface as
> **`prompts[]` entries with `serverName: "skill:config"`** (e.g. `autoreview`,
> `code-review`). So the protocol-backed view of "skills" is the prompts list.

### `_kiro.dev/commands/available`

```jsonc
<-- {"jsonrpc":"2.0","method":"_kiro.dev/commands/available","params":{
      "sessionId":"<id>",
      "commands":[
        // name INCLUDES the leading slash. `meta` is optional and varies.
        {"name":"/clear","description":"Clear conversation history"},
        {"name":"/agent","description":"Select or list available agents",
         "meta":{"optionsMethod":"_kiro.dev/commands/agent/options",
                 "inputType":"selection","hint":"","local":true,
                 "subcommands":["create","edit","swap"],
                 "subcommandHints":{"create":"<name>","edit":"[name]","swap":"<name>"}}}],
      "prompts":[
        // Skills + saved prompts. `arguments` observed empty; `serverName` varies
        // ("skill:config" for skills).
        {"name":"autoreview","description":"...","arguments":[],"serverName":"skill:config"}],
      "tools":[
        // `source` is "built-in" or "mcp:<serverName>".
        {"name":"code","description":"...","source":"built-in"},
        {"name":"take_screenshot","description":"...","source":"mcp:chrome-devtools"}],
      "mcpServers":[
        {"name":"chrome-devtools","status":"running","toolCount":29}]}}
```

- **`commands[].name` includes the leading `/`.** `meta` is optional; treat every
  field inside it as optional (`inputType`, `hint`, `local`, `optionsMethod`,
  `subcommands[]`, `subcommandHints{}`).
- **`prompts[]`**: `{name, description, arguments[], serverName}`. `serverName`
  distinguishes skills (`skill:config`) from other prompt sources.
- **`tools[]`**: `{name, description, source}` — `source` = `built-in` or
  `mcp:<server>`.
- **`mcpServers[]`**: `{name, status, toolCount}`.

### `_kiro.dev/mcp/server_initialized`

```jsonc
<-- {"jsonrpc":"2.0","method":"_kiro.dev/mcp/server_initialized",
      "params":{"sessionId":"<id>","serverName":"chrome-devtools"}}
```

### `_kiro.dev/subagent/list_update`

```jsonc
<-- {"jsonrpc":"2.0","method":"_kiro.dev/subagent/list_update",
      "params":{"subagents":[],"pendingStages":[]}}
```

- Observed **empty** in the spike (no active subagent fan-out). Per-item shape of
  `subagents[]`/`pendingStages[]` is therefore **not captured** — parse leniently
  (best-effort `name`/string fields), tolerating unknown structure.

### Slash-command invocability — VERIFIED

Sending a slash command as a plain `session/prompt` **text block executes it** —
it is _not_ treated as literal prose:

```jsonc
--> {"jsonrpc":"2.0","id":3,"method":"session/prompt",
      "params":{"sessionId":"<id>","prompt":[{"type":"text","text":"/help"}]}}
<-- session/update agent_message_chunk: "Available Commands:\n\n  /agent ..."
<-- {"jsonrpc":"2.0","id":3,"result":{"stopReason":"end_turn"}}

--> {..."prompt":[{"type":"text","text":"/clear"}]}
<-- session/update agent_message_chunk: "Conversation cleared\n"
```

→ The palette can be **actionable through the existing `session/prompt` path**
(i.e. our `orchEnqueue` flow). No separate invocation method is needed for
commands. Prompts/skills can be invoked the same way (their `name` has no slash;
kiro exposes a `/prompts` command to run them, and the skill name doubles as a
trigger phrase).

## Session resume — VERIFIED (`docs/spikes/acp_resume_probe.py`)

Sessions **persist and can be resumed** across process restarts:

- kiro-cli writes every session to `~/.kiro/sessions/cli/<sessionId>.{jsonl,json,history}`
  (`.jsonl` = transcript, `.json` = state, `.history` = input history).
- **`session/load`** resumes one:
  ```jsonc
  --> {"jsonrpc":"2.0","id":2,"method":"session/load",
        "params":{"sessionId":"<id>","cwd":"/abs","mcpServers":[]}}
  <-- {"jsonrpc":"2.0","id":2,"result":{"modes":{...},"models":{...}}}  // same shape as session/new
  ```
- **Locking caveat:** each active session holds `~/.kiro/sessions/cli/<id>.lock`
  = `{"pid":N,"started_at":"..."}`. A hard-killed process (a bare `kill_on_drop`
  SIGKILL) leaves a **stale lock**, and `session/load` then fails with
  `"Session is active in another process (PID N)"`. Resume works once the stale
  lock is cleared — remove `<id>.lock` when its `pid` is not alive (safe), or
  shut the agent down gracefully so it removes its own lock.
- **How Bugyo handles it** (see [`AcpClient::shutdown`](../src-tauri/src/acp/client.rs)
  - `ensure_client`/`release_client` in [`service.rs`](../src-tauri/src/service.rs)):
    releasing an idle session sends **SIGTERM and waits** for a clean exit (falling
    back to SIGKILL after a grace period) so kiro-cli removes its own lock instead
    of leaving a stale one. On resume, [`reclaim_stale_lock`](../src-tauri/src/acp/mod.rs)
    deletes the lock only if its `pid` is dead, and `ensure_client` **retries the
    reclaim + `session/load`** a few times: this closes the race where a
    just-released (or crashed) process is still exiting and momentarily keeps the
    lock alive. A truly orphaned live process (e.g. a hard app crash) still needs a
    manual quit/kill — we never SIGKILL an unknown PID out from under the lock.

## Image prompts (screenshots) — VERIFIED (`docs/spikes/acp_image_probe.py`)

`initialize` advertises `agentCapabilities.promptCapabilities.image: true`, and a
live probe confirmed kiro-cli accepts **image content blocks** on
`session/prompt`. The `prompt` array simply mixes text and image blocks:

```jsonc
--> {"jsonrpc":"2.0","id":11,"method":"session/prompt","params":{
      "sessionId":"...",
      "prompt":[
        {"type":"text","text":"Here's the current UI. Critique it."},
        {"type":"image","mimeType":"image/png","data":"<base64 PNG>"}
      ]}}
```

Accepted image-block shape (ACP standard): **`{type:"image", mimeType, data}`**
where `data` is base64 (no `data:` URI prefix). The model genuinely _sees_ the
image — in the probe it described the real captured screen, not the prompt text.

This is how Bugyo does **Codex-style visual input** without an MCP: the backend
captures a screenshot ([`screenshot`](../src-tauri/src/screenshot.rs)) and
injects it directly into the turn ([`protocol::prompt_request_with_images`],
[`client::prompt_with_images`], [`AcpManager::prompt_with_screenshot`], command
`acp_prompt_with_screenshot`). The screenshot is runtime-injected as an image
input — the agent never "calls a screenshot tool."

**Self-improvement loop usage:** agent edits the frontend in its worktree →
rebuild/serve → `acp_prompt_with_screenshot(sessionId, "critique this", opts)` →
the model sees the rendered UI and responds → iterate. By default the capture is
scoped to **Bugyo's own window** (resolved via `WebviewWindow::ns_window()` →
`-[NSWindow windowNumber]`, then `screencapture -l <id>`) — focused, cheaper, and
free of unrelated on-screen content. Explicit targets override: `region`
("x,y,w,h") > `window_id` > `display` (1 = main); pass `own_window: false` (with
no other target) for the full main display.

**macOS Screen Recording permission (required):** capture uses
`screencapture(1)`. The process invoking it (in dev, the terminal/`Bugyo`; when
packaged, the `.app`) must be granted **System Settings → Privacy & Security →
Screen Recording**. Without it, macOS returns desktop-only pixels (wallpaper),
not window contents — the capture still yields a valid PNG, so a "blank" result
usually means the permission is missing. Granting it requires quitting and
reopening the app once.

## Still to verify (not covered by spikes)

- `session/cancel` request/response shape.
- Whether `session/load` replays the transcript via `session/update` (the load
  call returns modes/models; transcript replay not yet captured).
- `fs/read_text_file` / `fs/write_text_file` — whether the agent calls back to the
  client for file I/O when we advertise `clientCapabilities.fs`.
- Error object shapes on failed requests.
- Multi-session behaviour within one `kiro-cli acp` process vs. one process per
  workspace (spike used a single session per process).
- Per-item shape of `_kiro.dev/subagent/list_update` `subagents[]`/`pendingStages[]`
  (observed empty — no active fan-out during the spike).
