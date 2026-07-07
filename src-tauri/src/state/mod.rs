//! State store — Bugyo's own on-disk fleet state, under `~/.kiro/bugyo/`.
//!
//! Layout:
//! - `workers/<name>.json`  — per-worker metadata + state
//! - `queue/<name>.jsonl`   — one `{"ts":...,"task":...}` per line (FIFO)
//! - `log.md`               — decision log, entries under `## <date>` headings
//!
//! This used to interoperate with the legacy tmux `kiro-orch` CLI at
//! `~/.kiro-orchestrator/`; Bugyo is now self-contained and stores its state
//! alongside its other config (projects, sessions) under `~/.kiro/bugyo/`.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// Errors from state I/O.
#[derive(Debug, thiserror::Error)]
pub enum StateError {
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("json: {0}")]
    Json(#[from] serde_json::Error),
}

/// Worker metadata for a session (`workers/<name>.json`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WorkerMeta {
    pub name: String,
    pub repo: String,
    pub command: String,
    pub created: String,
    #[serde(default)]
    pub last_dispatch: Option<String>,
    pub state: String,
}

/// Resolve the state home — Bugyo's config home (`~/.kiro/bugyo`), shared with
/// projects/sessions config so all app state lives in one place.
pub fn orch_home() -> PathBuf {
    crate::config::config_home()
}

/// Timestamp in the CLI's format: `date +%Y-%m-%dT%H:%M:%S%z`.
pub fn now_ts() -> String {
    chrono::Local::now()
        .format("%Y-%m-%dT%H:%M:%S%z")
        .to_string()
}

/// Serializes tests that mutate process env (`KIRO_ORCH_HOME` /
/// `BUGYO_CONFIG_HOME`) so parallel test threads don't observe each other's
/// overrides. Poison-tolerant. Test-only.
#[cfg(test)]
pub(crate) fn env_lock() -> std::sync::MutexGuard<'static, ()> {
    static LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
    LOCK.lock().unwrap_or_else(|e| e.into_inner())
}

fn workers_dir(home: &Path) -> PathBuf {
    home.join("workers")
}
fn queue_dir(home: &Path) -> PathBuf {
    home.join("queue")
}
fn queue_file(home: &Path, name: &str) -> PathBuf {
    queue_dir(home).join(format!("{name}.jsonl"))
}
fn log_file(home: &Path) -> PathBuf {
    home.join("log.md")
}

/// Write/overwrite a worker metadata file.
pub fn write_worker(home: &Path, meta: &WorkerMeta) -> Result<(), StateError> {
    let dir = workers_dir(home);
    std::fs::create_dir_all(&dir)?;
    let json = serde_json::to_string_pretty(meta)?;
    std::fs::write(dir.join(format!("{}.json", meta.name)), json)?;
    Ok(())
}

