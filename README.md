# Bugyo (奉行)

[![CI](https://github.com/Sannrox/bugyo/actions/workflows/ci.yml/badge.svg)](https://github.com/Sannrox/bugyo/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](./LICENSE)

**A desktop command center for orchestrating many `kiro-cli` sessions from one
window.** Bugyo runs a fleet of AI coding agents in parallel — each isolated in
its own git worktree — over the **Agent Client Protocol (ACP)**, with a
diff‑review‑and‑merge flow and a human‑in‑the‑loop approval model.

Named for the _bugyō_ (奉行), a magistrate who directed and governed subordinates.

> Bugyo is an independent, open‑source project. It orchestrates `kiro-cli` but is
> not affiliated with or endorsed by its maintainers.

## Why

The interactive orchestration pattern started life as a terminal‑bound tmux
control loop — powerful, but hard to observe or steer. Bugyo turns that pattern
into a native, observable, steerable GUI — inspired by
[Conductor](https://conductor.build) and the OpenAI Codex app, built on
`kiro-cli`'s ACP transport. It is fully self‑contained, storing its state under
`~/.kiro/bugyo/`.

## Tech

- **Backend:** Rust (Tauri v2) — ACP client, workspace/git manager, orchestrator.
- **Frontend:** React + TypeScript (Vite).
- **Transport:** newline‑delimited JSON‑RPC to `kiro-cli acp` over stdio.

## Getting started

Prerequisites: [Rust](https://rustup.rs), [Bun](https://bun.sh),
[`kiro-cli`](https://kiro.dev) on `PATH`, and the platform Tauri prerequisites.

```bash
bun install
bun run tauri dev
```

## Documentation

- [`VISION.md`](./VISION.md) — what we're building and why
- [`PLAN.md`](./PLAN.md) — phased roadmap
- [`AGENTS.md`](./AGENTS.md) — contributor/agent operating guide & standards
- [`CONTRIBUTING.md`](./CONTRIBUTING.md) — how to contribute
- [`docs/`](./docs/) — ACP notes, worktree notes, decisions (ADRs)

## License

Licensed under the [Apache License 2.0](./LICENSE). See [`NOTICE`](./NOTICE).
