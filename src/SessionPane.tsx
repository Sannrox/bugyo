import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  ArrowUp,
  Brain,
  Camera,
  Copy,
  GitBranch,
  MoreHorizontal,
  RotateCcw,
  Square,
  SquareTerminal,
  X,
} from "lucide-react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  acpCancel,
  acpCloseSession,
  acpPromptWithScreenshot,
  acpRespondPermission,
  notify,
  orchEnqueue,
  sessionTranscript,
} from "./lib/ipc";
import { projectName } from "./lib/format";
import { useFleet } from "./lib/fleetStore";
import { useSettings } from "./lib/settingsStore";
import { DISPLAY_STATUS_LABEL, effectiveStatus } from "./lib/review";
import type { TranscriptEntry } from "./lib/session";
import ReviewPanel from "./ReviewPanel";
import QueuePanel from "./QueuePanel";
import { InlineDiff } from "./DiffView";

type ToolEntry = Extract<TranscriptEntry, { kind: "tool" }>;

type TranscriptBlock =
  | { kind: "entry"; entry: TranscriptEntry }
  | { kind: "toolGroup"; tools: ToolEntry[]; id: string };

/** Apply global display settings: hide reasoning and/or filter tool calls. */
function filterTranscript(
  transcript: TranscriptEntry[],
  opts: { showReasoning: boolean; toolDisplay: "all" | "edits" | "hidden" },
): TranscriptEntry[] {
  return transcript.filter((entry) => {
    if (entry.kind === "thought") return opts.showReasoning;
    if (entry.kind === "tool") {
      if (opts.toolDisplay === "hidden") return false;
      if (opts.toolDisplay === "edits") return entry.diff != null;
      return true;
    }
    return true;
  });
}

/** Fold consecutive tool calls into groups; everything else passes through. */
function groupTranscript(transcript: TranscriptEntry[]): TranscriptBlock[] {
  const blocks: TranscriptBlock[] = [];
  let run: ToolEntry[] = [];
  const flush = () => {
    if (run.length > 0) {
      blocks.push({
        kind: "toolGroup",
        tools: run,
        id: run[0].toolCallId || `g${blocks.length}`,
      });
      run = [];
    }
  };
  for (const entry of transcript) {
    if (entry.kind === "tool") {
      run.push(entry);
    } else {
      flush();
      blocks.push({ kind: "entry", entry });
    }
  }
  flush();
  return blocks;
}

/** Whether a tool call has finished (any non-completed status counts as active). */
function toolDone(t: ToolEntry): boolean {
  return t.status === "completed" || t.status === "failed";
}

/** A single tool call: title, status, optional inline diff and output. */
function ToolEntryView({ entry }: { entry: ToolEntry }) {
  return (
    <div className="msg--tool-wrap">
      <div className="msg--tool">
        <span className="msg__tool-icon">🔧</span>
        <span>{entry.title}</span>
        {entry.status && (
          <span className="msg__tool-status">{entry.status}</span>
        )}
      </div>
      {entry.diff && <InlineDiff diff={entry.diff} />}
      {entry.output && (
        <details className="tool-output">
          <summary className="tool-output__head">Output</summary>
          <pre className="tool-output__body">{entry.output}</pre>
        </details>
      )}
    </div>
  );
}

/**
 * A run of consecutive tool calls, collapsed into one cluster so long
 * sequences don't flood the transcript. A single tool renders inline; 2+
 * collapse under a summary that stays open while any call is still running.
 */
