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
  hits: SearchHit[];
}

function sessionName(sess: {
  name?: string | null;
  workspace?: { branch: string } | null;
  sessionId: string;
}): string {
  return (
    sess.name ??
    sess.workspace?.branch ??
    `session ${sess.sessionId.slice(0, 8)}`
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
  const setActive = useFleet((s) => s.setActive);
  const sessions = useFleet((s) => s.sessions);
  const order = useFleet((s) => s.order);

  async function run(e: React.FormEvent) {
    e.preventDefault();
    const q = query.trim();
    if (!q) return;
    setBusy(true);
    setError("");
    try {
      setHits(await sessionSearch(q));
    } catch (err) {
      setError(String(err));
      setHits([]);
    } finally {
      setBusy(false);
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
          onChange={(e) => setQuery(e.currentTarget.value)}
        />
        <button type="submit" disabled={busy || !query.trim()}>
          Search transcripts
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
                  >
                    <Icon size={14} aria-hidden />
                    <span className="search__group-name">{g.name}</span>
                    <span className="muted">{g.hits.length}</span>
                  </button>
                  <ul className="search__hits">
                    {g.hits.map((h) => (
                      <li key={`${h.index}-${h.kind}`} className="search__hit">
                        <span className="search__hit-kind muted">{h.kind}</span>
                        <span className="search__hit-snippet">{h.snippet}</span>
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
