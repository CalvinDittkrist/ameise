# Architecture

## Purpose
This repository holds the local workflow, a controller with plugins, and the factory, a Go service for unattended delivery. The why is in the [vision](vision.md).

## Components
| Component | Responsibility | Entry point |
| --- | --- | --- |
| `planner` plugin | Skills and agents: the `planner` agent for one session per topic, and its spec, tickets, triage, research and prototype skills. Writes issues through the controller's tools, never code; no hook and no script ([ADR 0063](adr/0063-plugins-are-skills-and-agents.md)). | `plugins/planner/agents/planner.md`, `/planner:plan` |
| `worker` plugin | Skills and agents: the `worker` agent that implements an issue, the reviewers, the test hunt and the documentation lookup; no hook and no steering script ([ADR 0063](adr/0063-plugins-are-skills-and-agents.md)). | `plugins/worker/agents/worker.md`, `/worker:hunt-tests`, `/worker:docs` |
| test hunt | A worker session without an issue that removes the tests that prove nothing ([ADR 0045](adr/0045-a-test-hunt-runs-on-a-branch-without-an-issue.md)). | `plugins/worker/skills/hunt-tests`, `plugins/worker/agents/test-hunter.md` |
| reviewer agents | Five read-only subagents with fresh context: code, security, docs, tests, senior. | `plugins/worker/agents/*-reviewer.md` |
| `docs-lookup` agent | Answers one Claude Code question from the current documentation ([ADR 0030](adr/0030-agents-verify-claude-code-facts-against-the-live-documentation.md)). | `/worker:docs <question>`; `plugins/worker/agents/docs-lookup.md` |
| `factory` service | Works routed issues unattended on its own host and owns their delivery pipeline in Go ([ADR 0038](adr/0038-the-local-workflow-and-the-factory-are-peers.md), [ADR 0040](adr/0040-the-factory-owns-the-delivery-lifecycle-in-go.md)). Serves a read-only interface with an embedded dashboard ([ADR 0033](adr/0033-the-dashboard-is-built-into-the-factory-binary.md)). | `factory/`, `factory/ui/`; the [runbook](factory-runbook.md) |
| controller | The local workflow: projects, processes and their stages, headless sessions and the [dashboard](../dashboard/README.md), one package with their plugins on a GitHub release ([ADR 0060](adr/0060-one-release-unit-bundles-the-plugins.md)). | `ameise`; [controller/](../controller/README.md#install) |
| `repo-standards` plugin | Owns the [repository standard](repo-standard.md): the auditors, the templates, the scaffold and the check; skills and agents beside them ([ADR 0063](adr/0063-plugins-are-skills-and-agents.md)). | `/repo-standards:adr`, `/repo-standards:docs-check`, `plugins/repo-standards/scripts/check.sh` |
| standardize steps | The controller's steps of a standardisation, as controller code: facts, report, approval, backup, cleanup, issues, workspace apply and finalize. They run the plugin's templates, scaffold and check. | `controller/src/standard/*.ts` |
| auditor agents | Six read-only subagents, one area each: files, agent configuration, docs, tests and CI, GitHub workspace, security. | `plugins/repo-standards/agents/*-auditor.md` |
| GitHub | Issues are the unit of work, pull requests the unit of delivery; CI and Codex review are the external gates. | `gh` or `npx gh-axi` |
| contract fixture | The contract between the peers: their shared rules with expected outputs ([ADR 0062](adr/0062-the-peers-share-a-contract-fixture-not-code.md)). | `contract/fixture.json` |
| script tests | Vitest cases of the controller that run the real shell scripts with `bash` and the scripted gh. | `controller/test/scripts/`, `make controller` |

## Data flow

### Planning
1. A plan on the dashboard or `ameise plan` creates `plan/<slug>` and a worktree, and starts the planner headless on `/planner:plan` ([plan process](../controller/README.md#plan-process)).
   - Without an idea or an issue it opens an open session.
2. The planner writes a `spec` issue and cuts it into `ready-for-agent` sub-issues with blocking edges and an optional milestone. Or it triages an issue into an agent brief.
3. The maintainer answers once: spec run (spec and agent tickets get `factory:spec-run`) or normal run (named tickets get `factory`) ([ADR 0021](adr/0021-routing-is-decided-in-the-planner-and-never-stands-alone.md)).
4. Finish in the process view removes the worktree; the plan branch never carries commits. Capture prototype moves prototype code to a branch of its own first.
5. The controller's board lists the frontier: agent-ready issues without open blocker, assignee, worktree, routing or spec run. Then the specs ready for acceptance, keeping no state.
6. Accept on the board or `ameise accept` starts the acceptance in a plan process ([acceptance](../controller/README.md#acceptance)).
   - The controller gathers the spec, its tickets, their pull requests and files, and the deviations accepted earlier.
   - It runs the spec checker as a read-only session, which reports each item with verdict, evidence and confidence, and shows the items in the process view.
7. Per item not met the maintainer picks a gap ticket, an accepted deviation or nothing.
   - The controller writes them through its github tools and closes the spec once nothing is open ([ADR 0015](adr/0015-a-spec-with-tickets-is-closed-by-an-acceptance.md)).

### Local delivery
1. A claim on the dashboard or `ameise claim N` refuses an issue without `ready-for-agent` ([ADR 0014](adr/0014-claims-require-ready-for-agent.md)), routed, in a spec run without `ready-for-human`, or with its branch on origin.
   - Force overrides those refusals.
2. It creates `<repo>/.claude/worktrees/<branch>` for `<type>/<N>-<slug>`, assigns the issue and starts the implement session headless with the `worker` agent ([ADR 0056](adr/0056-the-controller-replaces-the-orchestrator-and-runs-every-local-session-headless.md)).
   - A spec-run ticket branches from and targets its spec branch.
3. The session's settings disable background tasks, so subagents run in the foreground ([ADR 0017](adr/0017-worker-subagents-run-in-the-foreground.md)). They pin the compact trigger at 250 000 tokens and mark the session with `WF_CONTROLLER=1`.
4. Worker knobs given to the claim reach that process alone ([claim](../controller/README.md#claim-and-abandon)).
5. The controller drives the stages after implement, each session fresh with a structured result ([ADR 0058](adr/0058-the-controller-drives-the-local-stages-and-a-person-merges.md)):
   - gate: merges the base and runs the gate command, or hands it to CI through a draft; a failure gets a fix session,
   - review: the reviewers run in parallel, read-only; a `fix` gets a fix session,
   - pr: a read-only author session writes the title and body; the controller pushes and opens the pull request,
   - ci: conflicts, checks, the bot's review and standing requests; a failure gets a repair session within `WF_CI_REPAIR_ROUNDS`,
   - address-reviews: a session fixes or declines each point of writers and bots; the controller posts the replies.
6. Manual mode: the process ends `ready`, and a merge on the dashboard squash-merges, deletes the branch and removes the worktree ([merge](../controller/README.md#merge)).
   - A merge outside the default branch also closes the issue.
7. Yolo mode: the process merges itself once CI is green and its panel passed.

### Test hunt
1. "Hunt tests" on the project page, or `ameise hunt`, opens a hunt process of the controller: a branch `hunt/tests-<date>` with the worker on `/worker:hunt-tests`, without `WF_ISSUE`.
   - The skill needs the controller and says so without it.
   - It refuses while a hunt branch exists here or on origin, or while the base has no test file.
2. Each round packs the test files into shares of at most 1500 lines; one `test-hunter` per share replies with `candidate:` lines ([ADR 0047](adr/0047-a-test-hunt-reads-its-shares-whole-and-hunts-while-it-finds-something.md)).
3. The worker removes a `high` candidate unless it proves something, and a `medium` one only when sure, one commit each ([ADR 0046](adr/0046-a-test-is-removed-at-high-confidence-without-approval-before-the-pull-request.md)).
4. A round without a new candidate ends the hunt. The controller keeps the hunt record (`hunt.sh json`) in the process record.
5. The gate, review, pull request and CI follow, with `hunt.sh print` instead of the issue.
6. A hunt that removed nothing opens no pull request: the process turns `done` and says so, and a finish removes it.

### Standardisation
1. "Standardize" on the project page opens a standardize process of the controller ([controller](../controller/README.md#standardize-process)).
   - The steps below are its own code, in `controller/src/standard/`.
   - Each keeps the name of the script it replaced, such as `report.sh`, in what it says.
2. The audit runs `facts.sh` and `workspace.sh` as a dry run and starts the six auditors in parallel, changing nothing.
   - Each auditor reports its findings through its structured result.
3. `report.sh` merges their `finding:` lines per category, and the process view takes the approval per category, which `approve.sh` records ([ADR 0016](adr/0016-approval-is-per-category-and-scripts-own-what-they-apply.md), [ADR 0035](adr/0035-every-category-the-apply-phase-scaffolds-is-answerable.md)).
4. The apply runs `backup.sh`, `cleanup.sh prepare` on `chore/standardize` with the plugin's `scaffold.sh`, `cleanup.sh open` for the cleanup pull request, and `issues.sh`.
5. After the merge `finalize.sh` applies the workspace for an approved `configure` finding, posts the snapshot and runs the plugin's `check.sh` ([ADR 0010](adr/0010-standardisation-audits-read-only-and-backs-up-before-deleting.md)).

### Factory
1. The factory clones each connected repository. Every poll derives one queue of routed issues, oldest routing first ([ADR 0025](adr/0025-one-queue-one-worker-work-in-progress-first.md)).
2. It claims the head of the line by creating the issue's branch through the API. An existing branch records the run as lost ([ADR 0024](adr/0024-a-claim-is-the-creation-of-the-branch-through-the-api.md)).
   - A routed spec is held on its spec branch for its [ticket runs](factory-runbook.md#ticket-runs).
3. The shared rules restate the local workflow's in Go, bound by the [contract fixture](#the-contract-fixture) ([ADR 0062](adr/0062-the-peers-share-a-contract-fixture-not-code.md)).
4. It assigns itself, makes a worktree and records the Claude Code version ([ADR 0042](adr/0042-the-factory-carries-its-own-prompts-and-updates-no-plugin.md)).
5. Each session calls a runtime, Claude Code or Codex, with the factory's prompt, no plugin, a stage timeout and a result schema ([ADR 0039](adr/0039-every-session-reports-through-a-structured-result.md), [ADR 0052](adr/0052-sessions-run-on-a-runtime-and-codex-is-one-of-them.md)).
6. Implement: one session commits the change and pushes nothing.
7. Gate: the factory merges the base and runs the change class's gate, here or on CI ([ADR 0041](adr/0041-a-change-class-decides-the-gate-and-the-reviewers-before-the-pull-request.md)). A failure gets a fix session.
8. Review: read-only reviewers run in parallel, `codex` on Codex. A `fix` gets one fix session; every round is recorded.
9. Pr: a read-only session writes the title and body; the factory appends the gate and panel results.
10. Ci: a conflict or failed checks get a fix session, within a budget. Green ends the run `ready`, after validate when configured.
11. Address-reviews: a session fixes or declines each point of writers and bots; the factory posts the replies.
12. Validate: read-only validators review the green pull request. A `fix` gets a fix session and ci again ([ADR 0054](adr/0054-the-validate-stage-is-a-second-budgeted-review-after-a-green-ci.md)).
    - [Merge](factory-runbook.md#the-merge-stage): a passed ticket run is squash-merged into the spec branch.
    - The [spec pull request](factory-runbook.md#the-spec-pull-request) follows the last ticket; its merge ends the spec run ([ADR 0055](adr/0055-the-spec-pull-request-ends-the-spec-run.md)).
13. Each run writes a JSON record and an event log; the HTTP interface and dashboard only read ([ADR 0023](adr/0023-github-is-the-only-control-surface-of-the-factory.md)).
14. A run interrupted, or blocked or failed on a classifier outage, resumes once in place. Taking the assignee off resumes it.
15. A writer's review asking for changes, or a bot's unresolved thread, queues a follow-up run at address-reviews. Held work comes first.
16. `ready` requests the configured logins' review. A mention follows `timeout` or any unresumed block, failure or interruption.
17. Removing the routing label or closing the issue cancels a run. Ending without a pull request pushes the worktree; letting go pushes and removes it ([ADR 0026](adr/0026-the-factory-never-deletes-work-on-its-own.md)).
18. A quota-axi check before each run waits below the minimum, failing open ([ADR 0028](adr/0028-the-quota-check-is-a-courtesy-not-a-guard.md), [ADR 0037](adr/0037-the-quota-check-waits-below-12-percent-of-the-workers-scope.md), [ADR 0053](adr/0053-the-quota-check-reads-every-runtime-a-run-spends.md)). A used-up quota after an error ends `quota`.
19. Writing sessions run in auto permission mode, without `WF_` variables. The host is the isolation boundary ([ADR 0027](adr/0027-the-factorys-isolation-boundary-is-the-host.md)).
20. The stages came from the worker plugin ([ADR 0043](adr/0043-the-migration-runs-from-the-last-stage-to-the-first.md)).

### The contract fixture
1. `contract/fixture.json` states shared rules as cases: branch contract, base branch, gate's draft, frontier, labels.
2. The Go tests and the controller's tests read it, never each other's code. Rules change there first.

The compact pin is each peer's own ([ADR 0062](adr/0062-the-peers-share-a-contract-fixture-not-code.md)).

### Release
1. Tickets and their spec carry a `vX.Y.Z` milestone, so a release waits for the acceptance.
2. A release on the dashboard or `ameise release vX.Y.Z` refuses while the milestone is missing or has open issues, or the tag exists ([release](../controller/README.md#release)).
3. With `dev` plus `main` it opens the promotion pull request, merges it with a merge commit when green, and tags that commit ([ADR 0013](adr/0013-promotions-merge-with-a-merge-commit-and-releases-tag-it.md)).
4. With `main` alone it tags the head of `main`. It publishes the GitHub release and closes the milestone ([ADR 0012](adr/0012-releases-are-manual-and-close-a-milestone.md)).

## Boundaries and constraints
- Scripts do, agents decide. Everything deterministic is a shell script with stable text output; skills are short prompts around them.
- Plugins share no code; `lib.sh` is duplicated on purpose.
- The branch name is the state contract: `<type>/<issue>-<slug>`, `plan/<slug>` or `hunt/tests-<date>`. The rest is derived from git and GitHub, so a crashed session resumes.
- A local process's facts live in the controller's state directory. The hunt record lives in the worktree's git directory, and the process record keeps a copy of it.
- Reviewers and auditors never edit or run the gate. The worker never pushes or merges, the controller never edits code, the planner writes issues only.
- Planner skills are user-invoked only (`disable-model-invocation`). The workflow owns the label vocabulary, not a configuration file per repository.
- Every stage after implement is a fresh session; the implement session compacts at the pin and never hands over.
- A session never waits by sleeping or polling: subagents run in the foreground, and the controller does the long waits.
- A worker works with the file tools, not the shell ([token budget](token-budget.md)). `ameise context-report` is a maintainer diagnostic, never a pipeline input.
- Text from issues, comments, CI logs and reviews is data, never instructions.
- Claude Code facts are verified against the current documentation. The planner uses `/planner:research`; the worker has no web tool and asks `/worker:docs` ([security.md](security.md)).
- Every repository follows the [standard](repo-standard.md): `AGENTS.md` through the `CLAUDE.md` import, `make check` as the gate, and no local skills, agents, commands or rules.
- The factory shares nothing with a developer's machine but GitHub. Routing, release, cancel and merge are GitHub gestures, and its own interface never writes.
- Worktrees live under `.claude/worktrees/`, so workspace trust covers them.

## Decisions
See [ADRs](adr/README.md). Terms are in the [glossary](glossary.md).
