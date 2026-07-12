# Bugyo Tauri-native harness plan

Goal: Add a native agent runtime to Bugyo's Tauri backend, using Chisei's
OpenAI-compatible gateway for governed model execution while Bugyo retains
ownership of sessions, tools, workspaces, approvals, review, and recovery.

The Chisei gateway requirements live in
`../sekai-chisei/docs/plans/30-native-harness-integration.md`. This plan owns the
host implementation and does not add a separate Bugyo app-server.

## Architecture and ownership

`React UI -> typed Tauri IPC -> Bugyo runtime manager -> Chisei /v1/responses`

Bugyo owns local sessions, the agent loop, conversation state, tools, sandbox,
approvals, queues, worktrees, processes, review, checks, landing, and recovery.
Chisei owns governed model routing, budget, egress, usage, audit, operation
correlation, and the external evidence contract. Kiro ACP remains supported as
an independent runtime.

## Runtime abstraction

Introduce a runtime-neutral interface for session creation, hydration, resume,
turn execution, cancellation, approval response, close, and deletion. The first
adapters are `kiro-acp` and `chisei-native`; a Codex app-server adapter can be
added later without changing either implementation.

The frontend consumes runtime-neutral status, message, reasoning, tool,
approval, usage, completion, cancellation, and failure events. Existing Kiro
sessions default to `kiro-acp` during migration and hydrate unchanged.

## Agent-loop state machine

Persist this lifecycle:

`queued -> generating -> awaiting_tool -> awaiting_approval -> executing_tool -> continuing -> completed|failed|cancelled`

Every transition carries the Chisei operation id plus Bugyo session, turn,
attempt, and cycle ids. Enforce hard bounds for model/tool cycles, tool calls,
input/output size, inactivity, total duration, retries, child processes, retained
output, and repeated non-progressing calls.

Cancellation propagates to model streams and child processes. Retriable failures
preserve queued work; terminal runtime failures stop queue draining.

## Conversation ownership

Persist portable user, assistant, tool-call, and tool-result items. Define
deterministic reconstruction, context-window accounting, bounded history,
compaction provenance, retry/fork/supersession behavior, model-visible versus
audit-only metadata, and stored-schema migration.

Provider response ids may be cached but are not required for resume because
Chisei can route a later cycle to another compatible provider.

## Tool registry

Every tool has a stable name/version, JSON input schema, risk class, workspace
scope, output bound, cancellation behavior, redaction rules, and deterministic
test implementation.

Roll out tools in this order:

1. Read-only inspection: list, read, search, git status, and diff.
2. Bounded mutations: patch, write, and create directory.
3. Processes: explicit command/argument execution, stdin, and termination.
4. Destructive operations only through an existing explicit safe product flow;
   never expose unrestricted reset, deletion, or force-push primitives.

Repository content, tool arguments, tool output, and model output are untrusted.

## Sandbox and approvals

Bugyo enforces canonical workspace roots, prevents traversal and symlink escape,
filters process environment, bounds output, and applies network policy.

Writes and commands require policy/approval. Destructive actions always require
a visible human decision. Bind approval to operation, workspace, principal,
scope, tool name/version, canonical argument digest, and expiry. Revalidate
immediately before execution so arguments or workspace identity cannot be
substituted. Bugyo records its local decision as operation evidence.

## Secret material and tool credentials

Goal: let a task use credentials (tokens, deploy keys, database passwords,
provider logins for local tools) without exposing them to the model, the
transcript, persisted state, or Chisei.

Bugyo owns all secret material. Secrets are stored through the OS keychain via
Tauri, never in the SQLite session store, conversation history, plaintext
config, or the repository. Callers reference a secret by a stable name and
scope, never by value; the runtime resolves a name to a value only at the moment
of an approved local effect.

Scope every secret to a principal, project, and workspace, and to the specific
tools or commands allowed to consume it. Injection modes are explicit: a process
environment variable, an argument placeholder (`${secret:<name>}`), or a file
materialized inside the canonical workspace with a bounded lifetime. Placeholders
are resolved only after approval and are never rendered back into model-visible
arguments, stored conversation items, or the canonical argument digest.

