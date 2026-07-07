import { useEffect, useState } from "react";
import { Folder, GitBranch, Plus } from "lucide-react";
import {
  acpStartSession,
  messageDialog,
  pickDirectory,
  projectAdd,
  trustProfileEffectiveTools,
  trustProfileList,
  workspaceCreate,
} from "./lib/ipc";
import { useFleet } from "./lib/fleetStore";
import type { TrustProfile } from "./lib/bindings";

/** Form to create a workspace-bound session (or a plain session). */
export default function NewSessionForm() {
  const addSession = useFleet((s) => s.addSession);
  const projects = useFleet((s) => s.projects);
  const addProjectToStore = useFleet((s) => s.addProject);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const [trustAll, setTrustAll] = useState(false);
  const [trustTools, setTrustTools] = useState("");
  // Trust-profile presets (loaded from the backend); picking one fills
  // trustTools with the profile's effective (destructive-stripped) tools.
  const [profiles, setProfiles] = useState<TrustProfile[]>([]);
  const [profileId, setProfileId] = useState("");

  useEffect(() => {
    trustProfileList()
      .then(setProfiles)
      .catch(() => {
        /* best-effort */
      });
  }, []);

  async function applyProfile(id: string) {
    setProfileId(id);
    if (!id) return;
    setTrustAll(false);
    try {
      const tools = await trustProfileEffectiveTools(id);
      setTrustTools(tools.join(", "));
    } catch {
      /* leave trustTools unchanged on error */
    }
  }

  const [repoRoot, setRepoRoot] = useState("");
  const [baseBranch, setBaseBranch] = useState("main");
  const [task, setTask] = useState("");
  const [setupScript, setSetupScript] = useState("");
  const [agent, setAgent] = useState("");
  const [model, setModel] = useState("");

  async function addProjectFlow() {
    try {
      setError("");
      const path = await pickDirectory("Select a repository");
      if (!path) return;
      const project = await projectAdd(path);
      addProjectToStore(project);
      setRepoRoot(project.path);
    } catch (e) {
      await messageDialog(String(e));
    }
  }

  function trustToolsList(): string[] {
    return trustTools
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
  }

  const selectedProject = projects.find((p) => p.path === repoRoot);
  const isGitProject = selectedProject?.isGitRepo ?? false;

  // Git project → create a worktree workspace; otherwise → plain session.
  async function submit() {
    if (isGitProject) {
      await createWorkspace();
    } else {
      await startPlain();
    }
  }

  async function createWorkspace() {
    try {
      setError("");
      setBusy(true);
      const result = await workspaceCreate({
        repoRoot: repoRoot.trim(),
        baseBranch: baseBranch.trim() || "main",
        task: task.trim(),
        setupScript: setupScript.trim() || undefined,
        trustAll,
        trustTools: trustToolsList(),
        agent: agent.trim() || undefined,
        model: model.trim() || undefined,
      });
      addSession({
        sessionId: result.sessionId,
        workspace: result.workspace,
      });
      setTask("");
      setSetupScript("");
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function startPlain() {
    try {
      setError("");
      setBusy(true);
      const id = await acpStartSession({
        cwd: repoRoot.trim() || undefined,
        trustAll,
        trustTools: trustToolsList(),
        agent: agent.trim() || undefined,
        model: model.trim() || undefined,
      });
      addSession({ sessionId: id, repoRoot: repoRoot.trim() || null });
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="composer">
      <h1 className="composer__title">What should Bugyo run?</h1>
      <p className="composer__subtitle muted">
        Create an isolated git-worktree workspace, or start a plain session.
      </p>

      <form
        className="composer__card"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <input
          className="composer__task"
          aria-label="task"
          placeholder="Task name (becomes the branch)…"
          value={task}
          onChange={(e) => setTask(e.currentTarget.value)}
          required={isGitProject}
        />

        <div className="composer__bar">
          <span className="chip chip--grow">
            <Folder size={14} aria-hidden />
            <select
              className="chip__input"
              aria-label="project"
              value={repoRoot}
              onChange={(e) => setRepoRoot(e.currentTarget.value)}
            >
              <option value="">
                {projects.length
                  ? "Select a project…"
                  : "No projects — add one →"}
              </option>
              {projects.map((p) => (
                <option key={p.path} value={p.path}>
                  {p.name}
                  {p.isGitRepo ? "" : "  (no git)"}
                </option>
              ))}
            </select>
          </span>
          <button
            type="button"
            className="chip chip--btn"
            onClick={() => void addProjectFlow()}
            title="Add a project (repository)"
          >
            <Plus size={14} aria-hidden /> Add project
          </button>
          {isGitProject && (
            <span className="chip chip--branch">
              <GitBranch size={14} aria-hidden />
              <input
                className="chip__input"
                aria-label="base branch"
                placeholder="base"
                value={baseBranch}
                onChange={(e) => setBaseBranch(e.currentTarget.value)}
              />
            </span>
          )}
          <label
            className="chip chip--toggle"
            title="Auto-approve all tool calls"
          >
            <input
              type="checkbox"
              checked={trustAll}
              onChange={(e) => setTrustAll(e.currentTarget.checked)}
            />
            Trust all
          </label>
          <button type="submit" className="composer__send" disabled={busy}>
            {busy ? "…" : isGitProject ? "Create workspace" : "Start session"}
          </button>
        </div>

        <details className="composer__more">
          <summary className="muted">Advanced</summary>
          <div className="composer__advanced">
            <div className="ws-form__row">
              <input
                aria-label="agent"
                placeholder="Agent (optional, e.g. orchestrator)"
                value={agent}
                onChange={(e) => setAgent(e.currentTarget.value)}
              />
              <input
                aria-label="model"
                placeholder="Model (optional)"
                value={model}
                onChange={(e) => setModel(e.currentTarget.value)}
              />
            </div>
            <textarea
              aria-label="setup script"
              placeholder="Optional setup script (sh)"
              value={setupScript}
              onChange={(e) => setSetupScript(e.currentTarget.value)}
            />
            {!trustAll && (
              <>
                {profiles.length > 0 && (
                  <select
                    aria-label="trust profile"
                    value={profileId}
                    onChange={(e) => void applyProfile(e.currentTarget.value)}
                  >
                    <option value="">Trust profile (optional)…</option>
                    {profiles.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                )}
                <input
                  aria-label="trust tools"
                  placeholder="Trust specific tools (comma-separated, optional)"
                  value={trustTools}
                  onChange={(e) => setTrustTools(e.currentTarget.value)}
                />
              </>
            )}
          </div>
        </details>

        {trustAll && (
          <p role="alert" className="warn">
            ⚠ The agent will run every tool — including writes and destructive
            actions — without asking.
          </p>
        )}
      </form>

      <p className="composer__hint muted">
        {isGitProject
          ? "Creates an isolated git worktree + branch and runs an agent there."
          : selectedProject
            ? "This project isn't a git repo — starts a plain session in its directory (no worktree)."
            : "Pick a project, or start a plain session in the current directory."}
      </p>

      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
    </div>
  );
}
