# 0052. Sessions run on a runtime, and Codex is one of them, as a reviewer first

Date: 2026-09-26
Status: accepted
Amends: [0039](0039-every-session-reports-through-a-structured-result.md), [0042](0042-the-factory-carries-its-own-prompts-and-updates-no-plugin.md): what a session is

## Context
- Every session was a print-mode `claude` call, so every reviewer was a Claude model.
- A prototype ran `codex exec` read-only with the reviewer schema as its output schema. Its last message held that schema.
- Codex prints its own events and names no model in them.

## Decision
- Every session runs on a runtime, `claude` or `codex`. The factory builds the call and reads the events by the runtime.
- A reviewer definition names its runtime. The five existing reviewers run on `claude`.
- The reviewer `codex` runs `codex exec` in the worktree: read-only sandbox, its model named, standard input closed, last message to a file.
- That last message is its structured result, read with a Claude reviewer's checks. A result that does not fit fails the run by name.
- A repository adds it by naming `codex` in its review knobs.
- A host without `codex` or its login ends such a run `blocked`. No reviewer is skipped.

## Consequences
- The panel can hold a model of another family.
- The run record names the runtime and the model of every session. Codex reports no cost, so its sessions are not in the run's cost.
- The quota check reads Codex too ([ADR 0053](0053-the-quota-check-reads-every-runtime-a-run-spends.md)).
- Sessions that write on the branch stay on Claude Code.
- Rejected: `codex review`, which takes no output schema.
