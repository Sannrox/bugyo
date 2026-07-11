import { useEffect, useState } from "react";
import { CircleDollarSign, Trash2 } from "lucide-react";
import type { BudgetConfig, ProjectCap } from "./lib/bindings";
import { budgetGet, budgetSet, confirmDialog, messageDialog } from "./lib/ipc";
import { useBudget } from "./lib/budgetStore";
import { useFleet } from "./lib/fleetStore";

/** Manage credit caps: a default per-session cap plus per-project overrides.
 * Sessions at/over their cap stop auto-dispatching (enforced in the backend). */
export default function BudgetSettings() {
  const config = useBudget((s) => s.config);
  const setConfig = useBudget((s) => s.setConfig);
  const [sessionCap, setSessionCap] = useState("");
  const [projPath, setProjPath] = useState("");
  const [projCap, setProjCap] = useState("");
  const [error, setError] = useState("");
  const [status, setStatus] = useState<"idle" | "saving" | "saved">("idle");
  const projects = useFleet((state) => state.projects);
  const parsedProjectCap = Number.parseFloat(projCap);
  const projectCapValid =
    Boolean(projPath) &&
    Number.isFinite(parsedProjectCap) &&
    parsedProjectCap > 0;
  const parsedSessionCap = Number.parseFloat(sessionCap);
  const sessionCapValid =
    sessionCap.trim() === "" ||
    (Number.isFinite(parsedSessionCap) && parsedSessionCap > 0);

  useEffect(() => {
    budgetGet()
      .then((c) => {
        setConfig(c);
        setSessionCap(c.sessionCap != null ? String(c.sessionCap) : "");
      })
      .catch((e) => setError(String(e)));
  }, [setConfig]);

  async function persist(next: BudgetConfig): Promise<boolean> {
    try {
      setStatus("saving");
      setError("");
      await budgetSet(next);
      setConfig(next);
      setStatus("saved");
      return true;
    } catch (e) {
      setStatus("idle");
      setError(String(e));
      await messageDialog(String(e));
      return false;
    }
  }

  function commitSessionCap() {
    if (!sessionCapValid) return;
    const n = parseFloat(sessionCap);
    void persist({
      ...config,
      sessionCap: Number.isFinite(n) && n > 0 ? n : null,
    });
  }

  async function addProjectCap(e: React.FormEvent) {
    e.preventDefault();
    const n = parseFloat(projCap);
    if (!projPath.trim() || !(Number.isFinite(n) && n > 0)) return;
    const projectCaps: ProjectCap[] = [
      ...config.projectCaps.filter((p) => p.path !== projPath.trim()),
      { path: projPath.trim(), cap: n },
    ];
    if (await persist({ ...config, projectCaps })) {
      setProjPath("");
      setProjCap("");
    }
  }

  async function removeProjectCap(path: string) {
    const ok = await confirmDialog(
      `Remove the credit cap for ${path}? Future automatic work will use the default cap instead.`,
      "Remove project cap",
    );
    if (!ok) return;
    await persist({
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
          onChange={(e) => {
            setSessionCap(e.currentTarget.value);
            setStatus("idle");
          }}
          onBlur={commitSessionCap}
        />
        <span className="budget__save-state" role="status">
          {status === "saving" ? "Saving…" : status === "saved" ? "Saved" : ""}
        </span>
      </div>

      {!sessionCapValid && (
        <p className="budget__guidance" role="status">
          Enter a positive credit cap, or leave the field blank for unlimited.
        </p>
      )}

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
                onClick={() => void removeProjectCap(p.path)}
              >
                <Trash2 size={14} aria-hidden />
              </button>
            </li>
          ))}
        </ul>
      )}

      <form className="tp__form" onSubmit={addProjectCap}>
        <select
          aria-label="project path"
          value={projPath}
          onChange={(e) => {
            setProjPath(e.currentTarget.value);
            setStatus("idle");
          }}
          disabled={projects.length === 0}
        >
          <option value="">
            {projects.length === 0
              ? "Add a project before setting an override"
              : "Select a project…"}
          </option>
          {projects.map((project) => (
            <option key={project.path} value={project.path}>
              {project.name}
            </option>
          ))}
        </select>
        <input
          aria-label="project cap"
          type="number"
          min="0"
          step="0.5"
          placeholder="Cap (credits)"
          value={projCap}
          onChange={(e) => {
            setProjCap(e.currentTarget.value);
            setStatus("idle");
          }}
        />
        <button
          type="submit"
          disabled={status === "saving" || !projectCapValid}
        >
          {status === "saving" ? "Saving…" : "Add project cap"}
        </button>
      </form>

      {projCap && !projectCapValid && (
        <p className="budget__guidance" role="status">
          Enter a positive credit cap and choose a registered project.
        </p>
      )}

      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
    </div>
  );
}
