# 0058. The controller drives the local stages, and a person merges

Date: 2026-09-27
Status: accepted
Supersedes: [0018](0018-worker-stages-hand-facts-over-through-the-worktree-git-dir.md), [0019](0019-the-gate-runs-once-per-review-round.md), [0032](0032-the-stage-measures-the-context-on-entry-and-a-handoff-grants-one-skip.md)

## Context
- The local worker runs every stage after implement in one long session. It hands itself over at checkpoints and passes facts through the worktree's git directory.
- The factory drives its stages in Go, one fresh session each ([ADR 0040](0040-the-factory-owns-the-delivery-lifecycle-in-go.md)).

## Decision
- A `work` process runs implement, gate, review, pr, ci and address-reviews in the controller.
- Implement is the one multi-turn session. It ends when the session reports its commits complete, unless the maintainer holds it open.
- Every later stage is one fresh session with a stage timeout and a result schema. The budgets are the repository's knobs.
- The process record holds each gate result and review round.
- Merge is an action: the maintainer's click in manual mode, automatic in yolo mode once CI is green and the panel is ready.
- There is no validate stage locally.

## Consequences
- No session hands itself over, and nothing depends on a status line.
- The gate record, round record, panel summary and repair record give way to the process record.
