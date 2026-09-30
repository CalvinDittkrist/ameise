# 0065. The controller warns of the quota and notifies a turn

Date: 2026-09-28
Status: accepted, amended
Amended by: [0069](0069-the-controller-reads-claude-and-codex-and-warns-a-claim-of-claude.md) (the quota reads Claude and Codex, a claim warns of Claude alone, and a switched-off check says off)
Extends: [0038](0038-the-local-workflow-and-the-factory-are-peers.md) (the peers may differ outside the contract fixture)

## Context
- Issue #263 gives the controller the quota and native notifications.
- The factory works unattended, so its quota check waits below the minimum ([ADR 0037](0037-the-quota-check-waits-below-12-percent-of-the-workers-scope.md), [ADR 0053](0053-the-quota-check-reads-every-runtime-a-run-spends.md)).
- A controller claim is made by a person at the machine, who can judge the quota themselves.

## Decision
- The controller reads the quota of every runtime a work process spends through the configured quota-axi, as the factory reads it.
- The quota never holds a claim. Below `quota_minimum` the claim goes on, and the claim dialog and the CLI warn of it.
- A reading that cannot be had is unknown and warns of nothing. The session of a claim starts without waiting for the reading.
- A process that turns blocked, ready or failed sends one native notification and carries a badge until its page is opened.

## Consequences
- The two peers differ here on purpose. The quota is not in the contract fixture.
- A slow or broken quota-axi costs a claim at most a short wait for its answer, never its session.
- Rejected: a controller that refuses a claim below the minimum. The person who claims is the guard, and a refusal would need a force for a judgement they already made.
