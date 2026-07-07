//! Bugyo's own configuration, stored under `~/.kiro/bugyo/`.
//!
//! Currently: the **projects registry** — a persisted list of repository paths.
//! A *project* is a repository path; a *workspace* is a git worktree within it.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::acp::protocol::ToolDiff;

/// Errors from config I/O.
#[derive(Debug, thiserror::Error)]
pub enum ConfigError {
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("json: {0}")]
    Json(#[from] serde_json::Error),
    #[error("path not found: {0}")]
    NotFound(String),
}

/// A registered project — a repository path plus a display name.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub path: String,
    pub name: String,
    /// Whether the path is a git repository (worktrees require this). Computed
    /// live on read, so it stays accurate.
    #[serde(default)]
    pub is_git_repo: bool,
}

/// Bugyo's config home: `$BUGYO_CONFIG_HOME`, else `~/.kiro/bugyo`.
pub fn config_home() -> PathBuf {
    if let Ok(dir) = std::env::var("BUGYO_CONFIG_HOME") {
        if !dir.is_empty() {
            return PathBuf::from(dir);
        }
    }
    let home = std::env::var("HOME").unwrap_or_else(|_| ".".to_string());
    PathBuf::from(home).join(".kiro").join("bugyo")
}

fn projects_file(home: &Path) -> PathBuf {
    home.join("projects.json")
}

/// Derive a display name from a repository path (its final component).
fn name_of(path: &Path) -> String {
    path.file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_string_lossy().into_owned())
}

/// Whether a path is a git repository (has a `.git` entry).
fn is_git_repo(path: &str) -> bool {
    Path::new(path).join(".git").exists()
}

/// Read the registered projects (sorted by name). Missing file → empty.
/// `is_git_repo` is recomputed on read so it stays accurate.
pub fn list_projects(home: &Path) -> Result<Vec<Project>, ConfigError> {
    let path = projects_file(home);
    if !path.exists() {
        return Ok(vec![]);
    }
    let contents = std::fs::read_to_string(path)?;
    let mut projects: Vec<Project> = serde_json::from_str(&contents).unwrap_or_default();
    for p in &mut projects {
        p.is_git_repo = is_git_repo(&p.path);
    }
    projects.sort_by_key(|p| p.name.to_lowercase());
    Ok(projects)
}

fn write_projects(home: &Path, projects: &[Project]) -> Result<(), ConfigError> {
    std::fs::create_dir_all(home)?;
    std::fs::write(projects_file(home), serde_json::to_string_pretty(projects)?)?;
    Ok(())
}

/// Register a project by repository path. A project is just a path — it does
/// **not** need to be a git repo (that's only required when creating a
/// *workspace* worktree). Validates the path exists; canonicalizes; dedupes.
pub fn add_project(home: &Path, repo_path: &str) -> Result<Project, ConfigError> {
    let p = PathBuf::from(repo_path);
    if !p.exists() {
        return Err(ConfigError::NotFound(repo_path.to_string()));
    }
    let canonical = std::fs::canonicalize(&p).unwrap_or(p);
    let path = canonical.to_string_lossy().into_owned();

    let mut projects = list_projects(home)?;
    if let Some(existing) = projects.iter().find(|pr| pr.path == path) {
        return Ok(existing.clone());
    }
    let project = Project {
        name: name_of(&canonical),
        is_git_repo: is_git_repo(&path),
        path,
    };
    projects.push(project.clone());
    write_projects(home, &projects)?;
    Ok(project)
}

/// Remove a project by path. No-op if absent.
pub fn remove_project(home: &Path, path: &str) -> Result<(), ConfigError> {
    let mut projects = list_projects(home)?;
    let before = projects.len();
    projects.retain(|p| p.path != path);
    if projects.len() != before {
        write_projects(home, &projects)?;
    }
    Ok(())
}

// ---- Persisted sessions ---------------------------------------------------

/// A persisted session descriptor — enough to list it and lazily resume it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PersistedSession {
    pub session_id: String,
    /// Working directory (project path or worktree path).
    pub repo: String,
    /// Worktree metadata, when this session is a workspace.
    #[serde(default)]
    pub workspace: Option<serde_json::Value>,
    /// Name for the worker/queue files.
    pub worker_name: String,
    /// Args to (re)spawn `kiro-cli acp`.
    pub args: Vec<String>,
    pub command: String,
    pub created: String,
    /// The automation that created this session, if any. Lets a recurring
    /// `NewSession`/`NewWorkspace` automation reuse its one session on later
    /// fires instead of creating a fresh worktree/process each time.
    #[serde(default)]
    pub automation_id: Option<String>,
}

fn sessions_file(home: &Path) -> PathBuf {
    home.join("sessions.json")
}

/// List persisted sessions (most-recent first by `created`).
pub fn list_sessions(home: &Path) -> Result<Vec<PersistedSession>, ConfigError> {
    let path = sessions_file(home);
    if !path.exists() {
        return Ok(vec![]);
    }
    let contents = std::fs::read_to_string(path)?;
    let mut sessions: Vec<PersistedSession> = serde_json::from_str(&contents).unwrap_or_default();
    sessions.sort_by(|a, b| b.created.cmp(&a.created));
    Ok(sessions)
}

/// Upsert a session (by `session_id`).
pub fn save_session(home: &Path, session: &PersistedSession) -> Result<(), ConfigError> {
    std::fs::create_dir_all(home)?;
    let mut sessions = list_sessions(home)?;
    if let Some(existing) = sessions
        .iter_mut()
        .find(|s| s.session_id == session.session_id)
    {
        *existing = session.clone();
    } else {
        sessions.push(session.clone());
    }
    std::fs::write(
        sessions_file(home),
        serde_json::to_string_pretty(&sessions)?,
    )?;
    Ok(())
}