/// Read all worker metadata files.
pub fn list_workers(home: &Path) -> Result<Vec<WorkerMeta>, StateError> {
    let dir = workers_dir(home);
    if !dir.exists() {
        return Ok(vec![]);
    }
    let mut out = Vec::new();
    for entry in std::fs::read_dir(dir)? {
        let path = entry?.path();
        if path.extension().and_then(|e| e.to_str()) == Some("json") {
            let contents = std::fs::read_to_string(&path)?;
            if let Ok(meta) = serde_json::from_str::<WorkerMeta>(&contents) {
                out.push(meta);
            }
        }
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(out)
}

/// Append a task to a worker's queue as a `.jsonl` line. Returns the new depth.
pub fn append_queue(home: &Path, name: &str, task: &str) -> Result<usize, StateError> {
    use std::io::Write;
    let dir = queue_dir(home);
    std::fs::create_dir_all(&dir)?;
    // Build the line with serde_json so every value is correctly escaped —
    // including control characters (U+0000–U+001F) that a hand-rolled escaper
    // would emit raw, producing an invalid JSON line that `read_queue` would
    // then silently drop. Values are serialized individually to keep the
    // stable `{"ts":…,"task":…}` field order.
    let line = format!(
        "{{\"ts\":{},\"task\":{}}}\n",
        serde_json::to_string(&now_ts())?,
        serde_json::to_string(task)?
    );
    let mut f = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(queue_file(home, name))?;
    f.write_all(line.as_bytes())?;
    Ok(read_queue(home, name)?.len())
}

/// Read the queued task strings for a worker (in order).
pub fn read_queue(home: &Path, name: &str) -> Result<Vec<String>, StateError> {
    let path = queue_file(home, name);
    if !path.exists() {
        return Ok(vec![]);
    }
    let contents = std::fs::read_to_string(path)?;
    let tasks = contents
        .lines()
        .filter(|l| !l.trim().is_empty())
        .filter_map(|l| {
            serde_json::from_str::<serde_json::Value>(l)
                .ok()
                .and_then(|v| v.get("task").and_then(|t| t.as_str()).map(String::from))
        })
        .collect();
    Ok(tasks)
}

/// Remove the first queued task (consume), rewriting the file. Returns it.
pub fn pop_queue(home: &Path, name: &str) -> Result<Option<String>, StateError> {
    let path = queue_file(home, name);
    if !path.exists() {
        return Ok(None);
    }
    let contents = std::fs::read_to_string(&path)?;
    let mut lines: Vec<&str> = contents.lines().filter(|l| !l.trim().is_empty()).collect();
    if lines.is_empty() {
        return Ok(None);
    }
    let first = lines.remove(0);
    let task = serde_json::from_str::<serde_json::Value>(first)
        .ok()
        .and_then(|v| v.get("task").and_then(|t| t.as_str()).map(String::from));
    let remaining = lines.join("\n");
    let content = if remaining.is_empty() {
        String::new()
    } else {
        format!("{remaining}\n")
    };
    std::fs::write(&path, content)?;
    Ok(task)
}

/// Append a decision-log entry under today's `## <date>` heading.
pub fn append_log(home: &Path, message: &str) -> Result<(), StateError> {
    use std::io::Write;
    std::fs::create_dir_all(home)?;
    let path = log_file(home);
    let heading = format!("## {}", chrono::Local::now().format("%Y-%m-%d"));
    let existing = std::fs::read_to_string(&path).unwrap_or_default();
    let mut f = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)?;
    if !existing.lines().any(|l| l == heading) {
        writeln!(f, "\n{heading}")?;
    }
    writeln!(f, "- {} {}", now_ts(), message)?;
    Ok(())
}

