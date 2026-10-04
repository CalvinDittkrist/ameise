# 0009. The profile is derived from GitHub, with two branch models, rulesets with no bypass and promotion by merge commit

Date: 2026-09-18
Status: accepted

## Context
- Public and private repositories need different settings: licence, security policy, secret scanning.
- Some repositories stage releases on `dev`. A config file per repository would be one more thing to keep in sync.
- Settings set by hand differed in ways nobody chose, and classic branch protection allows admin bypass and cannot protect tags.
- A squashed promotion gives `main` a commit `dev` never gets, so later promotions repeat earlier commits and conflict.

## Decision
The profile is visibility plus branch model, read from GitHub on every run: `main` alone, or `dev` plus `main`. An idempotent script sets the workspace through rulesets with no bypass, and a promotion merges with a merge commit.

## Consequences
- The model is `dev` plus `main` when the default branch is `dev`. No config file overrides the profile.
- The script prints the difference first and applies it only on a flag, after it stores a snapshot. A second run reports nothing.
- Merges are squash only. With `dev` plus `main`, `main` allows merge commits for the promotion, and the release tags that commit.
- Repositories with other layouts, such as release branches or `staging`, must move to one of the two models.
- Rejected: a config file per repository, arbitrary branch chains, configuring by hand, classic branch protection and squashing the promotion.
