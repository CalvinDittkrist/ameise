#!/usr/bin/env bash
# Print the session facts a worker skill needs (mode, issue, base, how subagents run and whether the controller
# runs this session) as key: value lines.
set -uo pipefail
. "$(dirname "$0")/lib.sh"
wf_kv mode "${WF_MODE:-manual}"
wf_kv issue "$(wf_issue_label)"
wf_kv base "$(wf_base_branch)"

# The controller starts a session with background tasks disabled, so a subagent's report is the result of the
# Agent call; a session started by hand has no such setting and its subagents run in the background, where
# ending the turn is how the agent waits, since a sleep loop costs a full turn each time. The truthy set is the
# one Claude Code itself applies to a boolean environment variable (2.1.278: whitespace removed, lowercased,
# then matched against 1, true, yes, on).
case "$(printf '%s' "${CLAUDE_CODE_DISABLE_BACKGROUND_TASKS:-}" | tr '[:upper:]' '[:lower:]' | tr -d '[:space:]')" in
  1|true|yes|on) wf_kv subagents "foreground" ;;
  *) wf_kv subagents "background" ;;
esac

# The controller marks every session it starts with WF_CONTROLLER=1 (ADR 0063). A skill that needs it reads
# this line and, without it, says the line to the user and stops, rather than failing somewhere later.
if [ "${WF_CONTROLLER:-}" = 1 ]; then
  wf_kv controller "present"
else
  wf_kv controller "absent; this skill needs the ameise controller, which runs its stages: start it with 'ameise', add this repository as a project and start the process from its dashboard"
fi
