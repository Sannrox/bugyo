//! Workspace manager — git worktree + branch lifecycle for isolated agent
//! workspaces.
//!
//! Implements the command contract verified in `docs/worktree-notes.md`. All
//! git invocations use `std::process::Command` with explicit args (never a
//! shell string) and run against an explicit `current_dir`.

use std::collections::BTreeSet;
use std::hash::{DefaultHasher, Hash, Hasher};
use std::path::{Path, PathBuf};
use std::process::Command;

use serde::{Deserialize, Serialize};

/// Errors from workspace/git operations.
#[derive(Debug, thiserror::Error)]
pub enum WorkspaceError {
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("git {op} failed: {stderr}")]
    Git { op: String, stderr: String },
    #[error("branch already exists: {0}")]
    BranchExists(String),
    #[error("invalid path: {0}")]
    InvalidPath(String),
    #[error("setup script failed (exit {code}): {stderr}")]
    SetupScript { code: i32, stderr: String },
}

/// A created workspace: an isolated git worktree on its own branch.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Workspace {
    /// Human-readable task that created this workspace.
    ///
    /// Older persisted workspaces predate this field, so deserialize them with
    /// an empty task and let clients fall back to the branch name.
    #[serde(default)]
    pub task: String,
    /// Absolute path to the repository the workspace was cut from.
    pub repo_root: String,
    /// Branch the workspace was based on (e.g. `main`).
    pub base_branch: String,
    /// The workspace's own branch.
    pub branch: String,
    /// Absolute path to the worktree checkout.
    pub worktree_path: String,
}

/// Run a git subcommand in `cwd`, returning trimmed stdout or a `Git` error.
fn run_git(cwd: &Path, args: &[&str]) -> Result<String, WorkspaceError> {
    let output = Command::new("git").current_dir(cwd).args(args).output()?;
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
    } else {
        Err(WorkspaceError::Git {
            op: args.first().map(|s| s.to_string()).unwrap_or_default(),
            stderr: String::from_utf8_lossy(&output.stderr).trim().to_string(),
        })
    }
}

/// Slugify a free-text task name into a safe branch component.
pub fn slugify(input: &str) -> String {
    let slug: String = input
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() {
                c.to_ascii_lowercase()
            } else {
                '-'
            }
        })
        .collect();
    let slug = slug.trim_matches('-').to_string();
    // Collapse runs of '-'.
    let mut out = String::with_capacity(slug.len());
    let mut prev_dash = false;
    for c in slug.chars() {
        if c == '-' {
            if !prev_dash {
                out.push(c);
            }
            prev_dash = true;
        } else {
            out.push(c);
            prev_dash = false;
        }
    }
    if out.is_empty() {
        "workspace".to_string()
    } else {
        out
    }
}

/// Whether a local branch already exists.
fn branch_exists(repo_root: &Path, branch: &str) -> bool {
    run_git(
        repo_root,
        &[
            "show-ref",
            "--verify",
            "--quiet",
            &format!("refs/heads/{branch}"),
        ],
    )
    .is_ok()
}

/// Pick a branch name derived from `slug` that doesn't collide, appending a
/// numeric suffix if necessary.
fn unique_branch(repo_root: &Path, slug: &str) -> String {
    if !branch_exists(repo_root, slug) {
        return slug.to_string();
    }
    for n in 2..1000 {
        let candidate = format!("{slug}-{n}");
        if !branch_exists(repo_root, &candidate) {
            return candidate;
        }
    }
    format!("{slug}-{}", std::process::id())
}