/// Remove a persisted session by id. No-op if absent.
pub fn remove_session(home: &Path, session_id: &str) -> Result<(), ConfigError> {
    let mut sessions = list_sessions(home)?;
    let before = sessions.len();
    sessions.retain(|s| s.session_id != session_id);
    if sessions.len() != before {
        std::fs::write(
            sessions_file(home),
            serde_json::to_string_pretty(&sessions)?,
        )?;
    }
    Ok(())
}

// ---- Automations ----------------------------------------------------------

/// How often an automation fires. Serialized as a tagged union so the TS side
/// can discriminate on `type` (see `src/lib/bindings`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Schedule {
    /// Fire every `secs` seconds (measured from the last run).
    IntervalSecs { secs: u64 },
    /// Fire on a cron expression (evaluated in local time).
    Cron { expr: String },
}

/// What an automation acts on when it fires.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum AutomationTarget {
    /// Re-invoke an existing session by id (preserves its context).
    ExistingSession { session_id: String },
    /// Start a fresh plain session rooted at `cwd` (defaults to backend cwd).
    NewSession {
        #[serde(default)]
        cwd: Option<String>,
        #[serde(default)]
        agent: Option<String>,
        #[serde(default)]
        model: Option<String>,
    },
    /// Create a fresh workspace (git worktree + branch) in a project.
    NewWorkspace {
        project_path: String,
        base_branch: String,
        #[serde(default)]
        branch_prefix: Option<String>,
        #[serde(default)]
        agent: Option<String>,
        #[serde(default)]
        model: Option<String>,
    },
}

/// Per-automation trust. Default (`Ask`) keeps the human-in-the-loop approval
/// flow; the wider modes are explicit, warned opt-ins (see the safety model).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum TrustMode {
    /// No trust widening — every tool call requires an explicit decision.
    #[default]
    Ask,
    /// Pre-trust a scoped allowlist of tools (`--trust-tools`).
    TrustTools { tools: Vec<String> },
    /// Auto-approve all tool calls (`--trust-all-tools`). Elevated risk.
    TrustAll,
}

fn default_true() -> bool {
    true
}

/// A scheduled automation: a durable prompt delivered to a session (existing or
/// freshly created) on a timer. The agent acts through its normal ACP tools.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Automation {
    pub id: String,
    pub name: String,
    #[serde(default = "default_true")]
    pub enabled: bool,
    /// The durable prompt sent each time the automation fires.
    pub prompt: String,
    pub schedule: Schedule,
    pub target: AutomationTarget,
    #[serde(default)]
    pub trust: TrustMode,
    /// Timestamp of the last run (CLI `now_ts` format). `None` = never run.
    #[serde(default)]
    pub last_run: Option<String>,
    #[serde(default)]
    pub created: String,
}

/// One recorded automation run (surfaced in the UI's run history).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AutomationRun {
    pub ts: String,
    pub automation_id: String,
    /// The session the run dispatched to / created, when applicable.
    #[serde(default)]
    pub session_id: Option<String>,
    /// One of: `dispatched`, `created`, `skipped`, `error`.
    pub status: String,
    #[serde(default)]
    pub message: Option<String>,
}

fn automations_file(home: &Path) -> PathBuf {
    home.join("automations.json")
}

/// List persisted automations (in stored order). Missing file → empty.
pub fn list_automations(home: &Path) -> Result<Vec<Automation>, ConfigError> {
    let path = automations_file(home);
    if !path.exists() {
        return Ok(vec![]);
    }
    let contents = std::fs::read_to_string(path)?;
    Ok(serde_json::from_str(&contents).unwrap_or_default())
}

fn write_automations(home: &Path, automations: &[Automation]) -> Result<(), ConfigError> {
    std::fs::create_dir_all(home)?;
    std::fs::write(
        automations_file(home),
        serde_json::to_string_pretty(automations)?,
    )?;
    Ok(())
}

/// Upsert an automation (by `id`). Used for both create and update.
pub fn save_automation(home: &Path, automation: &Automation) -> Result<(), ConfigError> {
    let mut automations = list_automations(home)?;
    if let Some(existing) = automations.iter_mut().find(|a| a.id == automation.id) {
        *existing = automation.clone();
    } else {
        automations.push(automation.clone());
    }
    write_automations(home, &automations)?;
    Ok(())
}

/// Remove an automation by id. No-op if absent.
pub fn remove_automation(home: &Path, id: &str) -> Result<(), ConfigError> {
    let mut automations = list_automations(home)?;
    let before = automations.len();
    automations.retain(|a| a.id != id);
    if automations.len() != before {
        write_automations(home, &automations)?;
    }
    Ok(())
}

// ---- Session UI metadata (pin / custom name / manual order) ---------------

/// Durable, UI-facing metadata for a session: whether it's pinned, an optional
/// human-friendly name (overrides the branch/label), and a manual sort order.
/// Stored separately from the session descriptor so UI tweaks never touch the
/// resume-critical `sessions.json`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionMeta {
    pub session_id: String,
    #[serde(default)]
    pub pinned: bool,
    #[serde(default)]
    pub name: Option<String>,
    /// Lower sorts earlier within a group. `None` keeps natural order.
    #[serde(default)]
    pub order: Option<i64>,
}

fn session_meta_file(home: &Path) -> PathBuf {
    home.join("session-meta.json")
}

/// List all persisted session metadata. Missing file → empty.
pub fn list_session_meta(home: &Path) -> Result<Vec<SessionMeta>, ConfigError> {
    let path = session_meta_file(home);
    if !path.exists() {
        return Ok(vec![]);
    }
    let contents = std::fs::read_to_string(path)?;
    Ok(serde_json::from_str(&contents).unwrap_or_default())
}

