# 0059. Sessions read GitHub themselves and write it only through controller tools

Date: 2026-09-27
Status: accepted

## Context
- A planner session writes issues, labels and blockers through the planner's scripts, which own the label vocabulary.
- A brief that carries an issue's text carries its author's words into a prompt.

## Decision
- A brief names the issue, the branch, its base and the reads a session may do with `gh` and `git`. The controller passes no issue text into a prompt.
- A planner session writes GitHub only through the controller tools registered in it: `create_issue`, `set_labels`, `block`, `comment`, `close`, `attach_milestone` and `create_milestone`.
  - A hook of the controller denies every Bash call of that session that writes GitHub.
- The tools own the label vocabulary and refuse what the factory cannot work. No other tool is registered.
- The acceptance writes its gap tickets, deviations and closing comment through the same writes and rules.
- The reviewers, the author session and the spec checker run without Edit, Write, MultiEdit, NotebookEdit and Agent. The hunter runs with Read, Grep and Glob only.
- The planner plugin carries no script that writes GitHub. A planner skill that writes says so and stops when the tools are absent ([ADR 0063](0063-plugins-are-skills-and-agents.md)).

## Consequences
- Every GitHub write of a local session goes through one place.
- A session that judges cannot change what it judges.
- A planner session the controller did not start writes nothing to GitHub.
