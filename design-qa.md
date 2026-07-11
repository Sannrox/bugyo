# Design QA — Original Codex desktop shell

- Source: `app-screenshot-light.webp` supplied with the task.
- Prototype state: `/?visual-reference` at 1674 × 1105.
- Latest capture: `output/playwright/codex-review-final.png`.

## Comparison

- Sidebar: matching pale translucent surface, compact navigation, project/thread hierarchy, selected row, and bottom utilities.
- Thread: matching single-workspace layout, compact titlebar, readable transcript column, user bubble, and floating follow-up composer.
- Review: contextual right inspector with independent header, change summary, verification, diff, sticky landing actions, close, and expand controls.
- Responsive behavior: review replaces the conversation below 1180px and can be expanded explicitly at desktop widths.
- Interaction checks: review expands, restores, and closes without losing the thread; primary navigation remains keyboard and pointer reachable.
- Scroll stress: `/?visual-reference&visual-stress` verifies 24 sessions (12 pinned), a 42-message transcript, and an 80-line diff at 900 × 650. The sidebar and review inspector scroll independently while their fixed controls remain available.
- Visibility transition: closing the narrow full-width review remeasures the virtualized transcript and lands on messages 31–40, including the newest message, while the composer remains fixed below it.
- Long settings: the Settings region at 760 × 650 scrolls from 0 to its 858px maximum and exposes the final Software updates control without moving the sidebar utilities.
- Secondary destinations: New Chat, Search, Plugins, Automations, Fleet, Attention, Event Log, and Settings were each rendered at 1674 × 1105 and aligned to the thread workspace's widths, typography, borders, controls, and empty-state treatment.
- Captures: `output/playwright/pages/*-final.png` contains the page-by-page evidence.

## Remaining polish

- P3: native macOS traffic lights are supplied by Tauri and are not visible in the browser-only fixture.
- P3: exact syntax colors vary slightly because Bugyo renders real parsed diffs rather than the reference repository's source file.

final result: passed
