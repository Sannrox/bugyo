import { useEffect, useRef, useState } from "react";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { Play, Plus, Trash2, Zap } from "lucide-react";
import {
  automationList,
  confirmDialog,
  onTriggerRun,
  triggerCreate,
  triggerList,
  triggerRemove,
  triggerRunNow,
  triggerUpdate,
} from "./lib/ipc";
import type {
  Automation,
  AutomationTarget,
  FanoutMode,
  HttpHeader,
  OutputFormat,
  Schedule,
  Trigger,
  TriggerAction,
  TriggerRun,
  TriggerSource,
  TrustMode,
} from "./lib/bindings";
import { useFleet } from "./lib/fleetStore";

/** Human summary of a schedule (for the list rows). */
function scheduleLabel(s: Schedule): string {
  return s.type === "intervalSecs" ? `every ${s.secs}s` : `cron: ${s.expr}`;
}

/** Human summary of a detector source. */
function sourceLabel(s: TriggerSource): string {
  return s.type === "command"
    ? `${`command: ${s.program} ${s.args.join(" ")}`.trim()} · ${s.cwd ?? "workspace not set"}`
    : `GET ${s.url}`;
}

/** Human summary of a trigger action. */
function actionLabel(a: TriggerAction): string {
  return a.type === "automation"
    ? `automation ${a.automationId}`
    : "inline action";
}