/// Create a workspace: fetch (best-effort), pick a unique branch from `slug`,
/// and add a worktree under `worktrees_root/<branch>` based on `base_branch`.
pub fn create(
    repo_root: &Path,
    base_branch: &str,
    slug: &str,
    worktrees_root: &Path,
) -> Result<Workspace, WorkspaceError> {
    if !repo_root.join(".git").exists() {
        return Err(WorkspaceError::InvalidPath(format!(
            "{} is not a git repository",
            repo_root.display()
        )));
    }

    // Best-effort fetch so the workspace starts from the latest remote commit.
    // Ignored when there is no remote / offline.
    let _ = run_git(repo_root, &["fetch", "--all", "--quiet"]);

    let branch = unique_branch(repo_root, &slugify(slug));
    let worktree_path = worktrees_root.join(&branch);
    let worktree_str = worktree_path
        .to_str()
        .ok_or_else(|| WorkspaceError::InvalidPath(worktree_path.display().to_string()))?;

    std::fs::create_dir_all(worktrees_root)?;

    run_git(
        repo_root,
        &["worktree", "add", "-b", &branch, worktree_str, base_branch],
    )?;

    // Canonicalize so the stored path matches what git reports (resolves
    // symlinks such as macOS /var → /private/var).
    let canonical = std::fs::canonicalize(&worktree_path).unwrap_or(worktree_path);

    Ok(Workspace {
        task: slug.trim().to_string(),
        repo_root: repo_root.to_string_lossy().into_owned(),
        base_branch: base_branch.to_string(),
        branch,
        worktree_path: canonical.to_string_lossy().into_owned(),
    })
}

/// Porcelain status lines for a worktree (empty = clean).
pub fn status(worktree_path: &Path) -> Result<Vec<String>, WorkspaceError> {
    let out = run_git(worktree_path, &["status", "--porcelain"])?;
    Ok(out.lines().map(str::to_string).collect())
}

/// Whether the worktree has uncommitted changes.
pub fn is_dirty(worktree_path: &Path) -> Result<bool, WorkspaceError> {
    Ok(!status(worktree_path)?.is_empty())
}

/// `git diff --stat <base>..<branch>` for committed workspace changes.
pub fn diff_stat(
    worktree_path: &Path,
    base_branch: &str,
    branch: &str,
) -> Result<String, WorkspaceError> {
    run_git(
        worktree_path,
        &[
            "--no-pager",
            "diff",
            "--stat",
            &format!("{base_branch}..{branch}"),
        ],
    )
}

/// Full patch of the current workspace versus its base, including committed,
/// staged, unstaged, and untracked changes. The review surface must show the
/// same contents that its fingerprint and changed-file count describe.
pub fn diff(
    worktree_path: &Path,
    base_branch: &str,
    _branch: &str,
) -> Result<String, WorkspaceError> {
    let mut patch = run_git(
        worktree_path,
        &["--no-pager", "diff", "--binary", base_branch],
    )?;
    for relative in untracked_files(worktree_path)? {
        let output = Command::new("git")
            .current_dir(worktree_path)
            .args([
                "--no-pager",
                "diff",
                "--binary",
                "--no-index",
                "--",
                "/dev/null",
                &relative,
            ])
            .output()?;
        // `git diff --no-index` returns 1 when differences were found.
        if !output.status.success() && output.status.code() != Some(1) {
            return Err(WorkspaceError::Git {
                op: "diff".to_string(),
                stderr: String::from_utf8_lossy(&output.stderr).trim().to_string(),
            });
        }
        let untracked_patch = String::from_utf8_lossy(&output.stdout);
        if !patch.is_empty() && !untracked_patch.is_empty() {
            patch.push('\n');
        }
        patch.push_str(untracked_patch.trim_end());
    }
    Ok(patch)
}

/// Result of running a workspace check/run script.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckResult {
    pub success: bool,
    pub exit_code: i32,
    pub stdout: String,
    pub stderr: String,
}

/// Durable summary of the latest workspace check. The change fingerprint
/// invalidates a green result as soon as the worktree changes again.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewCheck {
    pub script: String,
    pub success: bool,
    pub exit_code: i32,
    pub completed_at: String,
    pub change_fingerprint: String,
}

/// Durable landing outcome for a workspace. kiro's flow is git-only: the agent
/// commits its reviewed work and the human pushes the branch to `origin`. There
/// is no local merge or hosted pull/merge request (no `gh`/`glab`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum LandingState {
    Pushed,
}

/// Review metadata persisted with the session descriptor.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewRecord {
    #[serde(default)]
    pub last_check: Option<ReviewCheck>,
    #[serde(default)]
    pub landing: Option<LandingState>,
}

/// Backend-derived review lifecycle shown by every frontend surface.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ReviewStage {
    Active,
    NeedsReview,
    ReadyToLand,
    Pushed,
}

