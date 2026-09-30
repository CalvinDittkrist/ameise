#!/usr/bin/env bash
# End the planning session: refuse if work would be lost, then remove this worktree and branch from a detached process.
# In a session the controller runs (WF_PLAN_CONTROLLER=1) it only checks; the controller's Finish removes them.
# Usage: finish.sh [--force]
set -uo pipefail
. "$(dirname "$0")/lib.sh"
wf_need git
force=0; for a in "$@"; do case "$a" in --force) force=1 ;; -h|--help) sed -n '2,3p' "$0"; exit 0 ;; *) wf_die "unknown flag $a" ;; esac; done
slug=$(wf_plan_slug); [ -n "$slug" ] || wf_die "not in a plan/<slug> worktree"
branch=$(wf_branch); path=$(pwd); main_root=$(wf_main_root)
if [ "$force" = 0 ]; then
  [ -z "$(git status --porcelain)" ] || wf_die "uncommitted changes in this worktree; capture them with capture-prototype.sh <name> or pass --force to drop them"
  base=$(wf_base_branch); ref="origin/$base"; git rev-parse -q --verify "$ref" >/dev/null 2>&1 || ref="$base"
  n=$(git rev-list --count "$ref..HEAD" 2>/dev/null || echo 0)
  [ "$n" = 0 ] || wf_die "$branch has $n commit(s) not on $base; they would be lost. Move them with capture-prototype.sh or pass --force"
fi
# A session the controller runs is finished by the controller, which stops it and removes its worktree.
if [ "${WF_PLAN_CONTROLLER:-}" = 1 ]; then
  wf_kv plan "$slug"
  wf_kv cleanup "none yet: press Finish in the process view; the controller stops this session and removes worktree $path and branch $branch"
  exit 0
fi
wf_kv plan "$slug"
wf_kv cleanup "worktree $path and branch $branch are removed in 5 seconds"
nohup bash "$(dirname "$0")/cleanup-self.sh" "$main_root" "$path" "$branch" >/dev/null 2>&1 &
