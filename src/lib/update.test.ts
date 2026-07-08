import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the Tauri plugins the wrapper depends on. These have no browser runtime
// under jsdom, so we stub them and assert the wrapper's behavior around them.
const check = vi.fn();
const relaunch = vi.fn();
vi.mock("@tauri-apps/plugin-updater", () => ({
  check: () => check(),
}));
vi.mock("@tauri-apps/plugin-process", () => ({
  relaunch: () => relaunch(),
}));

import {
  checkForUpdate,
  describeUpdate,
  installUpdate,
  restartApp,
} from "./update";

beforeEach(() => {
  check.mockReset();
  relaunch.mockReset();
});

describe("describeUpdate", () => {
  it("maps the plugin handle to a renderable summary", () => {
    expect(
      describeUpdate({
        version: "0.2.0",
        currentVersion: "0.1.0",
        date: "2026-07-08",
        body: "  Fixes and improvements  ",
      }),
    ).toEqual({
      version: "0.2.0",
      currentVersion: "0.1.0",
      date: "2026-07-08",
      notes: "Fixes and improvements",
    });
  });

  it("drops empty/whitespace release notes", () => {
    expect(
      describeUpdate({ version: "1", currentVersion: "0", body: "   " }),
    ).toMatchObject({ notes: undefined });
    expect(describeUpdate({ version: "1", currentVersion: "0" })).toMatchObject(
      { notes: undefined },
    );
  });
});

describe("checkForUpdate", () => {
  it("reports an available update with its summary", async () => {
    const update = { version: "0.2.0", currentVersion: "0.1.0", body: "notes" };
    check.mockResolvedValue(update);

    const res = await checkForUpdate();
    expect(res.status).toBe("available");
    if (res.status === "available") {
      expect(res.update).toBe(update);
      expect(res.info.version).toBe("0.2.0");
      expect(res.info.notes).toBe("notes");
    }
  });

  it("reports up-to-date when the plugin returns null", async () => {
    check.mockResolvedValue(null);
    expect(await checkForUpdate()).toEqual({ status: "uptodate" });
  });

  it("never throws: a failed check resolves to an error result", async () => {
    check.mockRejectedValue(new Error("offline"));
    expect(await checkForUpdate()).toEqual({
      status: "error",
      message: "offline",
    });
  });
});

describe("installUpdate", () => {
  it("aggregates download progress across events", async () => {
    const events: number[] = [];
    const update = {
      downloadAndInstall: vi.fn(async (cb: (e: unknown) => void) => {
        cb({ event: "Started", data: { contentLength: 100 } });
        cb({ event: "Progress", data: { chunkLength: 40 } });
        cb({ event: "Progress", data: { chunkLength: 60 } });
        cb({ event: "Finished", data: {} });
      }),
    };

    await installUpdate(update, (p) => events.push(p.downloaded));
    expect(events).toEqual([0, 40, 100, 100]);
    expect(update.downloadAndInstall).toHaveBeenCalledOnce();
  });
});

describe("restartApp", () => {
  it("delegates to the process plugin", async () => {
    relaunch.mockResolvedValue(undefined);
    await restartApp();
    expect(relaunch).toHaveBeenCalledOnce();
  });
});
