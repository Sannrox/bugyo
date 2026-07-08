import { useMemo } from "react";
import { diffLines, parseUnifiedDiff } from "./lib/diff";
import type { ToolDiff } from "./lib/bindings";

/** Render a unified-diff patch as per-file, collapsible, colored diffs. */
export default function DiffView({ patch }: { patch: string }) {
  const files = useMemo(() => parseUnifiedDiff(patch), [patch]);
  if (files.length === 0) {
    return <p className="muted">(no committed changes vs base)</p>;
  }

  const totalAdd = files.reduce((n, f) => n + f.additions, 0);
  const totalDel = files.reduce((n, f) => n + f.deletions, 0);

  return (
    <div className="diff" aria-label="diff">
      <p className="diff__summary muted">
        {files.length} file{files.length === 1 ? "" : "s"} changed{" "}
        <span className="diff__add">+{totalAdd}</span>{" "}
        <span className="diff__del">−{totalDel}</span>
      </p>
      {files.map((file, fi) => (
        <details key={fi} className="diff__file" open={files.length <= 3}>
          <summary className="diff__file-head">
            <span className="diff__path">
              {file.oldPath && file.oldPath !== file.path && (
                <span className="diff__rename muted">{file.oldPath} → </span>
              )}
              {file.path}
            </span>
            {file.binary ? (
              <span className="diff__stat muted">binary</span>
            ) : (
              <span className="diff__stat">
                <span className="diff__add">+{file.additions}</span>{" "}
                <span className="diff__del">−{file.deletions}</span>
              </span>
            )}
          </summary>
          {file.binary ? (
            <p className="diff__binary muted">Binary file — not shown.</p>
          ) : (
            file.hunks.map((hunk, hi) => (
              <div key={hi} className="diff__hunk">
                <div className="diff__hunk-head">{hunk.header}</div>
                {hunk.lines.map((line, li) => (
                  <div
                    key={li}
                    className={`diff__line diff__line--${line.kind}`}
                  >
                    <span className="diff__gutter">
                      {line.kind === "add"
                        ? "+"
                        : line.kind === "del"
                          ? "−"
                          : " "}
                    </span>
                    <span className="diff__text">{line.text || " "}</span>
                  </div>
                ))}
              </div>
            ))
          )}
        </details>
      ))}
    </div>
  );
}

/** Compact inline diff for a tool call's file edit (from ACP `content`). */
export function InlineDiff({ diff }: { diff: ToolDiff }) {
  const created = diff.oldText == null;
  // The LCS diff is O(n·m) (DP table up to 1500×1500). SessionPane re-renders on
  // every batched store commit — up to once per animation frame while an agent
  // streams — so recomputing this in the render body would run multi-megabyte
  // DP passes at ~60fps. Memoize on the diff's contents.
  const lines = useMemo(
    () => diffLines(diff.oldText ?? "", diff.newText),
    [diff.oldText, diff.newText],
  );

  return (
    <details className="diff diff--inline">
      <summary className="diff__file-head">
        <span className="diff__path">
          {created ? "＋ " : "✎ "}
          {diff.path}
        </span>
      </summary>
      <div className="diff__hunk">
        {lines.map((line, i) => (
          <div key={i} className={`diff__line diff__line--${line.kind}`}>
            <span className="diff__gutter">
              {line.kind === "add" ? "+" : line.kind === "del" ? "−" : " "}
            </span>
            <span className="diff__text">{line.text || " "}</span>
          </div>
        ))}
      </div>
    </details>
  );
}
