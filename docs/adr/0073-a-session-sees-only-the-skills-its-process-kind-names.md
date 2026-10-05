# 0073. A session sees only the skills its process kind names

Date: 2026-10-04
Status: accepted

## Context
- A session lists every skill it can load to the model on every turn, bundled and personal ones included.
- `disableBundledSkills` removes every bundled skill, /simplify with them.

## Decision
- Every session gets the skill allowlist of its process kind and sees no other skill.
- A work session: `simplify`, `worker:docs`, `repo-standards:adr` and `repo-standards:docs-check`. A hunt session adds `worker:hunt-tests`. A plan session gets the planner's skills.
- The controller passes the Agent SDK's `skills` option, an exact list in which plugin skills are named `plugin:skill`. Its lists live in `controller/src/sessions/settings.ts`.
- The factory calls claude in print mode, which has no such option. Its settings switch off every bundled skill but simplify.
- They also switch off every personal and project skill and command file it finds, since a skill left out of skillOverrides is on.
- A skill a brief dispatches by its slash command runs whether or not it is listed.
- A personal or project skill or command file named simplify replaces the bundled one, so both then leave it off.

## Consequences
- Unlisted skills cost no context, and the Skill tool rejects them.
- The setting sources a session loads stay as they are.
- A session resumed in a terminal has no allowlist; the maintainer drives it by hand.
- A new skill a session needs is added to the list of its kind.
- The factory's list follows a Claude Code release's bundled skills; the init message shows new ones.