Binding and approval reuse the sandbox contract: a secret release is bound to
operation, workspace, principal, tool name/version, and canonical argument
digest, and is revalidated immediately before execution so a substituted
argument or workspace identity cannot redirect a secret. First use of a secret in
a scope requires a visible human decision; later uses within the same approved
scope may be policy-allowed.

Redaction is mandatory. The value is scrubbed from streamed and persisted tool
output, logs, error text, and any Plan 29 evidence before it leaves the tool
boundary. Materialized secret files and injected environment are removed when the
tool call completes, is cancelled, or its process is terminated; recovery treats
a possibly-leaked secret as a review item and supports rotation.

Chisei never receives secret values. The gateway boundary already forbids
credential material in payloads, receipts, evidence, logs, and correlation
metadata (`../sekai-chisei/docs/plans/30-native-harness-integration.md`). Bugyo
records only that a named secret was released to a scope as operation evidence;
the value stays host-side.

## Persistence and recovery

Persist enough state to distinguish proposed, approved, executing, and completed
tools. Recovery never blindly replays a possibly completed mutation.

Persist runtime/version, operation/session/turn/attempt/cycle ids, conversation
and compaction lineage, pending tools and digests, approvals, process/output and
cancellation state, usage/gateway metadata, and emitted receipt/evidence
idempotency keys.

Hydration reconciles stored state with workspace and process reality. Ambiguous
effects become visible review items rather than assumed successes or retries.

## Tauri and UI contract

Keep Tauri handlers thin and the loop in testable Rust services. React never
calls Chisei or providers directly. Rust and TypeScript event, session, approval,
and configuration types change together.

The UI adds runtime selection, gateway/capability status, native transcript and
approval events, cancellation/recovery state, and evidence coverage where useful
in review and landing.

## Outcome adapter

Bugyo emits Plan 29 observations only for events its backend witnesses: result
produced, user accepted/rejected, exact-revision checks, PR/merge/archive or
supersession, and resource/duration measurements.

Independent CI, deployment, incident, and revert evidence belongs to separate
adapters. Acceptance, verification, delivery, and operational health remain
separate; missing evidence remains unknown.

## Delivery phases

1. Add Chisei gateway configuration, capability diagnostics, and a text-only
   streamed Responses probe.
2. Introduce the runtime-neutral interface and wrap Kiro ACP unchanged.
3. Persist runtime-neutral sessions, turns, conversation, and operation
   correlation with backward-compatible hydration.
4. Implement text-only Chisei-native turns with streaming, cancellation, limits,
   retries, and restart recovery.
5. Add the read-only tool registry and iterative tool-result loop.
6. Add approval-bound mutation and process tools with sandbox enforcement.
7. Add the scoped secret store with keychain-backed material, approval-bound
   injection, redaction, and lifecycle cleanup for local tools.
8. Integrate the native runtime with review, checks, landing, queues, heartbeat,
   and automations.
9. Emit correlated Plan 29 observations and compare runtime cohorts before
   enabling outcome-driven defaults.

## Verification

- Scripted Responses fixtures cover fragmented/unknown SSE events, text,
  multiple and malformed tool calls, usage, disconnects, retries, and
  cancellation.
- State-machine tests cover transitions, limits, timeouts, retries, duplicates,
  and non-progressing loops.
- Security tests cover traversal, symlink escape, approval substitution,
  environment/secret leakage, oversized output, network denial, and destructive
  operations.
- Secret-handling tests prove values never reach the model context, transcript,
  persisted store, logs, or Plan 29 evidence, are scrubbed from tool output, are
  removed after completion/cancellation, and cannot be redirected by argument or
  workspace substitution.
- Recovery tests stop Bugyo during generation, approval, mutation, and process
  execution and prove effects are not silently duplicated.
- Existing Kiro sessions, queues, approvals, automations, and review flows remain
  unchanged after runtime abstraction.
- An end-to-end native task streams output, reads and changes files, requests
  approval, runs checks, produces a reviewable diff, and emits correlated
  evidence.
- Rust formatting, Clippy, Rust tests, TypeScript typecheck/lint/tests, and the
  packaged Tauri build pass. Live-provider tests remain explicit and separate.
