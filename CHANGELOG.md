# Changelog

All notable changes to Bugyo are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-07-08

First public release. An early, pre-1.0 cut — the core orchestration loop works
end to end, but expect rough edges and no stability guarantees yet.

### Added

- **Fleet orchestration** over the Agent Client Protocol (ACP): start, prompt,
  cancel, and delete many `kiro-cli` sessions in parallel from one window.
- **Git-worktree isolation** — each session runs on its own branch/worktree,
  with create, diff, check, merge (with a fail-closed conflict preview), open-PR,
  and archive flows.
- **Human-in-the-loop approvals** — tool calls surface as explicit permission
  prompts; nothing auto-proceeds unless trust is deliberately widened.
- **Trust profiles** and **budget caps** (global and per-project credit limits).
- **Automations** — durable, scheduled prompts that dispatch on a cron cadence.
- **Transcript search**, session metadata, an inbox/timeline, and a command
  palette.
- **Turn resilience** — prompt turns use an inactivity timeout that resets on
  agent activity (and never fires while a human approval is pending); stalled
  turns are re-queued for retry rather than dropped. Worker queues are keyed by
  session id to avoid cross-repo collisions.
- Self-contained state under `~/.kiro/bugyo/`.

### Packaging

- Multi-platform release bundles via `tauri-action`: macOS (universal), Linux
  (`.AppImage`/`.deb`), and Windows (`.msi`/`.exe`).
- macOS builds are **ad-hoc signed** but not notarized. On first launch, macOS
  Gatekeeper shows an "unidentified developer" warning — see the README for the
  one-time "Open Anyway" step. Developer ID signing + notarization can be
  enabled by adding repo secrets; see `docs/macos-code-signing.md`.

[unreleased]: https://github.com/Sannrox/bugyo/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/Sannrox/bugyo/releases/tag/v0.1.0
