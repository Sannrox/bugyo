import { useEffect, useState } from "react";
import { ScrollText } from "lucide-react";
import { orchLog } from "./lib/ipc";
import { useFleet } from "./lib/fleetStore";

function eventParts(line: string): { timestamp: string; message: string } {
  const match = line.match(/^\s*-\s+(\S+)\s+(.+)$/);
  return match
    ? { timestamp: match[1], message: match[2] }
    : { timestamp: "", message: line };
}

/** Event log page — the fleet's dispatch/automation history, read from Bugyo's
 * `log.md`. Markdown date headings are dropped; each entry is one event. */
export default function Timeline() {
  const [lines, setLines] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const sessions = useFleet((state) => state.sessions);
  const order = useFleet((state) => state.order);
  const setActive = useFleet((state) => state.setActive);

  async function load() {
    try {
      setLoading(true);
      setError("");
      const log = await orchLog();
      // Drop markdown date headings ("## 2026-…") — keep only event entries.
      setLines(log.filter((l) => !l.trimStart().startsWith("## ")));
      setLoaded(true);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoaded(true);
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  const filtered = query
    ? lines.filter((l) => l.toLowerCase().includes(query.toLowerCase()))
    : lines;

  return (
    <section className="eventlog" aria-label="event log">
      <header className="eventlog__head">
        <ScrollText size={18} aria-hidden />
        <h2>Event log</h2>
        <div className="eventlog__controls">
          <input
            aria-label="search events"
            placeholder="Search…"
            value={query}
            onChange={(e) => setQuery(e.currentTarget.value)}
          />
          <button
            type="button"
            className="pane__action"
            disabled={loading}
            onClick={() => void load()}
          >
            {loading ? "Refreshing…" : "Refresh"}
          </button>
        </div>
      </header>
      <p className="muted eventlog__note">
        Dispatch, automation, and prompt history across the fleet.
      </p>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {!loaded && (
        <p className="muted" role="status">
          Loading events…
        </p>
      )}
      <ul className="eventlog__list" aria-label="events">
        {[...filtered].reverse().map((line, i) => {
          const parts = eventParts(line);
          const sessionId = order.find((id) => line.includes(id));
          const session = sessionId ? sessions[sessionId] : null;
          const label =
            (session
              ? session.name ||
                session.workspace?.task ||
                session.workspace?.branch ||
                "Plain session"
              : sessionId?.slice(0, 8)) ?? "";
          return (
            <li key={i} className="eventlog__event">
              {parts.timestamp && (
                <time dateTime={parts.timestamp}>
                  {new Date(parts.timestamp).toLocaleString()}
                </time>
              )}
              <span>{parts.message}</span>
              {sessionId && (
                <button
                  type="button"
                  className="pane__action"
                  onClick={() => setActive(sessionId)}
                >
                  Open {label}
                </button>
              )}
            </li>
          );
        })}
      </ul>
      {loaded && filtered.length === 0 && !error && (
        <p className="muted">No matching events.</p>
      )}
    </section>
  );
}
