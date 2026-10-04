# 0059. Sessions read GitHub themselves and write it only through controller tools

Date: 2026-09-27
Status: accepted

## Context
- The author of a change is the worst judge of it, and a judge that can edit can change what it judges.
- A brief that carries an issue's text carries its author's words into a prompt.

## Decision
- Planning is a session of its own with the `planner` agent. It writes GitHub issues and no code; prototype code leaves on a branch of its own.
- A brief names the issue, the branch, its base and the reads a session may do with `gh` and `git`. No issue text enters a prompt.
- A planner session writes GitHub only through the controller tools registered in it: `create_issue`, `set_labels`, `block`, `comment`, `close`, `attach_milestone` and `create_milestone`.
- A controller hook denies every Bash call of that session that writes GitHub.
- The tools own the label vocabulary and refuse what the factory cannot work. The acceptance writes through them too.
- Each reviewer is a fresh session with the same brief.
- The reviewers, the author session and the spec checker run without Edit, Write, MultiEdit, NotebookEdit and Agent. The hunter has Read, Grep and Glob only.
- The planner plugin carries no script that writes GitHub.

## Consequences
- Every GitHub write of a local session goes through one place.
- A session that judges never sees the author's reasoning and cannot change what it judges.
- Rejected: a planner that writes code, and reviews inside the author's session.
