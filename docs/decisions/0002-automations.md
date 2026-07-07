# 0002 — Scheduled Automations: design & cron crate

- **Status:** Accepted
- **Date:** 2026-07-07
- **Deciders:** project owner
- **Context docs:** [`VISION.md`](../../VISION.md), [`PLAN.md`](../../PLAN.md),
  [`AGENTS.md`](../../AGENTS.md)

## Context

We want **Automations**: user-defined tasks that fire on a **timer** and drive a
kiro session — either re-invoking an existing session or spinning up a new
session/workspace — with a **durable prompt**. The agent does the real work
through its normal ACP tools; results are reviewed by opening the target
session's transcript.

The design deliberately mirrors the **OpenAI Codex app** "Automations" feature
(durable prompt + schedule + target; thread automations re-invoke an existing
thread, standalone automations start fresh runs, optionally in a worktree). See
<https://developers.openai.com/codex/app/automations>.

## Decisions

### 1. Action model — durable prompt, not a structured-action brain

An automation is a **durable prompt delivered to a session** on a schedule. The
agent's own turn is the "brain"; we do **not** parse structured JSON actions
back from the model, and we do **not** add an MCP callback layer. This reuses the
existing end-to-end path:

- **Existing session** → `AcpManager::enqueue` (dispatches now if idle, else
  queues) → `client.prompt` = ACP `session/prompt`.
- **New session** → `acp_start_session` semantics → `enqueue`.
- **New workspace** → `workspace_create` (git worktree + branch) → `enqueue`.

Findings are reviewed by opening the target session's streamed transcript. A
separate "Triage" store and Codex's "auto-archive if nothing to report" nicety
are **deferred**; both can be added later without rework.

### 2. Trigger — timer only (interval or cron)

Scope is intentionally **timer-triggered only** (no event triggers). Two
schedule kinds: `IntervalSecs { secs }` and `Cron { expr }`. The "is it due?"
decision is a **pure function** (`orchestrator::schedule::is_due`) taking the
schedule, `now`, and the last-run time — deterministic and unit-tested. The
scheduler loop (alongside the existing heartbeat) supplies the clock and
persists `last_run`.

Semantics:

- Interval: a fresh (never-run) interval is **seeded** on the scheduler's first
  pass rather than fired, so "every N" measures from now and app restarts don't
  re-fire it; thereafter it is due every `secs` from the last run. (Use **Run
  now** to test immediately.)
- Cron: due when an occurrence falls in `(last_run, now]`; a fresh cron (no
  `last_run`) is likewise seeded and waits for its next occurrence.

### 3. Cron crate — `saffron` 0.1.0 (pinned)

- **`saffron`** — standard 5-field Unix cron, integrates with `chrono`
  (`Cron::next_after(DateTime<Utc>)`), small dependency tree (`nom`). Chosen.
- Alternatives considered: **`cron`** (quartz-style 6–7 fields incl. seconds —
  non-standard syntax for users typing cron); **`croner`** (heavier). Rejected in
  favour of familiar 5-field syntax and a minimal footprint.

Pinned exactly (`saffron@0.1.0`) per `AGENTS.md`.

### 4. Safety — per-automation trust, default to approval

Each automation carries a `TrustMode`:

- `Ask` (default) — no trust widening; every tool call requires an explicit
  human decision (the standard human-in-the-loop flow).
- `TrustTools { tools }` — a scoped allowlist (`--trust-tools`).
- `TrustAll` — auto-approve all tool calls (`--trust-all-tools`); an explicit,
  **warned** opt-in surfaced in the UI.

Trust is applied when an automation **creates** a session (passed to
`kiro-cli acp` at launch). For an **existing** session, trust is fixed at that
session's original launch and is not changed by the automation. Destructive git
actions continue to require an explicit owner decision regardless of trust.

## Consequences

- Automations are a thin scheduler + router over primitives that already exist
  and are already safety-reviewed; the new mutation surface is small.
- Persistence lives in `~/.kiro/bugyo/automations.json` (same pattern as
  `projects.json` / `sessions.json`).
- Because we reuse `enqueue`, an automation targeting a **cold** (released)
  session lazily reloads it via `session/load` — no special handling needed.
