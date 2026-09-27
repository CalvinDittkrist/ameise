# 0055. The spec pull request ends the spec run

Date: 2026-09-27
Status: accepted

## Context
- A spec run holds a spec on its spec branch, and its tickets are squash-merged into that branch. Nothing brought the spec branch to the base. Issue #236.
- A ticket that carries `ready-for-human`, or is blocked, is no work for the factory, and a spec run could wait on it without anyone knowing.

## Decision
- Once every sub-issue of the spec is closed, a run on the spec itself (signal `spec-pull`) opens the spec pull request from the spec branch to the base.
- Its body says `Part of #<spec>`, never `Closes`: the acceptance stays with the planner.
- It goes through the ci stage alone, within the repair budget. Green ends it `ready` with a review request, and a person merges it.
- The poll that reads it merged ends the spec run `done`.
- A spec run whose open tickets all wait for a person comments once per ticket on the spec, mentioning the `notify` logins.
- Letting a spec go leaves an open spec pull request open for a person.

## Consequences
- A spec reaches its base through one pull request that a person merges.
- A person learns of a ticket the spec run waits on.
- Rejected: merging the spec pull request in the factory. The base is the person's to change.
