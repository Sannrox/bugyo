# Bugyo implementation plan

This roadmap turns [`VISION.md`](./VISION.md) into small, usable vertical
slices. A phase is complete only when its Rust and TypeScript contracts agree,
the relevant tests pass, and the packaged app has been exercised.

## Current product read

Bugyo already has the main technical pieces: ACP sessions and streaming,
worktree creation, approvals, queues and heartbeat, a fleet view, split panes,
automations, transcript search, and a review/check/merge surface. The primary
gap is cohesion. Features are exposed as separate controls, while the user is
left to infer the safe path from task creation through review and completion.

## Phase 1 — A coherent task loop (completed)

Make the core journey obvious and trustworthy:

1. Create a task in an isolated workspace by default.
2. Preserve the human task name separately from its branch slug.
3. Show project, task, branch, activity, queue, and attention state in the fleet.
4. Guide the user from active work into checks, review, merge/PR, and archive.
5. Keep plain sessions available as an explicit advanced path.

Exit criterion: a first-time user can add a repository, start a safe task,
observe it, respond to an approval, review its changes, run checks, and choose a
landing action without knowing Bugyo's internal terminology.

## Phase 2 — Durable operational state (completed)

- Persist the task lifecycle and latest activity across restarts.
- Make check results and `needs-review` first-class backend-derived state.
- Restore queue, heartbeat, approval, and automation context without ambiguity.
- Turn backend startup/reconnection failures into actionable recovery UI.

Exit criterion: quitting or losing an agent process never makes the fleet lie
about what is running, blocked, queued, or ready to review.

## Phase 3 — Review and landing workflow (completed)

- Replace the collapsed utility panel with a guided changes → checks → landing
  workflow.
- Persist per-project setup/check/run commands.
- Add clear clean/dirty/uncommitted/conflict states and safe merge gates.
- Make PR creation, archive, and post-merge cleanup explicit outcomes.

Exit criterion: every isolated workspace has one legible, safe route to land or
discard its work.

## Phase 4 — Fleet-scale control (completed)

- Add project/status filters and denser large-fleet navigation.
- Make queue contents editable and show the next heartbeat decision.
- Elevate the decision log into a searchable, explainable audit timeline.
- Improve multi-pane workflows and bulk actions for a dozen-plus sessions.

Exit criterion: the user can find risk, stalled work, and available capacity at
a glance across many projects.

## Phase 5 — Release readiness (locally verified)

- Exercise ACP and git flows against supported `kiro-cli` versions.
- Add deterministic integration coverage for process loss and git edge cases.
- Complete accessibility and keyboard-only passes.
- Verify signed update/install behavior and end-to-end packaged builds.

Exit criterion: the app is dependable as a daily command center, not just a
collection of working feature demos.

Local verification covers strict Rust/TypeScript compilation and linting,
deterministic unit/integration tests, a real ACP handshake and capability read
against `kiro-cli 2.12.0`, responsive visual QA, and production app/DMG/updater
bundle generation. Distribution notarization and updater signing remain release
operations: they require the Apple credentials and `TAURI_SIGNING_PRIVATE_KEY`
that are deliberately not stored in the repository.
