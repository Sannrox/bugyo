# VISION

## Purpose

Build **Bugyo** (奉行) — a **Tauri desktop application** that orchestrates and
manages many `kiro-cli` sessions from a single window. (A _bugyō_ was a
magistrate who directed and governed subordinates.)

The orchestration pattern began as a tmux-based control plane: one long-lived
interactive `kiro-cli chat` worker per repository, prompts dispatched with
`tmux send-keys`, output read back with `tmux capture-pane`, and an external
heartbeat feeding queued work to idle workers. It worked, but it was
terminal-bound, heuristic, and
hard to observe at a glance.

This project takes that proven loop and gives it a **native, observable, steerable
GUI**. One window. Every session visible. Every dispatch, queue, and status change
is a first-class UI event instead of a scrape of a terminal pane.

## Problem

The tmux orchestrator has real limitations that a GUI is uniquely suited to fix:

- **Observability is a scrape.** Session state is inferred from pane-hash
  stability and `capture-pane` text. Idle vs. busy is a guess — even though
  `kiro-cli acp` can emit this state as structured protocol events.
- **Steering is awkward.** Attaching means jumping into a tmux window; you can
  only watch one worker's raw stream at a time.
- **No cohesive overview.** There is no single view of all workers, their queues,
  their current task, their token spend, or their pending approvals.
- **Approvals are invisible.** When a worker stops on a write/tool-approval
  prompt, nothing surfaces it — you have to attach and notice.
- **State is files.** Worker metadata, queues, and the decision log live in
  `~/.kiro-orchestrator/` as JSON/JSONL with no live, unified surface.

## Vision

A single desktop window that acts as the **cockpit for a fleet of kiro sessions**.

The app should answer, at a glance:

1. What sessions are running, and against which repositories?
2. Which are working, idle, blocked, or waiting on my approval?
3. What is each one doing right now, and what is queued behind it?
4. What decisions has the orchestrator made, and why?
5. Where does a human need to step in?

If it succeeds, a maintainer runs a dozen concurrent kiro workers across many
repos, steers any of them without leaving the app, approves or denies actions
inline, and trusts the fleet to keep making safe progress between check-ins.

## Design Inspiration

Two shipping products define the UX bar for this category, and we deliberately
orient toward them:

- **Conductor** (`conductor.build`) — a macOS app for running multiple Claude
  Code / Codex / Cursor agents in parallel. Its defining ideas we adopt:
  - **Git worktree isolation**: every workspace gets its own branch and working
    tree, so agents work concurrently without colliding on disk or in git.
  - A **workspace sidebar** to see at a glance what each agent is working on.
  - **Setup/run scripts** per workspace to prepare and exercise the environment.
  - A **diff review → checks → merge / pull-request flow** to land each stream of
    work, and the ability to **run, review, merge, or archive** each on its own
    schedule.

- **Codex app** (OpenAI) — a macOS "command center for agents":
  - Agents run in **separate threads organized by projects**, so you switch
    between tasks without losing context.
  - A **tabbed / multi-pane interface** for parallel sessions.
  - **Long-running background tasks** with review of automated changes.
  - Built-in **worktrees** so several tasks progress without bleeding into each
    other.

What we take from them: **worktree-per-workspace isolation**, an **at-a-glance
fleet/sidebar overview**, **project-organized sessions**, and a **first-class
review-and-merge flow**.

What we do differently: this app is built on **kiro-cli** via **ACP** (not Claude
Code / Codex / Cursor), it inherits the `kiro-orchestrator` **dispatch / queue /
heartbeat** control loop for semi-autonomous progress between check-ins, and it
keeps a **human-in-the-loop approval model** as the default. It should not be
cross-platform-hostile, but the first target — like both references — is macOS.

## Product Shape

### 1. Session Fleet View

The primary surface: a live, project-organized overview of all workspaces —
a **workspace sidebar** (Conductor-style) plus a detail area.

- Sessions grouped by **project** (repository); switch between them without
  losing context (Codex-style threads).
- One card/row per workspace: repo, branch, agent, current task, status, queue
  depth — see at a glance what every agent is doing.
- Real-time status badges: **working / idle / blocked / needs-approval /
  needs-review / error**.
- Click into any workspace to see its full transcript and steer it directly.
- Multi-pane / tabbed layout so several live sessions can be watched side by side.

### 2. Workspaces & Worktree Isolation

Each unit of work is a **workspace**: an agent session bound to its own **git
worktree and branch** (the core isolation model from both Conductor and Codex).

- Creating a workspace cuts a fresh worktree/branch from the repo's base branch
  (fetching origin first), so agents never collide on disk or in git history.
- Multiple workspaces can target the **same repository** concurrently — one
  refactoring, one writing tests, one on docs — with zero cross-contamination.
- Optional per-workspace **setup script** (prepare deps/env) and **run script**
  (build/test/serve) so each worktree is immediately usable and checkable.
- Each workspace can be **run, reviewed, merged, or archived** on its own
  schedule; archiving cleans up the worktree.