/// Upsert metadata for a session (by `session_id`).
pub fn save_session_meta(home: &Path, meta: &SessionMeta) -> Result<(), ConfigError> {
    std::fs::create_dir_all(home)?;
    let mut all = list_session_meta(home)?;
    if let Some(existing) = all.iter_mut().find(|m| m.session_id == meta.session_id) {
        *existing = meta.clone();
    } else {
        all.push(meta.clone());
    }
    std::fs::write(session_meta_file(home), serde_json::to_string_pretty(&all)?)?;
    Ok(())
}

/// Remove metadata for a session by id. No-op if absent.
pub fn remove_session_meta(home: &Path, session_id: &str) -> Result<(), ConfigError> {
    let mut all = list_session_meta(home)?;
    let before = all.len();
    all.retain(|m| m.session_id != session_id);
    if all.len() != before {
        std::fs::write(session_meta_file(home), serde_json::to_string_pretty(&all)?)?;
    }
    Ok(())
}

// ---- Transcript restore (from kiro's persisted session store) -------------
/// A transcript entry, matching the TypeScript `TranscriptEntry` union.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum TranscriptEntry {
    User {
        text: String,
    },
    Agent {
        text: String,
    },
    Thought {
        text: String,
    },
    Tool {
        tool_call_id: String,
        title: String,
        status: Option<String>,
        diff: Option<ToolDiff>,
        output: Option<String>,
    },
    System {
        text: String,
    },
}

/// Whether a session id is safe to interpolate into a filesystem path. Session
/// ids are opaque tokens from the agent, but `session_transcript` is an
/// `invoke`-able command that accepts an arbitrary string, so we reject any id
/// that could traverse out of kiro's session store (path separators, `..`,
/// NUL) at this trust boundary.
fn is_safe_session_id(id: &str) -> bool {
    !id.is_empty()
        && !id.contains('/')
        && !id.contains('\\')
        && !id.contains("..")
        && !id.contains('\0')
}

fn kiro_session_jsonl(session_id: &str) -> PathBuf {
    let home = std::env::var("HOME").unwrap_or_else(|_| ".".to_string());
    PathBuf::from(home)
        .join(".kiro/sessions/cli")
        .join(format!("{session_id}.jsonl"))
}

fn concat_text(content: Option<&serde_json::Value>) -> String {
    content
        .and_then(|c| c.as_array())
        .map(|arr| {
            arr.iter()
                .filter(|p| p.get("kind").and_then(|k| k.as_str()) == Some("text"))
                .filter_map(|p| p.get("data").and_then(|d| d.as_str()))
                .collect::<Vec<_>>()
                .join("")
        })
        .unwrap_or_default()
}

/// Reconstruct a session's transcript from kiro's persisted `.jsonl`:
/// Prompt→user, AssistantMessage (text/toolUse)→agent/tool, tools with results
/// marked completed, honouring `Clear`.
pub fn read_transcript(session_id: &str) -> Vec<TranscriptEntry> {
    if !is_safe_session_id(session_id) {
        return vec![];
    }
    let path = kiro_session_jsonl(session_id);
    let Ok(contents) = std::fs::read_to_string(path) else {
        return vec![];
    };
    parse_transcript(&contents)
}

/// Reconstruct a file diff from a persisted tool `input` (write/edit tools):
/// `{path, content}` → create; `{path, oldStr|old_str, newStr|new_str}` → edit.
fn tool_diff_from_input(input: Option<&serde_json::Value>) -> Option<ToolDiff> {
    let input = input?;
    let path = input.get("path").and_then(|x| x.as_str())?.to_string();
    let get = |k1: &str, k2: &str| {
        input
            .get(k1)
            .or_else(|| input.get(k2))
            .and_then(|x| x.as_str())
            .map(str::to_string)
    };
    let old = get("oldStr", "old_str");
    let new = get("newStr", "new_str");
    if let (Some(old_text), Some(new_text)) = (old, new) {
        return Some(ToolDiff {
            path,
            old_text: Some(old_text),
            new_text,
        });
    }
    if let Some(content) = input.get("content").and_then(|x| x.as_str()) {
        return Some(ToolDiff {
            path,
            old_text: None,
            new_text: content.to_string(),
        });
    }
    None
}

