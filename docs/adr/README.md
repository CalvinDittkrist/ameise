# Architecture Decision Records

An ADR records a decision that holds today and is hard to reverse or surprising without context ([ADR 0071](0071-adrs-are-a-capped-set-of-decisions-that-hold-today.md)). Format: [MADR](https://adr.github.io/madr/), trimmed. Create one with `/repo-standards:adr <title>`.

- The set holds at most 20. A new ADR on a full set removes one, or moves it as a rule into the document of its area.
- A changed decision edits its ADR in place, and a decision that no longer holds is deleted.
- A status is proposed or accepted. A number is never reused.

Next free number: 0072

| ADR | Title | Status |
| --- | --- | --- |
| [0005](0005-sandboxing-strategy.md) | Sandboxing strategy: layered, Docker Sandboxes opt-in | accepted; the Docker sandbox flag superseded by [0056](0056-the-controller-replaces-the-orchestrator-and-runs-every-local-session-headless.md) |
| [0007](0007-agents-md-is-the-instruction-source.md) | AGENTS.md is the instruction source and CLAUDE.md imports it | accepted |
| [0008](0008-make-check-is-the-single-gate.md) | make check is the single gate and check the single required status check | accepted |
| [0009](0009-profile-derived-from-github-with-two-branch-models.md) | The profile is derived from GitHub, with exactly two branch models | accepted |
| [0010](0010-standardisation-audits-read-only-and-backs-up-before-deleting.md) | Standardisation audits read-only, deletes through a pull request and backs up with a protected tag | accepted |
| [0011](0011-github-workspace-configured-by-an-idempotent-script.md) | The GitHub workspace is configured by an idempotent script with rulesets and no bypass | accepted |
| [0012](0012-releases-are-manual-and-close-a-milestone.md) | Releases are manual and close a milestone | accepted; the orchestrator command superseded by [0056](0056-the-controller-replaces-the-orchestrator-and-runs-every-local-session-headless.md) |
| [0013](0013-promotions-merge-with-a-merge-commit-and-releases-tag-it.md) | Promotions merge with a merge commit, and the release tags it | accepted; `merge.sh` and `/orchestrator:release` superseded by [0056](0056-the-controller-replaces-the-orchestrator-and-runs-every-local-session-headless.md) |
| [0016](0016-approval-is-per-category-and-scripts-own-what-they-apply.md) | Approval is per category, and scripts own what they apply | amended by [0035](0035-every-category-the-apply-phase-scaffolds-is-answerable.md) |
| [0023](0023-github-is-the-only-control-surface-of-the-factory.md) | GitHub is the only control surface of the factory | accepted |
| [0024](0024-a-claim-is-the-creation-of-the-branch-through-the-api.md) | A claim is the creation of the branch through the GitHub API | accepted |
| [0025](0025-one-queue-one-worker-work-in-progress-first.md) | One queue, one worker, and work in progress before new work | accepted |
| [0026](0026-the-factory-never-deletes-work-on-its-own.md) | The factory never deletes work on its own | accepted |
| [0027](0027-the-factorys-isolation-boundary-is-the-host.md) | The factory's isolation boundary is the host | accepted |
| [0028](0028-the-quota-check-is-a-courtesy-not-a-guard.md) | The quota check is a courtesy, not a guard | accepted |
| [0035](0035-every-category-the-apply-phase-scaffolds-is-answerable.md) | Every category the apply phase scaffolds is answerable | accepted |
| [0039](0039-every-session-reports-through-a-structured-result.md) | Every session reports through a structured result and never through prose | accepted |
| [0040](0040-the-factory-owns-the-delivery-lifecycle-in-go.md) | The factory owns the delivery lifecycle in Go and starts one fresh session per stage | accepted |
| [0048](0048-writing-rules-are-part-of-the-standard-and-the-gate-checks-the-mechanical-ones.md) | Writing rules are part of the standard, and the gate checks the mechanical ones | accepted |
| [0050](0050-the-host-installs-every-factory-release-and-the-factory-drains-on-signal.md) | The host installs every factory release and the factory drains on signal | accepted |
| [0056](0056-the-controller-replaces-the-orchestrator-and-runs-every-local-session-headless.md) | The controller drives every local session headless, and a person merges | accepted |
| [0057](0057-the-controller-does-agents-decide.md) | The controller does, agents decide | accepted |
| [0059](0059-sessions-read-github-themselves-and-write-it-only-through-controller-tools.md) | Sessions read GitHub themselves and write it only through controller tools | accepted |
| [0062](0062-the-peers-share-a-contract-fixture-not-code.md) | The peers share a contract fixture, not code | accepted |
| [0070](0070-processes-run-on-process-graphs.md) | Processes run on process graphs | accepted |
| [0071](0071-adrs-are-a-capped-set-of-decisions-that-hold-today.md) | ADRs are a capped set of decisions that hold today | accepted |