/** Triggers panel: manage event-driven pollers that fire on new items. */
export default function Triggers() {
  const [items, setItems] = useState<Trigger[]>([]);
  const [runs, setRuns] = useState<TriggerRun[]>([]);
  const [editing, setEditing] = useState<Trigger | "new" | null>(null);
  const [error, setError] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [action, setAction] = useState("");
  const sessions = useFleet((state) => state.sessions);
  const setActive = useFleet((state) => state.setActive);

  async function refresh() {
    try {
      setError("");
      setItems(await triggerList());
    } catch (e) {
      setError(String(e));
    } finally {
      setLoaded(true);
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  // Live run history from the trigger event stream.
  useEffect(() => {
    let active = true;
    let unlisten: UnlistenFn | undefined;
    onTriggerRun((run) => setRuns((r) => [run, ...r].slice(0, 50)))
      .then((fn) => {
        if (active) unlisten = fn;
        else fn();
      })
      .catch((cause) => {
        if (active) setError(String(cause));
      });
    return () => {
      active = false;
      unlisten?.();
    };
  }, []);

  async function toggle(t: Trigger) {
    if (action) return;
    try {
      setAction(`toggle:${t.id}`);
      setError("");
      const updated = await triggerUpdate({ ...t, enabled: !t.enabled });
      setItems((xs) => xs.map((x) => (x.id === updated.id ? updated : x)));
    } catch (e) {
      setError(String(e));
    } finally {
      setAction("");
    }
  }

  async function remove(id: string) {
    if (action) return;
    const t = items.find((x) => x.id === id);
    const ok = await confirmDialog(
      `Delete trigger "${t?.name ?? id}"? This removes its detector, ` +
        "schedule, and dedup state and cannot be undone.",
      "Delete trigger",
    );
    if (!ok) return;
    try {
      setAction(`delete:${id}`);
      setError("");
      await triggerRemove(id);
      setItems((xs) => xs.filter((x) => x.id !== id));
    } catch (e) {
      setError(String(e));
    } finally {
      setAction("");
    }
  }

  async function runNow(id: string) {
    if (action) return;
    const trigger = items.find((item) => item.id === id);
    const ok = await confirmDialog(
      `Test and fire trigger "${trigger?.name ?? id}"? This polls the detector ` +
        "and dispatches every new match, which may spend tokens. Matches are not " +
        "consumed, so running it again can dispatch the same work again.",
      "Test & fire trigger",
    );
    if (!ok) return;
    try {
      setAction(`run:${id}`);
      setError("");
      await triggerRunNow(id);
    } catch (e) {
      setError(String(e));
    } finally {
      setAction("");
    }
  }

  return (
    <div className="automations">
      <header className="automations__head">
        <h1 className="automations__title">
          <Zap size={18} aria-hidden /> Triggers
        </h1>
        <button
          type="button"
          className="pane__action"
          onClick={() => setEditing("new")}
        >
          <Plus size={14} aria-hidden /> New trigger
        </button>
      </header>

      <p className="muted automations__intro">
        Event-driven pollers. A cheap, model-free detector (a command or an HTTP
        GET) is checked on a schedule; only genuinely-new items spend tokens by
        firing an action. Detection never runs the model — so watching costs
        nothing until something actually matches.
      </p>

      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}

      {editing && (
        <TriggerForm
          initial={editing === "new" ? null : editing}
          onCancel={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void refresh();
          }}
          onError={setError}
        />
      )}

      {!loaded ? (
        <p className="muted automations__empty" role="status">
          Loading triggers…
        </p>
      ) : items.length === 0 && !error ? (
        <p className="muted automations__empty">
          No triggers yet. Create one to fire a session when an external source
          changes.
        </p>
      ) : items.length > 0 ? (
        <ul className="automations__list">
          {items.map((t) => (
            <li key={t.id} className="automations__item">
              <label className="automations__toggle">
                <input
                  type="checkbox"
                  checked={t.enabled}
                  disabled={Boolean(action)}
                  onChange={() => void toggle(t)}
                  aria-label={`enable ${t.name}`}
                />
              </label>
              <div className="automations__meta">
                <span className="automations__name">{t.name}</span>
                <span className="muted automations__sub">
                  {scheduleLabel(t.schedule)} · {sourceLabel(t.source)} ·{" "}
                  {actionLabel(t.action)} · {t.mode}
                  {t.lastRun
                    ? ` · last ${t.lastRun.slice(11, 19)}`
                    : " · never polled"}
                </span>
              </div>
              <button
                type="button"
                className="pane__action"
                onClick={() => void runNow(t.id)}
                aria-label={`test and fire ${t.name}`}
                disabled={Boolean(action)}
              >
                <Play size={13} aria-hidden />
                {action === `run:${t.id}` ? "Running…" : "Test & fire"}
              </button>
              <button
                type="button"
                className="pane__action"
                onClick={() => setEditing(t)}
                aria-label={`edit ${t.name}`}
                disabled={Boolean(action)}
              >
                Edit
              </button>
              <button
                type="button"
                className="pane__action"
                onClick={() => void remove(t.id)}
                aria-label={`delete ${t.name}`}
                disabled={Boolean(action)}
              >
                {action === `delete:${t.id}` ? (
                  "Deleting…"
                ) : (
                  <Trash2 size={13} aria-hidden />
                )}
              </button>
            </li>
          ))}
        </ul>
      ) : null}

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
                <span className="muted">{r.matched} item(s)</span>
                {r.sessionId && (
                  <button
                    type="button"
                    className="automations__runsess"
                    onClick={() => setActive(r.sessionId!)}
                    disabled={!sessions[r.sessionId]}
                    title={
                      sessions[r.sessionId]
                        ? "Open target session"
                        : "Session is no longer available"
                    }
                  >
                    {sessions[r.sessionId]?.name ||
                      sessions[r.sessionId]?.workspace?.task ||
                      sessions[r.sessionId]?.workspace?.branch ||
                      r.sessionId.slice(0, 8)}
                  </button>
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
type SourceKind = TriggerSource["type"];
type ActionKind = TriggerAction["type"];
type TargetKind = AutomationTarget["type"];
type TrustKind = Exclude<TrustMode["type"], "trustAll">;

/** Split a newline-separated textarea into trimmed, non-empty tokens. */
function splitLines(text: string): string[] {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

/** Parse `Name: value` lines into HTTP headers. */
function parseHeaders(text: string): HttpHeader[] {
  return splitLines(text)
    .map((line) => {
      const idx = line.indexOf(":");
      if (idx < 0) return null;
      return {
        name: line.slice(0, idx).trim(),
        value: line.slice(idx + 1).trim(),
      };
    })
    .filter((h): h is HttpHeader => h !== null && h.name.length > 0);
}

/** Create/edit form for a single trigger. */
function TriggerForm({
  initial,
  onCancel,
  onSaved,
  onError,
}: {
  initial: Trigger | null;
  onCancel: () => void;
  onSaved: () => void;
  onError: (msg: string) => void;
}) {
  const projects = useFleet((s) => s.projects);
  const submitting = useRef(false);
  const sessionOrder = useFleet((s) => s.order);
  const sessions = useFleet((s) => s.sessions);
  const gitProjects = projects.filter((p) => p.isGitRepo);

  const [automations, setAutomations] = useState<Automation[]>([]);
  useEffect(() => {
    automationList()
      .then(setAutomations)
      .catch(() => setAutomations([]));
  }, []);

  const [name, setName] = useState(initial?.name ?? "");
  const [busy, setBusy] = useState(false);

  // Source.
  const [sourceKind, setSourceKind] = useState<SourceKind>(
    initial?.source.type ?? "command",
  );
  const [program, setProgram] = useState(
    initial?.source.type === "command" ? initial.source.program : "gh",
  );
  const [args, setArgs] = useState(
    initial?.source.type === "command" ? initial.source.args.join("\n") : "",
  );
  const [detectorCwd, setDetectorCwd] = useState(
    initial?.source.type === "command"
      ? (initial.source.cwd ?? "")
      : (gitProjects[0]?.path ?? ""),
  );
  const [url, setUrl] = useState(
    initial?.source.type === "httpGet" ? initial.source.url : "",
  );
  const [headers, setHeaders] = useState(
    initial?.source.type === "httpGet"
      ? initial.source.headers.map((h) => `${h.name}: ${h.value}`).join("\n")
      : "",
  );

  const [outputFormat, setOutputFormat] = useState<OutputFormat>(
    initial?.outputFormat ?? "json",
  );

  // Schedule.
  const [scheduleKind, setScheduleKind] = useState<ScheduleKind>(
    initial?.schedule.type === "cron" ? "cron" : "interval",
  );
  const [intervalSecs, setIntervalSecs] = useState(
    initial?.schedule.type === "intervalSecs" ? initial.schedule.secs : 300,
  );
  const [cronExpr, setCronExpr] = useState(
    initial?.schedule.type === "cron" ? initial.schedule.expr : "*/5 * * * *",
  );

  // Fan-out + cap.
  const [mode, setMode] = useState<FanoutMode>(initial?.mode ?? "fanOut");
  const [maxRuns, setMaxRuns] = useState(initial?.maxRunsPerTick ?? 5);

  // Action.
  const [actionKind, setActionKind] = useState<ActionKind>(
    initial?.action.type ?? "inline",
  );
  const [automationId, setAutomationId] = useState(
    initial?.action.type === "automation" ? initial.action.automationId : "",
  );
  const [prompt, setPrompt] = useState(
    initial?.action.type === "inline" ? initial.action.prompt : "",
  );
  const inlineTarget =
    initial?.action.type === "inline" ? initial.action.target : null;

  // Inline target.
  const [targetKind, setTargetKind] = useState<TargetKind>(
    inlineTarget?.type ?? "newWorkspace",
  );
  const [sessionId, setSessionId] = useState(
    inlineTarget?.type === "existingSession"
      ? inlineTarget.sessionId
      : (sessionOrder[0] ?? ""),
  );
  const [cwd, setCwd] = useState(
    inlineTarget?.type === "newSession" ? (inlineTarget.cwd ?? "") : "",
  );
  const [projectPath, setProjectPath] = useState(
    inlineTarget?.type === "newWorkspace"
      ? inlineTarget.projectPath
      : (gitProjects[0]?.path ?? ""),
  );
  const [baseBranch, setBaseBranch] = useState(
    inlineTarget?.type === "newWorkspace" ? inlineTarget.baseBranch : "main",
  );

  // Inline trust.
  const [trustKind, setTrustKind] = useState<TrustKind>(
    inlineTarget && initial?.action.type === "inline"
      ? initial.action.trust.type === "trustTools"
        ? "trustTools"
        : "ask"
      : "ask",
  );
  const [trustTools, setTrustTools] = useState(
    initial?.action.type === "inline" &&
      initial.action.trust.type === "trustTools"
      ? initial.action.trust.tools.join(", ")
      : "",
  );

  function buildSource(): TriggerSource {
    if (sourceKind === "command") {
      return {
        type: "command",
        program: program.trim(),
        args: splitLines(args),
        cwd: detectorCwd.trim() || null,
      };
    }
    return { type: "httpGet", url: url.trim(), headers: parseHeaders(headers) };
  }

  function buildSchedule(): Schedule {
    return scheduleKind === "interval"
      ? { type: "intervalSecs", secs: Math.max(1, Math.floor(intervalSecs)) }
      : { type: "cron", expr: cronExpr.trim() };
  }

  function buildTrust(): TrustMode {
    return trustKind === "trustTools"
      ? {
          type: "trustTools",
          tools: trustTools
            .split(",")
            .map((t) => t.trim())
            .filter(Boolean),
        }
      : { type: "ask" };
  }

  function buildTarget(): AutomationTarget {
    switch (targetKind) {
      case "existingSession":
        return { type: "existingSession", sessionId };
      case "newSession":
        return {
          type: "newSession",
          cwd: cwd.trim() || null,
          agent: null,
          model: null,
        };
      case "newWorkspace":
        return {
          type: "newWorkspace",
          projectPath,
          baseBranch: baseBranch.trim() || "main",
          branchPrefix: null,
          agent: null,
          model: null,
        };
    }
  }

  function buildAction(): TriggerAction {
    return actionKind === "automation"
      ? { type: "automation", automationId }
      : {
          type: "inline",
          prompt: prompt.trim(),
          target: buildTarget(),
          trust: buildTrust(),
        };
  }

  const sourceReady =
    (sourceKind === "command" &&
      Boolean(program.trim()) &&
      Boolean(detectorCwd.trim())) ||
    (sourceKind === "httpGet" && Boolean(url.trim()));
  const targetReady =
    (targetKind === "existingSession" && Boolean(sessionId)) ||
    targetKind === "newSession" ||
    (targetKind === "newWorkspace" && Boolean(projectPath));
  const actionReady =
    actionKind === "automation"
      ? Boolean(automationId)
      : Boolean(prompt.trim()) && targetReady;
  const canSubmit =
    Boolean(name.trim()) &&
    sourceReady &&
    actionReady &&
    (scheduleKind !== "cron" || Boolean(cronExpr.trim()));

  async function submit() {
    if (submitting.current) return;
    submitting.current = true;
    try {
      setBusy(true);
      const trigger: Trigger = {
        id: initial?.id ?? "",
        name: name.trim() || "Untitled trigger",
        enabled: initial?.enabled ?? true,
        source: buildSource(),
        outputFormat,
        schedule: buildSchedule(),
        action: buildAction(),
        mode,
        maxRunsPerTick: Math.max(1, Math.floor(maxRuns)),
        dedup: initial?.dedup ?? { watermark: null, seen: [] },
        lastRun: initial?.lastRun ?? null,
        created: initial?.created ?? "",
      };
      if (initial) await triggerUpdate(trigger);
      else await triggerCreate(trigger);
      onSaved();
    } catch (e) {
      onError(String(e));
    } finally {
      submitting.current = false;
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
      <div className="automations__formhead">
        <div>
          <strong>{initial ? "Edit trigger" : "Create trigger"}</strong>
        </div>
        <div className="automations__formhead-actions">
          <button
            type="submit"
            className="composer__send"
            disabled={busy || !canSubmit}
          >
            {busy ? "…" : initial ? "Save" : "Create"}
          </button>
          <button type="button" className="pane__action" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </div>

      <label className="automations__field">
        <span>Name</span>
        <input
          aria-label="trigger name"
          placeholder="e.g. New PRs on my-repo"
          value={name}
          onChange={(e) => setName(e.currentTarget.value)}
          required
        />
      </label>

      <div className="automations__section-label">
        <span>1</span> Detector
      </div>
      <div className="ws-form__row">
        <label className="chip">
          Source
          <select
            aria-label="source kind"
            value={sourceKind}
            onChange={(e) => setSourceKind(e.currentTarget.value as SourceKind)}
          >
            <option value="command">Command</option>
            <option value="httpGet">HTTP GET</option>
          </select>
        </label>
        <label className="chip">
          Format
          <select
            aria-label="output format"
            value={outputFormat}
            onChange={(e) =>
              setOutputFormat(e.currentTarget.value as OutputFormat)
            }
          >
            <option value="json">JSON</option>
            <option value="lines">Lines</option>
          </select>
        </label>
      </div>

      {sourceKind === "command" ? (
        <>
          <label className="automations__field">
            <span>Program</span>
            <input
              aria-label="program"
              placeholder="e.g. gh"
              value={program}
              onChange={(e) => setProgram(e.currentTarget.value)}
            />
          </label>
          <label className="automations__field">
            <span>Arguments (one per line)</span>
            <textarea
              aria-label="arguments"
              placeholder={"pr\nlist\n--json\nnumber,title,url,updatedAt"}
              value={args}
              onChange={(e) => setArgs(e.currentTarget.value)}
            />
          </label>
          <label className="automations__field">
            <span>Detector working directory</span>
            <input
              aria-label="detector working directory"
              list="trigger-detector-workspaces"
              placeholder="Absolute path to the workspace"
              value={detectorCwd}
              onChange={(e) => setDetectorCwd(e.currentTarget.value)}
            />
            <datalist id="trigger-detector-workspaces">
              {projects.map((project) => (
                <option key={project.path} value={project.path}>
                  {project.name}
                </option>
              ))}
            </datalist>
          </label>
          <p className="automations__guidance">
            ⚠ The command runs in this directory on your machine with your
            permissions. Its output is treated as untrusted data and injected
            into the prompt as clearly delimited context, never as instructions.
          </p>
        </>
      ) : (
        <>
          <label className="automations__field">
            <span>URL</span>
            <input
              aria-label="url"
              placeholder="https://api.github.com/repos/owner/name/pulls"
              value={url}
              onChange={(e) => setUrl(e.currentTarget.value)}
            />
          </label>
          <label className="automations__field">
            <span>Headers (one “Name: value” per line)</span>
            <textarea
              aria-label="headers"
              placeholder={"Authorization: Bearer ${GITHUB_TOKEN}"}
              value={headers}
              onChange={(e) => setHeaders(e.currentTarget.value)}
            />
          </label>
          <p className="automations__guidance">
            Use <code>{"${ENV_VAR}"}</code> in a header value to reference a
            secret from the environment — it is resolved at poll time and never
            stored.
          </p>
        </>
      )}

      <div className="automations__section-label">
        <span>2</span> Poll schedule
      </div>
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
            placeholder="e.g. */5 * * * *"
            value={cronExpr}
            onChange={(e) => setCronExpr(e.currentTarget.value)}
          />
        )}
      </div>

      <div className="automations__section-label">
        <span>3</span> Action
      </div>
      <div className="ws-form__row">
        <label className="chip">
          On new items
          <select
            aria-label="action kind"
            value={actionKind}
            onChange={(e) => setActionKind(e.currentTarget.value as ActionKind)}
          >
            <option value="inline">Inline action</option>
            <option value="automation">Run an automation</option>
          </select>
        </label>
        <label className="chip">
          When several match
          <select
            aria-label="fanout mode"
            value={mode}
            onChange={(e) => setMode(e.currentTarget.value as FanoutMode)}
          >
            <option value="fanOut">One run per item</option>
            <option value="batch">One batched run</option>
          </select>
        </label>
        <label className="chip">
          Max runs / poll
          <input
            type="number"
            min={1}
            max={20}
            aria-label="max runs per tick"
            value={maxRuns}
            onChange={(e) => setMaxRuns(Number(e.currentTarget.value))}
          />
        </label>
      </div>

      {actionKind === "automation" ? (
        <label className="automations__field">
          <span>Automation</span>
          <select
            aria-label="automation"
            value={automationId}
            onChange={(e) => setAutomationId(e.currentTarget.value)}
          >
            <option value="">Select an automation…</option>
            {automations.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </label>
      ) : (
        <>
          <label className="automations__field">
            <span>Agent instructions</span>
            <textarea
              aria-label="inline prompt"
              placeholder="Describe what to do with each matched item…"
              value={prompt}
              onChange={(e) => setPrompt(e.currentTarget.value)}
            />
          </label>
          <div className="ws-form__row">
            <label className="chip">
              Target
              <select
                aria-label="target kind"
                value={targetKind}
                onChange={(e) =>
                  setTargetKind(e.currentTarget.value as TargetKind)
                }
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
                  const label =
                    s?.workspace?.task ||
                    s?.workspace?.branch ||
                    "Plain session";
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

          <div className="ws-form__row">
            <label className="chip">
              Trust
              <select
                aria-label="trust mode"
                value={trustKind}
                onChange={(e) =>
                  setTrustKind(e.currentTarget.value as TrustKind)
                }
              >
                <option value="ask">Ask (default)</option>
                <option value="trustTools">Trust specific tools</option>
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
        </>
      )}

      <p className="automations__guidance">
        Firing spends tokens; detection does not. Writes, shell execution, and
        cloud actions always require approval regardless of trust.
      </p>

      {!sourceReady && (
        <p role="status" className="automations__guidance">
          Configure a detector (program or URL) before saving.
        </p>
      )}
      {!actionReady && (
        <p role="status" className="automations__guidance">
          Choose a valid action before saving this trigger.
        </p>
      )}
    </form>
  );
}
