# Worktree notes — workspace lifecycle

Phase 0 spike. Verified end-to-end by `docs/spikes/worktree_spike.sh` (runs in a
throwaway temp repo; all steps exited 0 / behaved as documented on git for macOS).

This is the command contract the Rust `workspace` module will automate via
`std::process::Command` (explicit args, never shell-interpolated).

## Lifecycle command list

| Step               | Command                                         | Notes                                           |
| ------------------ | ----------------------------------------------- | ----------------------------------------------- |
| Fetch base         | `git fetch --all`                               | no-op offline; base workspaces on latest origin |
| Create             | `git worktree add -b <branch> <path> <base>`    | new branch off `<base>` in a new worktree       |
| List               | `git worktree list` (`--porcelain` for parsing) | enumerate active workspaces                     |
| Status             | `git -C <path> status --porcelain`              | machine-readable dirty check                    |
| Diff (uncommitted) | `git -C <path> diff` / `diff --stat`            | live changes in the worktree                    |
| Diff (vs base)     | `git -C <path> diff <base>..<branch>`           | committed workspace changes for review          |
| Stage/commit       | `git -C <path> add -A` / `commit -m ...`        | agent output → commit                           |
| Merge              | `git merge --no-ff <branch> -m ...`             | run from the base checkout                      |
| Remove worktree    | `git worktree remove <path>`                    | refuses if dirty (see edge cases)               |
| Delete branch      | `git branch -d <branch>`                        | refuses if unmerged (see edge cases)            |

Always run git with `-C <path>` (or set `current_dir`) rather than `cd`. Prefer
`--porcelain` output for anything we parse.

## Edge cases (all reproduced)

1. **Branch name already exists** → `git worktree add -b <name> ...` fails
   `fatal: a branch named '<name>' already exists` (exit 255).
   → Pre-check with `git show-ref --verify refs/heads/<name>`; if it exists,
   attach without `-b`: `git worktree add <path> <existingBranch>`. Also generate
   collision-free branch names (e.g. slug + short id).

2. **Removing a dirty worktree** → `git worktree remove <path>` fails
   `contains modified or untracked files, use --force` (exit 128).
   → On archive, either commit/stash first, or require `--force` **behind an
   explicit user confirmation** (we'd be discarding uncommitted agent work).

3. **Deleting an unmerged branch** → `git branch -d <branch>` fails
   `the branch '<name>' is not fully merged` (exit 1). `git branch -D` force-deletes.
   → `-D` is **destructive**: gate it behind an explicit owner decision per the
   safety model. Never auto-`-D`.

## Design implications for the `workspace` module

- A `Workspace` = `{ repo_root, base_branch, branch, worktree_path, status }`.
- **Create**: fetch → ensure unique branch → `worktree add -b`. Then run the
  optional per-workspace **setup script** in `worktree_path`.
- Bind the workspace's ACP session `cwd` to `worktree_path` (see `acp-notes.md`).
- **Review**: `diff <base>..<branch>` feeds the diff UI; the **run/check script**
  executes in `worktree_path`; `status --porcelain` drives the dirty indicator.
- **Push**: `git push -u origin <branch>` — kiro is git-only, so landing means
  pushing the reviewed branch to `origin` (no local merge, no `gh`/`glab` PR/MR).
- **Archive**: `worktree remove` (confirm `--force` if dirty) → `branch -d`
  (never silent `-D`).
- Treat `worktree remove --force`, `branch -D`, hard reset, and force-push as
  destructive → explicit confirmation, regardless of trust settings.
- Concurrency: multiple worktrees off one repo work fine; serialize operations
  that touch the shared base checkout / `.git` (create/merge) per repo.
