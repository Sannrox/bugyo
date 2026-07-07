# 0001 — Frontend framework: SvelteKit vs React

- **Status:** Accepted — **React (Vite)**
- **Date:** 2026-07-07 (decided), revised from an initial SvelteKit recommendation
- **Deciders:** project owner
- **Context docs:** [`VISION.md`](../../VISION.md), [`PLAN.md`](../../PLAN.md),
  [`acp-notes.md`](../acp-notes.md)

## Context

The frontend is a **TypeScript** UI inside a Tauri v2 shell (decided already; the
Rust backend owns the ACP client and workspace/git logic). Its job is a
**Conductor/Codex-style cockpit**:

- a **workspace sidebar** (projects → workspaces) with live status badges;
- **streaming transcript panes** rendered from a high-frequency ACP
  `session/update` event stream (assistant chunks, tool calls, diffs);
- **inline approval prompts** driven by `session/request_permission`;
- a **diff review** surface and, later, an optional **xterm.js** terminal pane.

The workload is **event-heavy and reactive**: many concurrent sessions each
emitting frequent updates, all pushed from the backend over Tauri events. There
is no server-side rendering and no SEO concern — it's a local desktop SPA.

Both SvelteKit and React are first-class TypeScript and both have official Tauri
templates, so either is viable. The choice is about fit and cost.

**Decisive new factor: the project is going open source.** Contributor
accessibility — how many developers can contribute without a learning curve, and
how much bespoke UI the maintainers must own vs. pull from an ecosystem — becomes
a primary criterion, alongside the technical fit of the streaming UI.

(For reference: our design inspiration Conductor is a Tauri app; Melty Labs' prior
product was React-based, so the broader ecosystem we orient toward skews React.)

## Options

### Option A — SvelteKit (Svelte 5) with `adapter-static` (SPA mode)

Pros:

- **Fine-grained reactivity** (Svelte 5 runes) maps naturally to per-session
  streaming state — update the signal, only the affected DOM updates. No manual
  memoization to avoid re-render storms across many live panes.
- **Small bundle + fast startup**, which suits a desktop app; compiler output, no
  virtual-DOM runtime.
- **Less boilerplate**; stores are idiomatic and the AGENTS.md guidance already
  references Svelte stores for session/workspace state.
- File-based routing/conventions from SvelteKit, kept static via `adapter-static`.

Cons:

- Smaller component/library ecosystem than React (fewer off-the-shelf diff
  viewers, data grids, etc. — some hand-rolling).
- SvelteKit is a meta-framework built around SSR; we deliberately use SPA/static
  mode, so some of its features go unused (mild conceptual overhead).
- Smaller hiring/familiarity pool.

### Option B — React (Vite)

Pros:

- **Largest ecosystem**: mature libraries for diff views, virtualized lists,
  terminals, state (TanStack Query/Zustand), etc.
- Broadest familiarity; easiest to bring in help.

Cons:

- **Re-render management** under high-frequency streaming needs care
  (memoization, `useSyncExternalStore`, virtualization) to stay smooth with many
  live panes — more foot-guns for exactly our hot path.
- Heavier runtime/bundle than Svelte.
- More boilerplate for the same reactive behavior.

## Decision

**Choose Option B — React (Vite).**

The initial recommendation was SvelteKit, on the strength of Svelte 5's
fine-grained reactivity for our high-frequency streaming UI. The **open-source
decision overrides that**: for a project that wants outside contributors, React's
much larger talent pool (contributors can start without a learning curve) and
mature component ecosystem (diff viewers, virtualized trees/lists, terminals) are
worth more than the marginal reactivity ergonomics. Every bespoke Svelte
component is something the maintainers would own and support; React lets
contributors reach for known libraries instead.

The one real cost — **re-render management under heavy streaming** — is a solved
problem and squarely on us to get right: keep session/workspace state in an
external store (Zustand or `useSyncExternalStore` over the Tauri event stream),
subscribe with selectors, and virtualize long transcripts/lists. This is a
known-good pattern, just more deliberate than Svelte's defaults.

We would revisit toward Svelte only if the project stayed effectively
single-maintainer and the streaming-perf tuning proved more expensive than
expected.

## Consequences

- Phase 1 scaffolds `app/` with `create-tauri-app` → **React + TypeScript (Vite)**.
- **State:** an external store subscribed to backend ACP events — Zustand (or
  `useSyncExternalStore`), **not** prop-drilled component state — with selector
  subscriptions to avoid broad re-renders. UI status derives from backend events,
  never re-implemented client-side.
- **Performance discipline (required, not optional):** virtualize the transcript
  and any long lists; memoize row/pane components; batch high-frequency
  `session/update` events before committing to state. Treat this as a first-class
  concern in the streaming UI, per the tradeoff above.
- **Tooling** per AGENTS.md: Vitest (unit), React Testing Library (component),
  ESLint (typescript-eslint) + Prettier, `tsc --noEmit` in strict mode.
- **AGENTS.md** references to "Svelte stores" should be generalized to
  "React store (Zustand/context)"; update it in the same change as the scaffold.
- Being OSS, prefer well-known, maintained React libraries with compatible
  licenses; pin exact versions (see AGENTS.md dependency rules).
