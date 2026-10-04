# planner

Skills and agents for a planning session on one topic ([ADR 0063](../../docs/adr/0063-plugins-are-skills-and-agents.md)). The controller `ameise` starts it as a plan process from its dashboard: worktree `plan/<slug>`, a headless session with `--agent planner`, first turn `/planner:plan`. Its brief names the plan branch, the base and the topic or the issue. The plugin has no hook and no script.

The planner writes GitHub issues, never code, and the plan branch is never committed to or pushed. The agent has eight tools, the controller's github tools and no Skill tool. It reads GitHub with `gh`.

It writes GitHub only through the controller's tools ([ADR 0059](../../docs/adr/0059-sessions-read-github-themselves-and-write-it-only-through-controller-tools.md)): `create_issue`, `set_labels`, `block`, `comment`, `close`, `attach_milestone`, `create_milestone`. A session outside the controller writes nothing.

## Skills
| Skill | Tool or controller action | Needs the controller | Effect |
| --- | --- | --- | --- |
| `/planner:plan` | | no | the routes; recommends one and stops. Without the controller it says what needs one |
| `/planner:grill [topic]` | | no | question rounds along the decision tree until nothing is open; collects glossary terms and the ADRs to write, change or remove |
| `/planner:spec` | `create_issue` with `spec` | yes | one spec issue from the conversation, no new questions |
| `/planner:tickets [spec]` | `create_milestone`, `create_issue` with parent and milestone, `block`, `set_labels`, `attach_milestone` | yes | asks once for a `vX.Y.Z` milestone, once spec run or normal run, then per ticket who works it; vertical-slice `ready-for-agent` sub-issues with native blocking edges |
| `/planner:triage [issue]` | `comment`, `set_labels`, `close` | yes | three buckets; per issue verify, grill, agent brief, labels and the routing question; `wontfix` closes with the reason |
| `/planner:accept [spec]` | Accept on the board | yes | points to the acceptance the controller runs; writes nothing |
| `/planner:research <question>` | | no | background subagent, primary sources, answer lands in the issue |
| `/planner:prototype <question>` | Capture prototype in the process view | yes, for the capture | throwaway code, moved to `prototype/<plan>-<name>` by the controller and linked |
| `/planner:finish` | Finish in the process view | yes | lists what the session wrote; the controller's finish removes worktree and branch |

A skill that needs the controller tells by its github tools: the controller registers them in every planner session it starts. Without them the skill says that it needs a plan process of the controller, and stops.

Every skill has `disable-model-invocation: true`: only the user invokes them, and their descriptions cost no context. Stage skills that need the interview link to the grill skill's file instead of invoking it.

A ticket with a milestone takes its spec along, so the release waits for the acceptance. The acceptance of a finished spec is the controller's: it gathers the facts, runs a read-only spec checker and writes the maintainer's answers ([acceptance](../../controller/README.md#acceptance)).

Labels the controller's tools create on first use: `ready-for-agent`, `needs-triage`, `needs-info`, `ready-for-human`, `wontfix`, `spec`, `factory`, `factory:spec-run`, `bug`, `enhancement`.

- `factory` is the routing label. The ticket and triage stages ask per ticket, following `skills/tickets/routing.md`.
- `factory:spec-run` is the spec-run label. In a spec run the spec and its agent tickets carry it.
- `create_issue` and `set_labels` refuse a set that leaves `factory` without `ready-for-agent` or next to `ready-for-human`, and an unknown label.
- They refuse `factory:spec-run` next to `factory` or `ready-for-human`, or on a non-spec whose parent lacks it.
- Sub-issues and blocking edges use GitHub's native APIs and fall back to body text.

## Model
A session takes its model from the first that is set:

1. the `model` of its agent file: `fable` for `planner`
2. `model` in your Claude Code settings

The planner runs on Fable and sets no effort. The research subagent has no agent file, so it follows the session.

## Configuration
| Variable | Default | Effect |
| --- | --- | --- |
| `WF_PLANNER_LANGUAGE` | empty | conversation language, such as `german`; issues stay English. The [controller's readme](../../controller/README.md) says how it is read and checked |

## Develop
`claude --plugin-dir plugins/planner` loads the plugin without installing it. `make check` runs the gate.
