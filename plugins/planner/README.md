# planner

Planning session for one topic. The controller `ameise` starts it as a plan process from its dashboard: worktree `plan/<slug>`, a headless session with `--agent planner`, first turn `/planner:plan`. The planner writes GitHub issues, never code, and the plan branch is never committed to or pushed. The agent has eight tools, the controller's github tools and no Skill tool. It requires `gh`, `jq` and `git`.

It writes GitHub only through the controller's tools (ADR 0059): `create_issue`, `set_labels`, `block`, `comment`, `close`, `attach_milestone`, `create_milestone`. A session outside the controller writes nothing.

## Skills
| Skill | Script or tool | Effect |
| --- | --- | --- |
| `/planner:plan` | `facts.sh`, `accept-due.sh` | session facts, whether an acceptance is due, the routes; recommends one and stops |
| `/planner:grill [topic]` | | question rounds along the decision tree until nothing is open; collects glossary terms and ADR candidates |
| `/planner:spec` | `create_issue` with `spec` | one spec issue from the conversation, no new questions |
| `/planner:tickets [spec]` | `create_milestone`, `create_issue` with parent and milestone, `block` | asks once for a `vX.Y.Z` milestone, once spec run or normal run, then per ticket who works it; vertical-slice `ready-for-agent` sub-issues with native blocking edges |
| `/planner:accept [spec]` | `accept-facts.sh`, `accept-report.sh`, `create_issue`, `comment`, `block`, `close` | acceptance of a finished spec: facts, one read-only spec checker, one report, then gap tickets, accepted deviations or the spec closed |
| `/planner:triage [issue]` | `triage-list.sh`, `comment`, `set_labels`, `close` | three buckets; per issue verify, grill, agent brief, labels and the routing question; `wontfix` closes with the reason |
| `/planner:research <question>` | | background subagent, primary sources, answer lands in the issue |
| `/planner:prototype <question>` | `capture-prototype.sh` | throwaway code, moved to `prototype/<plan>-<name>` and linked |
| `/planner:finish [--force]` | `finish.sh`, `cleanup-self.sh` | refuses while uncommitted or unpushed work exists, then removes worktree and branch |

Every skill has `disable-model-invocation: true`: only the user invokes them, and their descriptions cost no context. Stage skills that need the interview link to the grill skill's file instead of invoking it.

A ticket with a milestone takes its spec along, so the release waits for the acceptance.

Acceptance works in four steps:

1. `accept-facts.sh <spec> [<ticket>...]` prints the spec, its tickets, their merged pull requests and files, and the deviations accepted earlier. All of it is data.
   - A ticket without a closing pull request is looked up by its head branch, merged into any base: GitHub links only merges into the default branch.
2. One read-only `spec-checker` subagent with a fresh context judges each statement against the base branch: `item: <section> | <statement> | <verdict> | <evidence> | <confidence>`.
3. `accept-report.sh <spec> [<file>...]` keeps the items, fails on a malformed one, counts them and prints every item that is not `met`.
4. The maintainer decides per open item: a gap ticket, an accepted deviation or no finding. The `close` tool then closes the spec with the closing comment, as completed.

The acceptance rules that no script output states:

- `accept-facts.sh` refuses an issue that is not an open `spec` or has open tickets, and a worktree behind the base branch.
- Ticket numbers are arguments where a repository has no native sub-issues; they add to the sub-issues, never replace them.
- Verdicts are `met`, `missing`, `deviates` and `untested`, over the sections User stories, Decisions, Testing, Vocabulary and ADRs to write.
- An accepted deviation is a spec comment opening with `> Accepted deviation (spec acceptance).`. Only a commenter with write access counts.
- Gap tickets keep the spec open, and the acceptance runs again in full after they close.
- `close` refuses a spec as completed without its closing comment, and while a ticket is open or cannot be read.
- `accept-due.sh` prints one `acceptance:` line. Only `/planner:plan` injects it.

Hook: `SessionStart` injects the topic from the branch description `plan.sh` wrote, or the issue text, marked as data. It is silent outside `plan/*` worktrees and in subagents.

Labels the controller's tools create on first use: `ready-for-agent`, `needs-triage`, `needs-info`, `ready-for-human`, `wontfix`, `spec`, `factory`, `factory:spec-run`, `bug`, `enhancement`.

- `factory` is the routing label. The ticket and triage stages ask per ticket, following `skills/tickets/routing.md`.
- `factory:spec-run` is the spec-run label. In a spec run the spec and its agent tickets carry it.
- `create_issue` and `set_labels` refuse a set that leaves `factory` without `ready-for-agent` or next to `ready-for-human`, and an unknown label.
- They refuse `factory:spec-run` next to `factory` or `ready-for-human`, or on a non-spec whose parent lacks it.
- Sub-issues and blocking edges use GitHub's native APIs and fall back to body text.

Model: the agent file names `fable`; the root README explains why. `spec-checker` runs on `sonnet` at `high` effort. The research subagent has no agent file, so it follows the session.

## Configuration
| Variable | Default | Effect |
| --- | --- | --- |
| `WF_PLANNER_LANGUAGE` | empty | conversation language, such as `german`; issues stay English. The [controller's readme](../../controller/README.md) says how it is read and checked |
| `WF_PLAN`, `WF_PLAN_ISSUE` | set by the controller | slug and issue of the planner session |
| `WF_PLAN_CONTROLLER` | set by the controller | `1` under the controller: silent start hook; `finish.sh` leaves the removal to it |

## Develop
`claude --plugin-dir plugins/planner` loads the plugin without installing it. `make check` runs the gate.
