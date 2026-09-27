# 0053. The quota check reads every runtime a run spends

Date: 2026-09-26
Status: accepted
Amends: [0044](0044-the-quota-check-reads-the-scope-of-every-model-a-run-spends.md): which providers the check reads

## Context
- [ADR 0044](0044-the-quota-check-reads-the-scope-of-every-model-a-run-spends.md) reads the Claude scopes of the models a run spends.
- A reviewer on Codex ([ADR 0052](0052-sessions-run-on-a-runtime-and-codex-is-one-of-them.md)) spends the host's Codex login, which that reading does not see.
- The Codex CLI reports no quota non-interactively. quota-axi reads it with `--provider codex --json`.
- A Codex turn at its limit fails with "You've hit your usage limit" and exit status 1.

## Decision
- Before a run whose panel or change classes name a Codex reviewer, the check also asks the configured quota-axi for the Codex provider.
- It reads the Codex `all_models` scope and the scope of the Codex model. A scope below `quota_minimum` holds the run until its reset.
- After a session's error, the check reads the provider of that session's runtime. A used-up Codex quota ends the run `quota`, resumed after the reset.
- A failed Codex reading starts the run with a warning ([ADR 0028](0028-the-quota-check-is-a-courtesy-not-a-guard.md)).
- The rest of 0044 stands.

## Consequences
- A run starts only when every runtime it runs on has quota left.
- A Codex reviewer at its limit ends the run `quota`, not `failed`.
- A run without a Codex reviewer calls quota-axi once, as before.
- Rejected: reading the quota from the usage-limit text, which names no reset to wait for.
