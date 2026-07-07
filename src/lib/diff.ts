// Pure unified-diff parser. Turns `git diff` output into per-file hunks with
// classified lines, so the UI can render a proper colored, collapsible diff.

export type DiffLineKind = "add" | "del" | "ctx" | "meta";

export interface DiffLine {
  kind: DiffLineKind;
  text: string;
}

export interface DiffHunk {
  header: string;
  lines: DiffLine[];
}

export interface DiffFile {
  path: string;
  hunks: DiffHunk[];
  additions: number;
  deletions: number;
  /** True for a binary file (no textual hunks; `Binary files … differ`). */
  binary: boolean;
  /** Original path when the file was renamed, else null. */
  oldPath: string | null;
}

function stripPrefix(p: string): string {
  if (p === "/dev/null") return p;
  return p.replace(/^[ab]\//, "");
}

/** Parse a unified diff (git format) into files → hunks → lines. */
export function parseUnifiedDiff(patch: string): DiffFile[] {
  const files: DiffFile[] = [];
  let file: DiffFile | null = null;
  let hunk: DiffHunk | null = null;

  for (const line of patch.split("\n")) {
    if (line === "") continue; // trailing split artifact (blank ctx lines are " ")
    if (line.startsWith("diff --git")) {
      const m = line.match(/ b\/(\S+)/);
      file = {
        path: m ? m[1] : "",
        hunks: [],
        additions: 0,
        deletions: 0,
        binary: false,
        oldPath: null,
      };
      files.push(file);
      hunk = null;
      continue;
    }
    if (line.startsWith("Binary files")) {
      if (file) file.binary = true;
      continue;
    }
    if (line.startsWith("rename from ")) {
      if (file) file.oldPath = line.slice("rename from ".length).trim();
      continue;
    }
    if (line.startsWith("rename to ")) {
      if (file) file.path = line.slice("rename to ".length).trim();
      continue;
    }
    if (line.startsWith("+++ ")) {
      if (file) {
        const p = stripPrefix(line.slice(4).trim());
        if (p !== "/dev/null") file.path = p;
      }
      continue;
    }
    if (
      line.startsWith("--- ") ||
      line.startsWith("index ") ||
      line.startsWith("new file") ||
      line.startsWith("deleted file") ||
      line.startsWith("similarity ") ||
      line.startsWith("rename ") ||
      line.startsWith("old mode") ||
      line.startsWith("new mode")
    ) {
      continue;
    }
    if (line.startsWith("@@")) {
      hunk = { header: line, lines: [] };
      if (file) file.hunks.push(hunk);
      continue;
    }
    if (!file || !hunk) continue;
    if (line.startsWith("\\")) continue; // "\ No newline at end of file"

    const c = line[0];
    if (c === "+") {
      hunk.lines.push({ kind: "add", text: line.slice(1) });
      file.additions += 1;
    } else if (c === "-") {
      hunk.lines.push({ kind: "del", text: line.slice(1) });
      file.deletions += 1;
    } else {
      hunk.lines.push({ kind: "ctx", text: line.slice(c === " " ? 1 : 0) });
    }
  }

  return files;
}

/**
 * Line-level diff between two texts via LCS — turns a tool call's old/new file
 * content into add/del/ctx lines. Falls back to a plain del+add for very large
 * inputs to bound the O(n·m) table.
 */
export function diffLines(oldText: string, newText: string): DiffLine[] {
  const a = oldText.length ? oldText.split("\n") : [];
  const b = newText.length ? newText.split("\n") : [];

  if (a.length > 1500 || b.length > 1500) {
    return [
      ...a.map((t): DiffLine => ({ kind: "del", text: t })),
      ...b.map((t): DiffLine => ({ kind: "add", text: t })),
    ];
  }

  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () =>
    new Array<number>(m + 1).fill(0),
  );
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] =
        a[i] === b[j]
          ? dp[i + 1][j + 1] + 1
          : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ kind: "ctx", text: a[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push({ kind: "del", text: a[i] });
      i++;
    } else {
      out.push({ kind: "add", text: b[j] });
      j++;
    }
  }
  while (i < n) out.push({ kind: "del", text: a[i++] });
  while (j < m) out.push({ kind: "add", text: b[j++] });
  return out;
}
