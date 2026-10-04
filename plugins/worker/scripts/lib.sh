#!/usr/bin/env bash
# Shared helpers for worker scripts. Sourced, not executed. Bash 3.2 compatible.
wf_die() { printf 'error: %s\n' "$*" >&2; exit 1; }
wf_warn() { printf 'warning: %s\n' "$*" >&2; }
wf_kv() { printf '%s: %s\n' "$1" "$2"; }
wf_need() { command -v "$1" >/dev/null 2>&1 || wf_die "$1 is required but not on PATH"; }
# A plan branch (plan/<slug>) carries a topic, so its slug may start with a number without being an issue.
wf_issue_from_branch() { printf '%s\n' "$1" | sed -nE '\#^plan/#d; s#^[a-z]+/([0-9]+)-.*#\1#p'; }
wf_branch() { git rev-parse --abbrev-ref HEAD 2>/dev/null || true; }
wf_issue() {
  if [ -n "${WF_ISSUE:-}" ]; then printf '%s\n' "$WF_ISSUE"; else wf_issue_from_branch "$(wf_branch)"; fi
}
wf_base_branch() {
  if [ -n "${WF_BASE_BRANCH:-}" ]; then printf '%s\n' "$WF_BASE_BRANCH"; return; fi
  local ref; ref=$(git symbolic-ref -q --short refs/remotes/origin/HEAD 2>/dev/null || true)
  if [ -n "$ref" ]; then printf '%s\n' "${ref#origin/}"; return; fi
  gh repo view --json defaultBranchRef -q .defaultBranchRef.name 2>/dev/null || printf 'main\n'
}
# Whether a word is one of a space-separated list. `case " $list " in *" $word "*)` answers yes for several
# words of the list at once as well, so a quoted pair of words passed for one; this compares word by word.
wf_in_list() {
  local item
  for item in $2; do [ "$item" = "$1" ] && return 0; done
  return 1
}
# The uncommitted changes of this worktree, indented for a refusal that lists them, and empty when there are
# none. A hunt's round and its removal describe a commit, so both refuse a dirty tree with this listing.
wf_dirty_tree() {
  local dirty; dirty=$(git status --porcelain)
  [ -z "$dirty" ] || printf '%s' "$dirty" | sed 's/^/  /'
}
# A commit as a reader wants it, and as the caller has it when git cannot resolve it any more: a record
# names a commit an amend or a rebase may have taken away, and a brief still has to be able to print it.
wf_short() { git rev-parse --short "$1" 2>/dev/null || printf '%s\n' "$1"; }
# Where the hunt record lives: this worktree's own git directory, never the common one, so two
# worktrees keep separate records. Removed with the worktree, which is what a hunt lives in.
wf_state_dir() {
  local d
  d=$(git rev-parse --path-format=absolute --git-dir 2>/dev/null) || wf_die "not inside a git repository"
  printf '%s/worker' "$d"
}
# A record of the hunt: headers, an empty line, then the block it carries. A field is read from the headers
# only: the block below them quotes a hunter's text, and a line of it that looks like a header is text in a
# block, not a fact about the record.
wf_record_field() { sed -n "/^$/q; s/^$2: //p" "$1" | head -1; }
# A test hunt works on a branch hunt/tests-<date>, which names no issue, because its removals are known only
# at its end: the hunt record in this worktree's git directory stands where the issue stands for a ticket.
wf_is_hunt_branch() { case "$(wf_branch)" in hunt/*) return 0 ;; *) return 1 ;; esac; }
# The issue as a brief prints it: the number, or `none` for a branch that works none.
wf_issue_label() {
  local issue; issue=$(wf_issue)
  if [ -n "$issue" ]; then printf '#%s\n' "$issue"
  elif wf_is_hunt_branch; then printf 'none (a test hunt: the hunt record stands for the issue)\n'
  else printf 'none\n'; fi
}

# The test files of the repository in the current directory, one tracked path per line, by the fixed
# conventions of a test hunt.
# shellcheck disable=SC2034  # read by hunt.sh
wf_test_file_rule='test_*.py, *_test.py, *_test.go, *.test.* and *.spec.* (JavaScript and TypeScript), and code files in a tests or spec directory; fixtures, testdata, __snapshots__, node_modules and vendor directories are skipped'
wf_test_files() { git -c core.quotePath=false ls-files 2>/dev/null | wf_test_paths; }
# The paths on stdin that are test files by that rule, one per line.
wf_test_paths() {
  awk '{
    n = split($0, part, "/"); name = part[n]; indir = 0
    for (i = 1; i < n; i++) {
      if (part[i] ~ /^(fixtures|testdata|__snapshots__|node_modules|vendor)$/) next
      if (part[i] == "tests" || part[i] == "spec") indir = 1
    }
    if (name ~ /^test_.*\.py$/ || name ~ /_test\.py$/ || name ~ /_test\.go$/ || name ~ /\.(test|spec)\.(js|jsx|ts|tsx|mjs|cjs|mts|cts)$/) { print; next }
    if (indir && name ~ /\.(py|go|js|jsx|ts|tsx|mjs|cjs|mts|cts|rb|sh|bash|java|kt|rs|php|cs|swift|ex|exs)$/) print
  }'
}
