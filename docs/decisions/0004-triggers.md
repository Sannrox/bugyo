# 0004 — Triggers: event-driven, token-free activation

- **Status:** Accepted
- **Date:** 2026-07-12
- **Deciders:** project owner
- **Context docs:** [`VISION.md`](../../VISION.md), [`PLAN.md`](../../PLAN.md),
  [`AGENTS.md`](../../AGENTS.md), [`0002-automations.md`](./0002-automations.md)

## Context

[Automations](./0002-automations.md) fire on a **timer** and always deliver a
durable prompt — which means every scheduled pass spends a full model turn just
to answer "is there anything to do?". For watch-style work ("react when a new PR
appears", "when CI goes red", "when a feed updates") that is mostly wasted spend:
the model is invoked on every tick regardless of whether anything changed.

**Triggers** add **event-driven** activation. A cheap, model-free *detector* is
polled on a schedule; only when it reports genuinely-new items does the trigger
spend tokens by firing an action. This explicitly **supersedes the "timer only,
no event triggers" scope note in [0002](./0002-automations.md)** — automations
remain the timer primitive; triggers are the event primitive layered over the
same dispatch path.

## Decisions

### 1. A generic detector model — no source is special-cased

A trigger's source is one of two **generic** detectors (`config::TriggerSource`):

- **`Command { program, args }`** — run a read-only command/script (spawned with
  explicit args via `std::process::Command`, never a shell string), parse its
  stdout.
- **`HttpGet { url, headers }`** — issue a read-only HTTP GET, parse the body.

There is no GitHub (or any other provider) type in the code. **Watching GitHub
PRs is just a configuration**, not a feature — see the worked example below.
Header values may contain `${ENV_VAR}` placeholders resolved at poll time, so a
token is referenced by env-var name and never persisted in `triggers.json` or
echoed back.

### 2. Output format — JSON (default) or Lines

A detector's output is parsed per `config::OutputFormat`:

- **`Json`** — an array of items. Each object derives its id from
  `id`/`number`/`key` (else a stable content hash), its dedup cursor from an
  `updatedAt`/`updated_at`/`updated` field, and exposes all fields for context
  injection. This is what `gh --json` and most HTTP APIs emit naturally.
- **`Lines`** — one item per non-empty line; the line is the content and its
  content-hash (FNV-1a, stable across runs) is the id. Lets any existing CLI
  one-liner be a detector without wrapping it in `jq`.

A pure exit-code / "condition met" mode was **deliberately deferred**: with no
item identity it either re-fires every tick (defeating the token saving) or
needs stateful edge-detection — a separate feature. `Lines` covers most of the
same ground with proper dedup.

### 3. Token-free detection is a contract

Detection **never invokes the model** (`service::detect` does I/O and parsing
only, no ACP calls). Firing is the only token-spending step. This is the whole
point of the feature and is enforced structurally: the detector boundary has no
access to the ACP client.

### 4. Dedup is internal — a watermark plus a bounded seen-set

Users configure *what* to watch, never *how* de-duplication works.
`config::DedupState` holds:

- a **`seen`** set of recently-fired item ids — authoritative, catching
  reopened/out-of-order items, bounded to `SEEN_CAP` (200, oldest pruned); and
- a **`watermark`** (highest cursor recorded) — a cheap backstop so ids pruned
  out of the bounded set are not re-fired.

The pure core (`orchestrator::triggers`) computes `new_items` (not in `seen` and
past the watermark), and `advance_state` records fired ids and advances the
watermark **only** to a value strictly below any new-but-unfired item's cursor,
so items capped out of a tick are never masked and fire on a later pass. Dedup
state survives restarts (persisted in the trigger) and is preserved across UI
edits (`trigger_update` never overwrites it from the frontend).

### 5. Fan-out vs batch is user-chosen; the per-tick cap has a hard ceiling

When a single poll finds several new items, `config::FanoutMode` chooses:

- **`FanOut`** — one run per item (each carries its own context); or
- **`Batch`** — a single run carrying all items (cheapest on tokens).

The user sets `max_runs_per_tick`, but it is clamped to a non-negotiable system
ceiling (`MAX_RUNS_CEILING` = 20) in `clamp_runs`, so a misconfigured filter
matching hundreds of items can never storm the fleet.

### 6. Actions reuse the automation dispatch path

`config::TriggerAction` is either:

- **`Automation { automationId }`** — fire an existing automation (reuses its
  prompt/target/trust); or
- **`Inline { prompt, target, trust }`** — carry the action directly.

Both route through the existing `run_automation_inner` (`ExistingSession` /
`NewSession` / `NewWorkspace` targets, with bounded session reuse), so triggers
add only a thin scheduler + detector + router over already-safety-reviewed
primitives — the same principle that kept automations small. Inline actions
synthesize an automation keyed `trigger:<id>` so `New*` targets reuse one session
across items and ticks.

### 7. Safety — untrusted output, trusted user commands, approval-first firing

- Detector output is **untrusted data**. Matched items are injected into the
  prompt inside a delimited `<untrusted-trigger-context>` block that instructs
  the agent to treat them as data, not instructions (per AGENTS.md).
- A **command detector runs with the user's own permissions** — trusted as their
  config, with a visible UI warning — but its output is still untrusted
  downstream.
- Firing respects the action's `TrustMode` (default `Ask`). Writes, shell
  execution, and cloud actions still require an explicit approval regardless of
  trust; the legacy `TrustAll` remains downgraded to approval-required.

## Worked example — a GitHub PR poller (no GitHub-specific code)

A `Command` trigger, format `Json`, polled every 5 minutes:

```
program: gh
args:
  pr
  list
  --repo owner/name
  --json number,title,url,updatedAt
  --search is:open
```

`gh` inherits the user's existing auth; each PR's `number` becomes the item id
and `updatedAt` the dedup cursor. Paired with an `Inline` action targeting a new
workspace and `FanOut` mode, each newly-opened PR spins up an isolated review
session — while the five-minutely poll itself costs no tokens. The same result
via `HttpGet` against the GitHub API uses an `Authorization: Bearer ${GITHUB_TOKEN}`
header.

## Consequences

- Persistence lives in `~/.kiro/bugyo/triggers.json` (same pattern as
  `automations.json`). A `trigger:run` event mirrors `automation:run`.
- The scheduler is a second periodic pass (`trigger_tick`, `TRIGGER_SECS`)
  alongside the heartbeat and automation loops. A detector error is recorded as
  an error run and backs off without advancing dedup state (retried next pass).
- Adds one dependency, `reqwest` (rustls), already present in-tree via the
  updater plugin — so no new dependency weight for the HTTP GET detector.
- "Run now" polls and fires on new items **without** advancing dedup state, so
  it is a safe, repeatable test while configuring (mirrors automation run-now).
