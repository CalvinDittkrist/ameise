#!/usr/bin/env bash
# Shared helpers for planner scripts. Sourced, not executed. Bash 3.2 compatible.
wf_die() { printf 'error: %s\n' "$*" >&2; exit 1; }
wf_warn() { printf 'warning: %s\n' "$*" >&2; }
wf_kv() { printf '%s: %s\n' "$1" "$2"; }
wf_need() { command -v "$1" >/dev/null 2>&1 || wf_die "$1 is required but not on PATH"; }
wf_branch() { git rev-parse --abbrev-ref HEAD 2>/dev/null || true; }
# Planning branches are plan/<slug>; the slug is the only state contract with the orchestrator.
wf_plan_slug() { printf '%s\n' "$(wf_branch)" | sed -nE 's#^plan/(.+)$#\1#p'; }
# The topic or issue travels in git's branch description (set by the orchestrator's plan.sh).
wf_plan_desc() { git config "branch.$(wf_branch).description" 2>/dev/null || true; }
wf_plan_issue() {
  if [ -n "${WF_PLAN_ISSUE:-}" ]; then printf '%s\n' "$WF_PLAN_ISSUE"; else wf_plan_desc | sed -nE 's/^issue: #([0-9]+).*/\1/p' | head -n 1; fi
}
wf_plan_topic() { wf_plan_desc | sed -nE 's/^topic: (.*)$/\1/p' | head -n 1; }
# An open session has neither topic nor issue on purpose; its description is `open: <timestamp>`.
wf_plan_open() { wf_plan_desc | sed -nE 's/^open: (.*)$/\1/p' | head -n 1; }
wf_base_branch() {
  if [ -n "${WF_BASE_BRANCH:-}" ]; then printf '%s\n' "$WF_BASE_BRANCH"; return; fi
  local ref; ref=$(git symbolic-ref -q --short refs/remotes/origin/HEAD 2>/dev/null || true)
  if [ -n "$ref" ]; then printf '%s\n' "${ref#origin/}"; return; fi
  gh repo view --json defaultBranchRef -q .defaultBranchRef.name 2>/dev/null || printf 'main\n'
}
wf_repo_nwo() { gh repo view --json nameWithOwner -q .nameWithOwner; }
# Root of the main checkout, even when called from a linked worktree.
wf_main_root() {
  local common
  common=$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null) || wf_die "not inside a git repository"
  dirname "$common"
}
# Branch-safe slug: URLs dropped, German umlauts transliterated, ASCII lower-case, at most 40 chars.
wf_slug() {
  printf '%s' "$1" | sed -E 's#https?://[^ ]*##g' \
    | sed -e 's/ä/ae/g; s/ö/oe/g; s/ü/ue/g; s/Ä/ae/g; s/Ö/oe/g; s/Ü/ue/g; s/ß/ss/g' \
    | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9]+/-/g; s/^-+//; s/-+$//' | cut -c1-40 | sed -E 's/-+$//'
}
wf_notify() {
  [ "${HERDR_ENV:-}" = 1 ] || return 0
  herdr notification show "$1" --body "${2:-}" --sound "${3:-done}" >/dev/null 2>&1 || true
}
# An issue number with an optional leading #, or a refusal naming what was passed.
wf_issue_num() { local n="${1#\#}"; printf '%s' "$n" | grep -Eq '^[0-9]+$' || wf_die "issue must be a number, got '$1'"; printf '%s' "$n"; }
# GitHub's numeric database id of issue $1 (dependency and sub-issue APIs want it, not the number).
wf_issue_db_id() { gh api "repos/$(wf_repo_nwo)/issues/$1" --jq .id 2>/dev/null; }

# --- Routing to the factory ---