function ToolGroup({ tools }: { tools: ToolEntry[] }) {
  const active = tools.some((t) => !toolDone(t));
  // Uncontrolled <details>: default open while active, collapsed once done.
  // `key` on the group id resets this default if the run's activity changes.
  const [open, setOpen] = useState<boolean | null>(null);
  const isOpen = open ?? active;

  if (tools.length === 1) {
    return <ToolEntryView entry={tools[0]} />;
  }

  const doneCount = tools.filter(toolDone).length;
  const summary = active
    ? `${tools.length} tool calls · ${doneCount}/${tools.length} done`
    : `${tools.length} tool calls`;

  return (
    <details
      className="tool-group"
      open={isOpen}
      onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}
    >
      <summary className="tool-group__head">
        <span className="msg__tool-icon">🔧</span>
        <span>{summary}</span>
        {active && <span className="msg__tool-status">running</span>}
      </summary>
      <div className="tool-group__body">
        {tools.map((t, i) => (
          <ToolEntryView key={t.toolCallId || i} entry={t} />
        ))}
      </div>
    </details>
  );
}

/** The main pane for a single session, selected from the fleet store by id. */
export default function SessionPane({ sessionId }: { sessionId: string }) {
  // Subscribe only to this session — a busy sibling won't re-render this pane.
  const session = useFleet((s) => s.sessions[sessionId]);
  const state = session?.state;
  const projects = useFleet((s) => s.projects);
  const setConnected = useFleet((s) => s.setConnected);
  const setQueued = useFleet((s) => s.setQueued);
  const splitOpen = useFleet((s) => s.secondaryId !== null);
  const closeSplit = useFleet((s) => s.closeSplit);
  const showReasoning = useSettings((s) => s.showReasoning);
  const toolDisplay = useSettings((s) => s.toolDisplay);
  const appendUserMessage = useFleet((s) => s.appendUserMessage);
  const [prompt, setPrompt] = useState("");
  const [error, setError] = useState("");
  const [permissionBusy, setPermissionBusy] = useState(false);
  const [permissionChoice, setPermissionChoice] = useState("");
  const [permissionError, setPermissionError] = useState("");
  const [reviewOpen, setReviewOpen] = useState(false);
  const [queueOpen, setQueueOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const moreMenuRef = useRef<HTMLDivElement>(null);
  const moreButtonRef = useRef<HTMLButtonElement>(null);
  const moreMenuListRef = useRef<HTMLDivElement>(null);
  const restoreMoreFocus = useRef(false);

  useEffect(() => {
    setPermissionBusy(false);
    setPermissionChoice("");
    setPermissionError("");
  }, [state?.pendingPermission?.requestId]);

  useEffect(() => {
    if (!moreOpen) return;
    moreMenuListRef.current
      ?.querySelector<HTMLButtonElement>("button")
      ?.focus();
    const closeOnOutsideClick = (event: MouseEvent) => {
      if (!moreMenuRef.current?.contains(event.target as Node)) {
        setMoreOpen(false);
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        restoreMoreFocus.current = true;
        setMoreOpen(false);
      }
    };
    document.addEventListener("mousedown", closeOnOutsideClick);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("mousedown", closeOnOutsideClick);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [moreOpen]);

  useLayoutEffect(() => {
    if (moreOpen || !restoreMoreFocus.current) return;
    restoreMoreFocus.current = false;
    moreButtonRef.current?.focus();
  }, [moreOpen]);
  const reviewAutoOpened = useRef(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  // Whether the transcript is pinned to the bottom (so new content auto-scrolls
  // only when the user hasn't scrolled up to read history).
  const stickToBottom = useRef(true);
  // Slash-command palette: highlighted row + whether the user dismissed it.
  const [paletteIndex, setPaletteIndex] = useState(0);
  const [paletteDismissed, setPaletteDismissed] = useState(false);

  useEffect(() => {
    if (
      reviewAutoOpened.current ||
      !session?.workspace ||
      session.review?.stage !== "readyToLand" ||
      state?.status === "working"
    ) {
      return;
    }
    reviewAutoOpened.current = true;
    setReviewOpen(true);
  }, [session?.review?.stage, session?.workspace, state?.status]);

  // Grouped, settings-filtered transcript blocks (memoized so the virtualizer
  // gets a stable list and streaming chunks don't re-group on every render).
  const blocks = useMemo(
    () =>
      groupTranscript(
        filterTranscript(state?.transcript ?? [], {
          showReasoning,
          toolDisplay,
        }),
      ),
    [state?.transcript, showReasoning, toolDisplay],
  );

  // Virtualize the transcript: only the visible blocks (plus a small overscan)
  // are mounted, so a long, multi-session stream doesn't render thousands of
  // nodes. Heights vary (markdown, diffs, collapsibles) → dynamic measurement.
  const virtualizer = useVirtualizer({
    count: blocks.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 120,
    overscan: 6,
    getItemKey: (index) => {
      const b = blocks[index];
      return b.kind === "toolGroup" ? `tg-${b.id}-${index}` : `e-${index}`;
    },
  });

  // Auto-scroll to the newest block while pinned to the bottom.
  //
  // `blocks.length` alone is not enough: `reduceSession` coalesces consecutive
  // agentMessage/agentThought chunks into the *same* transcript entry, so a
  // streaming reply grows the last block's height while the block count stays
  // constant. Track a signature of the last block's content so the effect also
  // re-runs (and re-pins) as that block grows.
  const lastBlockSignature = useMemo(() => {
    const last = blocks[blocks.length - 1];
    if (!last) return "";
    if (last.kind === "toolGroup") {
      // Cover every tool in the group, not just the last one. A
      // `tool_call_update` can grow a tool's `output` or attach/grow its
      // `diff` (an InlineDiff mounts/grows, changing the block's height)
      // without changing the last tool's `status` — sampling only the tail
      // would miss that growth and skip the auto-scroll re-pin.
      const sig = last.tools.reduce(
        (acc, t) =>
          `${acc}|${t.status}:${(t.output ?? "").length}:${t.diff?.newText.length ?? 0}`,
        "",
      );
      return `tg:${last.tools.length}:${sig}`;
    }
    const e = last.entry;
    const len = "text" in e ? e.text.length : 0;
    return `e:${e.kind}:${len}`;
  }, [blocks]);

  useEffect(() => {
    if (stickToBottom.current && blocks.length > 0) {
      virtualizer.scrollToIndex(blocks.length - 1, { align: "end" });
    }
  }, [blocks.length, lastBlockSignature, virtualizer]);

  useEffect(() => {
    if (state?.pendingPermission) {
      void notify("Approval needed", state.pendingPermission.title);
    }
  }, [state?.pendingPermission]);

  // Restore the transcript from kiro's store when selecting a session that has
  // no in-memory messages (e.g. resumed/cold). Guarded so it never clobbers a
  // live conversation.
  useEffect(() => {
    const current = useFleet.getState().sessions[sessionId];
    if (!current || current.state.transcript.length > 0) return;
    let active = true;
    sessionTranscript(sessionId)
      .then((entries) => {
        if (!active || entries.length === 0) return;
        const s = useFleet.getState();
        if (s.sessions[sessionId]?.state.transcript.length === 0) {
          s.setTranscript(sessionId, entries);
        }
      })
      .catch(() => {
        /* best-effort */
      });
    return () => {
      active = false;
    };
  }, [sessionId]);

  if (!session || !state) {
    return <p className="muted">Session not found.</p>;
  }

  const busy = state.status === "working" || state.status === "needsApproval";
  const displayStatus = effectiveStatus(state.status, session.review);

  // Header identity: friendly project name (if the session belongs to a repo)
  // plus the session's own name (its worktree branch, or "Plain session").
  const project = projectName(session.repoRoot, projects);
  const sessionName =
    (session.name ?? session.workspace?.task) ||
    session.workspace?.branch ||
    "Plain session";

  // ---- Slash-command palette (mirrors kiro-cli's own `/` palette) ----------
  // Skills surface as prompts (serverName "skill:config"); commands carry the
  // leading slash. Selecting fills the input; sending executes it (the ACP
  // `session/prompt` path runs slash commands — verified, see acp-notes.md).
  const caps = state.capabilities;
  const isSlash = prompt.startsWith("/");
  // Match against the command name only (text up to the first space), so args
  // typed after the command don't keep re-filtering the list.
  const query = isSlash ? prompt.slice(1).split(/\s/, 1)[0].toLowerCase() : "";
  // Once the input is a recognized command/prompt name followed by a space, the
  // user has moved on to typing *arguments*. Stop treating the input as a
  // palette query — otherwise the palette re-opens on every keystroke and Enter
  // re-selects the command, wiping the args the user just typed.
  const knownItemNames = new Set([
    ...caps.commands.map((c) => c.name.toLowerCase()),
    ...caps.prompts.map((p) => p.name.toLowerCase()),
  ]);
  const isKnownItem =
    knownItemNames.has(`/${query}`) || knownItemNames.has(query);
  const typingArgs = isSlash && /\s/.test(prompt) && isKnownItem;
  type PaletteItem = {
    kind: "command" | "prompt";
    name: string;
    description: string;
  };
  const paletteItems: PaletteItem[] = isSlash
    ? [
        ...caps.commands
          .filter(
            (c) =>
              c.name.toLowerCase().includes(query) ||
              c.description.toLowerCase().includes(query),
          )
          .map((c) => ({
            kind: "command" as const,
            name: c.name,
            description: c.description,
          })),
        ...caps.prompts
          .filter(
            (p) =>
              p.name.toLowerCase().includes(query) ||
              p.description.toLowerCase().includes(query),
          )
          .map((p) => ({
            kind: "prompt" as const,
            name: p.name,
            description: p.description,
          })),
      ]
    : [];
  const paletteOpen =
    isSlash && !paletteDismissed && !typingArgs && paletteItems.length > 0;
  const paletteActive = Math.max(
    0,
    Math.min(paletteIndex, paletteItems.length - 1),
  );

  function selectPaletteItem(item: PaletteItem) {
    // Fill the input with the command/prompt; the user confirms with Enter to
    // send (the send path executes it). This matches kiro-cli's palette and
    // avoids auto-firing destructive commands without a confirming keystroke.
    setPrompt(`${item.name} `);
    setPaletteDismissed(true);
    inputRef.current?.focus();
  }

  // Palette-aware keydown for the prompt textarea. Returns true if it handled
  // the key (so the caller skips its own Enter-to-submit behavior).
  function handlePaletteKey(
    e: React.KeyboardEvent<HTMLTextAreaElement>,
  ): boolean {
    if (!paletteOpen) return false;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setPaletteIndex((i) => (i + 1) % paletteItems.length);
      return true;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      setPaletteIndex(
        (i) => (i - 1 + paletteItems.length) % paletteItems.length,
      );
      return true;
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault(); // select the highlighted item instead of submitting
      selectPaletteItem(paletteItems[paletteActive]);
      return true;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      setPaletteDismissed(true);
      return true;
    }
    return false;
  }

  async function sendPrompt() {
    const text = prompt.trim();
    if (!text) return;
    setPrompt("");
    appendUserMessage(sessionId, text); // show the prompt immediately
    try {
      setError("");
      await orchEnqueue(sessionId, text);
    } catch (e) {
      setError(String(e));
    }
  }

  async function copyMessage(text: string) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      /* clipboard unavailable (e.g. insecure context) — silent no-op */
    }
  }

  // Re-run a previous prompt verbatim (optimistic echo + enqueue).
  async function resend(text: string) {
    appendUserMessage(sessionId, text);
    try {
      setError("");
      await orchEnqueue(sessionId, text);
    } catch (e) {
      setError(String(e));
    }
  }

  // Capture a screenshot of the running app and send it with the prompt as a
  // visual input (Codex-style). Unlike sendPrompt this is a direct one-shot
  // (it rejects while the session is busy), so the screenshot always reflects
  // the UI at send time. With an empty prompt, ask for a general critique.
  async function sendScreenshotPrompt() {
    if (busy) return;
    const text =
      prompt.trim() ||
      "Here's a screenshot of the current app UI. Review it and critique what you see.";
    setPrompt("");
    appendUserMessage(sessionId, `📷 ${text}`);
    try {
      setError("");
      await acpPromptWithScreenshot(sessionId, text);
    } catch (e) {
      setError(String(e));
    }
  }

  async function respond(optionId: string) {
    if (!state?.pendingPermission || permissionBusy) return;
    try {
      setPermissionBusy(true);
      setPermissionChoice(optionId);
      setPermissionError("");
      await acpRespondPermission(
        sessionId,
        state.pendingPermission.requestId,
        optionId,
      );
    } catch (e) {
      setPermissionBusy(false);
      setPermissionChoice("");
      setPermissionError(String(e));
    }
  }

  async function closeSession() {
    try {
      await acpCloseSession(sessionId);
      setConnected(sessionId, false);
    } catch (e) {
      setError(String(e));
    }
  }

  // Track whether the user is pinned to the bottom of the transcript.
  function handleScroll(e: React.UIEvent<HTMLDivElement>) {
    const el = e.currentTarget;
    stickToBottom.current =
      el.scrollHeight - el.scrollTop - el.clientHeight < 48;
  }

  // Render one grouped transcript block (used by the virtualized list).
  function renderBlock(block: TranscriptBlock, i: number) {
    if (block.kind === "toolGroup") {
      return <ToolGroup tools={block.tools} />;
    }
    const entry = block.entry;
    if (entry.kind === "user") {
      return (
        <div className="msg msg--user">
          <div className="msg__bubble">{entry.text}</div>
          <div className="msg__actions">
            <button
              type="button"
              className="msg__action"
              onClick={() => void copyMessage(entry.text)}
              aria-label="copy message"
              title="Copy"
            >
              <Copy size={13} aria-hidden />
            </button>
            <button
              type="button"
              className="msg__action"
              onClick={() => void resend(entry.text)}
              aria-label="retry message"
              title="Send again"
            >
              <RotateCcw size={13} aria-hidden />
            </button>
          </div>
        </div>
      );
    }
    if (entry.kind === "agent") {
      return (
        <div className="msg msg--agent">
          <Markdown remarkPlugins={[remarkGfm]}>{entry.text}</Markdown>
          <div className="msg__actions">
            <button
              type="button"
              className="msg__action"
              onClick={() => void copyMessage(entry.text)}
              aria-label="copy message"
              title="Copy"
            >
              <Copy size={13} aria-hidden />
            </button>
          </div>
        </div>
      );
    }
    if (entry.kind === "thought") {
      return (
        <details className="msg msg--thought">
          <summary className="msg__thought-head">
            <Brain size={13} aria-hidden /> Thinking
          </summary>
          <div className="msg__thought-body">
            <Markdown remarkPlugins={[remarkGfm]}>{entry.text}</Markdown>
          </div>
        </details>
      );
    }
    if (entry.kind === "system") {
      return (
        <p className="msg msg--system muted" key={i}>
          {entry.text}
        </p>
      );
    }
    return null;
  }

  return (
    <section className="pane">
      <header className="pane__header">
        <span className="pane__title">
          {session.workspace ? (
            <GitBranch size={15} aria-hidden />
          ) : (
            <SquareTerminal size={15} aria-hidden />
          )}
          {project && (
            <>
              <span className="pane__title-project">{project}</span>
              <span className="pane__title-sep" aria-hidden>
                /
              </span>
            </>
          )}
          {session.workspace ? (
            <code className="pane__title-name">{sessionName}</code>
          ) : (
            <span className="pane__title-name">{sessionName}</span>
          )}
        </span>
        <span role="status" aria-label="session status" className="badge">
          {DISPLAY_STATUS_LABEL[displayStatus]}
        </span>
        {session.queued > 0 && (
          <span className="badge" aria-label="queued tasks">
            queued {session.queued}
          </span>
        )}
        {state.contextPercent !== null && (
          <span className="badge" aria-label="context usage">
            ctx {state.contextPercent.toFixed(1)}%
          </span>
        )}
        {state.credits > 0 && (
          <span className="badge" aria-label="credits spent">
            {state.credits.toFixed(2)} cr
          </span>
        )}
        <div className="pane__actions">
          {splitOpen && (
            <button
              type="button"
              className="pane__action pane__action--icon"
              onClick={() => {
                setMoreOpen(false);
                closeSplit();
              }}
              aria-label="Close split view"
              title="Close split view"
            >
              <X size={17} aria-hidden />
            </button>
          )}
          {state.status !== "disconnected" && (
            <button
              type="button"
              className="pane__action pane__action--stop"
              onClick={() => void closeSession()}
              aria-label="Stop agent"
              title="Stop agent and keep the session resumable"
            >
              <Square size={14} aria-hidden />
              <span>Stop</span>
            </button>
          )}
          {session.workspace && (
            <button
              type="button"
              className={`pane__action${reviewOpen ? " pane__action--active" : ""}`}
              onClick={() => {
                setMoreOpen(false);
                setQueueOpen(false);
                setReviewOpen((open) => !open);
              }}
            >
              {reviewOpen ? "Hide review" : "Review"}
            </button>
          )}
          <button
            type="button"
            className={`pane__action${queueOpen ? " pane__action--active" : ""}`}
            onClick={() => {
              setMoreOpen(false);
              setReviewOpen(false);
              setQueueOpen((open) => !open);
            }}
          >
            {queueOpen
              ? "Back to session"
              : `Queue${session.queued > 0 ? ` (${session.queued})` : ""}`}
          </button>
          <div className="pane__more" ref={moreMenuRef}>
            <button
              ref={moreButtonRef}
              type="button"
              className="pane__action"
              aria-label="more session actions"
              title="More session actions"
              aria-expanded={moreOpen}
              onClick={() => setMoreOpen((open) => !open)}
            >
              <MoreHorizontal size={17} aria-hidden />
            </button>
            {moreOpen && (
              <div
                ref={moreMenuListRef}
                className="pane__more-menu"
                role="menu"
                aria-label="session actions"
                onKeyDown={(event) => {
                  const items = Array.from(
                    event.currentTarget.querySelectorAll<HTMLButtonElement>(
                      "button:not(:disabled)",
                    ),
                  );
                  const current = items.indexOf(
                    document.activeElement as HTMLButtonElement,
                  );
                  let next: number;
                  if (event.key === "ArrowDown")
                    next = (current + 1) % items.length;
                  else if (event.key === "ArrowUp")
                    next = (current - 1 + items.length) % items.length;
                  else if (event.key === "Home") next = 0;
                  else if (event.key === "End") next = items.length - 1;
                  else return;
                  event.preventDefault();
                  items[next]?.focus();
                }}
              >
                {splitOpen && (
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setMoreOpen(false);
                      closeSplit();
                    }}
                    title="Close the split view"
                  >
                    Close split view
                  </button>
                )}
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setMoreOpen(false);
                    void closeSession();
                  }}
                  title="Release the process; keep the session resumable"
                  disabled={state.status === "disconnected"}
                >
                  {state.status === "disconnected"
                    ? "Agent already stopped"
                    : "Stop agent"}
                </button>
              </div>
            )}
          </div>
        </div>
      </header>

      {queueOpen && (
        <div className="queue-page">
          <QueuePanel
            sessionId={sessionId}
            onSaved={(depth) => setQueued(sessionId, depth)}
          />
        </div>
      )}

      <div
        className={`pane__workspace${reviewOpen ? " pane__workspace--review" : ""}`}
      >
        <div className="pane__conversation">
          {state.status === "disconnected" && !queueOpen && (
            <div className="pane__recovery" role="status">
              <strong>Agent is stopped.</strong> Review remains available, and
              sending the next prompt will start a fresh ACP process and resume
              this session.
            </div>
          )}

          <div
            className="chat"
            aria-label="transcript"
            ref={scrollRef}
            onScroll={handleScroll}
          >
            {session.workspace && (
              <p className="chat__cwd muted">
                {session.workspace.worktreePath}
              </p>
            )}
            {state.transcript.length === 0 && (
              <p className="chat__empty muted">
                No messages yet. Ask the agent below to get started.
              </p>
            )}
            <div
              style={{
                height: `${virtualizer.getTotalSize()}px`,
                position: "relative",
                width: "100%",
              }}
            >
              {virtualizer.getVirtualItems().length === 0 && blocks.length > 0
                ? // Fallback for environments without a layout engine (e.g. jsdom
                  // tests): the virtualizer can't measure and yields no items, so
                  // render the full list rather than hiding content. Real browsers
                  // measure and take the virtualized path below.
                  blocks.map((block, i) => (
                    <div
                      key={
                        block.kind === "toolGroup"
                          ? `tg-${block.id}-${i}`
                          : `e-${i}`
                      }
                    >
                      {renderBlock(block, i)}
                    </div>
                  ))
                : virtualizer.getVirtualItems().map((vi) => (
                    <div
                      key={vi.key}
                      data-index={vi.index}
                      ref={virtualizer.measureElement}
                      style={{
                        position: "absolute",
                        top: 0,
                        left: 0,
                        width: "100%",
                        transform: `translateY(${vi.start}px)`,
                      }}
                    >
                      {renderBlock(blocks[vi.index], vi.index)}
                    </div>
                  ))}
            </div>
          </div>

          {state.pendingPermission && (
            <div
              role="alert"
              aria-live="assertive"
              aria-label="permission request"
              className="permission"
            >
              <p>
                <strong>Permission requested:</strong>{" "}
                {state.pendingPermission.title}
              </p>
              <div className="permission__actions">
                {state.pendingPermission.options.map((opt) => (
                  <button
                    key={opt.optionId}
                    type="button"
                    className={`permission__btn permission__btn--${opt.kind}`}
                    disabled={permissionBusy}
                    onClick={() => void respond(opt.optionId)}
                  >
                    {permissionChoice === opt.optionId
                      ? "Decision sent…"
                      : opt.name}
                  </button>
                ))}
              </div>
              {permissionBusy && (
                <p className="permission__state" role="status">
                  Waiting for the agent to continue…
                </p>
              )}
              {permissionError && (
                <p className="error" role="alert">
                  {permissionError} — choose again to retry.
                </p>
              )}
            </div>
          )}

          {(caps.tools.length > 0 ||
            caps.mcpServers.length > 0 ||
            caps.subagents.length > 0) && (
            <details className="caps">
              <summary>
                Capabilities
                <span className="muted">
                  {" "}
                  · {caps.tools.length} tools · {caps.mcpServers.length} MCP ·{" "}
                  {caps.subagents.length} subagents
                </span>
              </summary>
              <div className="caps__body">
                {caps.tools.length > 0 && (
                  <section className="caps__group" aria-label="tools">
                    <h4>Tools</h4>
                    <ul>
                      {caps.tools.map((t) => (
                        <li key={t.name}>
                          <code>{t.name}</code>
                          {t.source && (
                            <span className="muted"> · {t.source}</span>
                          )}
                        </li>
                      ))}
                    </ul>
                  </section>
                )}
                {caps.mcpServers.length > 0 && (
                  <section className="caps__group" aria-label="MCP servers">
                    <h4>MCP servers</h4>
                    <ul>
                      {caps.mcpServers.map((m) => (
                        <li key={m.name}>
                          <code>{m.name}</code>
                          <span className="muted">
                            {m.status ? ` · ${m.status}` : ""}
                            {m.toolCount != null
                              ? ` · ${m.toolCount} tools`
                              : ""}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </section>
                )}
                {caps.subagents.length > 0 && (
                  <section className="caps__group" aria-label="subagents">
                    <h4>Subagents</h4>
                    <ul>
                      {caps.subagents.map((s) => (
                        <li key={s.name}>
                          <code>{s.name}</code>
                        </li>
                      ))}
                    </ul>
                  </section>
                )}
              </div>
            </details>
          )}

          <form
            className="chatbox"
            onSubmit={(e) => {
              e.preventDefault();
              void sendPrompt();
            }}
          >
            {paletteOpen && (
              <ul
                id="session-palette"
                className="palette"
                role="listbox"
                aria-label="commands and prompts"
              >
                {paletteItems.map((item, i) => (
                  <li
                    key={`${item.kind}:${item.name}`}
                    id={`palette-opt-${i}`}
                    role="option"
                    aria-selected={i === paletteActive}
                    className={`palette__option${
                      i === paletteActive ? " palette__option--active" : ""
                    }`}
                    // onMouseDown (not onClick) so the textarea doesn't blur first.
                    onMouseDown={(e) => {
                      e.preventDefault();
                      selectPaletteItem(item);
                    }}
                  >
                    <span className="palette__name">{item.name}</span>
                    {item.kind === "prompt" && (
                      <span className="palette__tag">prompt/skill</span>
                    )}
                    {item.description && (
                      <span className="palette__desc">{item.description}</span>
                    )}
                  </li>
                ))}
                <li className="palette__foot" aria-hidden="true">
                  ↑↓ navigate · ↵ select · esc cancel
                </li>
              </ul>
            )}
            <textarea
              ref={inputRef}
              className="chatbox__input"
              aria-label="prompt"
              role="combobox"
              aria-expanded={paletteOpen}
              aria-controls="session-palette"
              aria-activedescendant={
                paletteOpen ? `palette-opt-${paletteActive}` : undefined
              }
              autoComplete="off"
              rows={1}
              placeholder={
                busy
                  ? "Queue a follow-up… (/ for commands)"
                  : "Ask for changes… (/ for commands)"
              }
              value={prompt}
              onChange={(e) => {
                setPrompt(e.currentTarget.value);
                setPaletteDismissed(false);
                setPaletteIndex(0);
              }}
              onKeyDown={(e) => {
                if (handlePaletteKey(e)) return;
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void sendPrompt();
                }
              }}
            />
            {state.status === "working" && (
              <button
                type="button"
                className="chatbox__stop"
                aria-label="Stop"
                title="Stop the current turn"
                onClick={() => void acpCancel(sessionId).catch(() => {})}
              >
                <Square size={16} aria-hidden />
              </button>
            )}
            <button
              type="button"
              className="chatbox__shot"
              aria-label="Screenshot"
              title="Capture a screenshot of the app and send it with your prompt"
              disabled={busy}
              onClick={() => void sendScreenshotPrompt()}
            >
              <Camera size={18} aria-hidden />
            </button>
            <button
              type="submit"
              className="chatbox__send"
              aria-label="Send"
              disabled={!prompt.trim()}
            >
              <ArrowUp size={18} aria-hidden />
            </button>
          </form>

          {error && (
            <p role="alert" className="error">
              {error}
            </p>
          )}
        </div>

        {reviewOpen && session.workspace && (
          <aside className="pane__review" aria-label="review inspector">
            <ReviewPanel
              sessionId={sessionId}
              onClose={() => setReviewOpen(false)}
            />
          </aside>
        )}
      </div>
    </section>
  );
}
