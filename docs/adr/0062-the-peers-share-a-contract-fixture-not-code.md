# 0062. The peers share a contract fixture, not code

Date: 2026-09-27
Status: accepted

## Context
- While the factory drove the worker pipeline, a skill written for a person decided what an unattended host did.
- The factory's drift tests ran the orchestrator's shell, which the controller replaces ([ADR 0056](0056-the-controller-replaces-the-orchestrator-and-runs-every-local-session-headless.md)).
- A test compared two shell copies of the label vocabulary.

## Decision
- The local workflow and the factory are peers. The controller and its plugins serve hands-on sessions; the factory serves unattended delivery and drives its own pipeline in Go.
- Neither is a fork of the other, neither runs the other's code, and neither waits on the other's release.
- One file, `contract/fixture.json`, states the rules the peers share as inputs with expected outputs:
  - the branch contract and the base branch rule;
  - the frontier rule, split by the routing label;
  - the label vocabulary with colour, description and order;
  - the gate's draft and its takeover of a pull request already open on the branch.
- The compact pin is not in the fixture: it concerns only the sessions a peer starts itself.
- Each side's tests read the fixture. A rule changes there first, and the side that disagrees fails naming the case.

## Consequences
- A change to a worker skill never reaches an unattended host, and a change to the factory needs no plugin release.
- A rule outside the fixture may differ between the peers on purpose.
- Rejected: the factory as a driver over the plugins, which ties unattended delivery to skills written for a person.