- This supersedes the orchestrator's "one persistent worker per repo" model,
  though a long-lived worker on a repo's main tree remains available for chores
  that should not run in an isolated branch.

### 3. Session Transport — ACP

Drive each session over the **Agent Client Protocol (ACP)** using kiro-cli's
built-in `kiro-cli acp` agent, instead of scraping terminals.

kiro-cli ships an ACP agent out of the box:

```
kiro-cli acp [--agent <AGENT>] [--model <MODEL>] [--effort <LEVEL>]
             [--trust-all-tools | --trust-tools <NAMES>]
             [--agent-engine v2|v1|v3]
```

ACP is a JSON-RPC protocol spoken over the process's stdio (the same protocol
editors like Zed use to talk to coding agents). The Tauri (Rust) backend spawns
`kiro-cli acp` worker processes and communicates structurally:

- **Sessions are protocol objects.** Create, prompt, and cancel sessions through
  ACP methods rather than typing into a pane. One `kiro-cli acp` process can host
  a session per repository/worker.
- **Output is structured, not scraped.** Streaming assistant messages, tool
  calls, and status transitions arrive as ACP `session/update` events — the UI
  renders a real transcript and derives status from events, not pane hashes.
- **Permission requests are first-class messages.** When the agent wants to run a
  tool or write, ACP surfaces a permission request the app answers with an
  explicit allow/deny — no attaching, no guessing (see §5). Trust can be
  pre-scoped with `--trust-tools`, or fully opened with `--trust-all-tools`.
- **Agent/model/effort are launch parameters.** Each worker is configured via
  `--agent`, `--model`, `--effort`, and `--agent-engine` when spawned.

The old tmux `send-keys`/`capture-pane` path (and a raw PTY + xterm.js pane)
remain available as an **interop/fallback** for direct terminal steering, but ACP
is the primary, durable transport.

### 4. Dispatch, Queue, and Heartbeat

Bring the orchestrator loop into the app as controllable, visible machinery.

- **Dispatch**: send a prompt to a worker now, from the UI.
- **Queue**: stack tasks per worker; the app drains them to idle workers.
- **Heartbeat**: an in-app scheduler replaces the external launchd/cron job,
  with a visible next-tick timer, dry-run preview, and per-pass log.
- Idle/busy detection comes from ACP session events (prompt turn started/ended,
  tool calls, permission requests) instead of pane-hash heuristics.

### 5. Approvals and Safety Surface

Make the human-in-the-loop moments loud and central.

- ACP delivers each write/tool call as a **structured permission request**; the
  app raises it as a UI notification with inline **Approve / Deny** — no
  attaching, no scraping a prompt out of a pane.
- Per-worker trust is set at launch (`--trust-tools <NAMES>` for a scoped
  allowlist, `--trust-all-tools` for full autonomy) and reflects/edits the
  `worker.json` `allowedTools` / `toolsSettings`.
- Destructive actions and real product/security decisions always surface as an
  explicit owner decision, never auto-proceed.

### 6. Review, Checks, and Merge

Landing work is a first-class flow, not an afterthought (the Conductor pattern).

- **Diff review** per workspace: see exactly what the agent changed in its
  worktree before anything touches the base branch.
- **Checks**: run the workspace's run/test script and surface pass/fail inline;
  a `needs-review` status gates merge on green checks.
- **Merge / pull request**: merge the workspace branch, or open a PR via the
  platform CLI (`gh` / `glab`), directly from the app.
- **Archive**: retire a finished or abandoned workspace and clean up its worktree.
- Destructive git actions (force-push, hard reset, branch deletion) always
  require an explicit owner decision.

### 7. Orchestrator Brain (optional, in-app)

The control-plane "brain" — an interactive `kiro-cli chat --agent orchestrator`
session — runs as a dedicated, always-visible pane.

- It triages and drives workers through the same commands `kiro-orch` exposes.
- Because it is a first-class pane, you watch and correct its decisions live.
- It never edits repos; it only orchestrates.

### 8. Unified State and Decision Log

Surface Bugyo's `~/.kiro/bugyo/` state as live, structured UI.

- Workers, queues, and the persistent decision log rendered and searchable.
- History of dispatches, status transitions, and approvals as a timeline.

## Design Principles

- **Local-first and self-owned.** The app runs on the user's machine, owns its
  session processes, and stores state locally. No required cloud dependency.
- **Observable over inferred.** Prefer real process/PTY signals to scraping.
- **Steerable always.** Any session can be watched and driven at any time.
- **Human-in-the-loop by default.** Writes, mutations, and real decisions prompt
  unless the user deliberately widens trust.
- **Interop, not lock-in.** Reuse `kiro-orch` primitives and state layout so the
  CLI and the app can coexist and share ground truth.
- **Thin, fast native shell.** Tauri (Rust core + web UI) for a small footprint,
  a fast startup, and direct OS/process access.

## Non-Goals

- Not a replacement for `kiro-cli` itself — it orchestrates sessions, it does not
  reimplement the agent.