/// Pure transcript parser over kiro's `.jsonl` contents.
pub fn parse_transcript(contents: &str) -> Vec<TranscriptEntry> {
    let mut entries: Vec<TranscriptEntry> = Vec::new();
    let mut completed: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut outputs: std::collections::HashMap<String, String> = std::collections::HashMap::new();

    for line in contents.lines() {
        if line.trim().is_empty() {
            continue;
        }
        let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        let kind = v.get("kind").and_then(|k| k.as_str()).unwrap_or("");
        let data = v.get("data");

        match kind {
            "Clear" => {
                entries.clear();
                completed.clear();
            }
            "Prompt" => {
                let text = concat_text(data.and_then(|d| d.get("content")));
                if !text.trim().is_empty() {
                    entries.push(TranscriptEntry::User { text });
                }
            }
            "AssistantMessage" => {
                let Some(content) = data
                    .and_then(|d| d.get("content"))
                    .and_then(|c| c.as_array())
                else {
                    continue;
                };
                let mut buf = String::new();
                for part in content {
                    match part.get("kind").and_then(|k| k.as_str()) {
                        Some("text") => {
                            if let Some(t) = part.get("data").and_then(|d| d.as_str()) {
                                buf.push_str(t);
                            }
                        }
                        Some("thinking") => {
                            if !buf.trim().is_empty() {
                                entries.push(TranscriptEntry::Agent {
                                    text: buf.trim().to_string(),
                                });
                                buf.clear();
                            }
                            if let Some(t) = part.get("data").and_then(|d| d.as_str()) {
                                if !t.trim().is_empty() {
                                    entries.push(TranscriptEntry::Thought {
                                        text: t.trim().to_string(),
                                    });
                                }
                            }
                        }
                        Some("toolUse") => {
                            if !buf.trim().is_empty() {
                                entries.push(TranscriptEntry::Agent {
                                    text: buf.trim().to_string(),
                                });
                                buf.clear();
                            }
                            let td = part.get("data");
                            entries.push(TranscriptEntry::Tool {
                                tool_call_id: td
                                    .and_then(|d| d.get("toolUseId"))
                                    .and_then(|x| x.as_str())
                                    .unwrap_or_default()
                                    .to_string(),
                                title: td
                                    .and_then(|d| d.get("name"))
                                    .and_then(|x| x.as_str())
                                    .unwrap_or("tool")
                                    .to_string(),
                                status: None,
                                diff: tool_diff_from_input(td.and_then(|d| d.get("input"))),
                                output: None,
                            });
                        }
                        _ => {}
                    }
                }
                if !buf.trim().is_empty() {
                    entries.push(TranscriptEntry::Agent {
                        text: buf.trim().to_string(),
                    });
                }
            }
            "ToolResults" => {
                if let Some(content) = data
                    .and_then(|d| d.get("content"))
                    .and_then(|c| c.as_array())
                {
                    for part in content {
                        if let Some(id) = part
                            .get("data")
                            .and_then(|d| d.get("toolUseId"))
                            .and_then(|x| x.as_str())
                        {
                            completed.insert(id.to_string());
                            let text = concat_text(part.get("data").and_then(|d| d.get("content")));
                            if !text.trim().is_empty() {
                                outputs.insert(id.to_string(), text);
                            }
                        }
                    }
                }
            }
            _ => {}
        }
    }

    for entry in &mut entries {
        if let TranscriptEntry::Tool {
            tool_call_id,
            status,
            output,
            ..
        } = entry
        {
            if completed.contains(tool_call_id) {
                *status = Some("completed".to_string());
            }
            if let Some(text) = outputs.get(tool_call_id) {
                *output = Some(text.clone());
            }
        }
    }
    entries
}

// ---- Budget caps ----------------------------------------------------------

/// Fraction of the cap at which a session is flagged "near" its budget.
pub const BUDGET_NEAR_FRACTION: f64 = 0.9;

/// A per-project credit cap.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectCap {
    pub path: String,
    pub cap: f64,
}

/// Credit caps: a default per-session cap plus optional per-project overrides.
/// `None`/absent means unlimited (never blocks).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct BudgetConfig {
    #[serde(default)]
    pub session_cap: Option<f64>,
    #[serde(default)]
    pub project_caps: Vec<ProjectCap>,
}

/// How a session's spend relates to its cap.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum BudgetLevel {
    Ok,
    Near,
    Over,
}

/// Pure: classify `spent` against an optional `cap`. No cap (or ≤ 0) → always
/// `Ok`. At-or-over the cap → `Over`; within the near fraction → `Near`.
pub fn budget_status(spent: f64, cap: Option<f64>) -> BudgetLevel {
    match cap {
        Some(c) if c > 0.0 => {
            if spent >= c {
                BudgetLevel::Over
            } else if spent >= c * BUDGET_NEAR_FRACTION {
                BudgetLevel::Near
            } else {
                BudgetLevel::Ok
            }
        }
        _ => BudgetLevel::Ok,
    }
}

/// The cap in effect for a session: its project's override if set, else the
/// default per-session cap.
pub fn effective_cap(cfg: &BudgetConfig, repo: Option<&str>) -> Option<f64> {
    if let Some(repo) = repo {
        if let Some(pc) = cfg.project_caps.iter().find(|p| p.path == repo) {
            return Some(pc.cap);
        }
    }
    cfg.session_cap
}

fn budget_file(home: &Path) -> PathBuf {
    home.join("budget.json")
}

/// Read the budget config. Missing file → default (unlimited).
pub fn get_budget(home: &Path) -> Result<BudgetConfig, ConfigError> {
    let path = budget_file(home);
    if !path.exists() {
        return Ok(BudgetConfig::default());
    }
    let contents = std::fs::read_to_string(path)?;
    Ok(serde_json::from_str(&contents).unwrap_or_default())
}

/// Persist the budget config.
pub fn save_budget(home: &Path, cfg: &BudgetConfig) -> Result<(), ConfigError> {
    std::fs::create_dir_all(home)?;
    std::fs::write(budget_file(home), serde_json::to_string_pretty(cfg)?)?;
    Ok(())
}

// ---- Persisted credit spend -----------------------------------------------
// Accumulated per-session credit spend, persisted so per-session budget caps
// survive app restarts (the in-memory tally would otherwise reset to zero on
// every launch, letting a long-lived session exceed its cap arbitrarily).

fn spend_file(home: &Path) -> PathBuf {
    home.join("spend.json")
}

/// Read persisted per-session credit spend (`session_id` → credits). Missing or
/// unreadable file → empty map.
pub fn get_spend(home: &Path) -> std::collections::HashMap<String, f64> {
    let path = spend_file(home);
    match std::fs::read_to_string(path) {
        Ok(contents) => serde_json::from_str(&contents).unwrap_or_default(),
        Err(_) => std::collections::HashMap::new(),
    }
}

/// Persist the per-session credit-spend map (overwrites).
pub fn save_spend(
    home: &Path,
    spend: &std::collections::HashMap<String, f64>,
) -> Result<(), ConfigError> {
    std::fs::create_dir_all(home)?;
    std::fs::write(spend_file(home), serde_json::to_string_pretty(spend)?)?;
    Ok(())
}