/// Read the decision log as lines (oldest→newest), limited to the last `limit`.
pub fn read_log(home: &Path, limit: usize) -> Result<Vec<String>, StateError> {
    let path = log_file(home);
    if !path.exists() {
        return Ok(vec![]);
    }
    let contents = std::fs::read_to_string(path)?;
    let lines: Vec<String> = contents
        .lines()
        .filter(|l| !l.trim().is_empty())
        .map(str::to_string)
        .collect();
    let start = lines.len().saturating_sub(limit);
    Ok(lines[start..].to_vec())
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
                "bugyo-state-{}-{}-{}",
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

    #[test]
    fn worker_roundtrip() {
        let tmp = Tmp::new();
        let meta = WorkerMeta {
            name: "feat-a".into(),
            repo: "/repo".into(),
            command: "kiro-cli acp".into(),
            created: now_ts(),
            last_dispatch: None,
            state: "idle".into(),
        };
        write_worker(&tmp.0, &meta).unwrap();
        let workers = list_workers(&tmp.0).unwrap();
        assert_eq!(workers, vec![meta]);
    }

    #[test]
    fn queue_line_roundtrips() {
        let tmp = Tmp::new();
        let depth = append_queue(&tmp.0, "feat-a", "fix the \"bug\"\nnow").unwrap();
        assert_eq!(depth, 1);

        // The line is JSON with an escaped task field.
        let raw = std::fs::read_to_string(tmp.0.join("queue").join("feat-a.jsonl")).unwrap();
        let line = raw.lines().next().unwrap();
        assert!(line.starts_with("{\"ts\":\""));
        assert!(line.ends_with("\"task\":\"fix the \\\"bug\\\"\\nnow\"}"));

        // And it round-trips back to the original task text.
        assert_eq!(
            read_queue(&tmp.0, "feat-a").unwrap(),
            vec!["fix the \"bug\"\nnow"]
        );
    }

    #[test]
    fn queue_fifo_pop() {
        let tmp = Tmp::new();
        append_queue(&tmp.0, "w", "one").unwrap();
        append_queue(&tmp.0, "w", "two").unwrap();
        assert_eq!(read_queue(&tmp.0, "w").unwrap(), vec!["one", "two"]);
        assert_eq!(pop_queue(&tmp.0, "w").unwrap(), Some("one".into()));
        assert_eq!(read_queue(&tmp.0, "w").unwrap(), vec!["two"]);
        assert_eq!(pop_queue(&tmp.0, "w").unwrap(), Some("two".into()));
        assert_eq!(read_queue(&tmp.0, "w").unwrap(), Vec::<String>::new());
        assert_eq!(pop_queue(&tmp.0, "w").unwrap(), None);
    }

    #[test]
    fn queue_preserves_tasks_with_control_characters() {
        // A task containing raw control characters (form-feed, vertical tab,
        // NUL, backspace) must round-trip. A hand-rolled escaper would emit
        // these raw, producing an invalid JSON line that `read_queue` silently
        // drops — losing the task. serde_json escapes them correctly.
        let tmp = Tmp::new();
        let task = "line1\u{0c}line2\u{0b}\u{0}end\u{8}";
        let depth = append_queue(&tmp.0, "w", task).unwrap();
        assert_eq!(depth, 1, "task must not be dropped");
        assert_eq!(read_queue(&tmp.0, "w").unwrap(), vec![task.to_string()]);
        assert_eq!(pop_queue(&tmp.0, "w").unwrap(), Some(task.to_string()));
    }

    #[test]
    fn log_creates_dated_heading_once() {
        let tmp = Tmp::new();
        append_log(&tmp.0, "dispatch -> feat-a: hello").unwrap();
        append_log(&tmp.0, "dispatch -> feat-b: world").unwrap();
        let log = std::fs::read_to_string(tmp.0.join("log.md")).unwrap();
        let heading = format!("## {}", chrono::Local::now().format("%Y-%m-%d"));
        assert_eq!(log.matches(&heading).count(), 1);
        assert!(log.contains("dispatch -> feat-a: hello"));
        assert!(log.contains("dispatch -> feat-b: world"));
    }

    #[test]
    fn reads_log_lines_with_limit() {
        let tmp = Tmp::new();
        append_log(&tmp.0, "one").unwrap();
        append_log(&tmp.0, "two").unwrap();
        append_log(&tmp.0, "three").unwrap();
        let all = read_log(&tmp.0, 100).unwrap();
        assert!(all.iter().any(|l| l.contains("one")));
        assert!(all.iter().any(|l| l.contains("three")));
        let last2 = read_log(&tmp.0, 2).unwrap();
        assert_eq!(last2.len(), 2);
        assert!(last2.iter().any(|l| l.contains("three")));
        assert!(!last2.iter().any(|l| l.contains("one")));
    }

    #[test]
    fn state_home_is_the_bugyo_config_home() {
        let _g = env_lock();
        std::env::set_var("BUGYO_CONFIG_HOME", "/tmp/custom-bugyo-state");
        assert_eq!(orch_home(), PathBuf::from("/tmp/custom-bugyo-state"));
        std::env::remove_var("BUGYO_CONFIG_HOME");
    }
}
