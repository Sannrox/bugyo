import { useEffect, useState } from "react";
import type { Project } from "./lib/bindings";
import { useFleet } from "./lib/fleetStore";
import { projectUpdate } from "./lib/ipc";

/** Durable setup/check commands reused by every new workspace in a project. */
export default function ProjectDefaults() {
  const projects = useFleet((state) => state.projects);
  const updateProject = useFleet((state) => state.updateProject);

  if (projects.length === 0) return null;

  return (
    <div className="settings__group project-defaults">
      <div className="settings__label">
        <span>Project workspace defaults</span>
        <span className="muted">
          Reuse the right base branch, setup, and verification commands for new
          tasks.
        </span>
      </div>
      {projects.map((project) => (
        <ProjectDefaultsRow
          key={project.path}
          project={project}
          onSaved={updateProject}
        />
      ))}
    </div>
  );
}

function ProjectDefaultsRow({
  project,
  onSaved,
}: {
  project: Project;
  onSaved: (project: Project) => void;
}) {
  const [baseBranch, setBaseBranch] = useState(project.baseBranch);
  const [setupScript, setSetupScript] = useState(project.setupScript);
  const [checkScript, setCheckScript] = useState(project.checkScript);
  const [status, setStatus] = useState<"idle" | "saving" | "saved">("idle");
  const [error, setError] = useState("");
  const dirty =
    baseBranch.trim() !== project.baseBranch ||
    setupScript.trim() !== project.setupScript ||
    checkScript.trim() !== project.checkScript;

  useEffect(() => {
    setBaseBranch(project.baseBranch);
    setSetupScript(project.setupScript);
    setCheckScript(project.checkScript);
  }, [project]);

  async function save(event: React.FormEvent) {
    event.preventDefault();
    try {
      setStatus("saving");
      setError("");
      const updated = await projectUpdate({
        ...project,
        baseBranch: baseBranch.trim() || "main",
        setupScript: setupScript.trim(),
        checkScript: checkScript.trim(),
      });
      onSaved(updated);
      setStatus("saved");
    } catch (cause) {
      setStatus("idle");
      setError(String(cause));
    }
  }

  return (
    <form className="project-defaults__project" onSubmit={save}>
      <div className="project-defaults__head">
        <div>
          <strong>{project.name}</strong>
          <code>{project.path}</code>
        </div>
        <button type="submit" disabled={status === "saving" || !dirty}>
          {status === "saving"
            ? "Saving…"
            : status === "saved"
              ? "Saved"
              : "Save defaults"}
        </button>
      </div>
      <label>
        <span>Base branch</span>
        <input
          aria-label={`${project.name} base branch`}
          value={baseBranch}
          disabled={status === "saving"}
          onChange={(event) => {
            setBaseBranch(event.currentTarget.value);
            setStatus("idle");
          }}
          placeholder="main"
        />
      </label>
      <label>
        <span>Setup command</span>
        <textarea
          aria-label={`${project.name} setup command`}
          value={setupScript}
          disabled={status === "saving"}
          onChange={(event) => {
            setSetupScript(event.currentTarget.value);
            setStatus("idle");
          }}
          placeholder="e.g. bun install"
        />
      </label>
      <label>
        <span>Check command</span>
        <textarea
          aria-label={`${project.name} check command`}
          value={checkScript}
          disabled={status === "saving"}
          onChange={(event) => {
            setCheckScript(event.currentTarget.value);
            setStatus("idle");
          }}
          placeholder="e.g. cargo test && bun run test"
        />
      </label>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}