/// Current review state, combining durable check/landing metadata with the
/// live git worktree. This is deliberately backend-owned so the fleet and the
/// review panel cannot disagree about whether checks are still valid.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewState {
    pub stage: ReviewStage,
    pub has_changes: bool,
    pub has_uncommitted_changes: bool,
    pub changed_files: Vec<String>,
    pub last_check: Option<ReviewCheck>,
}

fn untracked_files(worktree_path: &Path) -> Result<Vec<String>, WorkspaceError> {
    let output = run_git(
        worktree_path,
        &["ls-files", "--others", "--exclude-standard"],
    )?;
    Ok(output
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(str::to_string)
        .collect())
}

/// Fingerprint the resulting workspace contents relative to the base. This is
/// deliberately independent of Git's staged/committed state so a human can
/// commit the exact files they reviewed without invalidating a green check.
fn change_fingerprint(workspace: &Workspace) -> Result<String, WorkspaceError> {
    let root = Path::new(&workspace.worktree_path);
    let tracked = run_git(root, &["diff", "--name-only", &workspace.base_branch])?;
    let mut changed = BTreeSet::new();
    changed.extend(
        tracked
            .lines()
            .map(str::trim)
            .filter(|line| !line.is_empty())
            .map(str::to_string),
    );
    changed.extend(untracked_files(root)?);

    let mut hasher = DefaultHasher::new();
    for relative in changed {
        relative.hash(&mut hasher);
        let path = root.join(&relative);
        match std::fs::symlink_metadata(&path) {
            Ok(metadata) if metadata.file_type().is_symlink() => {
                "symlink".hash(&mut hasher);
                std::fs::read_link(&path)?.hash(&mut hasher);
            }
            Ok(metadata) => {
                "file".hash(&mut hasher);
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    (metadata.permissions().mode() & 0o111).hash(&mut hasher);
                }
                std::fs::read(&path)?.hash(&mut hasher);
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                "deleted".hash(&mut hasher);
            }
            Err(error) => return Err(error.into()),
        }
    }
    Ok(format!("{:016x}", hasher.finish()))
}

/// Whether the workspace HEAD is still the commit recorded by Git as its
/// upstream. `push -u` updates that tracking ref, so a later local commit makes
/// this false without requiring extra review metadata or a remote fetch.
fn head_matches_upstream(worktree_path: &Path) -> bool {
    let Ok(head) = run_git(worktree_path, &["rev-parse", "HEAD"]) else {
        return false;
    };
    let Ok(upstream) = run_git(worktree_path, &["rev-parse", "@{upstream}"]) else {
        return false;
    };
    head == upstream
}

/// Stage and commit every reviewed workspace change with an explicit message.
pub fn commit_all(worktree_path: &Path, message: &str) -> Result<(), WorkspaceError> {
    if message.trim().is_empty() {
        return Err(WorkspaceError::InvalidPath(
            "commit message cannot be empty".to_string(),
        ));
    }
    run_git(worktree_path, &["add", "--all"])?;
    run_git(worktree_path, &["commit", "-m", message.trim()])?;
    Ok(())
}

/// Resolve the current review lifecycle from git plus its durable record.
pub fn review_state(
    workspace: &Workspace,
    record: &ReviewRecord,
) -> Result<ReviewState, WorkspaceError> {
    let root = Path::new(&workspace.worktree_path);
    let status_lines = status(root)?;
    let tracked_files = run_git(root, &["diff", "--name-only", &workspace.base_branch])?;
    let untracked = untracked_files(root)?;
    let mut files = BTreeSet::new();
    files.extend(
        tracked_files
            .lines()
            .map(str::trim)
            .filter(|line| !line.is_empty())
            .map(str::to_string),
    );
    files.extend(untracked);
    let changed_files: Vec<String> = files.into_iter().collect();
    let has_changes = !changed_files.is_empty();
    let has_uncommitted_changes = !status_lines.is_empty();

    // Landing readiness is a function of commit state, not verification. The
    // agent is responsible for verifying its own work (via its own tools or a
    // Kiro hook the user configures); the harness never grades it. A human is
    // the final gate: they review the diff and choose to land. Any recorded
    // `last_check` is surfaced purely as informational evidence and never
    // blocks the flow.
    let stage = match &record.landing {
        None if !has_changes => ReviewStage::Active,
        // Uncommitted changes must be committed before a human can land them.
        _ if has_uncommitted_changes => ReviewStage::NeedsReview,
        // A push only remains current while the local branch still points at
        // the upstream commit updated by `git push -u`.
        Some(LandingState::Pushed) if head_matches_upstream(root) => ReviewStage::Pushed,
        // Committed changes on a clean worktree: ready for a human to land.
        _ => ReviewStage::ReadyToLand,
    };

    Ok(ReviewState {
        stage,
        has_changes,
        has_uncommitted_changes,
        changed_files,
        last_check: record.last_check.clone(),
    })
}

