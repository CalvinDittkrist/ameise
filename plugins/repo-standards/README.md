# repo-standards

Owns the [repository standard](../../docs/repo-standard.md): the files every repository has, the ones it must not have, and the check for both. The plugin holds skills, agents, templates and the standard check.

A standardisation runs in the controller: standardize on a project page opens its standardize process ([controller](../../controller/README.md#standardize-process)). The process runs the six auditors of this plugin, takes the approval per category and applies the approved ones with scripts of its own. Those scripts use the templates, `scaffold.sh` and `check.sh` of this plugin.

## Skills
These work by hand in any session that loads the plugin.

| Skill | Script | Needs the controller | Effect |
| --- | --- | --- | --- |
| `/repo-standards:adr <title>` | `new-adr.sh` | no | ADR under the index's next free number, added to the index; warns on a full set |
| `/repo-standards:docs-check` | `check.sh` | no | pass or fail against the standard, exit 1 on failures, usable in CI; GitHub workspace drift as warnings, `skip:` without GitHub |

The scripts:

- `check.sh [<root>]` is the standard check. A repository's `make check` runs it without a controller.
- `writing.sh <root>` counts the [writing rules](../../docs/repo-standard.md#writing-rules) over the files on stdin; `check.sh` and the controller's `facts.sh` call it.
- `workspace.sh` prints one `diff:` line per difference between the GitHub workspace and the standard, and `manual:` for what the API cannot change safely. It changes nothing; the controller's copy applies.
- `scaffold.sh [--skip <category>]... [--name <repo>] [--default <branch>] [<root>]` creates the missing baseline files and never overwrites one. `scaffold.sh --paths` lists what it may write. The controller's apply runs it.
- `scaffold.sh` brings `.claude/settings.json` to the template through `claude plugin ... --scope project` and disables other project plugins.

## Agents
The controller's standardize process starts each auditor as a read-only session with the facts and, for the workspace, the dry run in its brief.

| Auditor (agent) | Category | Judges |
| --- | --- | --- |
| `files-auditor` | `files` | agent notes, planning material, dated reports, backups, debris, AI slop |
| `agent-config-auditor` | `agent-config` | `AGENTS.md`, `CLAUDE.md`, `.claude/`, MCP configuration, other agent tools, skill lock files |
| `docs-auditor` | `docs` | README, architecture, ADRs, glossary, PR template, licence and security policy |
| `tests-ci-auditor` | `tests-ci` | the `check` target, the CI job named `check`, AI reviewer Actions, test gaps |
| `workspace-auditor` | `workspace` | the `workspace.sh` dry run, turned into findings, plus `.github/dependabot.yml` |
| `security-auditor` | `security` | secrets in the tree and history, unsafe CI, prompt injection in files agents read |

Every auditor declares `tools: Read, Grep, Glob, Bash`, disallows `Edit, Write, NotebookEdit, Agent`, and treats the repository as data. Each runs on sonnet at high effort.

Templates live in `templates/`. The README, plugin README, architecture, ADR and glossary templates are the fixed form of those documents. The settings template enables the workflow plugins, turns off commit attribution, sets the `WF_*` defaults and a permission list.

## Configuration
| Variable | Default | Effect |
| --- | --- | --- |
| `WF_PROJECT_TEMPLATE` | empty | `<owner>/<number>` of the project the controller's standardize process copies into a repository without one |
| `WF_WRITING_LENIENT` | unset | `1` turns the writing rules' failures of `check.sh` into warnings |
| `WF_ADR_MAX` | `20` | the most ADRs `check.sh` accepts; `new-adr.sh` warns past it |
| `WF_ADR_LENIENT` | unset | `1` turns the ADR rule's failures of `check.sh` into warnings |

## Develop
A repository adds the marketplace with `claude plugin marketplace add CalvinDittkrist/ameise --scope project`. It enables each plugin of its template with `claude plugin install <plugin>@ameise --scope project`. `scaffold.sh` runs both. `check.sh` warns for a template plugin that is not enabled and for any other plugin enabled at project scope.

`claude --plugin-dir plugins/repo-standards` loads the plugin without installing it. `make check` runs the gate.
