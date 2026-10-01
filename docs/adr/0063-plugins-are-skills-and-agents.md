# 0063. Plugins are skills and agents

Date: 2026-09-27
Status: accepted; amended 2026-10-01 (the Python suite is gone, and the tests of the scripts that stay shell run in the controller's vitest suite)

## Context
- The worker, planner and repo-standards plugins carry hooks, state scripts, steering scripts and Herdr calls beside their skills and agents.
- The controller takes the steering over ([ADR 0056](0056-the-controller-replaces-the-orchestrator-and-runs-every-local-session-headless.md), [ADR 0057](0057-the-controller-does-agents-decide.md)).

## Decision
- A plugin holds skills and agents: prompts that decide.
- Hooks and steering scripts leave the plugins as the controller takes each over.
- A skill that needs the controller says so when the controller is absent.
- A skill that needs no controller keeps working from the marketplace.

## Consequences
- A plugin change touches prompts, not steering.
- A repository without the controller is never left with a silent failure.
- The Python suite shrinks with the scripts it tests.
  - Amended 2026-10-01: the suite is gone. The tests of the scripts that stay shell are vitest tests under `controller/test/scripts/`.
