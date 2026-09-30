#!/usr/bin/env bash
# Detached cleanup after finish: remove the worktree and the local plan branch.
# Usage: cleanup-self.sh <main-root> <worktree-path> <branch>
set -uo pipefail
main="$1"; path="$2"; branch="$3"
sleep 5
cd "$main" || exit 1
git worktree remove --force "$path"
git worktree prune
git branch -D "$branch" >/dev/null 2>&1 || true
