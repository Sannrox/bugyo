import { useEffect, useRef, useState } from "react";
import { useFleet } from "./lib/fleetStore";
import { confirmDialog, messageDialog, workspaceArchive } from "./lib/ipc";

interface Command {
  id: string;
  label: string;
  hint?: string;
  run: () => void;
}

/**
 * ⌘K / Ctrl-K command palette: jump to any session and run navigation actions
 * from the keyboard. Destructive/gated actions (merge, approvals) intentionally
 * stay in their contextual, gated UI — the palette only exposes navigation and
 * archive (which itself always confirms), per the safety model.
 */
export default function CommandPalette({ onClose }: { onClose: () => void }) {
  const order = useFleet((s) => s.order);
  const sessions = useFleet((s) => s.sessions);
  const setActive = useFleet((s) => s.setActive);
  const removeSession = useFleet((s) => s.removeSession);
  const openInbox = useFleet((s) => s.openInbox);
  const openAutomations = useFleet((s) => s.openAutomations);
  const openSettings = useFleet((s) => s.openSettings);
  const openFleet = useFleet((s) => s.openFleet);
  const openSearch = useFleet((s) => s.openSearch);
  const openEventLog = useFleet((s) => s.openEventLog);

  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const previousFocus = useRef<HTMLElement | null>(
    document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null,
  );

  useEffect(() => {
    const restoreTarget = previousFocus.current;
    inputRef.current?.focus();
    return () => {
      if (restoreTarget?.isConnected) restoreTarget.focus();
    };
  }, []);

  async function archiveActive() {
    const activeId = useFleet.getState().activeId;
    const sess = activeId ? useFleet.getState().sessions[activeId] : null;
    if (!activeId || !sess?.workspace) return;
    const ok = await confirmDialog(
      "Archive this workspace? This removes the local git worktree and discards " +
        "uncommitted changes. Git deletes a safely merged branch; an unmerged branch is retained.",
      "Archive workspace",
    );
    if (!ok) return;
    try {
      await workspaceArchive(activeId, true);
      removeSession(activeId);
    } catch (e) {
      await messageDialog(String(e));
    }
  }

  const commands: Command[] = (() => {
    const nav: Command[] = [
      {
        id: "nav:new",
        label: "New task",
        hint: "compose",
        run: () => setActive(null),
      },
      {
        id: "nav:fleet",
        label: "Fleet overview",
        hint: "view",
        run: openFleet,
      },
      {
        id: "nav:inbox",
        label: "Attention inbox",
        hint: "view",
        run: openInbox,
      },
      {
        id: "nav:automations",
        label: "Automations",
        hint: "view",
        run: openAutomations,
      },
      {
        id: "nav:search",
        label: "Search sessions and transcripts",
        hint: "view",
        run: openSearch,
      },
      {
        id: "nav:eventlog",
        label: "Event history",
        hint: "view",
        run: openEventLog,
      },
      {
        id: "nav:settings",
        label: "Settings",
        hint: "view",
        run: openSettings,
      },
    ];

    const jumps: Command[] = order.map((id) => {
      const sess = sessions[id];
      const name =
        (sess?.name ?? sess?.workspace?.task) ||
        sess?.workspace?.branch ||
        "Plain session";
      return {
        id: `go:${id}`,
        label: `Go to ${name}`,
        hint: "session",
        run: () => setActive(id),
      };
    });

    const activeId = useFleet.getState().activeId;
    const activeWs = activeId ? sessions[activeId]?.workspace : null;
    const actions: Command[] = activeWs
      ? [
          {
            id: "act:archive",
            label: "Archive active workspace",
            hint: "destructive",
            run: () => void archiveActive(),
          },
        ]
      : [];

    return [...nav, ...jumps, ...actions];
  })();

  const q = query.trim().toLowerCase();
  const filtered = q
    ? commands.filter((c) => c.label.toLowerCase().includes(q))
    : commands;
  const active = Math.max(0, Math.min(index, filtered.length - 1));

  function runAt(i: number) {
    const cmd = filtered[i];
    if (!cmd) return;
    onClose();
    cmd.run();
  }

  return (
    <div className="palette-overlay" onClick={onClose}>
      <div
        className="cmdk"
        role="dialog"
        aria-modal="true"
        aria-label="command palette"
        onClick={(e) => e.stopPropagation()}
      >
        <input
          ref={inputRef}
          className="cmdk__input"
          role="combobox"
          aria-expanded="true"
          aria-autocomplete="list"
          aria-controls="cmdk-list"
          aria-activedescendant={
            filtered.length > 0 ? `cmdk-opt-${active}` : undefined
          }
          autoComplete="off"
          placeholder="Jump to a session or run a command…"
          value={query}
          onChange={(e) => {
            setQuery(e.currentTarget.value);
            setIndex(0);
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setIndex((i) => (i + 1) % Math.max(1, filtered.length));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setIndex(
                (i) =>
                  (i - 1 + Math.max(1, filtered.length)) %
                  Math.max(1, filtered.length),
              );
            } else if (e.key === "Enter") {
              e.preventDefault();
              runAt(active);
            } else if (e.key === "Escape") {
              e.preventDefault();
              onClose();
            } else if (e.key === "Tab") {
              // The combobox is the sole focus target in this modal pattern;
              // options are navigated with arrows and selected with Enter.
              e.preventDefault();
              inputRef.current?.focus();
            }
          }}
        />
        <ul id="cmdk-list" className="cmdk__list" role="listbox">
          {filtered.length === 0 && (
            <li className="cmdk__empty muted">No matching commands.</li>
          )}
          {filtered.map((c, i) => (
            <li
              key={c.id}
              id={`cmdk-opt-${i}`}
              role="option"
              aria-selected={i === active}
              className={`cmdk__option${i === active ? " cmdk__option--active" : ""}`}
              onMouseDown={(e) => {
                e.preventDefault();
                runAt(i);
              }}
            >
              <span className="cmdk__label">{c.label}</span>
              {c.hint && <span className="cmdk__hint muted">{c.hint}</span>}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
