# 0059. Sessions read GitHub themselves and write it only through controller tools

Date: 2026-09-27
Status: accepted

## Context
- A planner session writes issues, labels and blockers through the planner's scripts, which own the label vocabulary.
- A brief that carries an issue's text carries its author's words into a prompt.

## Decision
- A brief names the issue, the branch, its base and the reads a session may do with `gh` and `git`. The controller passes no issue text into a prompt.
- A session writes GitHub only through controller tools registered in the session: create issue, set labels, link blockers, comment, close and attach milestone.
- The tools own the label vocabulary and refuse what the factory cannot work. No other tool is registered.
- Reviewers, auditors, the spec checker, the author and the hunter run with Read, Grep and Glob only.

## Consequences
- Every GitHub write of a local session goes through one place.
- A session that judges cannot change what it judges.
