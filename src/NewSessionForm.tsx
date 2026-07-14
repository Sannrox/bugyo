import { useEffect, useRef, useState } from "react";
import {
  ArrowUp,
  ChevronDown,
  Folder,
  GitBranch,
  Plus,
  ShieldCheck,
  SquareTerminal,
} from "lucide-react";
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
  const submitting = useRef(false);
  const profileRequest = useRef(0);

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
    const request = ++profileRequest.current;
    setProfileId(id);
    if (!id) return;
    try {
      const tools = await trustProfileEffectiveTools(id);
      if (request === profileRequest.current) {
        setTrustTools(tools.join(", "));
      }
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
  const [mode, setMode] = useState<"workspace" | "plain">("workspace");

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

  useEffect(() => {
    if (repoRoot || mode !== "workspace") return;
    const gitProjects = projects.filter((project) => project.isGitRepo);
    if (gitProjects.length === 1) setRepoRoot(gitProjects[0].path);
  }, [mode, projects, repoRoot]);

  useEffect(() => {
    if (mode !== "workspace" || !selectedProject) return;
    setBaseBranch(selectedProject.baseBranch || "main");
    setSetupScript(selectedProject.setupScript || "");
  }, [mode, selectedProject]);

  async function submit() {
    if (submitting.current) return;
    submitting.current = true;
    try {
      if (mode === "workspace") {
        await createWorkspace();
      } else {
        await startPlain();
      }
    } finally {
      submitting.current = false;
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
        trustAll: false,
        trustTools: trustToolsList(),
        agent: agent.trim() || undefined,
        model: model.trim() || undefined,
      });
      addSession({
        sessionId: result.sessionId,
        workspace: result.workspace,
      });
      setTask("");
      setSetupScript(selectedProject?.setupScript || "");
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
        trustAll: false,
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
      <div className="composer__eyebrow">NEW TASK</div>
      <h1
        className="composer__title"
        aria-label="What should the fleet work on?"
      >
        What do you want to build?
      </h1>
      <p className="composer__subtitle muted">
        Describe the outcome. Bugyo isolates the work, keeps the agent visible,
        and brings changes back here for review.
      </p>

      <form
        className="composer__card"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        {mode === "workspace" && (
          <label className="composer__field composer__field--task">
            <span className="sr-only">Task</span>
            <textarea
              className="composer__task"
              aria-label="task"
              placeholder="Describe a task, feature, or fix…"
              value={task}
              onChange={(e) => setTask(e.currentTarget.value)}
              required
              autoFocus
              rows={4}
            />
          </label>
        )}

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
                  : "Add your first project →"}
              </option>
              {projects.map((p) => (
                <option key={p.path} value={p.path}>
                  {p.name}
                  {p.isGitRepo ? "" : "  (no git)"}
                </option>
              ))}
            </select>
          </span>
          {projects.length === 0 && (
            <button
              type="button"
              className="chip chip--btn"
              onClick={() => void addProjectFlow()}
              title="Add a project (repository)"
            >
              <Plus size={14} aria-hidden /> Add project
            </button>
          )}
          <button
            type="submit"
            className="composer__send"
            aria-label={
              mode === "workspace" ? "Create workspace" : "Start plain session"
            }
            disabled={
              busy || (mode === "workspace" && (!isGitProject || !task.trim()))
            }
          >
            {busy ? (
              <span className="composer__spinner" aria-label="Starting" />
            ) : (
              <ArrowUp size={18} aria-hidden />
            )}
          </button>
        </div>

        {mode === "workspace" && (
          <div className="composer__safety">
            <ShieldCheck size={15} aria-hidden />
            <span>
              Your main checkout stays untouched. Tool calls still ask for
              approval by default.
            </span>
          </div>
        )}
        {mode === "plain" && (
          <p className="composer__plain-warning" role="note">
            Plain sessions do not create a worktree. The agent operates directly
            in the selected directory.
          </p>
        )}

        <details className="composer__more">
          <summary className="muted">
            <span>Advanced</span>
            <span className="composer__mode-label">
              {mode === "workspace" ? "Isolated workspace" : "Plain session"}
            </span>
            <ChevronDown size={14} aria-hidden />
          </summary>
          <div className="composer__advanced">
            <div
              className="composer__mode"
              role="group"
              aria-label="session type"
            >
              <button
                type="button"
                className={
                  mode === "workspace"
                    ? "composer__mode-btn composer__mode-btn--active"
                    : "composer__mode-btn"
                }
                aria-pressed={mode === "workspace"}
                onClick={() => setMode("workspace")}
              >
                <GitBranch size={16} aria-hidden />
                <span>
                  <strong>Isolated workspace</strong>
                  <small>Recommended · new worktree and branch</small>
                </span>
              </button>
              <button
                type="button"
                className={
                  mode === "plain"
                    ? "composer__mode-btn composer__mode-btn--active"
                    : "composer__mode-btn"
                }
                aria-pressed={mode === "plain"}
                onClick={() => {
                  setMode("plain");
                  setRepoRoot("");
                }}
              >
                <SquareTerminal size={16} aria-hidden />
                <span>
                  <strong>Plain session</strong>
                  <small>Advanced · works in an existing directory</small>
                </span>
              </button>
            </div>
            {mode === "workspace" && (
              <label className="composer__field">
                <span>Base branch</span>
                <input
                  aria-label="base branch"
                  placeholder="main"
                  value={baseBranch}
                  onChange={(e) => setBaseBranch(e.currentTarget.value)}
                />
              </label>
            )}
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
              placeholder="Trust non-destructive tools (comma-separated, optional)"
              value={trustTools}
              onChange={(e) => setTrustTools(e.currentTarget.value)}
            />
            <p className="composer__safety-note muted">
              Writes, shell execution, and cloud actions always ask for
              approval.
            </p>
          </div>
        </details>
      </form>

      <p className="composer__hint muted">
        {mode === "workspace"
          ? selectedProject
            ? "Ready to create an isolated workspace for this project."
            : "Choose a git project to continue."
          : selectedProject
            ? `The session will run directly in ${selectedProject.name}.`
            : "Choose a project, or leave it empty to use Bugyo's current directory."}
      </p>

      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
    </div>
  );
}
