# 0008. make check is the single gate and check the single required status check

Date: 2026-09-18
Status: accepted, amended

## Context
- Each repository ran tests, linters and builds differently, so an agent discovered the command every time and sometimes ran less than CI.
- The required status checks in rulesets differed per repository.
- Spec: #3.

## Decision
A `Makefile` target `check` runs everything CI gates on, CI runs it in a job named `check`, and that is the only required status check.

## Consequences
- A repository with several CI jobs keeps them parallel, each on its own make target, and adds an aggregating job named `check`.
- Worker and reviewer prompts name `make check`; `check.sh` fails without a `check` target.
- Agents and humans run what CI runs, and one ruleset fits every repository.
- Make is on every CI image and developer machine; its syntax is a small cost.
- The `Makefile` replaces `scripts/test.sh` in this repository.
- Rejected: a configured command per repository, the variation this removes.
