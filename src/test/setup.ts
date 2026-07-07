// Extends Vitest's `expect` with jest-dom matchers (toBeInTheDocument, etc.).
import "@testing-library/jest-dom/vitest";

// Ensure the rendered DOM is torn down between tests (we run with
// `globals: false`, so RTL's auto-cleanup isn't registered automatically).
import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";

// jsdom has no `ResizeObserver`, which `@tanstack/react-virtual` constructs on
// mount. Provide a no-op stub so virtualized components mount without throwing.
// (With no layout engine the virtualizer yields no items; SessionPane falls
// back to rendering the full list — see its `renderAll` guard.)
if (typeof globalThis.ResizeObserver === "undefined") {
  class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  globalThis.ResizeObserver =
    ResizeObserverStub as unknown as typeof ResizeObserver;
}

afterEach(() => {
  cleanup();
});
