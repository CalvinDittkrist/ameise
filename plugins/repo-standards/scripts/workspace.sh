#!/usr/bin/env bash
# Compare the GitHub workspace of this repository with the standard (docs/repo-standard.md, ADR 0011).
# Usage: workspace.sh
# Changes nothing: it derives the profile, reads the current state and prints one `diff:` line per
# difference, `manual:` for what only a person can change and `blocked:` for what stops an apply. The
# standardize process of the controller applies the differences; check.sh reports them as warnings.
# Env: WF_PROJECT_TEMPLATE=<owner>/<number>, the project the controller copies when the repository has none linked.
set -euo pipefail
# shellcheck source=lib.sh
. "$(dirname "$0")/lib.sh"
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

case "${1:-}" in
  '') ;;
  -h|--help) sed -n '2,7p' "$0"; exit 0 ;;
  *) die "unknown argument $1; usage: workspace.sh (the standardize process of the controller applies the differences)" ;;
esac
for c in gh jq; do command -v "$c" >/dev/null 2>&1 || die "$c is required but not on PATH"; done
tpl="${WF_PROJECT_TEMPLATE:-}"
if [ -n "$tpl" ] && ! printf '%s' "$tpl" | grep -Eq '^[A-Za-z0-9-]+/[0-9]+$'; then
  die "WF_PROJECT_TEMPLATE must look like <owner>/<number>, got '$tpl'"
fi