/// Record a check against the exact current workspace contents.
pub fn record_check(
    workspace: &Workspace,
    record: &mut ReviewRecord,
    script: String,
    result: &CheckResult,
    completed_at: String,
) -> Result<(), WorkspaceError> {
    record.last_check = Some(ReviewCheck {
        script,
        success: result.success,
        exit_code: result.exit_code,
        completed_at,
        change_fingerprint: change_fingerprint(workspace)?,
    });
    Ok(())
}

/// Run a check/run script in the worktree via `sh -c`, capturing pass/fail and
/// output. Unlike a setup script, a non-zero exit is a *result*, not an error.
pub fn run_check(worktree_path: &Path, script: &str) -> Result<CheckResult, WorkspaceError> {
    let output = Command::new("sh")
        .current_dir(worktree_path)
        .arg("-c")
        .arg(script)
        .output()?;
    Ok(CheckResult {
        success: output.status.success(),
        exit_code: output.status.code().unwrap_or(-1),
        stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
    })
}

/// List worktree paths registered on the repo (`git worktree list --porcelain`).
pub fn list_worktrees(repo_root: &Path) -> Result<Vec<String>, WorkspaceError> {
    let out = run_git(repo_root, &["worktree", "list", "--porcelain"])?;
    Ok(out
        .lines()
        .filter_map(|l| l.strip_prefix("worktree ").map(str::to_string))
        .collect())
}

/// Run an optional setup script inside the worktree via `sh -c`.
/// Runs with the worktree as the working directory.
pub fn run_setup_script(worktree_path: &Path, script: &str) -> Result<(), WorkspaceError> {
    if script.trim().is_empty() {
        return Ok(());
    }
    let output = Command::new("sh")
        .current_dir(worktree_path)
        .arg("-c")
        .arg(script)
        .output()?;
    if output.status.success() {
        Ok(())
    } else {
        Err(WorkspaceError::SetupScript {
            code: output.status.code().unwrap_or(-1),
            stderr: String::from_utf8_lossy(&output.stderr).trim().to_string(),
        })
    }
}

/// Archive a workspace: remove the worktree and delete its branch when safe.
///
/// `force` is required to remove a dirty worktree (discarding uncommitted
/// changes) — a destructive action the caller must opt into explicitly. Branch
/// Branch deletion uses the safe `-d`. An unmerged branch (for example, one
/// backing an open pull request) is deliberately retained so archiving can
/// still clean up the local worktree without losing the branch or leaving the
/// session half-archived.
pub fn archive(
    repo_root: &Path,
    worktree_path: &Path,
    branch: &str,
    force: bool,
) -> Result<(), WorkspaceError> {
    let worktree_str = worktree_path
        .to_str()
        .ok_or_else(|| WorkspaceError::InvalidPath(worktree_path.display().to_string()))?;

    let mut remove_args = vec!["worktree", "remove"];
    if force {
        remove_args.push("--force");
    }
    remove_args.push(worktree_str);
    run_git(repo_root, &remove_args)?;

    // `branch -d` is intentionally best-effort: Git refuses unmerged branches,
    // which is the desired outcome for PR-backed workspaces. The worktree has
    // already been removed, so surfacing that refusal as an archive failure
    // would leave the persisted session pointing at a path that no longer
    // exists. Other deletion failures likewise retain the branch safely.
    let _ = run_git(repo_root, &["branch", "-d", branch]);
    Ok(())
}

