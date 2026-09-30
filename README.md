<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/banner-dark.png">
  <img alt="ameise" src="docs/assets/banner-light.png">
</picture>

# ameise

Claude Code plugins for agent-driven development that put security first, then low token use, then throughput. Planning sessions turn ideas into agent-ready issues, each claimed into an isolated worktree session. Each worker implements, passes an independent reviewer panel, opens a pull request from a fresh context and drives CI and review comments to green.

The local workflow is the controller `ameise`, one package with its dashboard and plugins. Beside it, `factory/` is a Go service that works routed issues unattended.

```mermaid
flowchart LR
  O[orchestrator<br/>/plan · /claim · /merge · /board] -->|worktree + Herdr pane| PL[planner<br/>/grill · /spec · /tickets · /triage · /accept]
  PL -->|ready-for-agent issues| O
  O -->|worktree + Herdr pane| W[worker<br/>/work]
  W --> I[implement + verify]
  I --> R{reviewer panel<br/>code · security · docs · tests · senior}
  R -->|FIX| I
  R -->|PASS| P[pr-author<br/>fresh context]
  P --> C[CI + Codex review]
  C -->|comments / failures| I
  C -->|green| M[/merge or yolo self-merge/]
```

## Plugins

| Plugin | What it gives you | Runs where |
| --- | --- | --- |
| [orchestrator](plugins/orchestrator/README.md) | `/plan`, `/claim`, `/yolo-claim`, `/hunt-tests`, `/merge`, `/board`, `/abandon`, `/herdr` | main checkout, inside [Herdr](https://herdr.dev) |
| [planner](plugins/planner/README.md) | `/grill`, `/spec`, `/tickets`, `/triage`, `/accept`, `/research`, `/prototype`, `/finish`; writes issues and runs the acceptance, never code | each planning worktree |
| [worker](plugins/worker/README.md) | `/work` pipeline, reviewer panel, fresh-context PR author, CI and review loop | each issue worktree |
| [repo-standards](plugins/repo-standards/README.md) | `/standardize`, `/apply`, `/adr`, `/docs-check`; the templates of the standard | any repository |

## Install

The [controller](controller/README.md) installs from its GitHub release, not yet from npm. It needs Node 22+, Claude Code, git, `jq` and a logged-in `gh`:

```sh
npm install --global https://github.com/CalvinDittkrist/ameise/releases/download/controller/v0.1.0/ameise-0.1.0.tgz
ameise                             # starts it and opens the dashboard on 127.0.0.1:7420
ameise projects add ~/src/repo     # then claim, plan, merge and release from the dashboard
```

For sessions started by hand, the plugins install from the marketplace `ameise` with Claude Code 2.1.270+, `gh`, `jq` and git. The orchestrator needs Herdr. Optional: `sbx` for sandboxed workers, `npx gh-axi`, Codex as reviewer.

```sh
claude plugin marketplace add CalvinDittkrist/ameise
claude plugin install worker@ameise
claude plugin install planner@ameise
claude plugin install repo-standards@ameise
claude plugin install orchestrator@ameise
```

Once per repository, bring it to the [standard](docs/repo-standard.md):

1. `/repo-standards:standardize` runs six read-only auditors and records your approval per category.
2. `/repo-standards:apply` pushes a protected `pre-standard` tag, opens the catalogue issue and one cleanup pull request, and turns code findings into issues.
3. After the merge, `/repo-standards:apply` again configures the GitHub workspace and runs the check.

Teammates only run the install commands. Skills also install outside Claude Code: `npx skills add CalvinDittkrist/ameise --skill <name>`, or `sbx skills add CalvinDittkrist/ameise` for Docker Sandboxes.

## Daily use

```sh
cd my-repo && claude --agent orchestrator --effort low   # inside a Herdr pane
```

```text
/orchestrator:plan add offline mode   # worktree + pane + planner: grill, spec, tickets
/orchestrator:plan 123                # triage or shape an existing issue
/orchestrator:plan                    # open session: ask about the code, no topic needed
/orchestrator:claim 123          # worktree + pane + worker for issue 123
/orchestrator:board              # who is doing what, PR and CI state
/orchestrator:merge 45           # squash-merge, remove worktree, workspace and branch
/orchestrator:yolo-claim 124     # worker merges itself when green
/orchestrator:hunt-tests         # worker removes the tests that prove nothing, one PR
/orchestrator:release v1.2.0     # milestone done: promote dev, tag, release notes, close it
```

The worker in each pane reports at decision points only; answer it there.

## Configuration

Every knob is an environment variable in `.claude/settings.json` under `env`; the template is `plugins/repo-standards/templates/settings.json`. Repositories never override agents or skills locally; the standard check fails on them.

| Variable | Default | Meaning |
| --- | --- | --- |
| `WF_BASE_BRANCH` | remote default branch | base for worktrees and PRs |
| `WF_REVIEWERS` | `code,security,docs,tests,senior` | reviewer panel members |
| `WF_REVIEW_ROUNDS` | `3` | max review rounds, counted over the recorded rounds, so it holds across a handover |
| `WF_CI_REPAIR_ROUNDS` | `3` | max repair rounds per pull request, such as a round of `/worker:address-reviews`, counted in the worktree |
| `WF_PR_BOT_REVIEWERS` | `chatgpt-codex-connector` | bot logins whose review the worker waits for; `""` for none |
| `WF_PR_REVIEW_WAIT` | `1200` | seconds to wait for the bot's one review after checks pass |
| `WF_HANDOFF_TOKENS` | `100000` | context size at which a worker hands the next stage to a fresh context; keep one review round under the compact trigger of 250 000 ([ADR 0031](docs/adr/0031-the-workflow-pins-the-size-at-which-a-worker-session-compacts.md), [ADR 0034](docs/adr/0034-the-compact-trigger-is-raised-through-the-window.md)) |
| `WF_CONTEXT_MAX_AGE` | `900` | seconds after which a recorded context size is too old, and the checkpoint says hand over |
| `WF_HANDOFF_SESSION_MS` | `60000` | how long the handover waits for a fresh session in the pane |
| `WF_HANDOFF_POLL_SECONDS` | `1` | how often it asks the pane |
| `WF_WORKER_PERMISSION_MODE` | `auto` | permission mode for worker sessions |
| `WF_DOCS_TIMEOUT` | `30` | seconds one request of `claude-docs.sh` may take (`/worker:docs`) |
| `WF_PLANNER_PERMISSION_MODE` | `auto` | permission mode for planner sessions |
| `WF_PLANNER_LANGUAGE` | empty | conversation language of planner sessions, such as `german`; what the planner writes stays English |
| `WF_CLAUDE_ARGS` | empty | extra flags for every worker and planner |
| `WF_PLANNER_CLAUDE_ARGS`, `WF_WORKER_CLAUDE_ARGS` | empty | extra flags for planner or worker sessions only |
| `WF_MODE`, `WF_ISSUE` | set by `/claim` | per-session mode (`manual` or `yolo`) and issue |
| `WF_REVIEW_MANDATE` | unset | names the review a driver starts a worker to answer; `repair.sh reset` restarts the repair count once per review. A factory follow-up run keeps its own count |
| `WF_PLAN`, `WF_PLAN_ISSUE` | set by `/plan` | per-session plan slug and planned issue |
| `WF_PROJECT_TEMPLATE` | empty | `<owner>/<number>` of the project `workspace.sh --apply` copies into a repository without one |

A claim sets a worker knob for its one session: `/orchestrator:claim 38 --env WF_HANDOFF_TOKENS=5000`, repeatable, for manual, yolo and sandboxed claims. Accepted names: `WF_REVIEWERS`, `WF_REVIEW_ROUNDS`, `WF_CI_REPAIR_ROUNDS`, `WF_PR_BOT_REVIEWERS`, `WF_PR_REVIEW_WAIT`, `WF_HANDOFF_TOKENS`, `WF_CONTEXT_MAX_AGE`, `WF_HANDOFF_SESSION_MS`, `WF_HANDOFF_POLL_SECONDS`, `WF_DOCS_TIMEOUT`.

- Any other name, a malformed argument and a repeated name are refused before anything is created. An empty value is a setting of its own.
- The value enters the `env` block of the claim's `--settings`, which wins per variable over the repository's settings ([settings](https://code.claude.com/docs/en/settings.md)).
- It holds for the whole run of that pane, because a handover clears the session and does not restart the process.
- Claude Code takes the last `--settings` and does not merge. A `--settings` in `WF_CLAUDE_ARGS`, `WF_PLANNER_CLAUDE_ARGS` or `WF_WORKER_CLAUDE_ARGS` replaces the scripts' object, so `plan.sh` and `claim.sh` warn.

A session takes its model from the first that is set:

1. `--model` in `WF_CLAUDE_ARGS`, `WF_WORKER_CLAUDE_ARGS` or `WF_PLANNER_CLAUDE_ARGS`
2. the `model` of its agent file: `fable` for `planner`, `opus` for `worker`
3. `model` in your Claude Code settings

The orchestrator, started by hand, runs on its agent file's `sonnet` at `low` effort. The planner runs on Fable. Neither it nor the worker sets an effort.

Every subagent with an agent file runs on `sonnet`: `high` effort for reviewers, auditors, the test hunter, docs lookup and spec checker, `medium` for the pull request author. `WF_*_CLAUDE_ARGS` move only their session, which the planner's research subagent follows.

## Design

- [Vision](docs/vision.md): why the repository exists and what it optimises for
- [Architecture](docs/architecture.md) and [ADRs](docs/adr/README.md)
- [The local workflow, step by step](docs/local-workflow.md)
- [Security and sandboxing](docs/security.md)
- [Factory host runbook](docs/factory-runbook.md): host setup and upkeep, and [the maintainer's list](docs/factory-runbook.md#the-maintainers-list) of the rename
- [Token budget: what loads when](docs/token-budget.md)
- [Repository standard](docs/repo-standard.md)

## Develop

```sh
make check                                        # the gate: shellcheck, plugin validate --strict, standard check, unit tests, Go vet/staticcheck/tests, the dashboard's lint, build and browser test
claude --plugin-dir plugins/worker                # try a plugin in a session without installing it
scripts/dev-orchestrator.sh                       # orchestrator from the checkout, inside a Herdr pane
scripts/context-report.py                         # diagnostic: context and tool mix of finished worker sessions
make ui                                           # build the dashboard the factory binary embeds (a fresh clone has only a placeholder)
go -C factory run . -fake -config factory.json    # the factory on a canned queue: no tokens, no git, no GitHub
npm --prefix factory/ui run dev                   # the dashboard with hot reload, against a factory started beside it
```

`dev-orchestrator.sh` points `WF_PLANNER_CLAUDE_ARGS` and `WF_WORKER_CLAUDE_ARGS` at the checkout's plugins. Without them a started session exits with `--agent 'planner' not found`, and `plan.sh` and `claim.sh` remove the worktree and print the fix. Tests run the real scripts against the `gh` and `herdr` shims in `tests/shims/`.

- A plugin is released by bumping `version` in its manifest and running `scripts/release.sh <plugin> --push`.
- The controller: bump `version` in `controller/package.json` and run `scripts/release.sh controller --push` on `main`; CI attaches the package to its release.

`factory/` is the factory, a Go service and no plugin. It is a peer of the local workflow and owns the delivery pipeline in Go ([ADR 0038](docs/adr/0038-the-local-workflow-and-the-factory-are-peers.md), [ADR 0040](docs/adr/0040-the-factory-owns-the-delivery-lifecycle-in-go.md)).

- It claims the head of its line by creating the issue's branch on GitHub ([ADR 0024](docs/adr/0024-a-claim-is-the-creation-of-the-branch-through-the-api.md)).
- It runs the stages implement, gate, review, pr, ci, validate, merge and address-reviews in a worktree of its own clone, one headless session per step that needs judgement.
- Its sessions run on its own prompts with the plugins off, so a host needs Claude Code, `git`, `gh` and the binary ([ADR 0042](docs/adr/0042-the-factory-carries-its-own-prompts-and-updates-no-plugin.md)).
- Its read-only HTTP interface serves a dashboard built into the binary ([ADR 0033](docs/adr/0033-the-dashboard-is-built-into-the-factory-binary.md)).

Its configuration is in the [runbook](docs/factory-runbook.md#configuration). The facts a developer needs:

- `factory/factory.example.json` is a host's configuration and runs paused. A configuration without `paused` is paused, and `-paused` never unpauses one.
- A run on a developer's machine sets its own data directory, drops `"quota_axi"` and passes `-fake`.
- `"gate"` runs a command in the worktree, none, or hands the gate to CI through a draft pull request ([runbook](docs/factory-runbook.md#a-gate-on-ci)).
- `"quota_axi"` is the path of a pinned [quota-axi](https://github.com/kunchenguid/quota-axi), version 0.1.49. Below `"quota_minimum"`, default 12 %, nothing starts ([ADR 0037](docs/adr/0037-the-quota-check-waits-below-12-percent-of-the-workers-scope.md)).

The factory is released by bumping `factory/VERSION` and running `scripts/release.sh factory --push` on `main`. The `factory/v<version>` tag makes CI attach static linux binaries for amd64 and arm64 with checksums to a GitHub release. The dashboard needs Node; `make check` installs its dependencies and Chromium.

MIT licensed.