err=$(mktemp); trap 'rm -f "$err"' EXIT
# get <path>: a GitHub API GET. Any failure is fatal.
get() { gh api "$1" 2>"$err" || die "cannot read $1: $(tail -n1 "$err")"; }
# get_all <path>: every page of a list, merged into one array.
get_all() {
  local out
  out=$(gh api --paginate "$1" 2>"$err") || die "cannot read $1: $(tail -n1 "$err")"
  printf '%s' "$out" | jq -s 'add // []'
}
# get_opt <path> [plan]: like get, but a 404 prints nothing (an empty 2xx prints true). With plan, a 403
# because the account's plan lacks the feature returns 3 instead of failing.
get_opt() {
  local out
  if out=$(gh api "$1" 2>"$err"); then printf '%s' "${out:-true}"
  elif grep -q 'HTTP 404' "$err"; then return 0
  elif [ -n "${2:-}" ] && grep -q 'HTTP 403' "$err" && grep -qi 'upgrade' "$err"; then return 3
  else die "cannot read $1: $(tail -n1 "$err")"; fi
}
nwo=$(gh repo view --json nameWithOwner -q .nameWithOwner 2>"$err") || die "cannot read the GitHub repository: $(tail -n1 "$err"); run gh auth status"
owner=${nwo%%/*}
repo=$(get "repos/$nwo")
[ "$(printf '%s' "$repo" | jq -r '.permissions.admin // false')" = true ] || die "admin rights on $nwo are needed to read and change its settings"
visibility=$(printf '%s' "$repo" | jq -r .visibility)
default=$(printf '%s' "$repo" | jq -r .default_branch)
# The profile (ADR 0009): dev plus main when the default branch is dev, otherwise main alone.
if [ "$default" = dev ]; then model="dev+main"; branches="main dev"; else model=main; branches=main; fi

diffs="" n=0 manual="" blocked=""
found() { diffs="$diffs$*"$'\n'; n=$((n + 1)); } # one difference to the standard
step() { manual="$manual$*"$'\n'; }          # something only a person can change
block() { blocked="$blocked$*"$'\n'; }       # a reason an apply refuses
case "$default" in main|dev) ;; *)
  block "the default branch is $default, but the standard knows main alone or dev plus main; rename it to main (Settings > Branches, or gh api --method POST repos/$nwo/branches/$default/rename -f new_name=main), then run workspace.sh again" ;;
esac

# Merge settings, wiki and discussions. With dev plus main the promotion needs merge commits.
merge_commit=false; [ "$model" = main ] || merge_commit=true
want_repo=$(jq -cn --argjson mc "$merge_commit" '{allow_squash_merge: true, allow_merge_commit: $mc, allow_rebase_merge: false,
  delete_branch_on_merge: true, squash_merge_commit_title: "PR_TITLE", has_wiki: false, has_discussions: false}')
repo_patch=$(printf '%s' "$repo" | jq -c --argjson w "$want_repo" '. as $r | $w | with_entries(select($r[.key] != .value))')
while IFS= read -r l; do [ -z "$l" ] || found "repo $l"; done <<EOF
$(printf '%s' "$repo" | jq -r --argjson p "$repo_patch" '. as $r | $p | to_entries[] | "\(.key): \($r[.key]) -> \(.value)"')
EOF

# Rulesets, named "standard: <ref>" so they are recognised on the next run. Only the pull request
# rule and the required checks carry parameters; canon drops what GitHub adds and the standard leaves open.
ruleset() { # ruleset <branch> <linear true|false> <merge methods as JSON>
  jq -cn --arg b "$1" --argjson lin "$2" --argjson mm "$3" '{name: ("standard: " + $b), target: "branch", enforcement: "active",
    bypass_actors: [], conditions: {ref_name: {include: ["refs/heads/" + $b], exclude: []}},
    rules: ([{type: "deletion"}, {type: "non_fast_forward"},
      {type: "pull_request", parameters: {required_approving_review_count: 0, dismiss_stale_reviews_on_push: false,
        require_code_owner_review: false, require_last_push_approval: false, required_review_thread_resolution: true,
        allowed_merge_methods: $mm}},
      {type: "required_status_checks", parameters: {strict_required_status_checks_policy: false,
        required_status_checks: [{context: "check"}]}}] + (if $lin then [{type: "required_linear_history"}] else [] end))}'
}
canon='def canon: {target, enforcement, bypass_actors: (.bypass_actors // []),
  include: (.conditions.ref_name.include // [] | sort), exclude: (.conditions.ref_name.exclude // [] | sort),
  rules: ([.rules[] | {type} + (
    if .type == "pull_request" then {p: (.parameters | {required_approving_review_count, dismiss_stale_reviews_on_push,
      require_code_owner_review, require_last_push_approval, required_review_thread_resolution,
      m: (.allowed_merge_methods // ["merge", "rebase", "squash"] | sort)})}
    elif .type == "required_status_checks" then {p: (.parameters | {s: .strict_required_status_checks_policy,
      c: ([.required_status_checks[].context] | sort)})}
    else {} end)] | sort_by(.type))};'
want_rulesets=""
for b in $branches; do
  if [ "$model" = "dev+main" ] && [ "$b" = main ]; then want_rulesets="$want_rulesets$(ruleset main false '["merge","squash"]')"$'\n'
  else want_rulesets="$want_rulesets$(ruleset "$b" true '["squash"]')"$'\n'; fi
done
want_rulesets="$want_rulesets$(tag_ruleset)"
# Classic branch protection is replaced by the ruleset; it is removed after the ruleset is in place.
# GitHub answers 403 when the plan has neither (a private repository on GitHub Free).
branch_rules=0 rules=1
for b in $branches; do
  rc=0; p=$(get_opt "repos/$nwo/branches/$b/protection" plan) || rc=$?
  [ "$rc" = 0 ] || { [ "$rc" = 3 ] && rules=0 && break; exit 1; }
  [ -n "$p" ] || continue
  found "branch-protection $b: classic -> removed (the ruleset replaces it)"
done
if [ "$rules" = 0 ]; then
  step "rulesets: not offered for this private repository on its account's plan; upgrade the account to GitHub Pro or make the repository public, then run workspace.sh again"
  want_rulesets=""
else existing=$(get_all "repos/$nwo/rulesets?includes_parents=false&per_page=100"); fi
while IFS= read -r want; do
  [ -n "$want" ] || continue
  name=$(printf '%s' "$want" | jq -r .name)
  id=$(printf '%s' "$existing" | jq -r --arg n "$name" '[.[] | select(.name == $n)] | first | .id // empty')
  if [ -z "$id" ]; then
    found "ruleset $name: missing -> create"
  else
    cur=$(get "repos/$nwo/rulesets/$id")
    if [ "$(jq -n --argjson a "$cur" --argjson b "$want" "$canon"' ($a | canon) == ($b | canon)')" = true ]; then continue; fi
    found "ruleset $name: differs -> replace"
  fi
  [ "$(printf '%s' "$want" | jq -r .target)" = tag ] || branch_rules=1
done <<EOF
$want_rulesets
EOF

# The required check must exist before a ruleset requires it, or nothing could merge.
if [ "$branch_rules" = 1 ]; then
  runs=$(get "repos/$nwo/commits/$default/check-runs?check_name=check&per_page=1" | jq -r '.total_count // 0')
  [ "$runs" != 0 ] || block "the default branch $default has no CI job named check; add a CI job named check that runs make check on every push to $default, merge it so it runs on the head of $default, then run the apply again"
fi

# Labels: the workflow vocabulary plus skill-candidate (lib.sh); GitHub matches label names ignoring case.
labels=$(get_all "repos/$nwo/labels?per_page=100")
while IFS='|' read -r name _; do
  printf '%s' "$labels" | jq -e --arg n "$name" 'any(.[]; (.name | ascii_downcase) == $n)' >/dev/null && continue
  found "label $name: missing -> create"
done <<EOF
$WF_LABELS
EOF

# Dependabot alerts (204 when on, 404 when off) and security updates; read-only Actions token.
alerts=$(get_opt "repos/$nwo/vulnerability-alerts"); if [ -n "$alerts" ]; then alerts=on; else alerts=off; fi
[ "$alerts" = on ] || found "dependabot alerts: off -> on"
fixes=$(get_opt "repos/$nwo/automated-security-fixes")
fixes=$(printf '%s' "${fixes:-null}" | jq -r 'if .enabled == true then "on" else "off" end')
[ "$fixes" = on ] || found "dependabot security-updates: off -> on"
actions=$(get "repos/$nwo/actions/permissions/workflow")
token=$(printf '%s' "$actions" | jq -r .default_workflow_permissions)
[ "$token" = read ] || found "actions default-token: $token -> read"
approves=$(printf '%s' "$actions" | jq -r '.can_approve_pull_request_reviews // false')
[ "$approves" = false ] || found "actions token-approves-pull-requests: true -> false"

# Public repositories: secret scanning, push protection, private vulnerability reporting.
sa_patch="{}" pvr=""
if [ "$visibility" = public ]; then
  sa_patch=$(printf '%s' "$repo" | jq -c '.security_and_analysis // {} | [("secret_scanning", "secret_scanning_push_protection") as $k
    | select(.[$k].status != "enabled") | {($k): {status: "enabled"}}] | add // {}')
  for k in $(printf '%s' "$sa_patch" | jq -r 'keys[]'); do
    found "$(printf '%s' "$k" | tr _ -): $(printf '%s' "$repo" | jq -r --arg k "$k" '.security_and_analysis[$k].status // "disabled"') -> enabled"
  done
  pvr=$(get_opt "repos/$nwo/private-vulnerability-reporting")
  pvr=$(printf '%s' "${pvr:-null}" | jq -r 'if .enabled == true then "on" else "off" end')
  [ "$pvr" = on ] || found "private-vulnerability-reporting: off -> on"
elif [ "$(printf '%s' "$repo" | jq -r '.security_and_analysis.secret_scanning.status // "unavailable"')" = unavailable ]; then
  step "secret scanning and push protection: not offered for this private repository (GitHub Secret Protection needs an organisation on GitHub Team or Enterprise); make the repository public or move it to such an organisation to get them"
fi

# Milestones: close open ones that are empty, or orphaned (not named vX.Y.Z, so never released, and
# nothing open). Never creates one.
close=$(get_all "repos/$nwo/milestones?state=open&per_page=100" | jq -c '[.[] | select(.open_issues == 0 and
  (.closed_issues == 0 or (.title | test("^v[0-9]+\\.[0-9]+\\.[0-9]+$") | not)))
  | {number, title, open_issues, closed_issues, why: (if .closed_issues == 0 then "empty" else "orphaned" end)}] | sort_by(.number)')
while IFS= read -r l; do [ -z "$l" ] || found "$l"; done <<EOF
$(printf '%s' "$close" | jq -r '.[] | "milestone \(.title): open, \(.why) -> closed"')
EOF

# Project: one per repository, copied from the template when none is linked, and carrying the standard's
# Status and Priority fields. The API cannot create or turn on project workflows.
# The fields of a project are a union; the interface ProjectV2FieldCommon gives the name and the type of
# every member, so a field type GitHub adds later is read too instead of looking like a missing field.
# GitHub caps a project at 50 fields, so the one page of 100 the query asks for is always all of them.
q='query($o: String!, $n: String!) { repository(owner: $o, name: $n) { projectsV2(first: 20) { nodes {
  id number title url closed workflows(first: 50) { nodes { name enabled } }
  fields(first: 100) { nodes { ... on ProjectV2FieldCommon { name dataType }
    ... on ProjectV2SingleSelectField { options { name } } } } } } } }'
autoadd="turn on Workflows > Auto-add to project with the filter is:issue,pr is:open for $nwo (the API cannot create or turn on project workflows)"
# The fields every project has (docs/repo-standard.md, Projects). A field is matched by name ignoring case
# and its options are compared by name alone, ignoring case and order; colour and description are what a
# missing field is created with, never a reason to report a difference.
want_fields='[{"name": "Status", "options": [
    {"name": "Triage", "color": "GRAY", "description": "Not planned yet"},
    {"name": "Ready", "color": "BLUE", "description": "Ready to be picked up"},
    {"name": "In progress", "color": "YELLOW", "description": "Being worked on"},
    {"name": "In review", "color": "ORANGE", "description": "Waiting for review"},
    {"name": "Done", "color": "GREEN", "description": "Merged or closed"}]},
  {"name": "Priority", "options": [
    {"name": "P0", "color": "RED", "description": "Now"},
    {"name": "P1", "color": "ORANGE", "description": "Next"},
    {"name": "P2", "color": "YELLOW", "description": "Soon"},
    {"name": "P3", "color": "GRAY", "description": "Someday"}]}]'
projects_read=1
if ! projects=$(gh api graphql -f query="$q" -f o="$owner" -f n="${nwo#*/}" 2>"$err"); then
  grep -q 'read:project' "$err" || die "cannot read the projects of $nwo: $(tail -n1 "$err")"
  projects="[]" projects_read=0; step "project: not checked, the gh token cannot read projects; run gh auth refresh -s project, then run workspace.sh again"
