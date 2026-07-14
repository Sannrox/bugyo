import { useMemo, useRef, useState } from "react";
import { GitBranch, Search, SquareTerminal } from "lucide-react";
import { useFleet } from "./lib/fleetStore";
import { sessionSearch } from "./lib/ipc";
import type { SearchHit } from "./lib/bindings";

/** A hit plus a display name/icon resolved from the store (if the session is loaded). */
interface Group {
  sessionId: string;
  name: string;
  isWorkspace: boolean;
  available: boolean;
  hits: SearchHit[];
}

function sessionName(sess: {
  name?: string | null;
  workspace?: { task: string; branch: string } | null;
  sessionId: string;
}): string {
  return (
    (sess.name ?? sess.workspace?.task) ||
    sess.workspace?.branch ||
    "Plain session"
  );
}

/**
 * Unified search. Filters the fleet's sessions live (jump to any session by
 * name), and — on submit — greps every persisted transcript for content
 * matches. One surface that does both.
 */
export default function SearchPanel() {
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const searchVersion = useRef(0);
  const setActive = useFleet((s) => s.setActive);
  const sessions = useFleet((s) => s.sessions);
  const order = useFleet((s) => s.order);

  async function run(e: React.FormEvent) {
    e.preventDefault();
    const q = query.trim();
    if (!q) return;
    const version = ++searchVersion.current;
    setBusy(true);
    setError("");
    try {
      const next = await sessionSearch(q);
      if (searchVersion.current === version) setHits(next);
    } catch (err) {
      if (searchVersion.current === version) {
        setError(String(err));
        setHits([]);
      }
    } finally {
      if (searchVersion.current === version) setBusy(false);
    }
  }

  const q = query.trim().toLowerCase();

  // Live session matches (name filter) — the "jump to session" half.
  const sessionMatches = useMemo(() => {
    return order
      .map((id) => sessions[id])
      .filter((s): s is NonNullable<typeof s> => Boolean(s))
      .map((s) => ({
        sessionId: s.sessionId,
        name: sessionName(s),
        isWorkspace: s.workspace != null,
      }))
      .filter((s) => !q || s.name.toLowerCase().includes(q));
  }, [order, sessions, q]);

  // Transcript content matches (grep) — the "search transcripts" half.
  const groups = useMemo<Group[]>(() => {
    if (!hits) return [];
    const byId = new Map<string, SearchHit[]>();
    for (const h of hits) {
      const list = byId.get(h.sessionId) ?? [];
      list.push(h);
      byId.set(h.sessionId, list);
    }
    return [...byId.entries()].map(([sessionId, list]) => {
      const sess = sessions[sessionId];
      return {
        sessionId,
        name: sess ? sessionName(sess) : `session ${sessionId.slice(0, 8)}`,
        isWorkspace: sess?.workspace != null,
        available: Boolean(sess),
        hits: list,
      };
    });
  }, [hits, sessions]);

  return (
    <div className="search" aria-label="search">
      <h1 className="search__title">Search</h1>
      <form className="search__form" onSubmit={run}>
        <Search size={16} aria-hidden className="search__icon" />
        <input
          ref={inputRef}
          autoFocus
          aria-label="search query"
          placeholder="Filter sessions, or press Enter to search transcripts…"
          value={query}
          onChange={(e) => {
            searchVersion.current += 1;
            setQuery(e.currentTarget.value);
            setHits(null);
            setError("");
            setBusy(false);
          }}
        />
        <button type="submit" disabled={busy || !query.trim()}>
          {busy ? "Searching…" : "Search transcripts"}
        </button>
      </form>

      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}

      {/* Sessions (live name filter) */}
      {sessionMatches.length > 0 && (
        <section className="search__section" aria-label="sessions">
          <h2 className="search__section-title muted">Sessions</h2>
          <ul className="search__sessions">
            {sessionMatches.map((s) => {
              const Icon = s.isWorkspace ? GitBranch : SquareTerminal;
              return (
                <li key={s.sessionId}>
                  <button
                    type="button"
                    className="search__group-head"
                    onClick={() => setActive(s.sessionId)}
                  >
                    <Icon size={14} aria-hidden />
                    <span className="search__group-name">{s.name}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {q && sessionMatches.length === 0 && hits === null && (
        <p className="muted search__empty">
          No session names match. Press Enter to search transcript content.
        </p>
      )}

      {/* Transcript content matches */}
      {hits !== null && !busy && groups.length === 0 && !error && (
        <p className="muted search__empty">No transcript matches.</p>
      )}

      {groups.length > 0 && (
        <section className="search__section" aria-label="transcript matches">
          <h2 className="search__section-title muted">Transcript matches</h2>
          <div className="search__results">
            {groups.map((g) => {
              const Icon = g.isWorkspace ? GitBranch : SquareTerminal;
              return (
                <section key={g.sessionId} className="search__group">
                  <button
                    type="button"
                    className="search__group-head"
                    onClick={() => setActive(g.sessionId)}
                    disabled={!g.available}
                    title={
                      g.available
                        ? "Open session"
                        : "This transcript belongs to a session that is no longer in the fleet"
                    }
                  >
                    <Icon size={14} aria-hidden />
                    <span className="search__group-name">{g.name}</span>
                    <span className="muted">{g.hits.length}</span>
                    {!g.available && (
                      <span className="search__unavailable">Archived</span>
                    )}
                  </button>
                  <ul className="search__hits">
                    {g.hits.map((h) => (
                      <li key={`${h.index}-${h.kind}`}>
                        <button
                          type="button"
                          className="search__hit"
                          onClick={() => setActive(g.sessionId)}
                          disabled={!g.available}
                        >
                          <span className="search__hit-kind muted">
                            {h.kind}
                          </span>
                          <span className="search__hit-snippet">
                            {h.snippet}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </section>
              );
            })}
          </div>
        </section>
      )}
    </div>
  );
}
