import { useEffect, useState } from "react";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { Clock, Play, Plus, Trash2 } from "lucide-react";
import {
  automationCreate,
  automationList,
  automationRemove,
  automationRunNow,
  automationUpdate,
  onAutomationRun,
} from "./lib/ipc";
import type {
  Automation,
  AutomationRun,
  AutomationTarget,
  Schedule,
  TrustMode,
} from "./lib/bindings";
import { useFleet } from "./lib/fleetStore";

/** Human summary of a schedule (for the list rows). */
function scheduleLabel(s: Schedule): string {
  return s.type === "intervalSecs" ? `every ${s.secs}s` : `cron: ${s.expr}`;
}

/** Human summary of a target (for the list rows). */
function targetLabel(t: AutomationTarget): string {
  switch (t.type) {
    case "existingSession":
      return `session ${t.sessionId.slice(0, 8)}`;
    case "newSession":
      return "new session";
    case "newWorkspace":
      return `new workspace in ${t.projectPath.split("/").filter(Boolean).pop() ?? t.projectPath}`;
  }
}

/** Automations panel: manage scheduled durable-prompt automations. */
export default function Automations() {
  const [items, setItems] = useState<Automation[]>([]);
  const [runs, setRuns] = useState<AutomationRun[]>([]);
  const [editing, setEditing] = useState<Automation | "new" | null>(null);
  const [error, setError] = useState("");

  async function refresh() {
    try {
      setItems(await automationList());
    } catch (e) {
      setError(String(e));
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  // Live run history from the automation event stream.
  useEffect(() => {
    let active = true;
    let unlisten: UnlistenFn | undefined;
    onAutomationRun((run) => setRuns((r) => [run, ...r].slice(0, 50))).then(
      (fn) => {
        if (active) unlisten = fn;
        else fn();
      },
    );
    return () => {
      active = false;
      unlisten?.();
    };
  }, []);

  async function toggle(a: Automation) {
    try {
      const updated = await automationUpdate({ ...a, enabled: !a.enabled });
      setItems((xs) => xs.map((x) => (x.id === updated.id ? updated : x)));
    } catch (e) {
      setError(String(e));
    }
  }

  async function remove(id: string) {
    try {
      await automationRemove(id);
      setItems((xs) => xs.filter((x) => x.id !== id));
    } catch (e) {
      setError(String(e));
    }
  }

  async function runNow(id: string) {
    try {
      const run = await automationRunNow(id);
      setRuns((r) => [run, ...r].slice(0, 50));
    } catch (e) {
      setError(String(e));
    }
  }

  return (
    <div className="automations">
      <header className="automations__head">
        <h1 className="automations__title">
          <Clock size={18} aria-hidden /> Automations
        </h1>
        <button
          type="button"
          className="pane__action"
          onClick={() => setEditing("new")}
        >
          <Plus size={14} aria-hidden /> New automation
        </button>
      </header>

      <p className="muted automations__intro">
        Scheduled tasks that deliver a durable prompt to a session on a timer.
        The agent acts through its normal tools; review results by opening the
        target session.
      </p>

      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}

      {editing && (
        <AutomationForm
          initial={editing === "new" ? null : editing}
          onCancel={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void refresh();
          }}
          onError={setError}
        />
      )}

      {items.length === 0 ? (
        <p className="muted automations__empty">
          No automations yet. Create one to run a task on a schedule.
        </p>
      ) : (
        <ul className="automations__list">
          {items.map((a) => (
            <li key={a.id} className="automations__item">
              <label className="automations__toggle">
                <input
                  type="checkbox"
                  checked={a.enabled}
                  onChange={() => void toggle(a)}
                  aria-label={`enable ${a.name}`}
                />
              </label>
              <div className="automations__meta">
                <span className="automations__name">{a.name}</span>
                <span className="muted automations__sub">
                  {scheduleLabel(a.schedule)} · {targetLabel(a.target)}
                  {a.trust.type === "trustAll" && " · ⚠ trust-all"}
                  {a.lastRun
                    ? ` · last ${a.lastRun.slice(11, 19)}`
                    : " · never run"}
                </span>
              </div>
              <button
                type="button"
                className="pane__action"
                onClick={() => void runNow(a.id)}
                aria-label={`run ${a.name} now`}
              >
                <Play size={13} aria-hidden /> Run now
              </button>
              <button
                type="button"
                className="pane__action"
                onClick={() => setEditing(a)}
                aria-label={`edit ${a.name}`}
              >
                Edit
              </button>
              <button
                type="button"
                className="pane__action"
                onClick={() => void remove(a.id)}
                aria-label={`delete ${a.name}`}
              >
                <Trash2 size={13} aria-hidden />
              </button>
            </li>
          ))}
        </ul>
      )}

      <section className="automations__history" aria-label="run history">
        <h2 className="automations__subtitle">Recent runs</h2>
        {runs.length === 0 ? (
          <p className="muted">No runs yet this session.</p>
        ) : (
          <ul className="automations__runs">
            {runs.map((r, i) => (
              <li key={`${r.ts}-${i}`} className="automations__run">
                <span className={`badge badge--${r.status}`}>{r.status}</span>
                <span className="muted">{r.ts.slice(11, 19)}</span>
                {r.sessionId && (
                  <span className="automations__runsess">
                    {r.sessionId.slice(0, 8)}
                  </span>
                )}
                {r.message && <span className="error">{r.message}</span>}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

type ScheduleKind = "interval" | "cron";
type TargetKind = AutomationTarget["type"];
type TrustKind = TrustMode["type"];

/** Create/edit form for a single automation. */
function AutomationForm({
  initial,
  onCancel,
  onSaved,
  onError,
}: {
  initial: Automation | null;
  onCancel: () => void;
  onSaved: () => void;
  onError: (msg: string) => void;
}) {
  const projects = useFleet((s) => s.projects);
  const sessionOrder = useFleet((s) => s.order);
  const sessions = useFleet((s) => s.sessions);
  const gitProjects = projects.filter((p) => p.isGitRepo);

  const [name, setName] = useState(initial?.name ?? "");
  const [prompt, setPrompt] = useState(initial?.prompt ?? "");
  const [busy, setBusy] = useState(false);

  const [scheduleKind, setScheduleKind] = useState<ScheduleKind>(
    initial?.schedule.type === "cron" ? "cron" : "interval",
  );
  const [intervalSecs, setIntervalSecs] = useState(
    initial?.schedule.type === "intervalSecs" ? initial.schedule.secs : 3600,
  );
  const [cronExpr, setCronExpr] = useState(
    initial?.schedule.type === "cron" ? initial.schedule.expr : "0 9 * * *",
  );

  const [targetKind, setTargetKind] = useState<TargetKind>(
    initial?.target.type ?? "existingSession",
  );
  const [sessionId, setSessionId] = useState(
    initial?.target.type === "existingSession"
      ? initial.target.sessionId
      : (sessionOrder[0] ?? ""),
  );
  const [cwd, setCwd] = useState(
    initial?.target.type === "newSession" ? (initial.target.cwd ?? "") : "",
  );
  const [projectPath, setProjectPath] = useState(
    initial?.target.type === "newWorkspace"
      ? initial.target.projectPath
      : (gitProjects[0]?.path ?? ""),
  );
  const [baseBranch, setBaseBranch] = useState(
    initial?.target.type === "newWorkspace"
      ? initial.target.baseBranch
      : "main",
  );
  const [agent, setAgent] = useState(
    (initial?.target.type === "newSession" ||
    initial?.target.type === "newWorkspace"
      ? initial.target.agent
      : "") ?? "",
  );
  const [model, setModel] = useState(
    (initial?.target.type === "newSession" ||
    initial?.target.type === "newWorkspace"
      ? initial.target.model
      : "") ?? "",
  );

  const [trustKind, setTrustKind] = useState<TrustKind>(
    initial?.trust.type ?? "ask",
  );
  const [trustTools, setTrustTools] = useState(
    initial?.trust.type === "trustTools" ? initial.trust.tools.join(", ") : "",
  );

  function buildSchedule(): Schedule {
    return scheduleKind === "interval"
      ? { type: "intervalSecs", secs: Math.max(1, Math.floor(intervalSecs)) }
      : { type: "cron", expr: cronExpr.trim() };
  }

  function buildTarget(): AutomationTarget {
    const a = agent.trim() || null;
    const m = model.trim() || null;
    switch (targetKind) {
      case "existingSession":
        return { type: "existingSession", sessionId };
      case "newSession":
        return {
          type: "newSession",
          cwd: cwd.trim() || null,
          agent: a,
          model: m,
        };
      case "newWorkspace":
        return {
          type: "newWorkspace",
          projectPath,
          baseBranch: baseBranch.trim() || "main",
          branchPrefix: null,
          agent: a,
          model: m,
        };
    }
  }

  function buildTrust(): TrustMode {
    switch (trustKind) {
      case "ask":
        return { type: "ask" };
      case "trustAll":
        return { type: "trustAll" };
      case "trustTools":
        return {
          type: "trustTools",
          tools: trustTools
            .split(",")
            .map((t) => t.trim())
            .filter(Boolean),
        };
    }
  }

  async function submit() {
    try {
      setBusy(true);
      const automation: Automation = {
        id: initial?.id ?? "",
        name: name.trim() || "Untitled automation",
        enabled: initial?.enabled ?? true,
        prompt: prompt.trim(),
        schedule: buildSchedule(),
        target: buildTarget(),
        trust: buildTrust(),
        lastRun: initial?.lastRun ?? null,
        created: initial?.created ?? "",
      };
      if (initial) await automationUpdate(automation);
      else await automationCreate(automation);
      onSaved();
    } catch (e) {
      onError(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      className="composer__card automations__form"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <input
        aria-label="automation name"
        placeholder="Name"
        value={name}
        onChange={(e) => setName(e.currentTarget.value)}
        required
      />
      <textarea
        aria-label="durable prompt"
        placeholder="Durable prompt — what the agent should do each time it runs"
        value={prompt}
        onChange={(e) => setPrompt(e.currentTarget.value)}
        required
      />

      <div className="ws-form__row">
        <label className="chip">
          Schedule
          <select
            aria-label="schedule kind"
            value={scheduleKind}
            onChange={(e) =>
              setScheduleKind(e.currentTarget.value as ScheduleKind)
            }
          >
            <option value="interval">Interval</option>
            <option value="cron">Cron</option>
          </select>
        </label>
        {scheduleKind === "interval" ? (
          <input
            type="number"
            min={1}
            aria-label="interval seconds"
            value={intervalSecs}
            onChange={(e) => setIntervalSecs(Number(e.currentTarget.value))}
          />
        ) : (
          <input
            aria-label="cron expression"
            placeholder="e.g. 0 9 * * *"
            value={cronExpr}
            onChange={(e) => setCronExpr(e.currentTarget.value)}
          />
        )}
      </div>

      <div className="ws-form__row">
        <label className="chip">
          Target
          <select
            aria-label="target kind"
            value={targetKind}
            onChange={(e) => setTargetKind(e.currentTarget.value as TargetKind)}
          >
            <option value="existingSession">Existing session</option>
            <option value="newSession">New session</option>
            <option value="newWorkspace">New workspace</option>
          </select>
        </label>

        {targetKind === "existingSession" && (
          <select
            aria-label="session"
            value={sessionId}
            onChange={(e) => setSessionId(e.currentTarget.value)}
          >
            <option value="">Select a session…</option>
            {sessionOrder.map((id) => {
              const s = sessions[id];
              const label = s?.workspace?.branch ?? "plain session";
              return (
                <option key={id} value={id}>
                  {label} ({id.slice(0, 8)})
                </option>
              );
            })}
          </select>
        )}

        {targetKind === "newSession" && (
          <input
            aria-label="working directory"
            placeholder="Working directory (optional)"
            value={cwd}
            onChange={(e) => setCwd(e.currentTarget.value)}
          />
        )}

        {targetKind === "newWorkspace" && (
          <>
            <select
              aria-label="project"
              value={projectPath}
              onChange={(e) => setProjectPath(e.currentTarget.value)}
            >
              <option value="">Select a git project…</option>
              {gitProjects.map((p) => (
                <option key={p.path} value={p.path}>
                  {p.name}
                </option>
              ))}
            </select>
            <input
              aria-label="base branch"
              placeholder="base branch"
              value={baseBranch}
              onChange={(e) => setBaseBranch(e.currentTarget.value)}
            />
          </>
        )}
      </div>

      {(targetKind === "newSession" || targetKind === "newWorkspace") && (
        <div className="ws-form__row">
          <input
            aria-label="agent"
            placeholder="Agent (optional)"
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
      )}

      <div className="ws-form__row">
        <label className="chip">
          Trust
          <select
            aria-label="trust mode"
            value={trustKind}
            onChange={(e) => setTrustKind(e.currentTarget.value as TrustKind)}
          >
            <option value="ask">Ask (default)</option>
            <option value="trustTools">Trust specific tools</option>
            <option value="trustAll">Trust all tools</option>
          </select>
        </label>
        {trustKind === "trustTools" && (
          <input
            aria-label="trust tools"
            placeholder="Comma-separated tool names"
            value={trustTools}
            onChange={(e) => setTrustTools(e.currentTarget.value)}
          />
        )}
      </div>

      {trustKind === "trustAll" && (
        <p role="alert" className="warn">
          ⚠ This automation will auto-approve every tool call — including writes
          and destructive actions — without asking, each time it runs.
        </p>
      )}

      <div className="automations__formactions">
        <button type="submit" className="composer__send" disabled={busy}>
          {busy ? "…" : initial ? "Save" : "Create"}
        </button>
        <button type="button" className="pane__action" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}
