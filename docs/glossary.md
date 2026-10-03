# Glossary

Terms the code, the issues and the docs use, one row each.

| Term | Meaning |
| --- | --- |
| `ameise` | The product: the local workflow and the factory, two peers in one repository. Shown as "ameise controller" and "ameise factory" where a title names a peer ([ADR 0066](adr/0066-the-product-is-named-ameise-and-its-parts-keep-their-names.md)). |
| standard | The written baseline a repository is checked against: [repo-standard.md](repo-standard.md). |
| writing rules | The fixed rule set for prose in documents, prompts and comments ([repo-standard.md](repo-standard.md#writing-rules)). The standard check counts the mechanical ones; the docs reviewer judges the rest. |
| profile | Visibility plus branch model (`main` alone, or `dev` plus `main`), derived from GitHub, never configured. |
| gate | The command that must pass before a pull request: the gate command of the applying change class ([ADR 0041](adr/0041-a-change-class-decides-the-gate-and-the-reviewers-before-the-pull-request.md)), `make check` for `full`. It runs in the worktree or on CI, as the factory's gate command or `WF_GATE` sets. |
| `WF_GATE` | The local workflow's gate form, the peer of the factory's gate command: unset for `make check`, a command run without a shell, `none`, or `ci` and `ci:<jobs>` for a gate on CI. |
| gate on CI | A gate whose form is `ci`: it reads the checks of the gate's draft instead of running a command in the worktree. Both peers have it. |
| gate's draft | The draft pull request the first gate on CI opens and the pr stage finishes. Its draft state is the peer's record, never GitHub's. |
| auditor | A read-only subagent that judges one area of a repository during standardisation and returns findings. |
| facts | The compact `key: value` block `facts.sh` prints about a repository; every auditor gets it instead of exploring. |
| finding | One proposed action of an auditor, one line: `finding: <category> \| <target> \| <action> \| <reason> \| <confidence>`. Actions are delete, replace, create, issue and configure ([ADR 0016](adr/0016-approval-is-per-category-and-scripts-own-what-they-apply.md)). |
| cleanup pull request | The one pull request from `chore/standardize` that carries a standardisation run's deletions and new baseline files; its description lists how to restore each removed path. |
| catalogue issue | The issue, labelled `skill-candidate`, that lists the skills standardisation removed and how to restore each from the `pre-standard` tag. |
| standardize process | A process of the controller on `chore/standardize` that runs the audit, the apply of the approved categories and the finalize of a standardisation, with the approval per category in its process view. |
| drift | A difference between a repository's GitHub workspace and the standard; `workspace.sh` prints one `diff:` line per difference. |
| snapshot | The JSON file the controller's `workspace.sh --apply` writes before its first change: the previous value of everything it changes. |
| open session | Retired ([ADR 0056](adr/0056-the-controller-replaces-the-orchestrator-and-runs-every-local-session-headless.md)): a planner session without a topic on a `plan/open-<yyyymmdd-hhmm>` branch. It became a planning session when a topic emerged. Now an open `plan` process. |
| conversation language | The language the planner talks to the user in, set with `WF_PLANNER_LANGUAGE`; issues, comments and glossary terms stay English. |
| promotion | The pull request from `dev` to `main` that carries a release in the two-level branch model. |
| acceptance | The check of a whole spec against the code on the base branch after its tickets are closed; it ends with gap tickets or the spec closed ([ADR 0015](adr/0015-a-spec-with-tickets-is-closed-by-an-acceptance.md)). |
| foreground subagent | A subagent whose report is the result of the Agent call, because background tasks are disabled; worker sessions run this way ([ADR 0017](adr/0017-worker-subagents-run-in-the-foreground.md)). |
| context report | `ameise context-report`, the maintainer's diagnostic over finished worker sessions: peak context, tool mix, sleep calls. Never an input to the pipeline. |
| spec checker | The read-only session that judges each checkable statement of a spec during an acceptance: the controller runs it beside the acceptance's plan process. |
| item | One checkable statement of a spec with its verdict: `item: <section> \| <statement> \| <verdict> \| <evidence> \| <confidence>`. |
| accepted deviation | A difference between spec and code the maintainer keeps. A writer records it on the spec in a comment that opens with `> Accepted deviation (spec acceptance).` An acceptance does not report it again. |
| gap ticket | A `ready-for-agent` sub-issue an acceptance creates for an item that is not met. |
| routing label | The label `factory`, which hands an issue to the factory host. A local claim refuses it without `--force`; the planner sets it per ticket ([ADR 0021](adr/0021-routing-is-decided-in-the-planner-and-never-stands-alone.md)). |
| spec run | A spec the factory works as one unit: its agent tickets on a spec branch, none of them routed one by one. The planner asks once per spec: spec run or normal run. |
| spec-run label | The label `<routing label>:spec-run`, `factory:spec-run` by default, on a spec and its agent tickets. The controller's github tools refuse it beside the routing label or `ready-for-human`, and on a ticket whose spec lacks it. |
| spec branch | The branch `spec/<number>-<slug>` a spec run integrates its tickets on. The factory creates it through the API from the base, and that creation is the claim of the spec. |
| spec pull request | The pull request from the spec branch to the base that ends a spec run once its tickets are closed. It is part of the spec, goes through the ci stage alone, and a person squash-merges it. |
| label vocabulary | The fixed set of GitHub labels the workflow uses. Each plugin that creates labels defines it. Every copy follows the vocabulary in `contract/fixture.json`, and the controller's tests check each one ([ADR 0062](adr/0062-the-peers-share-a-contract-fixture-not-code.md)). |
| round record | Retired ([ADR 0058](adr/0058-the-controller-drives-the-local-stages-and-a-person-merges.md)): what one review round left, recorded by `panel.sh round`: each verdict, the fixes, the `disputed:` lines and the commit. The process record holds it now. |
| panel summary | Retired ([ADR 0058](adr/0058-the-controller-drives-the-local-stages-and-a-person-merges.md)): the block the local pull request stage read (`review_rounds`, `panel`, `fixed`, `disputed`), derived by `panel.sh record` from the round records. |
| compact trigger | The context size a worker session compacts at, 250 000 tokens: the pinned window times the pinned percentage ([ADR 0031](adr/0031-the-workflow-pins-the-size-at-which-a-worker-session-compacts.md), [ADR 0034](adr/0034-the-compact-trigger-is-raised-through-the-window.md)). |
| context value | Retired ([ADR 0056](adr/0056-the-controller-replaces-the-orchestrator-and-runs-every-local-session-headless.md)): a worker session's context size, written by its pane's status line to `<worktree git dir>/worker/context` and read by `checkpoint.sh`. |
| checkpoint | Retired ([ADR 0056](adr/0056-the-controller-replaces-the-orchestrator-and-runs-every-local-session-headless.md)): a point where the local pipeline measured the context and could hand over: entering review, entering `/worker:ci`, and the end of each review round. |
| handoff | Retired ([ADR 0056](adr/0056-the-controller-replaces-the-orchestrator-and-runs-every-local-session-headless.md)): continuing a worker's issue in a fresh context in the same pane once the context passed `WF_HANDOFF_TOKENS`. |
| handoff note | Retired ([ADR 0056](adr/0056-the-controller-replaces-the-orchestrator-and-runs-every-local-session-headless.md)): the page a handing-over context wrote for the next: decisions, rejected, verified, open, plus base, commits and diffstat. |
| resume stage | Retired ([ADR 0056](adr/0056-the-controller-replaces-the-orchestrator-and-runs-every-local-session-headless.md)): the stage a handed-over pipeline continued at, `review` or `ci`, printed by `facts.sh` as `resume_stage:`. |
| implement session | The first session of a factory run, the inline agent `worker` on the factory's own prompt ([ADR 0042](adr/0042-the-factory-carries-its-own-prompts-and-updates-no-plugin.md)). It commits the change, pushes nothing and reports its commits or `blocked`. |
| author session | The read-only session of the factory's pr stage. From the diff, the commits and the issue it reports the pull request's title and body. |
| review round | One round of the factory's review stage: the due reviewers run in parallel and report verdicts and findings; on any `fix`, one fix session gets every finding by its id. |
| fix session | A factory session that repairs one thing, such as a merge conflict, failed checks or review findings, then commits and pushes. |
| ci knobs | The factory's ci settings `repair_rounds`, `bot_reviewers`, `review_wait` and `checks_grace`, per host and per repository. `bot_reviewers` lists the bots whose review the ci stage waits for after green checks; it filters no threads. |
| gate record | Retired ([ADR 0058](adr/0058-the-controller-drives-the-local-stages-and-a-person-merges.md)): the result of one local gate run, written by the worker's `gate.sh`: commit, dirty flag, exit status, time and output tail. |
| repair record | Retired ([ADR 0058](adr/0058-the-controller-drives-the-local-stages-and-a-person-merges.md)): the count of CI repair rounds of one pull request, kept by `repair.sh` and refused past `WF_CI_REPAIR_ROUNDS`. |
| factory | The Go service in `factory/` that works routed issues unattended on a host of its own ([ADR 0038](adr/0038-the-local-workflow-and-the-factory-are-peers.md), [ADR 0040](adr/0040-the-factory-owns-the-delivery-lifecycle-in-go.md)). Not a plugin. |
| factory host | The dedicated machine the factory runs on. It shares nothing with a developer's machine but GitHub and is the isolation boundary ([ADR 0027](adr/0027-the-factorys-isolation-boundary-is-the-host.md)). |
| routed issue | An open issue with `ready-for-agent` and the routing label, no assignee and no open blocker. |
| queue | The routed issues of all connected repositories in one line, derived from GitHub on every poll, never stored; held work first ([ADR 0025](adr/0025-one-queue-one-worker-work-in-progress-first.md)). |
| factory run | The factory's answer to one signal, with its record and event log, across its stages. Kinds: first run, resumed run, follow-up run. |
| stage | One step of the factory's pipeline in Go: implement, gate, review, pr, ci, validate, merge, address-reviews ([ADR 0040](adr/0040-the-factory-owns-the-delivery-lifecycle-in-go.md), [ADR 0054](adr/0054-the-validate-stage-is-a-second-budgeted-review-after-a-green-ci.md)). Also a step of the controller's `work` process, without validate and merge ([ADR 0058](adr/0058-the-controller-drives-the-local-stages-and-a-person-merges.md)). |
| session | One call of a runtime inside a stage of the factory or a process of the controller, reporting a structured result. A controller session with a person in the loop is multi-turn ([ADR 0039](adr/0039-every-session-reports-through-a-structured-result.md), [ADR 0052](adr/0052-sessions-run-on-a-runtime-and-codex-is-one-of-them.md)). |
| runtime | The program a session runs on: `claude` (Claude Code in print mode) or `codex` (`codex exec`). A reviewer definition names its runtime; every other session runs on `claude` ([ADR 0052](adr/0052-sessions-run-on-a-runtime-and-codex-is-one-of-them.md)). |
| validate | The factory's stage after a green ci stage: the validators review the pull request's diff. A `fix` gets a fix session and another ci pass, within `validate.rounds`. Off without validators ([ADR 0054](adr/0054-the-validate-stage-is-a-second-budgeted-review-after-a-green-ci.md)). |
| validator | A reviewer of the panel, `codex` and `fable` included, that a repository's `validate.validators` names to review the green pull request read-only. |
| ticket run | A factory run of one ticket of a spec run: cut from the spec branch, its pull request against it, validated, then merged into it. |
| merge | The factory's stage after validate in a ticket run: a pull request with green ci, a `ready` panel and a passed validation is squash-merged into the spec branch. |
| change class | An ordered rule of a connected repository: name, path patterns, gate command, optional reviewers. `full` is built in ([ADR 0041](adr/0041-a-change-class-decides-the-gate-and-the-reviewers-before-the-pull-request.md)). |
| review finding | One structured finding of a reviewer session: severity, path, line, claim, why, fix. `finding` stays the auditor's line. |
| outcome | How a factory run ended: `ready`, `merged`, `blocked`, `failed`, `timeout`, `lost`, `interrupted`, `cancelled`, `quota`. In the controller, the result a node returns, such as pass, fail, complete or input; the process graph maps it to the next node. |
| remote claim | Creating the issue's branch through the GitHub API, which exactly one claimer wins ([ADR 0024](adr/0024-a-claim-is-the-creation-of-the-branch-through-the-api.md)). |
| local claim | Retired ([ADR 0056](adr/0056-the-controller-replaces-the-orchestrator-and-runs-every-local-session-headless.md)): the orchestrator plugin's claim of an issue into a worktree (`/orchestrator:claim`). A claim through the controller replaces it. |
| release signal | Removing the assignee from an issue the factory holds, which queues a resumed run. |
| outage signal | A held run that ended `blocked` or `failed` after the auto mode classifier gave no verdict (`Classifier unavailable`). It queues a resumed run after `outage_wait`, on the one automatic resume an interruption spends. |
| changes-requested signal | A writer's new review asking for changes on a held issue's pull request, after the last run ended; only the latest counts. It is a mandate: the follow-up run's repair count starts at none. |
| bot review | A review in any state, or a thumbs-up reaction on the pull request, of a bot the bot reviewers list; the signal the controller's ci stage waits for. |
| bot review signal | A Bot account's review on a held issue's pull request, after the last run ended, that leaves an unresolved thread. It queues a follow-up run whose repair count carries over ([ADR 0051](adr/0051-a-bots-review-queues-a-follow-up-run-within-the-repair-budget.md)). |
| follow-up run | The factory run that answers a review on a held issue's pull request, in the claim's worktree, starting at address-reviews. A changes-requested signal starts its repair count afresh; a bot review signal carries it over. |
| follow-up | The controller's answer to a review on the pull request of a `work` process the ci stage left ready or blocked on a review: its ci stage waits on the pull request again and starts an address-reviews session. |
| address-reviews session | The factory session that fixes or declines each point writers or bots still raise, pushes, and reports replies. The factory posts them and resolves the threads. The controller's is the same, except that the controller pushes. |
| quota check | The factory's call of the host's quota-axi before every run and after a session error ([ADR 0028](adr/0028-the-quota-check-is-a-courtesy-not-a-guard.md), [ADR 0037](adr/0037-the-quota-check-waits-below-12-percent-of-the-workers-scope.md), [ADR 0044](adr/0044-the-quota-check-reads-the-scope-of-every-model-a-run-spends.md), [ADR 0053](adr/0053-the-quota-check-reads-every-runtime-a-run-spends.md)). It reads the Codex provider as well for a run whose panel names `codex`. |
| connected repository | A repository named in the factory's configuration, as `owner/name`. |
| drain | The factory's answer to `SIGHUP`: it claims and resumes nothing new, lets the run in `.now` end with its own outcome, delivers what that run owes and exits with the drain code, 75 ([ADR 0050](adr/0050-the-host-installs-every-factory-release-and-the-factory-drains-on-signal.md)). |
| update tick | One run of the factory binary's update mode by the host's timer, as root; it reads the release, the running state and the file, does one action and exits. |
| auto-update | The configuration field `auto_update` that lets the host install factory releases; false by default, read by the update tick and reported by the factory. |
| block list | The updater's root-owned list of versions that failed after an install and are never installed again; a line is lifted by deleting it. |
| bridge release | The factory release that carries the new repository name and is tagged before the repository is renamed, so that the host installs it through the old name ([ADR 0068](adr/0068-the-host-crosses-the-rename-through-a-bridge-release.md)). |
| dashboard | The page the factory serves at `/`, built into the binary from `factory/ui`. It reads the endpoints of the interface and writes nothing ([ADR 0033](adr/0033-the-dashboard-is-built-into-the-factory-binary.md)). |
| controller | The local program behind the command `ameise`: holds the projects, their worktrees and processes, runs every session headless and serves the local dashboard. The local peer of the factory ([ADR 0056](adr/0056-the-controller-replaces-the-orchestrator-and-runs-every-local-session-headless.md)). In `controller/`. |
| process | One worktree with its chain of sessions, of one process kind; the unit the board shows. |
| process kind | `plan`, `work`, `hunt` or `standardize`: what a process does and the branch it works on. |
| interrupted process | A process whose session stopped with the controller, or an adopted one with no session yet. A resume goes on with the stopped one's session in its worktree, and starts a fresh session for an adopted one. |
| foreign worktree | A work worktree of a project that no process record names, as one the controller did not start. It is adopted into a process or removed. |
| project | A checkout of a connected repository on this machine, configured in the controller by its path alone. Owner, name, base branch and profile are derived on read ([ADR 0061](adr/0061-projects-are-the-machines-checkouts.md)). |
| board | The controller's central view: every project, its processes, the frontier and the specs ready for acceptance. |
| controller tool | A tool the controller registers in a session for one GitHub write, such as create issue or set labels. It owns the label vocabulary ([ADR 0059](adr/0059-sessions-read-github-themselves-and-write-it-only-through-controller-tools.md)). |
| contract fixture | `contract/fixture.json`: the rules the local workflow and the factory share (the branch contract, the base branch rule, the gate's draft, the frontier rule, the label vocabulary), as inputs with expected outputs, which both sides' tests read ([ADR 0062](adr/0062-the-peers-share-a-contract-fixture-not-code.md)). |
| local dashboard | The page the controller serves, beside the factory's dashboard. |
| orchestrator | Retired as a plugin ([ADR 0056](adr/0056-the-controller-replaces-the-orchestrator-and-runs-every-local-session-headless.md)): the agent in a terminal pane that claimed issues and opened planning sessions. The controller replaces it. |
| test hunt | One run of `/worker:hunt-tests`: a worker on a branch of its own that removes tests that prove nothing ([ADR 0045](adr/0045-a-test-hunt-runs-on-a-branch-without-an-issue.md)). |
| hunter | The read-only subagent `test-hunter` of a test hunt, with no shell, that reads one share of at most 1500 lines and replies with candidates. |
| candidate | One hunter line: `candidate: <path> \| <test> \| <category> \| <reason> \| <confidence>` ([ADR 0046](adr/0046-a-test-is-removed-at-high-confidence-without-approval-before-the-pull-request.md), [ADR 0047](adr/0047-a-test-hunt-reads-its-shares-whole-and-hunts-while-it-finds-something.md)). |
| hunt record | The rounds, removals and kept candidates of a test hunt, kept by `hunt.sh` in the worktree's git directory and copied into the hunt process's record; it stands in for the issue. |
| process graph | The XState machine a process kind of the controller runs on: its nodes, the outcomes of each node and the edge each outcome or event takes ([ADR 0070](adr/0070-processes-run-on-process-graphs.md)). |
| node | One state of a process graph. It runs controller code or one agent, and returns an outcome. |
| park | A node a process waits on, ready, blocked, input or failed, until a message, a follow-up or a request moves it. |
| agent run | The controller's settings for running one agent session and reading its result: name, stage label, the plugin agent it names, output schema, reader, write access. Not the Agent SDK's agent definition, which the plugin's agent file holds. |
| engine | The controller code that enters the nodes of a process graph, runs them and follows their edges. |

A retired term names a part of the local workflow that the controller replaces. The factory keeps the same facts in its run record.
