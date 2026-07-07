//! Workspace manager — git worktree + branch lifecycle for isolated agent
//! workspaces.
//!
//! Implements the command contract verified in `docs/worktree-notes.md`. All
//! git invocations use `std::process::Command` with explicit args (never a
//! shell string) and run against an explicit `current_dir`.

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
    #[error(
        "repository HEAD is '{head}', expected base branch '{expected}'; \
         check out '{expected}' before merging"
    )]
    WrongBaseBranch { head: String, expected: String },
}

/// A created workspace: an isolated git worktree on its own branch.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Workspace {
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

/// Full patch of the changes the branch introduced vs its base (three-dot, so
/// only the branch's own changes are shown), for the review panel.
pub fn diff(
    worktree_path: &Path,
    base_branch: &str,
    branch: &str,
) -> Result<String, WorkspaceError> {
    run_git(
        worktree_path,
        &["--no-pager", "diff", &format!("{base_branch}...{branch}")],
    )
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

/// Push the branch and open a pull/merge request via `gh` (GitHub) or `glab`
/// (GitLab). Returns the tool's stdout (typically the PR/MR URL).
///
/// Inherently environment-dependent: needs a remote, push credentials, and
/// `gh`/`glab` installed and authenticated.
pub fn open_pr(
    repo_root: &Path,
    branch: &str,
    title: Option<&str>,
) -> Result<String, WorkspaceError> {
    run_git(repo_root, &["push", "-u", "origin", branch])?;

    let has = |bin: &str| {
        Command::new("sh")
            .arg("-c")
            .arg(format!("command -v {bin}"))
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
    };

    let (program, args): (&str, Vec<String>) = if has("gh") {
        let mut a = vec![
            "pr".to_string(),
            "create".to_string(),
            "--head".to_string(),
            branch.to_string(),
        ];
        match title {
            Some(t) => {
                a.push("--title".into());
                a.push(t.to_string());
                a.push("--body".into());
                a.push(String::new());
            }
            None => a.push("--fill".into()),
        }
        ("gh", a)
    } else if has("glab") {
        let mut a = vec![
            "mr".to_string(),
            "create".to_string(),
            "--source-branch".to_string(),
            branch.to_string(),
        ];
        match title {
            Some(t) => {
                a.push("--title".into());
                a.push(t.to_string());
                a.push("--description".into());
                a.push(String::new());
            }
            None => a.push("--fill".into()),
        }
        ("glab", a)
    } else {
        return Err(WorkspaceError::Git {
            op: "open_pr".into(),
            stderr: "neither `gh` nor `glab` found on PATH".into(),
        });
    };

    let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
    let output = Command::new(program)
        .current_dir(repo_root)
        .args(&arg_refs)
        .output()?;
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
    } else {
        Err(WorkspaceError::Git {
            op: format!("{program} create"),
            stderr: String::from_utf8_lossy(&output.stderr).trim().to_string(),
        })
    }
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

/// Archive a workspace: remove the worktree and delete its branch.
///
/// `force` is required to remove a dirty worktree (discarding uncommitted
/// changes) — a destructive action the caller must opt into explicitly. Branch
/// deletion uses the safe `-d` (refuses if unmerged); force-deleting an
/// unmerged branch is intentionally not offered here.
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

    run_git(repo_root, &["branch", "-d", branch])?;
    Ok(())
}

/// Merge a workspace branch into the recorded base branch of `repo_root`
/// (no-ff). Refuses to merge unless `repo_root`'s current HEAD is exactly
/// `base_branch`: the workspace was cut from `base_branch`, and merging into
/// whatever happens to be checked out could silently land approved work on the
/// wrong branch. A detached HEAD reports `"HEAD"` and is likewise refused.
pub fn merge(repo_root: &Path, base_branch: &str, branch: &str) -> Result<(), WorkspaceError> {
    let head = current_branch(repo_root)?;
    if head != base_branch {
        return Err(WorkspaceError::WrongBaseBranch {
            head,
            expected: base_branch.to_string(),
        });
    }
    run_git(
        repo_root,
        &["merge", "--no-ff", branch, "-m", &format!("merge {branch}")],
    )?;
    Ok(())
}

/// Result of a non-mutating pre-merge check.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MergePreview {
    /// Whether merging `branch` into the base would apply cleanly.
    pub clean: bool,
    /// Paths that would conflict (best-effort; empty when clean).
    pub conflicted_files: Vec<String>,
}

