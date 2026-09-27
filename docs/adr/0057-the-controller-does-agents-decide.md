# 0057. The controller does, agents decide

Date: 2026-09-27
Status: accepted
Supersedes: [0002](0002-scripts-do-agents-decide.md)

## Context
- Deterministic work of the local workflow lives in plugin scripts that skills call ([ADR 0002](0002-scripts-do-agents-decide.md)).
- The controller ([ADR 0056](0056-the-controller-replaces-the-orchestrator-and-runs-every-local-session-headless.md)) runs the same deterministic work as code.

## Decision
- Deterministic work is controller code: claims, worktrees, the gate, the order of stages, the GitHub writes, the records.
- A skill is a prompt that decides. It calls no steering script.
- A session reports through a structured result, and the controller acts on it.

## Consequences
- A rule is written and tested once, in the controller.
- A skill stays short and holds judgement only.
- The plugins' steering scripts leave as the controller takes each over ([ADR 0063](0063-plugins-are-skills-and-agents.md)).
