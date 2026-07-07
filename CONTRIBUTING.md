# Contributing to Bugyo

Thanks for your interest in contributing! This guide covers the essentials.
For deeper conventions and the safety model, read [`AGENTS.md`](./AGENTS.md).

## Getting set up

Prerequisites: [Rust](https://rustup.rs), [Bun](https://bun.sh),
[`kiro-cli`](https://kiro.dev) on `PATH`, and the platform
[Tauri prerequisites](https://tauri.app/start/prerequisites/).

```bash
bun install
bun run tauri dev
```

## Before you open a PR

Run the full check suite for both languages (from the repository root):

```bash
# Rust
cd src-tauri
cargo fmt --all --check
cargo clippy --all-targets --all-features -- -D warnings
cargo test --all-features
cd ..

# TypeScript
bun run typecheck
bun run lint
bun run format:check
bun run test
```

CI runs the same checks on every PR (see `.github/workflows/ci.yml`).

## Conventions

- **Commits:** [Conventional Commits](https://www.conventionalcommits.org/)
  (`feat:`, `fix:`, `refactor:`, `test:`, `docs:`, `chore:`), scoped where
  useful (`feat(acp): …`).
- **Scope:** keep changes small and vertical; match the phasing in
  [`PLAN.md`](./PLAN.md).
- **Types are a contract:** when you change an IPC payload, update the Rust type
  and the TypeScript binding together.
- **Style:** match surrounding code; run the formatters and linters above.

## Safety model

Bugyo drives real agents that can mutate git and the filesystem. Any change to a
mutation path (git, filesystem, tool approval) must respect the safety model in
[`AGENTS.md`](./AGENTS.md): human‑in‑the‑loop by default, destructive actions
always confirm, agent work stays isolated in worktrees.

## License

By contributing, you agree that your contributions are licensed under the
[Apache License 2.0](./LICENSE).
