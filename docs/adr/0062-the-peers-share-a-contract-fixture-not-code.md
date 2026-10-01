# 0062. The peers share a contract fixture, not code

Date: 2026-09-27
Status: accepted; amended 2026-10-01 (the gate's draft and its takeover are in the fixture too)
Extends: [0022](0022-the-factory-is-a-second-driver-over-the-worker-pipeline.md), [0038](0038-the-local-workflow-and-the-factory-are-peers.md)

## Context
- The factory's drift tests ran the orchestrator's shell. The controller replaces that shell ([ADR 0056](0056-the-controller-replaces-the-orchestrator-and-runs-every-local-session-headless.md)), so the tests would bind to code that goes.
- The label vocabulary was bound by a test that compared two shell copies.

## Decision
- One file, `contract/fixture.json`, states the rules the peers share as inputs with expected outputs.
  - The branch contract and the base branch rule.
  - The frontier rule, split by the routing label.
  - The label vocabulary with colour, description and order.
  - Amended 2026-10-01: the gate's draft and its takeover of a pull request already open on the branch.
- The compact pin is not in the fixture: it concerns only the sessions a peer starts itself, not a shared state.
- Each side's tests read the fixture. No test of one side runs the other side's code.
- A rule changes in the fixture first. The side that disagrees fails and names the case.

## Consequences
- The peers still share no code, and the controller's tests need no shell.
- A rule outside the fixture may differ between the peers on purpose.
