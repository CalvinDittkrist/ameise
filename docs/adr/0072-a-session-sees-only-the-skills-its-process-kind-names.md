# 0072. A session sees only the skills its process kind names

Date: 2026-10-04
Status: accepted

## Context
- A session lists every skill it can load to the model on every turn: every bundled skill and every personal skill of the maintainer beside the plugins' own.
- `disableBundledSkills` removes every bundled skill, /simplify with them ([ADR 0071](0071-the-implement-session-runs-the-bundled-simplify-before-it-reports.md)).

## Decision
- Every session gets the skill allowlist of its process kind and sees no other skill.
- A work session: `simplify`, `worker:docs`, `repo-standards:adr` and `repo-standards:docs-check`. A hunt session adds `worker:hunt-tests`. A plan session gets the planner's skills.
- The controller passes the Agent SDK's `skills` option, an exact list in which plugin skills are named `plugin:skill`. Its lists live in `controller/src/sessions/settings.ts`.
- The factory calls claude in print mode, where neither the option nor a flag exists. Its session settings set skillOverrides `off` for every bundled skill but simplify.
- A skill a brief dispatches by its slash command runs whether or not it is listed.
- A personal or project skill named simplify replaces the bundled one in the runtime, so the controller leaves `simplify` out of a work list when one exists. That session has no /simplify.

## Consequences
- Bundled and personal skills cost no context, and the Skill tool rejects them.
- The setting sources a session loads stay as they are.
- A session opened in a terminal resumes without the allowlist: the interactive CLI has no flag or setting for an exact list, and the maintainer drives that session by hand.
- A new skill a session needs is added to the list of its kind.
- The factory's list follows the bundled skills of a Claude Code release; a session's init message shows a new one.