/// Roll back a workspace that failed during creation before it was exposed to
/// the user. Unlike normal archive, this may force-delete the branch because
/// both the worktree and branch were created by the same unsuccessful
/// transaction and cannot contain accepted user work.
pub fn rollback_create(
    repo_root: &Path,
    worktree_path: &Path,
    branch: &str,
) -> Result<(), WorkspaceError> {
    let worktree_str = worktree_path
        .to_str()
        .ok_or_else(|| WorkspaceError::InvalidPath(worktree_path.display().to_string()))?;
    run_git(repo_root, &["worktree", "remove", "--force", worktree_str])?;
    run_git(repo_root, &["branch", "-D", branch])?;
    Ok(())
}

/// Push the workspace branch to `origin`, setting upstream on the first push
/// (`git push -u origin <branch>`). This is how kiro lands work: the reviewed
/// commits go to the remote branch, where they are picked up by whatever review
/// process the team runs. There is no local merge and no hosted PR/MR creation
/// (no `gh`/`glab`) — just git.
///
/// Environment-dependent: needs an `origin` remote and push credentials.
pub fn push(repo_root: &Path, branch: &str) -> Result<(), WorkspaceError> {
    run_git(repo_root, &["push", "-u", "origin", branch])?;
    Ok(())
}

/// The repository's current branch name (`git rev-parse --abbrev-ref HEAD`).
/// Returns `"HEAD"` when in a detached-HEAD state.
pub fn current_branch(repo_root: &Path) -> Result<String, WorkspaceError> {
    run_git(repo_root, &["rev-parse", "--abbrev-ref", "HEAD"])
}