else
  projects=$(printf '%s' "$projects" | jq -c '[.data.repository.projectsV2.nodes[] | select(.closed | not)]')
fi
open_projects=$(printf '%s' "$projects" | jq length)
if [ "$projects_read" = 0 ]; then :
elif [ "$open_projects" = 0 ]; then
  if [ -n "$tpl" ]; then found "project: none linked -> copy of $tpl"; step "project (the copy): $autoadd"
  else step "project: none linked; set WF_PROJECT_TEMPLATE=<owner>/<number> and run again to copy the template project, or create one by hand"; fi
else
  [ "$open_projects" = 1 ] || step "projects: $open_projects open ones are linked ($(printf '%s' "$projects" | jq -r '[.[].url] | join(", ")')); the standard wants one; unlink or close the others by hand"
  while IFS= read -r url; do [ -z "$url" ] || step "project $url: $autoadd"; done <<EOF
$(printf '%s' "$projects" | jq -r '.[] | select(any(.workflows.nodes[]; .name == "Auto-add to project" and .enabled) | not) | .url')
EOF
  # One verdict line per project and required field: the kind, the project (its node id and its url), the
  # field, the line to print. Every column is filled, because read collapses repeated tabs. A field that is
  # there but differs is never rewritten: replacing an option list clears that field on every item. A missing
  # one is created only while a single project is linked, so no write lands in a project the run just asked
  # the maintainer to unlink.
  single=false; [ "$open_projects" != 1 ] || single=true
  while IFS=$'\t' read -r kind _ _ _ line; do
    case "$kind" in
      diff) found "$line" ;;
      manual) step "$line" ;;
    esac
  done <<EOF