/// Predict whether merging `branch` into `base_branch` is clean — **without**
/// touching the working tree, index, or refs. Uses `git merge-tree
/// --write-tree` (git ≥ 2.38), which computes the merge in-memory: exit 0 =
/// clean, exit 1 = conflicts (stdout lists the conflicted paths after the
/// resulting tree OID), any other exit = a real error.
pub fn merge_preview(
    repo_root: &Path,
    base_branch: &str,
    branch: &str,
) -> Result<MergePreview, WorkspaceError> {
    let output = Command::new("git")
        .current_dir(repo_root)
        .args([
            "merge-tree",
            "--write-tree",
            "--name-only",
            base_branch,
            branch,
        ])
        .output()?;
    match output.status.code() {
        Some(0) => Ok(MergePreview {
            clean: true,
            conflicted_files: vec![],
        }),
        Some(1) => {
            let stdout = String::from_utf8_lossy(&output.stdout);
            // Line 1 is the merged tree OID; the rest are conflicted paths.
            let conflicted_files = stdout
                .lines()
                .skip(1)
                .map(|l| l.trim())
                .filter(|l| !l.is_empty())
                .map(str::to_string)
                .collect();
            Ok(MergePreview {
                clean: false,
                conflicted_files,
            })
        }
        _ => Err(WorkspaceError::Git {
            op: "merge-tree".to_string(),
            stderr: String::from_utf8_lossy(&output.stderr).trim().to_string(),
        }),
    }
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
        assert_eq!(ws.branch, "add-feature");
        assert!(Path::new(&ws.worktree_path).join("file.txt").exists());
        assert!(branch_exists(&repo, "add-feature"));
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

        // Commit so the branch is mergeable, merge it, then archive cleanly.
        std::fs::write(wt.join("x.txt"), "x\n").unwrap();
        run_git(&wt, &["add", "-A"]).unwrap();
        run_git(&wt, &["commit", "-q", "-m", "x"]).unwrap();
        merge(&repo, "main", &ws.branch).unwrap();

        archive(&repo, &wt, &ws.branch, false).unwrap();
        assert!(!wt.exists());
        assert!(!branch_exists(&repo, &ws.branch));
    }

    #[test]
    fn merge_refuses_when_head_is_not_base_branch() {
        let tmp = Tmp::new("wrongbase");
        let repo = tmp.path().join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        init_repo(&repo);
        let wt_root = tmp.path().join("wts");
        let ws = create(&repo, "main", "wb-work", &wt_root).unwrap();
        let wt = Path::new(&ws.worktree_path).to_path_buf();

        std::fs::write(wt.join("x.txt"), "x\n").unwrap();
        run_git(&wt, &["add", "-A"]).unwrap();
        run_git(&wt, &["commit", "-q", "-m", "x"]).unwrap();

        // Move the repo's HEAD off `main` onto another branch.
        run_git(&repo, &["checkout", "-q", "-b", "other"]).unwrap();

        let err = merge(&repo, "main", &ws.branch).unwrap_err();
        assert!(
            matches!(&err, WorkspaceError::WrongBaseBranch { head, expected }
                if head == "other" && expected == "main"),
            "expected WrongBaseBranch, got {err:?}"
        );

        // No merge happened: `other` has no merge commit for the branch.
        let log = run_git(&repo, &["log", "--oneline"]).unwrap();
        assert!(!log.contains(&format!("merge {}", ws.branch)), "log: {log}");
    }

    #[test]
    fn merge_preview_reports_clean_and_conflicts() {
        let tmp = Tmp::new("mtpreview");
        let repo = tmp.path().join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        init_repo(&repo);
        let wt_root = tmp.path().join("wts");

        // A clean branch: adds a new file, no overlap with main.
        let clean = create(&repo, "main", "feat-clean", &wt_root).unwrap();
        let clean_wt = Path::new(&clean.worktree_path).to_path_buf();
        std::fs::write(clean_wt.join("new.txt"), "hello\n").unwrap();
        run_git(&clean_wt, &["add", "-A"]).unwrap();
        run_git(&clean_wt, &["commit", "-q", "-m", "add new"]).unwrap();

        let preview = merge_preview(&repo, "main", &clean.branch).unwrap();
        assert!(preview.clean, "expected clean, got {preview:?}");
        assert!(preview.conflicted_files.is_empty());

        // A conflicting branch: edits file.txt's only line; main edits it too.
        let conf = create(&repo, "main", "feat-conf", &wt_root).unwrap();
        let conf_wt = Path::new(&conf.worktree_path).to_path_buf();
        std::fs::write(conf_wt.join("file.txt"), "feature\n").unwrap();
        run_git(&conf_wt, &["add", "-A"]).unwrap();
        run_git(&conf_wt, &["commit", "-q", "-m", "feature edit"]).unwrap();
        // Diverge main on the same line.
        std::fs::write(repo.join("file.txt"), "mainline\n").unwrap();
        run_git(&repo, &["add", "-A"]).unwrap();
        run_git(&repo, &["commit", "-q", "-m", "main edit"]).unwrap();

        let preview = merge_preview(&repo, "main", &conf.branch).unwrap();
        assert!(!preview.clean, "expected conflict, got {preview:?}");
        assert!(
            preview
                .conflicted_files
                .iter()
                .any(|f| f.contains("file.txt")),
            "expected file.txt in conflicts, got {:?}",
            preview.conflicted_files
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
