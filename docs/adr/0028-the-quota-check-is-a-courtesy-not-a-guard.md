# 0028. The quota check is a courtesy, not a guard

Date: 2026-09-21
Status: accepted

## Context
- The factory host and the maintainer share one Claude subscription, and the maintainer cannot wait for quota.
- quota-axi, a third-party CLI, reads the remaining percentage and reset of each Claude and Codex scope.
- A check that can stop the factory stops it when the check breaks, unwatched.
- A run's stream does not say whether it ended on the quota.

## Decision
Before every run the quota check waits while quota is below a minimum, and it fails open so it can never stop the factory.

- It reads every scope a run spends: `all_models` and the scope of each model of each runtime the run's sessions name.
- It waits for the latest reset of every scope below the minimum.
- A session's error triggers one more check of that session's runtime. A used-up quota ends the run `quota`, which resumes after the reset.
- A quota resume happens once in a row; a second stop waits for a person.

## Consequences
- When quota-axi is missing, fails or prints something unexpected, the run starts with a warning.
- quota-axi is pinned at a configured path, never fetched at run time. Without it the check is off.
- A `quota` ending neither spends nor restores the one automatic interruption resume ([ADR 0026](0026-the-factory-never-deletes-work-on-its-own.md)).
- The runbook holds the thresholds and the pinned version.
- Rejected: a gate that fails closed; a changed output would stop the host for days.
- Rejected: parsing the undocumented error text.
