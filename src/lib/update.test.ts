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
  getLastCheckedAt,
  installUpdate,
  MIN_CHECK_INTERVAL_MS,
  restartApp,
  runScheduledCheck,
  setLastCheckedAt,
  shouldCheckNow,
} from "./update";

// jsdom in this project ships without `localStorage`; provide a Map-backed stub
// so the throttle-persistence tests exercise real read/write paths.
const store = new Map<string, string>();
const localStorageStub: Storage = {
  get length() {
    return store.size;
  },
  clear: () => store.clear(),
  getItem: (k) => store.get(k) ?? null,
  key: (i) => [...store.keys()][i] ?? null,
  removeItem: (k) => void store.delete(k),
  setItem: (k, v) => void store.set(k, String(v)),
};
vi.stubGlobal("localStorage", localStorageStub);

beforeEach(() => {
  check.mockReset();
  relaunch.mockReset();
  window.localStorage.clear();
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

describe("shouldCheckNow", () => {
  it("allows a check when never checked before", () => {
    expect(shouldCheckNow(null, 1_000_000)).toBe(true);
    expect(shouldCheckNow(NaN, 1_000_000)).toBe(true);
  });

  it("skips within the throttle window and allows past it", () => {
    const last = 1_000_000;
    expect(shouldCheckNow(last, last + MIN_CHECK_INTERVAL_MS - 1)).toBe(false);
    expect(shouldCheckNow(last, last + MIN_CHECK_INTERVAL_MS)).toBe(true);
  });
});

describe("last-checked persistence", () => {
  it("round-trips through localStorage and ignores garbage", () => {
    expect(getLastCheckedAt()).toBeNull();
    setLastCheckedAt(42);
    expect(getLastCheckedAt()).toBe(42);
    window.localStorage.setItem("bugyo-update-last-checked", "not-a-number");
    expect(getLastCheckedAt()).toBeNull();
  });
});

describe("runScheduledCheck", () => {
  it("checks and records the attempt when due", async () => {
    check.mockResolvedValue(null);
    const now = 5_000_000;

    const res = await runScheduledCheck(now);

    expect(res).toEqual({ status: "uptodate" });
    expect(check).toHaveBeenCalledOnce();
    expect(getLastCheckedAt()).toBe(now);
  });

  it("skips without hitting the endpoint inside the throttle window", async () => {
    const last = 5_000_000;
    setLastCheckedAt(last);

    const res = await runScheduledCheck(last + MIN_CHECK_INTERVAL_MS - 1);

    expect(res).toEqual({ status: "skipped" });
    expect(check).not.toHaveBeenCalled();
    expect(getLastCheckedAt()).toBe(last);
  });

  it("rechecks a known available update inside the throttle window", async () => {
    const update = { version: "0.2.0", currentVersion: "0.1.0" };
    check.mockResolvedValue(update);
    const first = 5_000_000;

    expect((await runScheduledCheck(first)).status).toBe("available");
    expect(
      (await runScheduledCheck(first + MIN_CHECK_INTERVAL_MS - 1)).status,
    ).toBe("available");
    expect(check).toHaveBeenCalledTimes(2);
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
