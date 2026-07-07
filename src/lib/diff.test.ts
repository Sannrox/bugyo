import { describe, it, expect } from "vitest";
import { parseUnifiedDiff } from "./diff";

const PATCH = `diff --git a/src/main.rs b/src/main.rs
index e69de29..0cfbf08 100644
--- a/src/main.rs
+++ b/src/main.rs
@@ -1,3 +1,4 @@
 fn main() {
-    println!("old");
+    println!("new");
+    // added line
 }
diff --git a/new.txt b/new.txt
new file mode 100644
--- /dev/null
+++ b/new.txt
@@ -0,0 +1,1 @@
+hello
`;

describe("parseUnifiedDiff", () => {
  it("splits into files with classified lines and counts", () => {
    const files = parseUnifiedDiff(PATCH);
    expect(files.map((f) => f.path)).toEqual(["src/main.rs", "new.txt"]);

    const main = files[0];
    expect(main.additions).toBe(2);
    expect(main.deletions).toBe(1);
    expect(main.hunks).toHaveLength(1);
    expect(main.hunks[0].lines).toEqual([
      { kind: "ctx", text: "fn main() {" },
      { kind: "del", text: '    println!("old");' },
      { kind: "add", text: '    println!("new");' },
      { kind: "add", text: "    // added line" },
      { kind: "ctx", text: "}" },
    ]);

    const created = files[1];
    expect(created.path).toBe("new.txt");
    expect(created.additions).toBe(1);
    expect(created.hunks[0].lines).toEqual([{ kind: "add", text: "hello" }]);
  });

  it("returns empty for an empty patch", () => {
    expect(parseUnifiedDiff("")).toEqual([]);
  });

  it("parses a rename with no content change", () => {
    const patch = `diff --git a/old/name.ts b/new/name.ts
similarity index 100%
rename from old/name.ts
rename to new/name.ts
`;
    const files = parseUnifiedDiff(patch);
    expect(files).toHaveLength(1);
    expect(files[0].path).toBe("new/name.ts");
    expect(files[0].oldPath).toBe("old/name.ts");
    expect(files[0].additions).toBe(0);
    expect(files[0].deletions).toBe(0);
    expect(files[0].binary).toBe(false);
  });

  it("flags a binary file", () => {
    const patch = `diff --git a/logo.png b/logo.png
new file mode 100644
index 0000000..abc1234
Binary files /dev/null and b/logo.png differ
`;
    const files = parseUnifiedDiff(patch);
    expect(files).toHaveLength(1);
    expect(files[0].path).toBe("logo.png");
    expect(files[0].binary).toBe(true);
    expect(files[0].hunks).toEqual([]);
  });
});

import { diffLines } from "./diff";

describe("diffLines", () => {
  it("produces context/add/del via LCS for an edit", () => {
    const lines = diffLines("a\nb\nc\n", "a\nB\nc\nd\n");
    // "a" and "c" stay as context; "b"→"B" is a del+add; "d" is added; the
    // trailing empty line from the newline is context on both sides.
    expect(lines).toEqual([
      { kind: "ctx", text: "a" },
      { kind: "del", text: "b" },
      { kind: "add", text: "B" },
      { kind: "ctx", text: "c" },
      { kind: "add", text: "d" },
      { kind: "ctx", text: "" },
    ]);
  });

  it("treats a create (empty old) as all additions", () => {
    expect(diffLines("", "x\ny")).toEqual([
      { kind: "add", text: "x" },
      { kind: "add", text: "y" },
    ]);
  });
});
