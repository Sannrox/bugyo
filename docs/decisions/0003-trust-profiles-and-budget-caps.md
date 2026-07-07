# 0003 — Trust Profiles & Budget Caps

- **Status:** Accepted
- **Date:** 2026-07-07
- **Deciders:** project owner
- **Context docs:** [`VISION.md`](../../VISION.md), [`PLAN.md`](../../PLAN.md),
  [`AGENTS.md`](../../AGENTS.md)

## Context

Two governance features for running a fleet of agents safely and affordably:

- **Trust profiles** — reusable approval-rule presets so the operator can
  auto-allow a scoped set of safe tools per session without hand-typing
  `--trust-tools` each time, while never weakening the human-in-the-loop model
  for destructive actions.
- **Budget caps** — per-session (and per-project) credit limits so an
  autonomous, heartbeat-driven fleet can't run up unbounded spend.

Both touch safety-sensitive paths (tool approval and dispatch), so the design
prioritizes a single, testable enforcement point and a fail-safe default.

## Decisions

### 1. Trust profiles map to the existing `--trust-tools` launch path

A `TrustProfile { id, name, autoAllowTools, alwaysAsk }` is stored in
`~/.kiro/bugyo/trust-profiles.json`. When a session is started under a profile,
the profile is translated to the tools passed to `kiro-cli acp --trust-tools`
— **the same, already-vetted trust mechanism** used before this feature.

We deliberately did **not** add an auto-responder inside the live ACP permission
loop. Reusing the launch-time trust path means:

- there is no new code deciding, mid-turn, whether to approve a tool call;
- the behavior is identical to a manually-typed `--trust-tools` list, which is
  already covered by Phase 3's approval tests;
- it avoids a second, subtly-different approval code path to keep correct.

### 2. "Destructive always asks" is enforced in one pure function

`config::effective_trust_tools(profile)` is the **single** point that computes
which tools a profile actually pre-trusts:

```
effective = autoAllowTools − alwaysAsk − ALWAYS_ASK_TOOLS
```

`ALWAYS_ASK_TOOLS` is a hardcoded denylist of destructive / broad-blast-radius
built-ins (`execute_bash`, `fs_write`, `use_aws`). A profile can never
pre-trust these, even if a user lists one — the denylist strips it. This upholds
the safety model's "destructive actions always confirm" rule regardless of
configuration, and it is unit-tested
(`effective_trust_tools_strips_destructive_and_always_ask`). The UI states the
guarantee explicitly.

`--trust-all-tools` remains a separate, explicitly-warned opt-in and is
unaffected by profiles.

### 3. Budget caps are enforced at the single dispatch choke point

`BudgetConfig { sessionCap, projectCaps }` is stored in
`~/.kiro/bugyo/budget.json`; `None`/absent means **unlimited**. The effective
cap for a session is its project override if set, else the default per-session
cap (`config::effective_cap`). Classification (`ok` / `near` / `over`, with
`near` at ≥ 90 %) is a pure function (`config::budget_status`), unit-tested and
mirrored one-to-one in the frontend (`lib/budget.ts`) for the near/over badge.

Spend is accumulated **backend-side**: the event sink sums `credits` from each
`Metrics` event into a per-session total. Enforcement happens at the top of
`AcpManager::dispatch_one` — the one place every dispatch funnels through
(manual enqueue, autonomous heartbeat drain, and post-turn drain). If a session
is over its cap:

- the queued task is **left intact** (not dropped) — raising the cap resumes it;
- a `budget:exceeded` event is emitted and the decision is logged;
- `dispatch_one` returns without dispatching.

This is **fail-safe**: the mechanism can only _prevent_ work, never approve or
perform anything. It never touches git, the filesystem, or tool approvals.

## Consequences

- Approval-fatigue is reduced for read-only tooling without widening trust for
  writes/exec — the safety model is preserved by construction.
- A capped fleet degrades gracefully (pauses) instead of overspending; the
  operator sees near/over badges and a status event.
- Trust profiles are applied at **start** time, so changing a profile does not
  retroactively change a running session's trust — restart the session to apply
  new rules. This is intentional (a session's trust is fixed for its lifetime).
- Budget spend is tracked in-process (resets on app restart); durable spend
  history is out of scope for this iteration.

## Alternatives considered

- **Auto-respond in the permission loop** (rejected) — a second approval path
  with more surface area and higher risk than reusing `--trust-tools`.
- **Frontend-only budget enforcement** (rejected) — the heartbeat dispatches
  autonomously with no UI in the loop, so enforcement must live in the backend
  dispatch path to be effective.