/// Default location for a repo's worktrees: a sibling `.bugyo-worktrees/<repo>`.
pub fn default_worktrees_root(repo_root: &Path) -> PathBuf {
    let name = repo_root
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "repo".to_string());
    repo_root
        .parent()
        .unwrap_or(repo_root)
        .join(".bugyo-worktrees")
        .join(name)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn init_repo(dir: &Path) {
        run_git(dir, &["init", "-q", "-b", "main"]).unwrap();
        run_git(dir, &["config", "user.email", "t@example.com"]).unwrap();
        run_git(dir, &["config", "user.name", "Test"]).unwrap();
        // Test repositories must not inherit a developer's global signing
        // policy or require an interactive pinentry/GPG agent.
        run_git(dir, &["config", "commit.gpgSign", "false"]).unwrap();
        std::fs::write(dir.join("file.txt"), "line1\n").unwrap();
        run_git(dir, &["add", "file.txt"]).unwrap();
        run_git(dir, &["commit", "-q", "-m", "init"]).unwrap();
    }

    struct Tmp(PathBuf);
    impl Tmp {
        fn new(tag: &str) -> Self {
            use std::sync::atomic::{AtomicU64, Ordering};
            static COUNTER: AtomicU64 = AtomicU64::new(0);
            let n = COUNTER.fetch_add(1, Ordering::Relaxed);
            let p = std::env::temp_dir().join(format!(
                "bugyo-ws-{tag}-{}-{}-{}",
                std::process::id(),
                n,
                fastish()
            ));
            std::fs::create_dir_all(&p).unwrap();
            Tmp(p)
        }
        fn path(&self) -> &Path {
            &self.0
        }
    }
    impl Drop for Tmp {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
    fn fastish() -> u128 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    }

    #[test]
    fn slugify_is_safe() {
        assert_eq!(slugify("Fix issue #42!"), "fix-issue-42");
        assert_eq!(slugify("  multiple   spaces  "), "multiple-spaces");
        assert_eq!(slugify("///"), "workspace");
    }

    #[test]
    fn create_makes_isolated_worktree_and_branch() {
        let tmp = Tmp::new("create");
        let repo = tmp.path().join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        init_repo(&repo);
        let wt_root = tmp.path().join("wts");

        let ws = create(&repo, "main", "add feature", &wt_root).unwrap();
        assert_eq!(ws.task, "add feature");
        assert_eq!(ws.branch, "add-feature");
        assert!(Path::new(&ws.worktree_path).join("file.txt").exists());
        assert!(branch_exists(&repo, "add-feature"));
    }

    #[test]
    fn review_state_stages_on_commit_state_not_checks() {
        let tmp = Tmp::new("review-state");
        let repo = tmp.path().join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        init_repo(&repo);
        let workspace = create(&repo, "main", "review flow", &tmp.path().join("wts")).unwrap();
        let mut record = ReviewRecord::default();

        // No changes yet.
        assert_eq!(
            review_state(&workspace, &record).unwrap().stage,
            ReviewStage::Active
        );

        // Uncommitted changes must be committed before a human can land them.
        let changed = Path::new(&workspace.worktree_path).join("review.txt");
        std::fs::write(&changed, "first\n").unwrap();
        let pending = review_state(&workspace, &record).unwrap();
        assert_eq!(pending.stage, ReviewStage::NeedsReview);
        assert!(pending.has_uncommitted_changes);
        assert_eq!(pending.changed_files, vec!["review.txt"]);
        let patch = diff(
            Path::new(&workspace.worktree_path),
            &workspace.base_branch,
            &workspace.branch,
        )
        .unwrap();
        assert!(patch.contains("diff --git"));
        assert!(patch.contains("+first"));

        // A recorded check is informational only: it does NOT advance the stage.
        // While changes remain uncommitted the workspace still Needs review.
        let passed = run_check(Path::new(&workspace.worktree_path), "true").unwrap();
        record_check(
            &workspace,
            &mut record,
            "true".into(),
            &passed,
            "now".into(),
        )
        .unwrap();
        assert_eq!(
            review_state(&workspace, &record).unwrap().stage,
            ReviewStage::NeedsReview
        );

        // Committing (with no check at all) is what makes it ready to land.
        commit_all(Path::new(&workspace.worktree_path), "reviewed changes").unwrap();
        let committed = review_state(&workspace, &record).unwrap();
        assert_eq!(committed.stage, ReviewStage::ReadyToLand);
        assert!(!committed.has_uncommitted_changes);

        // New uncommitted edits drop back to NeedsReview regardless of checks.
        std::fs::write(&changed, "changed after commit\n").unwrap();
        assert_eq!(
            review_state(&workspace, &record).unwrap().stage,
            ReviewStage::NeedsReview
        );

        // A failing check likewise does not gate: stage stays commit-driven.
        let failed = run_check(Path::new(&workspace.worktree_path), "false").unwrap();
        record_check(
            &workspace,
            &mut record,
            "false".into(),
            &failed,
            "later".into(),
        )
        .unwrap();
        assert_eq!(
            review_state(&workspace, &record).unwrap().stage,
            ReviewStage::NeedsReview
        );
    }

    #[test]
    fn two_workspaces_on_one_repo_do_not_collide() {
        let tmp = Tmp::new("iso");
        let repo = tmp.path().join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        init_repo(&repo);
        let wt_root = tmp.path().join("wts");

        let a = create(&repo, "main", "feat-a", &wt_root).unwrap();
        let b = create(&repo, "main", "feat-b", &wt_root).unwrap();
        assert_ne!(a.worktree_path, b.worktree_path);
        assert_ne!(a.branch, b.branch);

        // Independent changes in each worktree.
        std::fs::write(Path::new(&a.worktree_path).join("a.txt"), "A\n").unwrap();
        std::fs::write(Path::new(&b.worktree_path).join("b.txt"), "B\n").unwrap();

        // Neither file bleeds into the other worktree or the base repo.
        assert!(!Path::new(&b.worktree_path).join("a.txt").exists());
        assert!(!Path::new(&a.worktree_path).join("b.txt").exists());
        assert!(!repo.join("a.txt").exists());
        assert!(!repo.join("b.txt").exists());

        // Both are registered as worktrees.
        let worktrees = list_worktrees(&repo).unwrap();
        assert!(worktrees.iter().any(|w| w == &a.worktree_path));
        assert!(worktrees.iter().any(|w| w == &b.worktree_path));
    }

    #[test]
    fn unique_branch_avoids_collision() {
        let tmp = Tmp::new("uniq");
        let repo = tmp.path().join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        init_repo(&repo);
        let wt_root = tmp.path().join("wts");

        let a = create(&repo, "main", "dup", &wt_root).unwrap();
        let b = create(&repo, "main", "dup", &wt_root).unwrap();
        assert_eq!(a.branch, "dup");
        assert_eq!(b.branch, "dup-2");
    }

    #[test]
    fn status_diff_and_setup_script() {
        let tmp = Tmp::new("diff");
        let repo = tmp.path().join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        init_repo(&repo);
        let wt_root = tmp.path().join("wts");
        let ws = create(&repo, "main", "work", &wt_root).unwrap();
        let wt = Path::new(&ws.worktree_path);

        assert!(!is_dirty(wt).unwrap());

        // Setup script writes a file → worktree becomes dirty.
        run_setup_script(wt, "echo hello > setup_out.txt").unwrap();
        assert!(is_dirty(wt).unwrap());
        assert!(wt.join("setup_out.txt").exists());

        // Commit it, then the committed diff vs base is non-empty.
        run_git(wt, &["add", "-A"]).unwrap();
        run_git(wt, &["commit", "-q", "-m", "work"]).unwrap();
        let diff = diff_stat(wt, "main", &ws.branch).unwrap();
        assert!(diff.contains("setup_out.txt"), "diff was: {diff}");
    }

    #[test]
    fn archive_removes_worktree_and_branch() {
        let tmp = Tmp::new("archive");
        let repo = tmp.path().join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        init_repo(&repo);
        let wt_root = tmp.path().join("wts");
        let ws = create(&repo, "main", "tmp-work", &wt_root).unwrap();
        let wt = Path::new(&ws.worktree_path).to_path_buf();

        // Commit so the branch is mergeable, merge it into main (raw git — the
        // app no longer merges), then archive: `branch -d` deletes the merged
        // branch cleanly.
        std::fs::write(wt.join("x.txt"), "x\n").unwrap();
        run_git(&wt, &["add", "-A"]).unwrap();
        run_git(&wt, &["commit", "-q", "-m", "x"]).unwrap();
        run_git(&repo, &["merge", "--no-ff", "-m", "merge", &ws.branch]).unwrap();

        archive(&repo, &wt, &ws.branch, false).unwrap();
        assert!(!wt.exists());
        assert!(!branch_exists(&repo, &ws.branch));
    }

    #[test]
    fn archive_unmerged_workspace_removes_worktree_and_retains_branch() {
        let tmp = Tmp::new("archive-unmerged");
        let repo = tmp.path().join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        init_repo(&repo);
        let wt_root = tmp.path().join("wts");
        let ws = create(&repo, "main", "pr-work", &wt_root).unwrap();
        let wt = Path::new(&ws.worktree_path).to_path_buf();

        std::fs::write(wt.join("pr.txt"), "review me\n").unwrap();
        run_git(&wt, &["add", "-A"]).unwrap();
        run_git(&wt, &["commit", "-q", "-m", "pr work"]).unwrap();

        archive(&repo, &wt, &ws.branch, false).unwrap();
        assert!(!wt.exists());
        assert!(
            branch_exists(&repo, &ws.branch),
            "unmerged PR branch must be retained"
        );
    }

    #[test]
    fn rollback_create_removes_failed_workspace_and_branch() {
        let tmp = Tmp::new("rollback-create");
        let repo = tmp.path().join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        init_repo(&repo);
        let wt_root = tmp.path().join("wts");
        let ws = create(&repo, "main", "failed-setup", &wt_root).unwrap();
        let wt = Path::new(&ws.worktree_path).to_path_buf();
        std::fs::write(wt.join("setup-artifact.txt"), "partial\n").unwrap();

        rollback_create(&repo, &wt, &ws.branch).unwrap();
        assert!(!wt.exists());
        assert!(!branch_exists(&repo, &ws.branch));
    }

    #[test]
    fn push_sends_branch_to_origin_and_sets_upstream() {
        let tmp = Tmp::new("push");
        let origin = tmp.path().join("origin.git");
        std::fs::create_dir_all(&origin).unwrap();
        // A bare repo to act as `origin`.
        assert!(Command::new("git")
            .args(["init", "-q", "--bare"])
            .arg(&origin)
            .status()
            .unwrap()
            .success());

        let repo = tmp.path().join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        init_repo(&repo);
        run_git(
            &repo,
            &["remote", "add", "origin", origin.to_str().unwrap()],
        )
        .unwrap();

        let wt_root = tmp.path().join("wts");
        let ws = create(&repo, "main", "push-work", &wt_root).unwrap();
        let wt = Path::new(&ws.worktree_path).to_path_buf();
        std::fs::write(wt.join("p.txt"), "p\n").unwrap();
        run_git(&wt, &["add", "-A"]).unwrap();
        run_git(&wt, &["commit", "-q", "-m", "push work"]).unwrap();

        push(&repo, &ws.branch).unwrap();

        let record = ReviewRecord {
            landing: Some(LandingState::Pushed),
            ..ReviewRecord::default()
        };
        assert_eq!(
            review_state(&ws, &record).unwrap().stage,
            ReviewStage::Pushed
        );

        // The branch now exists on origin.
        let remote_refs = run_git(&repo, &["ls-remote", "--heads", "origin"]).unwrap();
        assert!(
            remote_refs.contains(&ws.branch),
            "expected {} on origin, got {remote_refs}",
            ws.branch
        );
        // Upstream was set (`-u`): the worktree branch tracks origin/<branch>.
        let upstream = run_git(
            &wt,
            &[
                "rev-parse",
                "--abbrev-ref",
                "--symbolic-full-name",
                "@{upstream}",
            ],
        )
        .unwrap();
        assert_eq!(upstream, format!("origin/{}", ws.branch));

        // Further work invalidates the durable pushed outcome. Uncommitted
        // edits need review; once committed, the new HEAD is ready to push.
        std::fs::write(wt.join("p.txt"), "changed after push\n").unwrap();
        assert_eq!(
            review_state(&ws, &record).unwrap().stage,
            ReviewStage::NeedsReview
        );
        commit_all(&wt, "more work").unwrap();
        assert_eq!(
            review_state(&ws, &record).unwrap().stage,
            ReviewStage::ReadyToLand
        );
    }

    #[test]
    fn archive_dirty_worktree_requires_force() {
        let tmp = Tmp::new("dirty");
        let repo = tmp.path().join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        init_repo(&repo);
        let wt_root = tmp.path().join("wts");
        let ws = create(&repo, "main", "dirty-work", &wt_root).unwrap();
        let wt = Path::new(&ws.worktree_path).to_path_buf();
        std::fs::write(wt.join("scratch.txt"), "x\n").unwrap();

        // Non-force archive refuses to discard uncommitted changes.
        assert!(matches!(
            archive(&repo, &wt, &ws.branch, false),
            Err(WorkspaceError::Git { .. })
        ));
        assert!(wt.join("scratch.txt").exists(), "worktree must be intact");
    }

    #[test]
    fn diff_shows_branch_changes_and_run_check_reports_status() {
        let tmp = Tmp::new("review");
        let repo = tmp.path().join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        init_repo(&repo);
        let wt_root = tmp.path().join("wts");
        let ws = create(&repo, "main", "review-work", &wt_root).unwrap();
        let wt = Path::new(&ws.worktree_path);

        std::fs::write(wt.join("feature.txt"), "new feature\n").unwrap();
        run_git(wt, &["add", "-A"]).unwrap();
        run_git(wt, &["commit", "-q", "-m", "add feature"]).unwrap();

        let patch = diff(wt, "main", &ws.branch).unwrap();
        assert!(patch.contains("feature.txt"), "patch: {patch}");
        assert!(patch.contains("new feature"), "patch: {patch}");

        let ok = run_check(wt, "test -f feature.txt && echo present").unwrap();
        assert!(ok.success);
        assert_eq!(ok.exit_code, 0);
        assert!(ok.stdout.contains("present"));

        let bad = run_check(wt, "echo boom >&2; exit 3").unwrap();
        assert!(!bad.success);
        assert_eq!(bad.exit_code, 3);
        assert!(bad.stderr.contains("boom"));
    }

    #[test]
    fn create_rejects_non_repo() {
        let tmp = Tmp::new("norepo");
        let not_repo = tmp.path().join("plain");
        std::fs::create_dir_all(&not_repo).unwrap();
        let wt_root = tmp.path().join("wts");
        assert!(matches!(
            create(&not_repo, "main", "x", &wt_root),
            Err(WorkspaceError::InvalidPath(_))
        ));
    }
}
