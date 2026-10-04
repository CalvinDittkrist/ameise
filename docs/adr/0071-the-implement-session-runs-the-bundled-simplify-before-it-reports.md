# 0071. The implement session runs the bundled /simplify before it reports

Date: 2026-10-04
Status: accepted

## Context
- A first implementation carries clutter: duplicated loops, empty branches, a helper written twice.
- The senior reviewer catches part of it after the gate, and each finding costs a fix session and a gate run.
- Claude Code bundles /simplify: four agents review changed code for cleanup, and it applies the fixes.

## Decision
- The simplify step is the last step of the implement session, before every complete report. It is no node of the delivery graph.
- The implement brief of each peer carries it while the knob is on: `WF_SIMPLIFY` in the controller, `simplify` in the factory, both on by default.
- The brief names the base; the worker passes the diff against it, because a worker branch has no upstream.
  - The factory sets its branch's upstream to `origin/<base>` before the session, because /simplify without a target reviews against the upstream, else main.
- The fixes are refactor commits of the same session. A runtime without /simplify goes on and says so in its report.
- The worker's subagent allowlist adds the read-only Explore type for the skill's reviewers. The factory's inline worker allows it already.
- The factory has no SDK skill option in print mode, so it uses skillOverrides ([ADR 0072](0072-a-session-sees-only-the-skills-its-process-kind-names.md)).

## Consequences
- The reviewers see a tidier change, and fewer fix rounds follow.
- The fix sessions of gate, review, ci and address-reviews run no simplify step.
- Rejected: a stage of its own, a copy of the skill in a plugin, an own cleanup reviewer.
