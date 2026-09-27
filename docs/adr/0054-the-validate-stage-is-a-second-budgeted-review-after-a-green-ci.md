# 0054. The validate stage is a second, budgeted review after a green ci

Date: 2026-09-27
Status: accepted

## Context
- The reviewer panel reads the change before the pull request ([ADR 0040](0040-the-factory-owns-the-delivery-lifecycle-in-go.md)). CI and its fixes may change the branch after it.
- A green pull request went to a person with no second read of the whole change. Spec #233.

## Decision
- A repository's `validate.validators` names reviewers of the panel. Without them the stage is off.
- After a green ci stage, the validators review the branch's diff against its base, in parallel and read-only.
- When every validator passes, the run ends `ready`.
- When one does not, one fix session gets every finding. The run goes back through ci.
- The fix sessions are bounded by `validate.rounds`, default 2. They do not count against `ci.repair_rounds`.
- Past the budget the run ends `ready` all the same. The factory adds a section to the pull request's body that says the validation did not pass.
- A resumed run carries the validation on and does not validate a passed head again.
- The validators' models count toward the quota check ([ADR 0053](0053-the-quota-check-reads-every-runtime-a-run-spends.md)).

## Consequences
- A person reads a pull request that passed a second review, or one whose body says it did not.
- A validation that does not converge costs at most `validate.rounds` fix sessions and ci passes.
- Rejected: blocking the run past the budget. The pull request is green, and a person decides on the findings.
- Rejected: sharing `ci.repair_rounds`, which CI needs.
