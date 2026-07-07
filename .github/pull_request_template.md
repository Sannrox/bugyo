<!--
Thanks for contributing to Bugyo! Please fill out the sections below.
Keep changes small and vertical (see PLAN.md). Use Conventional Commit titles.
-->

## Summary

<!-- What does this PR do and why? -->

## Related issues

<!-- e.g. Closes #123 -->

## Type of change

- [ ] `feat` — new feature
- [ ] `fix` — bug fix
- [ ] `refactor` — no behavior change
- [ ] `docs` — documentation only
- [ ] `test` — tests only
- [ ] `chore` — tooling / maintenance

## Checklist

- [ ] Rust: `cargo fmt --all --check`, `cargo clippy --all-targets --all-features -- -D warnings`, `cargo test --all-features` pass
- [ ] TypeScript: `bun run typecheck`, `bun run lint`, `bun run format:check`, `bun run test` pass
- [ ] IPC changes keep Rust ↔ TS types in sync (payload contract updated on both sides)
- [ ] Mutation paths (git / filesystem / tool approval) respect the safety model in `AGENTS.md`
- [ ] No secrets, `.env`, or credentials committed
- [ ] Docs / CHANGELOG updated where relevant

## Notes for reviewers

<!-- Anything reviewers should focus on, tradeoffs, follow-ups. -->