# The factory's routing label, as the label vocabulary defines it (labels.sh). The factory host works an issue
# that carries it unattended, with no Herdr, no screen and nobody to ask, so the planner decides per ticket
# whether it is routed, and issue.sh (create and label) is the only script that puts the label on an issue.
WF_ROUTING_LABEL=factory
# True when the label set $2... contains the name $1. The names come from GitHub, so -e keeps one that opens
# with a dash an operand instead of an option to grep.
wf_labels_have() { local want="$1"; shift; printf '%s\n' "$@" | grep -qxF -e "$want"; }
# Refuse a label set that routes an issue the factory cannot work: routing is only true next to
# `ready-for-agent` (the factory takes no half-specified issue) and never next to `ready-for-human` (a person
# implements that one). $1 names the issue in the message, $2 is how this call drops the routing label (the
# set is the one the call would leave behind, so the label may be one the call never named), the rest is that
# label set.
wf_require_routable() {
  local subject="$1" drop="$2"; shift 2
  wf_labels_have "$WF_ROUTING_LABEL" "$@" || return 0
  if wf_labels_have ready-for-human "$@"; then
    wf_die "$subject would carry $WF_ROUTING_LABEL and ready-for-human: the factory works unattended, so an issue a person has to implement is never routed to it. Drop one of the two labels; $drop."
  fi
  if ! wf_labels_have ready-for-agent "$@"; then
    wf_die "$subject would carry $WF_ROUTING_LABEL without ready-for-agent: the factory takes only issues a worker can finish from the brief alone. Add ready-for-agent, or $drop."
  fi
}
# The spec-run label (labels.sh): the factory works the spec that carries it and the tickets of that spec
# that carry it too, on a spec branch, and routes none of them one by one. So it never sits beside the
# routing label, never on work a person does, and only on a spec or on a ticket whose spec carries it.
WF_SPEC_RUN_LABEL=factory:spec-run
# Refuse a label set the spec run cannot work. $1 names the issue, $2 is how this call drops the spec-run
# label, $3 the parent's number (empty for none, read only when the set carries no spec label), the rest is
# the label set the call would leave behind.
wf_require_spec_run() {
  local subject="$1" drop="$2" parent="$3" plabels; shift 3
  wf_labels_have "$WF_SPEC_RUN_LABEL" "$@" || return 0
  if wf_labels_have "$WF_ROUTING_LABEL" "$@"; then
    wf_die "$subject would carry $WF_ROUTING_LABEL and $WF_SPEC_RUN_LABEL: a spec run routes its tickets itself, so an issue carries one of the two. Drop one of them; $drop, or drop $WF_ROUTING_LABEL."
  fi
  if wf_labels_have ready-for-human "$@"; then
    wf_die "$subject would carry $WF_SPEC_RUN_LABEL and ready-for-human: the factory skips a ticket a person works, so that ticket keeps ready-for-human alone. Drop one of the two labels; $drop."
  fi
  wf_labels_have spec "$@" && return 0
  [ -n "$parent" ] || wf_die "$subject would carry $WF_SPEC_RUN_LABEL but is no spec and has no parent: the label marks a spec and the tickets of its spec run. Label the spec, or make the issue a ticket of a spec that carries it; $drop."
  plabels=$(wf_issue_labels "$parent")
  printf '%s\n' "$plabels" | grep -qxF -e "$WF_SPEC_RUN_LABEL" \
    || wf_die "$subject would carry $WF_SPEC_RUN_LABEL but its spec #$parent does not: a ticket joins a spec run only once its spec is one. Label #$parent first with issue.sh label $parent --add $WF_SPEC_RUN_LABEL, or $drop."
}
# The number of the parent of issue $1 (its spec), or empty when it has none. A failed read other than
# "no parent" is a refusal: the spec-run rule would be judged on a guess.
wf_issue_parent() {
  local out
  if out=$(gh api "repos/$(wf_repo_nwo)/issues/$1/parent" --jq .number 2>&1); then printf '%s' "$out"; return 0; fi
  case "$out" in *"Not Found"*|*404*) return 0 ;; esac
  wf_die "could not read the parent of #$1; is gh authenticated for this repository, and are sub-issues available here?"
}
# The labels issue $1 carries now, one per line, or a refusal: the routing rule holds over the whole set, not
# over the labels one call happens to name.
wf_issue_labels() {
  gh issue view "$1" --json labels --jq '.labels[].name' 2>/dev/null \
    || wf_die "could not read the labels of #$1; is gh authenticated for this repository, and does the issue exist?"
}

# --- The acceptance of a spec (accept-facts.sh, accept-close.sh, accept-due.sh) ---

# Issue $2 of repository $1 as JSON, or a refusal naming it.
wf_issue_json() { gh api "repos/$1/issues/$2" 2>/dev/null || wf_die "could not read issue #$2 in $1; does it exist, and is gh authenticated for this repository?"; }
# The native sub-issues of issue $2 of repository $1 as one JSON array, empty where there are none.
# Fails (non-zero, no output) where the API is unavailable, which is not the same as a spec without tickets.
wf_sub_issues() {
  local raw   # captured first: through a pipe the status would be jq's, which turns an outage into "no tickets"
  raw=$(gh api --paginate "repos/$1/issues/$2/sub_issues?per_page=100" 2>/dev/null) || return 1
  printf '%s' "$raw" | jq -s -c 'add // []'
}
# Refuse anything but an open spec issue. $1 the number, $2 its JSON.
wf_require_open_spec() {
  local labels; labels=$(printf '%s' "$2" | jq -r '[.labels[]?.name] | join(",")')
  case ",$labels," in
    *,spec,*) ;;
    *) wf_die "#$1 is not labelled spec (labels: ${labels:--}); an acceptance judges a spec against the code. Open a planning session on the issue to triage it." ;;
  esac
  [ "$(printf '%s' "$2" | jq -r .state)" = open ] || wf_die "#$1 is closed; it was accepted already. Reopen it to accept it again."
}
# Refuse a worktree that is not the base branch as it is now: the acceptance judges the code on the base
# branch, and a planning worktree branched off before the tickets merged would show the checker old code.
# $1 the base branch. A fetch that fails costs the comparison, not the run.
wf_require_base_up_to_date() {
  local ref="origin/$1" behind ahead
  # The explicit refspec updates refs/remotes/origin/<base>; fetching the branch by name only writes FETCH_HEAD.
  git fetch --quiet origin "+refs/heads/$1:refs/remotes/origin/$1" 2>/dev/null \
    || wf_warn "could not fetch $ref; this worktree may be older than the base branch"
  git rev-parse --verify --quiet "$ref" >/dev/null || { wf_warn "no $ref here; the code the checker reads may be older than the base branch"; return 0; }
  behind=$(git rev-list --count "HEAD..$ref" 2>/dev/null || echo 0)
  ahead=$(git rev-list --count "$ref..HEAD" 2>/dev/null || echo 0)
  [ "$ahead" = 0 ] || wf_warn "this worktree has $ahead commit(s) that $ref does not; the checker reads them as if they were merged"
  [ "$behind" = 0 ] && return 0
  # A planning branch carries no commits, so a fast-forward is the normal fix; a diverged one needs a rebase.
  [ "$ahead" = 0 ] || wf_die "this worktree is $behind commit(s) behind $ref and has $ahead of its own, so the checker would judge the spec against old code. Capture the commits (/planner:prototype) or drop them, then: git rebase $ref"
  wf_die "this worktree is $behind commit(s) behind $ref, so the checker would judge the spec against old code. Update it first: git merge --ff-only $ref"
}
