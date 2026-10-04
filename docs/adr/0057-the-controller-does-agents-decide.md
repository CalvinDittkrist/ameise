# 0057. The controller does, agents decide

Date: 2026-09-27
Status: accepted

## Context
- The local workflow needs deterministic steps, such as claims, worktrees, the gate and the GitHub writes, and judgement, such as code, reviews and plans.
- A rule kept both in a script and in a prompt drifts. A plugin also runs in repositories where the controller is absent.

## Decision
- Deterministic work is controller code: claims, worktrees, the gate, the order of stages, the GitHub writes, the records and the steps of a standardisation.
- A script the controller owns is no place for deterministic work.
- A plugin holds skills and agents: prompts that decide. A skill calls no steering script.
- A plugin keeps a script only for its skills' injections and the standard check.
- A session reports through a structured result, and the controller acts on it.
- The controller marks every session it starts with `WF_CONTROLLER=1`. A skill that needs the controller says so and stops without it.
- A skill that needs no controller keeps working from the marketplace.

## Consequences
- A rule is written and tested once, in the controller.
- A skill stays short and holds judgement only, so a plugin change touches prompts, not steering.
- A repository without the controller is never left with a silent failure.
- The tests of the scripts that stay shell are vitest tests under `controller/test/scripts/`.