$(printf '%s' "$projects" | jq -r --argjson want "$want_fields" --argjson single "$single" '
  def names: [.[].name | ascii_downcase] | sort;
  def list: [.[].name] | join(", ");
  .[] as $p | $want[] as $w | ([$p.fields.nodes[] | select(((.name // "") | ascii_downcase) == ($w.name | ascii_downcase))] | first) as $f
  | "project \($p.url) field \($w.name)" as $where | ($w.options | list) as $wants | "\($p.id)\t\($p.url)\t\($w.name)" as $cols
  | if $f == null then (if $single then "diff\t\($cols)\t\($where): missing -> create single-select with \($wants)"
      else "manual\t\($cols)\t\($where): missing; the run creates it only while one project is linked, so unlink the others and run again, or create the single-select with \($wants) by hand" end)
    elif $f.dataType != "SINGLE_SELECT" then "manual\t\($cols)\t\($where): a \(($f.dataType // "unknown") | ascii_downcase | gsub("_"; " ")) field, but the standard wants a single-select with \($wants); change it by hand"
    elif ($f.options | names) != ($w.options | names) then "manual\t\($cols)\t\($where): options \($f.options | list), but the standard wants \($wants); change them by hand (replacing an option list clears the field on every item)"
    else empty end')
EOF
fi

printf 'repository: %s\n' "$nwo"
printf 'profile: %s, %s\n' "$visibility" "$model"
printf '%s' "$diffs" | sed 's/^/diff: /'
printf '%s' "$manual" | sed 's/^/manual: /'
printf '%s' "$blocked" | sed 's/^/blocked: /'
printf 'differences: %s\n' "$n"
[ "$n" = 0 ] || [ -n "$blocked" ] || printf 'next: the standardize process of the controller makes these changes\n'
