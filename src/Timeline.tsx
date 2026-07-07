import { useEffect, useState } from "react";
import { ScrollText } from "lucide-react";
import { orchLog } from "./lib/ipc";

/** Event log page — the fleet's dispatch/automation history, read from Bugyo's
 * `log.md`. Markdown date headings are dropped; each entry is one event. */
export default function Timeline() {
  const [lines, setLines] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");

  async function load() {
    try {
      setError("");
      const log = await orchLog();
      // Drop markdown date headings ("## 2026-…") — keep only event entries.
      setLines(log.filter((l) => !l.trimStart().startsWith("## ")));
      setLoaded(true);
    } catch (e) {
      setError(String(e));
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
            onClick={() => void load()}
          >
            Refresh
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
      <ul className="eventlog__list" aria-label="events">
        {[...filtered].reverse().map((line, i) => (
          <li key={i} className="muted">
            {line}
          </li>
        ))}
      </ul>
      {loaded && filtered.length === 0 && (
        <p className="muted">No matching events.</p>
      )}
    </section>
  );
}
