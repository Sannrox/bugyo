#!/usr/bin/env bash
# Phase 0 worktree spike: exercise the full workspace lifecycle the Rust
# `workspace` module will automate — create worktree+branch, run a command,
# diff, merge, cleanup — plus a few edge cases. Runs entirely in a temp repo.
#
# Every git command is echoed (set -x style via `run`) so we can transcribe the
# exact command list into the ADR / module design. Throwaway; deletes its tmp.
set -euo pipefail

TMP="$(mktemp -d)"
echo "### sandbox: $TMP"
trap 'rm -rf "$TMP"' EXIT

run() { echo "+ $*"; "$@"; }

# --- set up an origin-like base repo -------------------------------------
BASE="$TMP/base"
run git init -q -b main "$BASE"
cd "$BASE"
run git config user.email spike@example.com
run git config user.name "Spike"
printf 'line1\n' > file.txt
run git add file.txt
run git commit -q -m "init"
echo

# --- 1. create a workspace = worktree + branch off base ------------------
echo "=== 1. create worktree + branch ==="
WT="$TMP/wt/feat-x"
run git fetch --all -q || echo "(no remotes; fetch is a no-op here)"
run git worktree add -b feat-x "$WT" main
run git worktree list
echo

# --- 2. agent works in the worktree (simulated) --------------------------
echo "=== 2. run a command / make changes in the worktree ==="
cd "$WT"
printf 'line2\n' >> file.txt
printf 'new\n' > added.txt
run git -C "$WT" status --porcelain
echo

# --- 3. diff the workspace vs base branch --------------------------------
echo "=== 3. diff (uncommitted, then committed vs base) ==="
run git -C "$WT" --no-pager diff --stat
run git -C "$WT" add -A
run git -C "$WT" commit -q -m "feat: work"
echo "-- committed diff vs main --"
run git -C "$WT" --no-pager diff --stat main..feat-x
echo

# --- 4. merge the workspace branch back into base ------------------------
echo "=== 4. merge feat-x into main ==="
cd "$BASE"
run git merge --no-ff -q feat-x -m "merge feat-x"
run git --no-pager log --oneline -n 3
echo

# --- 5. cleanup: remove worktree + delete branch -------------------------
echo "=== 5. cleanup ==="
run git worktree remove "$WT"
run git branch -d feat-x
run git worktree list
echo

# --- edge cases ----------------------------------------------------------
echo "=== EDGE: worktree add with a branch name that already exists ==="
run git branch dup-branch main
set +e
git worktree add -b dup-branch "$TMP/wt/dup" main
echo "(exit=$?)  -> must detect existing branch; use 'git worktree add <path> <branch>' without -b to attach"
set -e
run git worktree add "$TMP/wt/dup" dup-branch
run git worktree remove "$TMP/wt/dup"
run git branch -d dup-branch
echo

echo "=== EDGE: remove a worktree with uncommitted changes (dirty) ==="
run git worktree add -b dirty "$TMP/wt/dirty" main
printf 'x\n' > "$TMP/wt/dirty/scratch.txt"
set +e
git worktree remove "$TMP/wt/dirty"
echo "(exit=$?)  -> refuses when dirty; needs --force"
set -e
run git worktree remove --force "$TMP/wt/dirty"
run git branch -D dirty
echo

echo "=== EDGE: unmerged branch delete safety ==="
run git worktree add -b wip "$TMP/wt/wip" main
printf 'wip\n' >> "$TMP/wt/wip/file.txt"
run git -C "$TMP/wt/wip" commit -q -am "wip"
run git worktree remove --force "$TMP/wt/wip"
set +e
git branch -d wip
echo "(exit=$?)  -> 'branch -d' refuses unmerged; 'branch -D' force-deletes (DESTRUCTIVE, must confirm)"
set -e
run git branch -D wip
echo

echo "### spike complete"
