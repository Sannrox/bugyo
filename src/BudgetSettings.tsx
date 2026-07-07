import { useEffect, useState } from "react";
import { CircleDollarSign, Trash2 } from "lucide-react";
import type { BudgetConfig, ProjectCap } from "./lib/bindings";
import { budgetGet, budgetSet, messageDialog } from "./lib/ipc";
import { useBudget } from "./lib/budgetStore";

/** Manage credit caps: a default per-session cap plus per-project overrides.
 * Sessions at/over their cap stop auto-dispatching (enforced in the backend). */
export default function BudgetSettings() {
  const config = useBudget((s) => s.config);
  const setConfig = useBudget((s) => s.setConfig);
  const [sessionCap, setSessionCap] = useState("");
  const [projPath, setProjPath] = useState("");
  const [projCap, setProjCap] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    budgetGet()
      .then((c) => {
        setConfig(c);
        setSessionCap(c.sessionCap != null ? String(c.sessionCap) : "");
      })
      .catch((e) => setError(String(e)));
  }, [setConfig]);

  async function persist(next: BudgetConfig) {
    try {
      await budgetSet(next);
      setConfig(next);
    } catch (e) {
      await messageDialog(String(e));
    }
  }

  function commitSessionCap() {
    const n = parseFloat(sessionCap);
    void persist({
      ...config,
      sessionCap: Number.isFinite(n) && n > 0 ? n : null,
    });
  }

  function addProjectCap(e: React.FormEvent) {
    e.preventDefault();
    const n = parseFloat(projCap);
    if (!projPath.trim() || !(Number.isFinite(n) && n > 0)) return;
    const projectCaps: ProjectCap[] = [
      ...config.projectCaps.filter((p) => p.path !== projPath.trim()),
      { path: projPath.trim(), cap: n },
    ];
    void persist({ ...config, projectCaps });
    setProjPath("");
    setProjCap("");
  }

  function removeProjectCap(path: string) {
    void persist({
      ...config,
      projectCaps: config.projectCaps.filter((p) => p.path !== path),
    });
  }

  return (
    <div className="settings__group" aria-label="budget caps">
      <h3 className="settings__subhead">
        <CircleDollarSign size={15} aria-hidden /> Budget caps
      </h3>
      <p className="muted settings__note">
        Credit caps per session (and per project). A session at or over its cap
        stops auto-dispatching until you raise the cap.
      </p>

      <div className="settings__row">
        <label htmlFor="budget-session" className="settings__label">
          <span>Default per-session cap</span>
          <span className="muted">Credits; blank = unlimited.</span>
        </label>
        <input
          id="budget-session"
          aria-label="session cap"
          type="number"
          min="0"
          step="0.5"
          placeholder="∞"
          value={sessionCap}
          onChange={(e) => setSessionCap(e.currentTarget.value)}
          onBlur={commitSessionCap}
        />
      </div>

      {config.projectCaps.length > 0 && (
        <ul className="tp__list">
          {config.projectCaps.map((p) => (
            <li key={p.path} className="tp__item">
              <div className="tp__info">
                <span className="tp__name">{p.path}</span>
                <span className="muted tp__tools">{p.cap} cr</span>
              </div>
              <button
                type="button"
                className="tp__remove"
                aria-label={`remove cap for ${p.path}`}
                onClick={() => removeProjectCap(p.path)}
              >
                <Trash2 size={14} aria-hidden />
              </button>
            </li>
          ))}
        </ul>
      )}

      <form className="tp__form" onSubmit={addProjectCap}>
        <input
          aria-label="project path"
          placeholder="Project path (repo root) for a per-project cap"
          value={projPath}
          onChange={(e) => setProjPath(e.currentTarget.value)}
        />
        <input
          aria-label="project cap"
          type="number"
          min="0"
          step="0.5"
          placeholder="Cap (credits)"
          value={projCap}
          onChange={(e) => setProjCap(e.currentTarget.value)}
        />
        <button type="submit" disabled={!projPath.trim() || !projCap.trim()}>
          Add project cap
        </button>
      </form>

      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
    </div>
  );
}
