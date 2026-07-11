import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";
import { orchQueue, orchQueueReplace } from "./lib/ipc";

function cleanTasks(source: string[]): string[] {
  return source.map((task) => task.trim()).filter(Boolean);
}

/** Ordered, editable view of prompts waiting behind the current turn. */
export default function QueuePanel({
  sessionId,
  onSaved,
}: {
  sessionId: string;
  onSaved: (depth: number) => void;
}) {
  const [tasks, setTasks] = useState<string[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saveState, setSaveState] = useState<
    "saved" | "unsaved" | "saving" | "error"
  >("saved");
  const [reloadKey, setReloadKey] = useState(0);
  const tasksRef = useRef<string[]>([]);
  const savedSignature = useRef("");
  const onSavedRef = useRef(onSaved);
  const saveChain = useRef<Promise<void>>(Promise.resolve());

  useEffect(() => {
    onSavedRef.current = onSaved;
  }, [onSaved]);

  const save = useCallback(
    async (source = tasksRef.current) => {
      const clean = cleanTasks(source);
      const signature = JSON.stringify(clean);
      if (signature === savedSignature.current) return;
      try {
        setBusy(true);
        setSaveState("saving");
        setError("");
        const operation = saveChain.current
          .catch(() => {})
          .then(() => orchQueueReplace(sessionId, clean));
        saveChain.current = operation;
        await operation;
        savedSignature.current = signature;
        onSavedRef.current(clean.length);
        if (JSON.stringify(cleanTasks(tasksRef.current)) === signature) {
          setTasks(clean);
          setSaveState("saved");
        } else {
          setSaveState("unsaved");
        }
      } catch (cause) {
        setError(String(cause));
        setSaveState("error");
      } finally {
        setBusy(false);
      }
    },
    [sessionId],
  );

  useEffect(() => {
    let active = true;
    setLoaded(false);
    setTasks([]);
    tasksRef.current = [];
    savedSignature.current = "";
    setSaveState("saved");
    setError("");
    orchQueue(sessionId)
      .then((queue) => {
        if (active) {
          setTasks(queue);
          tasksRef.current = queue;
          savedSignature.current = JSON.stringify(cleanTasks(queue));
          setLoaded(true);
        }
      })
      .catch((cause) => {
        if (active) {
          setError(String(cause));
        }
      });
    return () => {
      active = false;
    };
  }, [reloadKey, sessionId]);

  useEffect(() => {
    tasksRef.current = tasks;
    if (!loaded) return;
    const signature = JSON.stringify(cleanTasks(tasks));
    if (signature === savedSignature.current) {
      setSaveState("saved");
      return;
    }
    setSaveState("unsaved");
    const timer = window.setTimeout(() => void save(tasks), 650);
    return () => window.clearTimeout(timer);
  }, [loaded, save, tasks]);

  // Navigation should never discard a final keystroke. Flush any outstanding
  // queue snapshot when the editor unmounts; the next open will read it back.
  useEffect(
    () => () => {
      const clean = cleanTasks(tasksRef.current);
      if (JSON.stringify(clean) === savedSignature.current) return;
      saveChain.current = saveChain.current
        .catch(() => {})
        .then(() => orchQueueReplace(sessionId, clean))
        .then(() => onSavedRef.current(clean.length))
        .catch(() => {});
    },
    [sessionId],
  );

  function update(index: number, value: string) {
    setTasks((current) =>
      current.map((task, position) => (position === index ? value : task)),
    );
  }

  function move(index: number, offset: -1 | 1) {
    setTasks((current) => {
      const target = index + offset;
      if (target < 0 || target >= current.length) return current;
      const next = [...current];
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  }

  return (
    <section className="queue-panel" aria-label="queued tasks">
      <header className="queue-panel__head">
        <div>
          <strong>Queued work</strong>
          <p className="muted">
            The heartbeat dispatches these prompts from top to bottom when the
            agent is idle.
          </p>
        </div>
        <button
          type="button"
          className="pane__action"
          disabled={!loaded}
          onClick={() => setTasks((current) => [...current, ""])}
        >
          <Plus size={13} aria-hidden /> Add
        </button>
      </header>

      {!loaded && !error && (
        <p className="muted queue-panel__empty" role="status">
          Loading queued work…
        </p>
      )}
      {loaded && tasks.length === 0 && !error && (
        <p className="muted queue-panel__empty">Nothing is queued.</p>
      )}
      <ol className="queue-panel__list">
        {tasks.map((task, index) => (
          <li key={index}>
            <span className="queue-panel__order">{index + 1}</span>
            <textarea
              aria-label={`queued task ${index + 1}`}
              value={task}
              onChange={(event) => update(index, event.currentTarget.value)}
            />
            <div className="queue-panel__actions">
              <button
                type="button"
                aria-label={`move queued task ${index + 1} up`}
                disabled={index === 0}
                onClick={() => move(index, -1)}
              >
                <ArrowUp size={13} aria-hidden />
              </button>
              <button
                type="button"
                aria-label={`move queued task ${index + 1} down`}
                disabled={index === tasks.length - 1}
                onClick={() => move(index, 1)}
              >
                <ArrowDown size={13} aria-hidden />
              </button>
              <button
                type="button"
                aria-label={`remove queued task ${index + 1}`}
                onClick={() =>
                  setTasks((current) =>
                    current.filter((_, position) => position !== index),
                  )
                }
              >
                <Trash2 size={13} aria-hidden />
              </button>
            </div>
          </li>
        ))}
      </ol>

      <div className="queue-panel__footer">
        <span
          className={`queue-panel__save-state queue-panel__save-state--${saveState}`}
          role="status"
        >
          {saveState === "saving"
            ? "Saving…"
            : saveState === "unsaved"
              ? "Unsaved changes"
              : saveState === "error"
                ? "Save failed"
                : "Saved"}
        </span>
        <button
          type="button"
          disabled={busy || saveState === "saved"}
          onClick={() => void save()}
        >
          Save now
        </button>
        {error && (
          <>
            <span className="error" role="alert">
              {error}
            </span>
            {!loaded && (
              <button
                type="button"
                onClick={() => setReloadKey((key) => key + 1)}
              >
                Retry loading
              </button>
            )}
          </>
        )}
      </div>
    </section>
  );
}
