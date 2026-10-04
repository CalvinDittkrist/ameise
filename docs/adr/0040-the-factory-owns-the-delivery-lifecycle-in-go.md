# 0040. The factory owns the delivery lifecycle in Go and starts one fresh session per stage

Date: 2026-09-23
Status: accepted

## Context
- Inside one worker session the agent drove the gate, the reviews, the pull request, CI and the repairs.
- Each transition is deterministic, cost tokens and could be skipped or misread.
- A plugin updated before each run let a hands-on skill steer an unattended host with no deploy.

## Decision
The factory owns the delivery pipeline in Go as fixed stages, from implement to merge, and carries the prompts of its sessions.

- A stage that needs judgement starts one fresh session with a brief of facts and reads one structured result ([ADR 0039](0039-every-session-reports-through-a-structured-result.md)). Other stages run a command or a GitHub call.
- Sessions are never resumed. Reviewers and the pull request author are read-only through the call's tool restriction.
- The configuration holds knobs, never steps.
- Each session kind has its prompt in the binary, versioned with it. No plugin runs, and the factory updates nothing before a run.
- A run records the factory and Claude Code versions.
- A resumed run reads its stage from git, GitHub and its record, which names its pull request and whether it is the gate's draft.

## Consequences
- The agent no longer counts, waits or records.
- A host needs claude, git, gh and the factory binary.
- A change to what an unattended session is told is a factory release.
- Rejected: an executor abstraction or a configurable step list.
- Rejected: updating a plugin before a run.
