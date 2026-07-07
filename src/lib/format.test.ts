import { describe, it, expect } from "vitest";
import { formatPing, repoBasename, projectName, relativeTime } from "./format";

describe("formatPing", () => {
  it("renders the message and backend version", () => {
    expect(
      formatPing({ message: "pong: hello, Ada", appVersion: "0.1.0" }),
    ).toBe("pong: hello, Ada (backend v0.1.0)");
  });
});

describe("repoBasename", () => {
  it("returns the last path segment", () => {
    expect(repoBasename("/Users/ada/Projects/kiro-app")).toBe("kiro-app");
  });

  it("ignores a trailing slash", () => {
    expect(repoBasename("/Users/ada/Projects/kiro-app/")).toBe("kiro-app");
  });

  it("falls back to the input when there is no segment", () => {
    expect(repoBasename("/")).toBe("/");
  });
});

describe("projectName", () => {
  const projects = [
    { path: "/Users/ada/Projects/kiro-app", name: "Bugyo" },
    { path: "/Users/ada/other", name: "Other" },
  ];

  it("prefers the registered project name", () => {
    expect(projectName("/Users/ada/Projects/kiro-app", projects)).toBe("Bugyo");
  });

  it("falls back to the basename for an unregistered repo", () => {
    expect(projectName("/tmp/scratch-repo", projects)).toBe("scratch-repo");
  });

  it("returns null for a repo-less (plain) session", () => {
    expect(projectName(null, projects)).toBeNull();
  });
});

describe("relativeTime", () => {
  const now = 1_700_000_000_000;
  const ago = (ms: number) => now - ms;

  it("shows 'now' for very recent activity", () => {
    expect(relativeTime(ago(0), now)).toBe("now");
    expect(relativeTime(ago(30_000), now)).toBe("now"); // 30s
  });

  it("clamps future timestamps (clock skew) to 'now'", () => {
    expect(relativeTime(now + 5_000, now)).toBe("now");
  });

  it("shows minutes under an hour", () => {
    expect(relativeTime(ago(5 * 60_000), now)).toBe("5m");
    expect(relativeTime(ago(59 * 60_000), now)).toBe("59m");
  });

  it("shows hours under a day", () => {
    expect(relativeTime(ago(3 * 3_600_000), now)).toBe("3h");
  });

  it("shows days under a week", () => {
    expect(relativeTime(ago(2 * 86_400_000), now)).toBe("2d");
  });

  it("shows weeks beyond a week", () => {
    expect(relativeTime(ago(3 * 7 * 86_400_000), now)).toBe("3w");
  });
});