// ---- Trust profiles (approval-rule presets) -------------------------------
/// Tools that are ALWAYS asked regardless of any trust profile — destructive or
/// broad-blast-radius built-ins. A profile can never pre-trust these; this is
/// the backstop enforcing the safety model's "destructive actions always
/// confirm" rule even if a user lists one in `auto_allow_tools`.
pub const ALWAYS_ASK_TOOLS: &[&str] = &["execute_bash", "fs_write", "use_aws"];

/// A named approval-rule preset. `auto_allow_tools` are pre-trusted (mapped to
/// `--trust-tools` at session start); `always_ask` names are never pre-trusted
/// even if also listed in `auto_allow_tools`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrustProfile {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub auto_allow_tools: Vec<String>,
    #[serde(default)]
    pub always_ask: Vec<String>,
}

/// The tools a profile actually pre-trusts: `auto_allow_tools`, minus anything
/// in `always_ask`, minus the built-in destructive denylist. Pure + tested.
/// This is the single point where the "destructive always asks" invariant is
/// enforced when a profile is applied.
pub fn effective_trust_tools(profile: &TrustProfile) -> Vec<String> {
    let mut deny: std::collections::HashSet<&str> = ALWAYS_ASK_TOOLS.iter().copied().collect();
    for t in &profile.always_ask {
        deny.insert(t.as_str());
    }
    profile
        .auto_allow_tools
        .iter()
        .filter(|t| !deny.contains(t.as_str()))
        .cloned()
        .collect()
}

fn trust_profiles_file(home: &Path) -> PathBuf {
    home.join("trust-profiles.json")
}

/// List persisted trust profiles. Missing file → empty.
pub fn list_trust_profiles(home: &Path) -> Result<Vec<TrustProfile>, ConfigError> {
    let path = trust_profiles_file(home);
    if !path.exists() {
        return Ok(vec![]);
    }
    let contents = std::fs::read_to_string(path)?;
    Ok(serde_json::from_str(&contents).unwrap_or_default())
}

/// Upsert a trust profile (by `id`).
pub fn save_trust_profile(home: &Path, profile: &TrustProfile) -> Result<(), ConfigError> {
    std::fs::create_dir_all(home)?;
    let mut all = list_trust_profiles(home)?;
    if let Some(existing) = all.iter_mut().find(|p| p.id == profile.id) {
        *existing = profile.clone();
    } else {
        all.push(profile.clone());
    }
    std::fs::write(
        trust_profiles_file(home),
        serde_json::to_string_pretty(&all)?,
    )?;
    Ok(())
}

/// Remove a trust profile by id. No-op if absent.
pub fn remove_trust_profile(home: &Path, id: &str) -> Result<(), ConfigError> {
    let mut all = list_trust_profiles(home)?;
    let before = all.len();
    all.retain(|p| p.id != id);
    if all.len() != before {
        std::fs::write(
            trust_profiles_file(home),
            serde_json::to_string_pretty(&all)?,
        )?;
    }
    Ok(())
}

// ---- Cross-session transcript search --------------------------------------
/// A single search hit within a session's transcript.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    pub session_id: String,
    /// Index of the matching entry within the transcript.
    pub index: usize,
    /// Entry kind: `user` | `agent` | `thought` | `tool` | `system`.
    pub kind: String,
    /// The matching line, trimmed and truncated for display.
    pub snippet: String,
}

/// The searchable (kind, text) of a transcript entry. Tool entries fold their
/// title and output together so a search matches either.
fn entry_search_text(e: &TranscriptEntry) -> (&'static str, String) {
    match e {
        TranscriptEntry::User { text } => ("user", text.clone()),
        TranscriptEntry::Agent { text } => ("agent", text.clone()),
        TranscriptEntry::Thought { text } => ("thought", text.clone()),
        TranscriptEntry::System { text } => ("system", text.clone()),
        TranscriptEntry::Tool { title, output, .. } => {
            let mut t = title.clone();
            if let Some(o) = output {
                t.push('\n');
                t.push_str(o);
            }
            ("tool", t)
        }
    }
}

/// Pure: find transcript entries containing `query` (case-insensitive). One hit
/// per entry, snippeted to the first matching line (trimmed, ≤200 chars). The
/// `session_id` is left blank for the caller to fill in.
pub fn search_entries(entries: &[TranscriptEntry], query: &str) -> Vec<SearchHit> {
    let q = query.trim().to_lowercase();
    if q.is_empty() {
        return vec![];
    }
    let mut hits = Vec::new();
    for (i, e) in entries.iter().enumerate() {
        let (kind, text) = entry_search_text(e);
        if let Some(line) = text.lines().find(|l| l.to_lowercase().contains(&q)) {
            hits.push(SearchHit {
                session_id: String::new(),
                index: i,
                kind: kind.to_string(),
                snippet: line.trim().chars().take(200).collect(),
            });
        }
    }
    hits
}

