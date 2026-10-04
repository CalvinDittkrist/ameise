#!/usr/bin/env bash
# Helpers shared by the repo-standards scripts. Sourced, never run. The controller restates what it needs in its
# own code (controller/src/stages/standard); plugins and the controller share no code.

# has <dir> <name>: a file or directory of exactly this name is in dir. macOS file systems ignore case,
# so [ -e ] would accept claude.md for CLAUDE.md.
has() { local e; for e in "$1"/*; do [ "${e##*/}" = "$2" ] && return 0; done; return 1; }
# first_of <dir> <name>...: the first name present in dir, exact case.
first_of() { local dir=$1 n; shift; for n in "$@"; do has "$dir" "$n" && { printf '%s' "$n"; return; }; done; }
# The six finding categories of a standardisation, one per auditor, in report order; scaffold.sh --skip takes them.
# shellcheck disable=SC2034 # used by the scripts that source this file
WF_CATEGORIES="files agent-config docs tests-ci workspace security"
# in_list <value> <space separated list>: the list holds exactly this value. Compared word by word, so a value
# that is several words, or that carries a glob character, is not a member of anything.
in_list() { local x; for x in $2; do if [ "$x" = "$1" ]; then return 0; fi; done; return 1; }
# workflow_jobs <file>: the jobs of a GitHub Actions workflow as `id` or `id ("name")`, comma separated,
# name only when it differs from the id (GitHub shows the name as the check).
workflow_jobs() {
  awk '
    /^jobs:[[:space:]]*$/ { in_jobs = 1; ind = 0; next }
    in_jobs && /^[^[:space:]#]/ { in_jobs = 0 }
    !in_jobs || /^[[:space:]]*(#|$)/ { next }
    { match($0, /^ */); d = RLENGTH }
    ind == 0 { ind = d }
    d == ind && /^ *[A-Za-z0-9_-]+:/ { id = $0; sub(/^ */, "", id); sub(/:.*/, "", id); ids[++n] = id; next }
    n && d > ind && sd[n] == "" { sd[n] = d }
    n && d == sd[n] && /^ *name:/ { v = $0; sub(/^ *name:[[:space:]]*/, "", v); sub(/[[:space:]]+$/, "", v); gsub(/^["\047]|["\047]$/, "", v); nm[n] = v }
    END { for (i = 1; i <= n; i++) printf "%s%s%s", (i > 1 ? ", " : ""), ids[i], (nm[i] != "" && nm[i] != ids[i] ? " (\"" nm[i] "\")" : "") }
  ' "$1"
}
# is_check_job: the workflow_jobs output on stdin has a job GitHub reports as the check `check`.
is_check_job() { local jobs; jobs=$(tr ',' '\n' | sed -E 's/^ +//'); grep -Eq '^check$|\("check"\)$' <<<"$jobs"; }
# ci_check_workflow <root>: the first workflow, relative to root, with the job check; empty when none has one.
# It reads the file system, like the other baseline lookups, so an ignored workflow counts too.
ci_check_workflow() {
  local w
  for w in "$1"/.github/workflows/*.yml "$1"/.github/workflows/*.yaml; do
    [ -f "$w" ] && workflow_jobs "$w" | is_check_job && { printf '%s' "${w#"$1"/}"; return; }
  done; return 0
}

# The names the README and the licence may have, the standard's name first. check.sh, scaffold.sh and the
# controller's facts.sh accept exactly these, so the audit, the check and the scaffold agree on what exists. The other baseline files
# have one or two names each, listed where they are used (the Makefile in make's order of precedence).
# shellcheck disable=SC2034
WF_README_NAMES="README.md README.rst README.txt README readme.md" WF_LICENSE_NAMES="LICENSE LICENSE.md LICENSE.txt COPYING"

# The backup tag of a standardisation, and the ruleset that protects it from deletion and moving; workspace.sh
# wants that ruleset.
WF_TAG=pre-standard
tag_ruleset() {
  jq -cn --arg t "$WF_TAG" '{name: ("standard: " + $t), target: "tag", enforcement: "active", bypass_actors: [],
    conditions: {ref_name: {include: ["refs/tags/" + $t], exclude: []}}, rules: [{type: "deletion"}, {type: "update"}]}'
}
# shellcheck disable=SC2034 # used by workspace.sh
# The workflow's label vocabulary (the controller's github tools in controller/src/github/github.ts) plus skill-candidate: name|color|description.
WF_LABELS='ready-for-agent|0E8A16|Fully specified; an agent can take it
needs-triage|FBCA04|A maintainer has to evaluate this
needs-info|D876E3|Waiting on the reporter
ready-for-human|1D76DB|Needs a human to implement
wontfix|FFFFFF|Will not be actioned; the closing comment says why
spec|5319E7|Spec issue; its tickets carry the work
factory|FFC799|Routed to the factory host; local claims leave it alone
factory:spec-run|F29D4B|Routes a spec and its tickets to a spec run on the factory host
bug|D73A4A|Something is broken
enhancement|A2EEEF|New feature or improvement
skill-candidate|C5DEF5|A removed skill that could move into the marketplace'

# The ADR rule's shared parts: check.sh enforces the rule, new-adr.sh warns on a full set.
# adr_max: the most ADRs a repository keeps, WF_ADR_MAX or 20. Prints the value and returns 1 when it is not a
# positive integer.
adr_max() { local m=${WF_ADR_MAX-20}; printf '%s' "$m"; case "$m" in '' | *[!0-9]* | 0*) return 1 ;; esac; }
# adr_next_free <index>: the number of the index's line "Next free number: NNNN"; empty when the index has none.
adr_next_free() {
  [ -f "$1" ] || return 0
  sed -nE '/^Next free number: [0-9]{4}[[:space:]]*$/{s/^Next free number: ([0-9]{4}).*/\1/p;q;}' "$1"
}
# adr_refs <root> <adrs>: each reference to an ADR with no file, in the files listed on stdin relative to root.
# adrs lists the ADR file names, one per line. Changelogs are not read, since they quote history.
adr_refs() {
  local awk_file
  awk_file="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/adr-refs.awk"
  grep -Eiv '(^|/)changelog[^/]*$' | grep . | sed 's|^|./|' | (cd "$1" && tr '\n' '\0' \
    | xargs -0 grep -IlE -e 'ADR[ -]?[0-9]{4}' -e '[0-9]{4}-[^/[:space:]]*\.md' -- 2>/dev/null \
    | tr '\n' '\0' | xargs -0 awk -v adrs="$2" -f "$awk_file")
}
