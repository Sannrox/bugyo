// Typed wrapper over the Tauri updater/process plugins. UI components call
// these helpers rather than the plugins directly (mirrors the `lib/ipc` rule in
// AGENTS.md). The pure `describeUpdate` transform is unit-tested; the plugin
// calls are thin and error-tolerant so a failed/offline check never throws into
// the render tree.

import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { getVersion } from "@tauri-apps/api/app";

/** Human-facing summary of an available update (safe to render). */
export interface AvailableUpdate {
  /** The version offered by the release manifest, e.g. "0.2.0". */
  version: string;
  /** The version currently running. */
  currentVersion: string;
  /** Release notes / changelog body, if the manifest provided one. */
  notes?: string;
  /** Publish date string from the manifest, if any. */
  date?: string;
}

/** Result of a check: a newer signed build, already current, or a failure. */
export type UpdateCheck =
  | { status: "available"; update: Update; info: AvailableUpdate }
  | { status: "uptodate" }
  | { status: "error"; message: string };

/**
 * Minimum gap between automatic checks. Rapid relaunches (or the periodic timer
 * firing) within this window skip redundant checks unless the last result found
 * an update, which must be revalidated to obtain a live install handle.
 * User-initiated checks bypass this.
 */
export const MIN_CHECK_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

/**
 * How often a long-running window re-checks for updates, so an always-open app
 * eventually notices a release without needing a relaunch.
 */
export const PERIODIC_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours

/** localStorage key holding the epoch-ms of the last automatic check attempt. */
const LAST_CHECKED_KEY = "bugyo-update-last-checked";
/** Whether the most recent successful check found an available update. */
const LAST_FOUND_UPDATE_KEY = "bugyo-update-last-found-update";

/** Download progress while installing an update. */
export interface UpdateProgress {
  /** Bytes downloaded so far. */
  downloaded: number;
  /** Total bytes, if the server sent a content length. */
  contentLength?: number;
}

/** Minimal shape of the plugin `Update` handle we read for display. */
interface UpdateLike {
  version: string;
  currentVersion: string;
  date?: string;
  body?: string;
}

/** Pure transform: plugin `Update` handle → renderable summary. */
export function describeUpdate(update: UpdateLike): AvailableUpdate {
  const notes = update.body?.trim();
  return {
    version: update.version,
    currentVersion: update.currentVersion,
    notes: notes ? notes : undefined,
    date: update.date,
  };
}

/**
 * Check the configured endpoint for a newer signed release. Never throws:
 * network/verification failures resolve to an `error` result so callers can
 * surface a message without a try/catch at the call site.
 */
export async function checkForUpdate(): Promise<UpdateCheck> {
  try {
    const update = await check();
    if (!update) {
      setLastCheckFoundUpdate(false);
      return { status: "uptodate" };
    }
    setLastCheckFoundUpdate(true);
    return { status: "available", update, info: describeUpdate(update) };
  } catch (err) {
    return { status: "error", message: errorMessage(err) };
  }
}

function lastCheckFoundUpdate(): boolean {
  try {
    return window.localStorage.getItem(LAST_FOUND_UPDATE_KEY) === "true";
  } catch {
    return false;
  }
}

function setLastCheckFoundUpdate(found: boolean): void {
  try {
    window.localStorage.setItem(LAST_FOUND_UPDATE_KEY, String(found));
  } catch {
    /* storage may be unavailable in sandboxed contexts */
  }
}

/** Read the last automatic-check timestamp (epoch ms), or null if never/unavailable. */
export function getLastCheckedAt(): number | null {
  try {
    const raw = window.localStorage.getItem(LAST_CHECKED_KEY);
    if (!raw) return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

/** Record when an automatic check was attempted. Never throws. */
export function setLastCheckedAt(when: number): void {
  try {
    window.localStorage.setItem(LAST_CHECKED_KEY, String(when));
  } catch {
    /* storage may be unavailable in sandboxed contexts */
  }
}

/**
 * Pure throttle decision: should an automatic check run now given when one last
 * ran? A missing/invalid last-checked time always allows a check.
 */
export function shouldCheckNow(
  lastCheckedAt: number | null,
  now: number,
  minIntervalMs: number = MIN_CHECK_INTERVAL_MS,
): boolean {
  if (lastCheckedAt == null || !Number.isFinite(lastCheckedAt)) return true;
  return now - lastCheckedAt >= minIntervalMs;
}

/** Result of a throttled check: the underlying check, or skipped by the throttle. */
export type ScheduledCheck = UpdateCheck | { status: "skipped" };

/**
 * Automatic check that respects the cross-launch throttle. A known available
 * update bypasses the throttle because the plugin's install handle cannot be
 * persisted across launches and must be reacquired. When a check runs, it
 * records the attempt time first so concurrent windows do not duplicate it.
 */
export async function runScheduledCheck(
  now: number = Date.now(),
): Promise<ScheduledCheck> {
  if (!lastCheckFoundUpdate() && !shouldCheckNow(getLastCheckedAt(), now)) {
    return { status: "skipped" };
  }
  setLastCheckedAt(now);
  return checkForUpdate();
}

/**
 * Download and install an available update, reporting cumulative progress.
 * Does not relaunch — call {@link restartApp} afterwards.
 */
export async function installUpdate(
  update: Pick<Update, "downloadAndInstall">,
  onProgress?: (p: UpdateProgress) => void,
): Promise<void> {
  let downloaded = 0;
  let contentLength: number | undefined;
  await update.downloadAndInstall((event) => {
    switch (event.event) {
      case "Started":
        contentLength = event.data.contentLength;
        onProgress?.({ downloaded, contentLength });
        break;
      case "Progress":
        downloaded += event.data.chunkLength;
        onProgress?.({ downloaded, contentLength });
        break;
      case "Finished":
        onProgress?.({ downloaded, contentLength });
        break;
    }
  });
}

/** Relaunch the app so the freshly installed version takes over. */
export function restartApp(): Promise<void> {
  return relaunch();
}

/**
 * The running app's version (from `tauri.conf.json`), for display so users can
 * report which build they're on. Never throws: resolves to `null` outside a
 * Tauri window (e.g. in tests or a plain browser preview).
 */
export async function getAppVersion(): Promise<string | null> {
  try {
    return await getVersion();
  } catch {
    return null;
  }
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  return "Update check failed";
}