/// Search every persisted session's transcript for `query`. Reads each
/// session's transcript from kiro's store; sessions with no matches are omitted.
pub fn session_search(home: &Path, query: &str) -> Vec<SearchHit> {
    let mut out = Vec::new();
    for s in list_sessions(home).unwrap_or_default() {
        let entries = read_transcript(&s.session_id);
        for mut hit in search_entries(&entries, query) {
            hit.session_id = s.session_id.clone();
            out.push(hit);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Tmp(PathBuf);
    impl Tmp {
        fn new() -> Self {
            use std::sync::atomic::{AtomicU64, Ordering};
            static COUNTER: AtomicU64 = AtomicU64::new(0);
            let n = COUNTER.fetch_add(1, Ordering::Relaxed);
            let p = std::env::temp_dir().join(format!(
                "bugyo-cfg-{}-{}-{}",
                std::process::id(),
                n,
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
            std::fs::create_dir_all(&p).unwrap();
            Tmp(p)
        }
    }
    impl Drop for Tmp {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn make_repo(dir: &Path) {
        std::fs::create_dir_all(dir.join(".git")).unwrap();
    }

    #[test]
    fn session_meta_roundtrip() {
        let tmp = Tmp::new();
        // Missing file → empty.
        assert!(list_session_meta(&tmp.0).unwrap().is_empty());

        let m = SessionMeta {
            session_id: "s1".into(),
            pinned: true,
            name: Some("nightly".into()),
            order: Some(2),
        };
        save_session_meta(&tmp.0, &m).unwrap();
        save_session_meta(&tmp.0, &m).unwrap(); // upsert, no duplicate
        let listed = list_session_meta(&tmp.0).unwrap();
        assert_eq!(listed, vec![m.clone()]);

        // Upsert by id: editing fields does not duplicate.
        let mut edited = m.clone();
        edited.pinned = false;
        edited.name = None;
        save_session_meta(&tmp.0, &edited).unwrap();
        let listed = list_session_meta(&tmp.0).unwrap();
        assert_eq!(listed.len(), 1);
        assert!(!listed[0].pinned);
        assert_eq!(listed[0].name, None);

        // A second session appends.
        save_session_meta(
            &tmp.0,
            &SessionMeta {
                session_id: "s2".into(),
                pinned: false,
                name: None,
                order: None,
            },
        )
        .unwrap();
        assert_eq!(list_session_meta(&tmp.0).unwrap().len(), 2);

        // Remove by id; absent id is a no-op.
        remove_session_meta(&tmp.0, "s1").unwrap();
        assert_eq!(list_session_meta(&tmp.0).unwrap().len(), 1);
        remove_session_meta(&tmp.0, "nope").unwrap();
        assert_eq!(list_session_meta(&tmp.0).unwrap().len(), 1);
    }

    #[test]
    fn session_meta_defaults_when_fields_absent() {
        // Older/minimal file with only session_id deserializes with defaults.
        let json = r#"[{"sessionId":"s1"}]"#;
        let parsed: Vec<SessionMeta> = serde_json::from_str(json).unwrap();
        assert_eq!(parsed.len(), 1);
        assert!(!parsed[0].pinned);
        assert_eq!(parsed[0].name, None);
        assert_eq!(parsed[0].order, None);
    }

    #[test]
    fn effective_trust_tools_strips_destructive_and_always_ask() {
        let profile = TrustProfile {
            id: "p1".into(),
            name: "Read-only".into(),
            // A user lists a mix, including a destructive tool.
            auto_allow_tools: vec![
                "fs_read".into(),
                "code".into(),
                "execute_bash".into(), // destructive — must be stripped
                "grep".into(),
            ],
            always_ask: vec!["grep".into()], // explicit override
        };
        let eff = effective_trust_tools(&profile);
        // execute_bash removed by the denylist; grep by always_ask; only the
        // safe read-only tools remain, in order.
        assert_eq!(eff, vec!["fs_read".to_string(), "code".to_string()]);
        // Invariant: no ALWAYS_ASK tool is ever pre-trusted.
        for t in ALWAYS_ASK_TOOLS {
            assert!(!eff.contains(&t.to_string()));
        }
    }

    #[test]
    fn trust_profile_persistence_roundtrip() {
        let tmp = Tmp::new();
        assert!(list_trust_profiles(&tmp.0).unwrap().is_empty());
        let p = TrustProfile {
            id: "p1".into(),
            name: "Read-only".into(),
            auto_allow_tools: vec!["fs_read".into()],
            always_ask: vec![],
        };
        save_trust_profile(&tmp.0, &p).unwrap();
        save_trust_profile(&tmp.0, &p).unwrap(); // upsert, no dup
        assert_eq!(list_trust_profiles(&tmp.0).unwrap(), vec![p.clone()]);
        remove_trust_profile(&tmp.0, "p1").unwrap();
        assert!(list_trust_profiles(&tmp.0).unwrap().is_empty());
        remove_trust_profile(&tmp.0, "nope").unwrap(); // no-op
    }

    #[test]
    fn budget_status_classifies_under_near_and_over() {
        // No cap → always ok.
        assert_eq!(budget_status(1000.0, None), BudgetLevel::Ok);
        assert_eq!(budget_status(1000.0, Some(0.0)), BudgetLevel::Ok);
        // Under 90% → ok.
        assert_eq!(budget_status(5.0, Some(10.0)), BudgetLevel::Ok);
        assert_eq!(budget_status(8.9, Some(10.0)), BudgetLevel::Ok);
        // ≥ 90% but < cap → near.
        assert_eq!(budget_status(9.0, Some(10.0)), BudgetLevel::Near);
        assert_eq!(budget_status(9.99, Some(10.0)), BudgetLevel::Near);
        // At or over the cap → over.
        assert_eq!(budget_status(10.0, Some(10.0)), BudgetLevel::Over);
        assert_eq!(budget_status(12.0, Some(10.0)), BudgetLevel::Over);
    }

    #[test]
    fn effective_cap_prefers_project_override() {
        let cfg = BudgetConfig {
            session_cap: Some(5.0),
            project_caps: vec![ProjectCap {
                path: "/repo1".into(),
                cap: 20.0,
            }],
        };
        assert_eq!(effective_cap(&cfg, Some("/repo1")), Some(20.0)); // override
        assert_eq!(effective_cap(&cfg, Some("/other")), Some(5.0)); // falls back
        assert_eq!(effective_cap(&cfg, None), Some(5.0));
        assert_eq!(effective_cap(&BudgetConfig::default(), Some("/x")), None);
    }

    #[test]
    fn budget_config_roundtrip() {
        let tmp = Tmp::new();
        assert_eq!(get_budget(&tmp.0).unwrap(), BudgetConfig::default());
        let cfg = BudgetConfig {
            session_cap: Some(10.0),
            project_caps: vec![ProjectCap {
                path: "/repo1".into(),
                cap: 25.0,
            }],
        };
        save_budget(&tmp.0, &cfg).unwrap();
        assert_eq!(get_budget(&tmp.0).unwrap(), cfg);
    }

    #[test]
    fn spend_roundtrip_and_missing_is_empty() {
        let tmp = Tmp::new();
        // Missing file → empty.
        assert!(get_spend(&tmp.0).is_empty());
        let mut spend = std::collections::HashMap::new();
        spend.insert("sess-1".to_string(), 12.5);
        spend.insert("sess-2".to_string(), 0.0);
        save_spend(&tmp.0, &spend).unwrap();
        assert_eq!(get_spend(&tmp.0), spend);
    }

    #[test]
    fn read_transcript_rejects_path_traversal_ids() {
        // Unsafe ids never touch the filesystem path — they short-circuit to an
        // empty transcript rather than escaping kiro's session store.
        assert!(read_transcript("../../../../etc/passwd").is_empty());
        assert!(read_transcript("a/b").is_empty());
        assert!(read_transcript("..").is_empty());
        assert!(read_transcript("").is_empty());
        assert!(read_transcript("with\0nul").is_empty());
        // A well-formed id with no on-disk transcript is also empty (benign).
        assert!(read_transcript("00000000-0000-0000-0000-000000000000").is_empty());
    }

    #[test]
    fn search_entries_finds_matches_case_insensitively() {
        let entries = vec![
            TranscriptEntry::User {
                text: "Please run the TESTS now".into(),
            },
            TranscriptEntry::Agent {
                text: "Sure — first line\nrunning the tests\ndone".into(),
            },
            TranscriptEntry::Tool {
                tool_call_id: "t1".into(),
                title: "execute_bash".into(),
                status: Some("completed".into()),
                diff: None,
                output: Some("all tests passed".into()),
            },
            TranscriptEntry::Agent {
                text: "unrelated".into(),
            },
        ];

        let hits = search_entries(&entries, "tests");
        // user (matches "TESTS"), agent (line "running the tests"), tool (output).
        assert_eq!(hits.len(), 3);
        assert_eq!(hits[0].index, 0);
        assert_eq!(hits[0].kind, "user");
        assert_eq!(hits[1].index, 1);
        assert_eq!(hits[1].snippet, "running the tests"); // matching line only
        assert_eq!(hits[2].kind, "tool");
        assert!(hits[2].snippet.contains("passed"));

        // Empty / whitespace query → no hits.
        assert!(search_entries(&entries, "   ").is_empty());
        // No match → empty.
        assert!(search_entries(&entries, "zzz-nope").is_empty());
    }

    #[test]
    fn session_persistence_roundtrip() {
        let tmp = Tmp::new();
        let s = PersistedSession {
            session_id: "s1".into(),
            repo: "/repo".into(),
            workspace: None,
            worker_name: "s1".into(),
            args: vec!["acp".into()],
            command: "kiro-cli acp".into(),
            created: "2026-07-07T10:00:00+0200".into(),
            automation_id: None,
        };
        save_session(&tmp.0, &s).unwrap();
        save_session(&tmp.0, &s).unwrap(); // upsert, no duplicate
        let listed = list_sessions(&tmp.0).unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].session_id, "s1");

        remove_session(&tmp.0, "s1").unwrap();
        assert!(list_sessions(&tmp.0).unwrap().is_empty());
    }

    #[test]
    fn parses_transcript_from_jsonl() {
        let jsonl = concat!(
            r#"{"kind":"Prompt","data":{"content":[{"kind":"text","data":"hello there"}]}}"#,
            "\n",
            r#"{"kind":"AssistantMessage","data":{"content":[{"kind":"text","data":"Hi! Reading."},{"kind":"toolUse","data":{"toolUseId":"t1","name":"read"}}]}}"#,
            "\n",
            r#"{"kind":"ToolResults","data":{"content":[{"kind":"toolResult","data":{"toolUseId":"t1"}}]}}"#,
            "\n",
            r#"{"kind":"Clear","data":null}"#,
            "\n",
            r#"{"kind":"Prompt","data":{"content":[{"kind":"text","data":"second turn"}]}}"#,
            "\n"
        );
        // Clear wiped the first turn; only the last prompt remains.
        assert_eq!(
            parse_transcript(jsonl),
            vec![TranscriptEntry::User {
                text: "second turn".into()
            }]
        );

        let jsonl2 = concat!(
            r#"{"kind":"Prompt","data":{"content":[{"kind":"text","data":"hello"}]}}"#,
            "\n",
            r#"{"kind":"AssistantMessage","data":{"content":[{"kind":"thinking","data":"I should create the file."},{"kind":"text","data":"Hi!"},{"kind":"toolUse","data":{"toolUseId":"t1","name":"write","input":{"path":"x.txt","content":"new content"}}}]}}"#,
            "\n",
            r#"{"kind":"ToolResults","data":{"content":[{"kind":"toolResult","data":{"toolUseId":"t1","content":[{"kind":"text","data":"Successfully created x.txt (1 line)."}]}}]}}"#,
            "\n"
        );
        let e2 = parse_transcript(jsonl2);
        assert_eq!(e2.len(), 4);
        assert_eq!(
            e2[0],
            TranscriptEntry::User {
                text: "hello".into()
            }
        );
        assert_eq!(
            e2[1],
            TranscriptEntry::Thought {
                text: "I should create the file.".into()
            }
        );
        assert_eq!(e2[2], TranscriptEntry::Agent { text: "Hi!".into() });
        assert_eq!(
            e2[3],
            TranscriptEntry::Tool {
                tool_call_id: "t1".into(),
                title: "write".into(),
                status: Some("completed".into()),
                diff: Some(ToolDiff {
                    path: "x.txt".into(),
                    old_text: None,
                    new_text: "new content".into(),
                }),
                output: Some("Successfully created x.txt (1 line).".into()),
            }
        );
    }

    fn sample_automation(id: &str) -> Automation {
        Automation {
            id: id.into(),
            name: "nightly triage".into(),
            enabled: true,
            prompt: "Check the queue and report anything broken.".into(),
            schedule: Schedule::IntervalSecs { secs: 3600 },
            target: AutomationTarget::ExistingSession {
                session_id: "s1".into(),
            },
            trust: TrustMode::Ask,
            last_run: None,
            created: "2026-07-07T10:00:00+0200".into(),
        }
    }

    #[test]
    fn automation_persistence_roundtrip() {
        let tmp = Tmp::new();
        // Missing file → empty.
        assert!(list_automations(&tmp.0).unwrap().is_empty());

        let a = sample_automation("a1");
        save_automation(&tmp.0, &a).unwrap();
        let listed = list_automations(&tmp.0).unwrap();
        assert_eq!(listed, vec![a.clone()]);

        // Upsert by id: editing fields does not duplicate.
        let mut edited = a.clone();
        edited.name = "renamed".into();
        edited.enabled = false;
        edited.last_run = Some("2026-07-07T11:00:00+0200".into());
        save_automation(&tmp.0, &edited).unwrap();
        let listed = list_automations(&tmp.0).unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].name, "renamed");
        assert!(!listed[0].enabled);
        assert_eq!(
            listed[0].last_run.as_deref(),
            Some("2026-07-07T11:00:00+0200")
        );

        // A second automation appends.
        save_automation(&tmp.0, &sample_automation("a2")).unwrap();
        assert_eq!(list_automations(&tmp.0).unwrap().len(), 2);

        // Remove by id.
        remove_automation(&tmp.0, "a1").unwrap();
        let listed = list_automations(&tmp.0).unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].id, "a2");

        // Removing an absent id is a no-op.
        remove_automation(&tmp.0, "nope").unwrap();
        assert_eq!(list_automations(&tmp.0).unwrap().len(), 1);
    }

    #[test]
    fn automation_target_and_schedule_serialize_tagged() {
        let ws = AutomationTarget::NewWorkspace {
            project_path: "/repo".into(),
            base_branch: "main".into(),
            branch_prefix: Some("auto".into()),
            agent: None,
            model: None,
        };
        let v = serde_json::to_value(&ws).unwrap();
        assert_eq!(v["type"], "newWorkspace");
        assert_eq!(v["projectPath"], "/repo");
        assert_eq!(v["baseBranch"], "main");

        let sched = serde_json::to_value(Schedule::Cron {
            expr: "0 9 * * *".into(),
        })
        .unwrap();
        assert_eq!(sched["type"], "cron");
        assert_eq!(sched["expr"], "0 9 * * *");

        let trust = serde_json::to_value(TrustMode::TrustTools {
            tools: vec!["fs_read".into()],
        })
        .unwrap();
        assert_eq!(trust["type"], "trustTools");
        assert_eq!(trust["tools"][0], "fs_read");
    }

    #[test]
    fn automation_enabled_defaults_true_when_absent() {
        // A stored automation missing `enabled` (older file) deserializes enabled.
        let json = r#"[{"id":"a1","name":"n","prompt":"p",
            "schedule":{"type":"intervalSecs","secs":60},
            "target":{"type":"existingSession","sessionId":"s1"}}]"#;
        let parsed: Vec<Automation> = serde_json::from_str(json).unwrap();
        assert_eq!(parsed.len(), 1);
        assert!(parsed[0].enabled);
        assert_eq!(parsed[0].trust, TrustMode::Ask);
        assert_eq!(parsed[0].last_run, None);
    }

    #[test]
    fn config_home_respects_env() {
        let _g = crate::state::env_lock();
        std::env::set_var("BUGYO_CONFIG_HOME", "/tmp/custom-bugyo");
        assert_eq!(config_home(), PathBuf::from("/tmp/custom-bugyo"));
        std::env::remove_var("BUGYO_CONFIG_HOME");
    }

    #[test]
    fn add_list_remove_roundtrip() {
        let tmp = Tmp::new();
        let repo = tmp.0.join("my-repo");
        make_repo(&repo);

        let added = add_project(&tmp.0, repo.to_str().unwrap()).unwrap();
        assert_eq!(added.name, "my-repo");

        let projects = list_projects(&tmp.0).unwrap();
        assert_eq!(projects.len(), 1);
        assert_eq!(projects[0].name, "my-repo");

        remove_project(&tmp.0, &added.path).unwrap();
        assert!(list_projects(&tmp.0).unwrap().is_empty());
    }

    #[test]
    fn add_is_idempotent_by_path() {
        let tmp = Tmp::new();
        let repo = tmp.0.join("repo");
        make_repo(&repo);
        add_project(&tmp.0, repo.to_str().unwrap()).unwrap();
        add_project(&tmp.0, repo.to_str().unwrap()).unwrap();
        assert_eq!(list_projects(&tmp.0).unwrap().len(), 1);
    }

    #[test]
    fn registers_any_existing_dir_and_rejects_missing() {
        let tmp = Tmp::new();
        // A plain (non-git) directory registers fine — git is only needed for
        // creating workspaces, not for registering a project.
        let plain = tmp.0.join("plain");
        std::fs::create_dir_all(&plain).unwrap();
        let added = add_project(&tmp.0, plain.to_str().unwrap()).unwrap();
        assert_eq!(added.name, "plain");

        // A missing path is rejected.
        assert!(matches!(
            add_project(&tmp.0, "/no/such/path/here"),
            Err(ConfigError::NotFound(_))
        ));
    }
}
