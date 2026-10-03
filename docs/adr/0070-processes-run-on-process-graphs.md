# 0070. Processes run on process graphs

Date: 2026-10-03
Status: accepted

## Context
- Each stage of the controller started its successor itself, so the order of the stages was written nowhere.
- Every stage repeated one frame: stage, start event, abort, stop, tracking, failure on a throw, announce.
- Issue #378 plans process graphs; #383 adds XState, the engine and the pr node.

## Decision
- A process kind runs on a process graph: an XState v5 machine of nodes, edges by outcome or event, and named guards for budgets.
- The engine uses only XState's pure functions: the resolved state, the edge check, the transition and the JSON. No actor runs.
- The record stays the source of truth with `workflow` and `node`. Guards read a context built from the record at every transition.
- A node returns an outcome and never names its successor. A park keeps the process on its node; only `done` is final.
- An outcome without an edge parks the process failed with a note naming the node and the outcome.
- Graphs are controller code in one registry by process kind. The engine imports no graph and no node.

## Consequences
- The order of a pipeline is in one graph, and a new process kind is a graph, its nodes and a registration.
- A stage that is not a node yet runs through an adapter, so the stages move one at a time.
- Records, states, notes and events keep their shape.
- Rejected: persisted XState snapshots, a second source of truth beside the record.
