// Typed wrapper over the Tauri updater/process plugins. UI components call
// these helpers rather than the plugins directly (mirrors the `lib/ipc` rule in
// AGENTS.md). The pure `describeUpdate` transform is unit-tested; the plugin
// calls are thin and error-tolerant so a failed/offline check never throws into
// the render tree.

import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

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
    if (!update) return { status: "uptodate" };
    return { status: "available", update, info: describeUpdate(update) };
  } catch (err) {
    return { status: "error", message: errorMessage(err) };
  }
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

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  return "Update check failed";
}
