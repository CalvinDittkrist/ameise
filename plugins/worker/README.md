# worker

Skills and agents for the work on one issue: prompts that decide, while the controller does the deterministic work. The controller `ameise` drives the stages: it starts the implement session with the `worker` agent, then runs the gate, the reviewer panel, the pull request, CI and the answers to reviews in sessions of its own. The plugin has no hook and no steering script.

## Skills
| Skill | Script | Needs the controller | Effect |
| --- | --- | --- | --- |
| `/worker:hunt-tests` | `facts.sh`, `hunt.sh` | yes | the hunt stage of a test hunt; without the controller it says so and stops |
| `/worker:docs` | `claude-docs.sh` | no | a read-only `docs-lookup` subagent answers one Claude Code question from the current documentation, so the pages stay out of the worker's context, which has no `WebFetch` |
| `/worker:gh-axi` | | no | the `gh-axi` discovery skill, so the worker prefers it over raw `gh`; a hand-started session only, since the controller's skill allowlist leaves it out |

A skill that needs the controller reads the `controller:` line of `facts.sh`. The controller marks every session it starts with `WF_CONTROLLER=1`; without it the line says what to start, and the skill stops there.

## Agents
- `worker`: the main thread of an implement session, on opus. It implements and commits, and runs no gate, review, pull request or CI.
- Its tools, and the subagents its `Agent` tool may start, are listed in `agents/worker.md` (tested).
- The five reviewers `code-reviewer`, `security-reviewer`, `docs-reviewer`, `test-reviewer` and `senior-reviewer`: the panel the controller's review stage runs, in fresh read-only contexts.
- `test-hunter`: one share of a test hunt, with `Read`, `Grep` and `Glob` only.
- `docs-lookup`: answers one question from the documentation.

The `worker` agent file names `opus` and sets no effort; without that `model`, a session takes `model` from your Claude Code settings. Every subagent runs on sonnet at high effort. `docs-reviewer` and `docs-lookup` run without CLAUDE.md. The docs reviewer runs on a smaller model than the worker and without CLAUDE.md, because spotting slop needs no repository context.

## Test hunt
A hunt removes its candidates without asking anyone before the pull request, because asking per test stops an unattended session. The safeguards come after: a commit per test, the panel, the maintainer's merge.

- `hunt.sh round` splits the tests into shares of at most 1500 lines, one `test-hunter` each.
- `high` candidates are removed and `medium` ones checked by the worker, one commit per test. Up to three rounds run while a round finds something new.
- The hunt record, `hunt.sh print`, stands in for the issue. A hunt that removed nothing opens no pull request.
- `hunt.sh json` prints the same record as one JSON object, which the controller keeps in the hunt process's record.

## Documentation
`scripts/claude-docs.sh` prints the index or a page from a hard-coded https origin; it is no network boundary.

## Configuration
| Variable | Default | Effect |
| --- | --- | --- |
| `WF_DOCS_TIMEOUT` | `30` | seconds one documentation request may take |
| `WF_MODE`, `WF_ISSUE`, `WF_BASE_BRANCH` | set by the controller | mode (`manual` or `yolo`), issue and base of the session |
| `WF_CONTROLLER` | set by the controller | marks a session the controller started |

## Develop
`claude --plugin-dir plugins/worker` loads the plugin without installing it. `make check` runs the gate.
