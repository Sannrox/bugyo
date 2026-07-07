import type { PingResponse } from "./bindings";

/** Render a ping response for display. Pure — unit-tested in `format.test.ts`. */
export function formatPing(res: PingResponse): string {
  return `${res.message} (backend v${res.appVersion})`;
}

/** Last non-empty path segment of a repo root — the fallback display name. */
export function repoBasename(repoRoot: string): string {
  return repoRoot.split("/").filter(Boolean).pop() ?? repoRoot;
}

/**
 * Friendly project name for a repo root: the registered project's name when the
 * repo is known, otherwise its basename. Returns null for plain (repo-less)
 * sessions so callers can omit the project segment entirely.
 */
export function projectName(
  repoRoot: string | null,
  projects: readonly { path: string; name: string }[],
): string | null {
  if (!repoRoot) return null;
  return (
    projects.find((p) => p.path === repoRoot)?.name ?? repoBasename(repoRoot)
  );
}

/**
 * A compact relative-time label ("now", "5m", "3h", "2d", "3w") for how long
 * ago `thenMs` was, measured against `nowMs` (defaults to the current time).
 * Future timestamps and clock skew clamp to "now". Pure — unit-tested.
 */
export function relativeTime(
  thenMs: number,
  nowMs: number = Date.now(),
): string {
  const secs = Math.floor((nowMs - thenMs) / 1000);
  if (secs < 45) return "now";
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d`;
  const weeks = Math.round(days / 7);
  return `${weeks}w`;
}