- Not a general-purpose terminal multiplexer or a tmux clone.
- Not a cloud service or multi-tenant SaaS in its first form.
- Not an autonomous system that hides its decisions — every action stays
  inspectable and steerable.

## Architecture (initial direction)

```
┌──────────────────────────── Tauri App ────────────────────────────┐
│  Frontend (TypeScript web UI)                                      │
│   • Workspace sidebar (projects → workspaces, status badges)       │
│   • Structured transcript panes (rendered from ACP events)         │
│   • Dispatch/queue controls, approval prompts, decision timeline   │
│   • Diff review + checks + merge/PR flow                           │
│   • Optional raw terminal pane (xterm.js) for direct steering      │
│                        ▲  events / commands (IPC)                  │
│  Backend (Rust core)   │                                           │
│   • ACP client: spawn `kiro-cli acp` workers, speak JSON-RPC        │
│     (session/new, session/prompt, session/cancel, session/update,  │
│      permission requests)                                          │
│   • Workspace manager: git worktree/branch create, setup/run       │
│     scripts, diff, merge/PR (gh/glab), archive                     │
│   • Dispatch/queue engine + in-app heartbeat scheduler             │
│   • Status/idle detection from ACP session events                  │
│   • State store under ~/.kiro/bugyo (projects, sessions, queue)     │
└────────────────────────────────────────────────────────────────────┘
        spawns / drives ▼  (ACP over stdio)
  workspace: feat-a   workspace: fix-b   workspace: docs-c   orchestrator brain
  (kiro-cli acp in its own git worktree + branch)          (agent orchestrator)
```

Tech baseline: **Tauri v2**, Rust backend, and a **TypeScript + React (Vite)**
web frontend (decided in `docs/decisions/0001-frontend-framework.md`; React
chosen for open-source contributor accessibility and ecosystem). Transport
is **ACP over stdio** to `kiro-cli acp` worker processes (JSON-RPC client in
Rust). An optional `portable-pty` + `xterm.js` path provides a raw terminal view
for direct steering and tmux interop.

## Current State

- `kiro-orchestrator/` implements the loop today over tmux: `bin/kiro-orch`
  (init/add/dispatch/queue/status/attach/heartbeat/stop/down), `worker` and
  `orchestrator` agent configs, a `maintainer-orchestrator-kiro` skill, and a
  launchd/cron heartbeat.
- The state model (`workers/<name>.json`, `queue/<name>.jsonl`, `log.md`) and the
  dispatch/queue/heartbeat semantics are the reference behavior to port.
- **kiro-cli already provides the transport this app needs:** `kiro-cli acp`
  exposes an Agent Client Protocol agent over stdio, with `--agent`, `--model`,
  `--effort`, `--trust-tools`/`--trust-all-tools`, and `--agent-engine` options.
  The app builds on this rather than scraping terminals.
- The Tauri app does not exist yet — this document defines its direction.

## Milestones

### Near Term (MVP)

- Scaffold the Tauri v2 app (Rust backend + TypeScript web frontend).
- Implement a minimal ACP client in the Rust backend: spawn one `kiro-cli acp`
  worker, `initialize`, open a session, send a prompt, and render streamed
  `session/update` events as a transcript.
- Handle a permission request end-to-end with an inline Approve / Deny control.
- Persist fleet state (queue, workers, decision log) under `~/.kiro/bugyo`.
- Fleet view listing workers with live, event-derived status badges.

### Mid Term

- **Workspaces with git worktree isolation**: create a workspace as its own
  worktree + branch, with optional setup/run scripts.
- Multi-workspace management from the workspace sidebar: add/remove, per-workspace
  panes, dispatch & queue from the UI.
- **Diff review + checks + merge/PR flow** to land a workspace's work.
- In-app heartbeat scheduler with next-tick timer and dry-run preview.
- Inline approval prompts for writes/tool calls, with per-workspace trust editing.
- Structured status/idle detection driven by ACP session events.

### Long Term

- The orchestrator brain as a first-class in-app pane driving the fleet.
- Searchable decision timeline and unified state history.
- Per-session token/spend and effectiveness reporting.
- Cross-machine or shared-fleet coordination (optional, later).

## Success Criteria

The app is succeeding when:

- A maintainer runs many kiro workers across repos from one window and always
  knows, at a glance, which need attention.
- Steering any session takes one click, not a tmux attach.
- Approvals surface immediately and are actionable inline.
- The app and `kiro-orch` CLI interoperate over shared state without conflict.
- Nothing destructive happens without an explicit, visible owner decision.

## Short Version

A **Conductor/Codex-style command center for kiro-cli**: take the tmux-based
`kiro-orchestrator` loop and turn it into a **Tauri desktop cockpit** built on
kiro-cli's **Agent Client Protocol** (`kiro-cli acp`). One window that runs,
watches, steers, and safely governs a fleet of kiro sessions — each isolated in
its own **git worktree**, driven by structured protocol events instead of
terminal scraping, landed through a **diff-review-and-merge flow**, steerable
instead of attached, and human-in-the-loop by default.
