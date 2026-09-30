# Token budget: what loads when

Every context of the pipeline holds only what its job needs.

| Context | Loaded at start | Loaded on demand | Never |
| --- | --- | --- | --- |
| planner (fable; its `spec-checker` on sonnet at high effort, its research subagent inherits) | its agent prompt (≈300 tokens), eight tools (Bash, Read, Write, Edit, Grep, Glob, Agent, WebFetch; ≈10k). CLAUDE.md with the imported AGENTS.md, topic or issue from the brief or the hook | one stage skill body per invocation; templates (spec, ticket, brief) only when that stage runs; a research subagent's report | worker skills; other stages' bodies |
| worker (opus), the implement session | eight tools (the planner's set with Skill instead of WebFetch; ≈13k), CLAUDE.md with the imported AGENTS.md, the controller's brief | the issue it reads itself: body capped at 6 000 chars, last 8 comments at 1 500 chars; skill bodies when invoked | the gate output, the reviews and the stages after it |
| a stage session of the controller (fix, repair, address-reviews) | its brief: the failure, the findings or the review points it answers, quoted as data | the files and logs it reads | the implement session's transcript and every stage before |
| `docs-lookup` (sonnet, high effort) | its prompt (≈400 tokens), the question and the script path | the documentation pages it reads through `claude-docs.sh` | CLAUDE.md (`omitClaudeMd`), the worker's conversation, the open web |
| each reviewer (sonnet, high effort) | its prompt (≈350 tokens), CLAUDE.md (docs reviewer omits it), the brief with the gate's last run | files it chooses to read | the worker's conversation |
| the pull request's author session | its brief | diff, commits, issue | the worker's conversation |
| each auditor (sonnet, high effort) | its prompt (≈600 tokens), CLAUDE.md, the brief with the facts block (≈1k on a mid-size repository) | files it chooses to read | the other auditors' replies, the main session's conversation |

Practices that keep the budget flat:

- Skills are short and call scripts that print compact `key: value` lines and tables, never raw JSON.
- `!`command`` injection puts facts (mode, issue, range) into the skill at invocation time, instead of the model discovering them with tool calls.
- Each injected command is a plugin script pre-approved in the skill's `allowed-tools`. Without that, the permission check refuses a forked skill's injection.
- Long waits, for the gate, the checks and the bot's review, are the controller's and cost no turn.
- The controller starts its sessions with `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1`, so their subagents block and hand the report back as the tool result.
- A background launch returns at once and leaves the agent waiting in sleep turns, each one a full pass over the context ([ADR 0017](adr/0017-worker-subagents-run-in-the-foreground.md)).

File access:

- A main-thread agent's prompt replaces Claude Code's default system prompt entirely. The default guidance to prefer the file tools is gone, so the prompt carries it.
- Without it a worker reads and writes through the shell, and file contents read with `cat`, `sed -n` or `head` fill the context.
- The worker prompt states how to work with files: read with a range, search with the search tools, change with edits, write only new files.
- It also rules out whole-file shell reads and heredoc rewrites, and asks for independent reads in parallel.
- `scripts/context-report.py` measures whether that holds. The planner and reviewer prompts do not carry the guidance yet, and the report does not measure subagent turns.

The gate:

- The controller runs the gate; no session and no reviewer runs it.
- Reviewers run in parallel, and only the reviewers that returned FIX are re-run.
- The gate's last run, with the end of its output, is a line of the reviewers' brief.

The context size:

- Every stage after implement is a fresh session, so no context grows across stages ([ADR 0056](adr/0056-the-controller-replaces-the-orchestrator-and-runs-every-local-session-headless.md)).
- The process view shows the implement session's size from its usage events, against the compact trigger.
- A work session sets `autoCompactWindow: 312500` and pins `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=80`, so it compacts by 250 000 tokens ([ADR 0031](adr/0031-the-workflow-pins-the-size-at-which-a-worker-session-compacts.md)).
- The workflow states that bound, not an undocumented percentage of the window. It stops the session growing until the model refuses ([ADR 0034](adr/0034-the-compact-trigger-is-raised-through-the-window.md)).

Tools, plugins and instructions:

- Each main-session agent lists its `tools:`; a tool that is not listed is not sent to the model at all.
- Skill alone costs ≈3k, because it carries the listing of every skill in the account.
- Planner skills are typed by the user, so the planner has no Skill tool. The worker keeps it for the skills of repo-standards and its own.
- The controller starts its sessions with `--strict-mcp-config`, so account-level MCP connectors (their instructions and tool names, ≈1.7k) stay out.
- They load only the plugin of their agent and repo-standards, and switch the marketplace's copies off (`enabledPlugins`).
- So a planner never carries worker skill descriptions or the reviewer agent listing, and a worker never carries the planner's.
- `/repo-standards:standardize` and `/repo-standards:apply` are `disable-model-invocation: true` too.
- Plugin agents cannot be hidden, so the six auditor descriptions (one line each) are listed in every session that enables `repo-standards`.
- Every session keeps `repo-standards` for `/repo-standards:adr` and carries those six lines.
- Every planner skill is `disable-model-invocation: true`, which keeps even its description out of context. Enabling the plugin costs other sessions nothing.
- Plugin token cost is visible with `claude plugin details <plugin>@ameise`; keep skill descriptions to one sentence.
- Repository instruction files (`AGENTS.md`, `CLAUDE.md`) stay under 200 lines. A monorepo keeps one pair per area, which loads only when an agent works there.
- What goes in is what every session needs, because it loads in every session and every subagent.
- So the vision is a linked file ([vision.md](vision.md)) and not an `@` import. An import would load at launch and cost the whole text everywhere.
- A documentation page is read where it is needed and nowhere else. `/worker:docs` puts the question to a `docs-lookup` subagent that runs `claude-docs.sh`.
- The pages stay in that context. A page can run to tens of thousands of tokens, so the agent narrows it with `grep` and runs on sonnet.
- The worker's context gets the answer and the page URLs, under 300 words ([ADR 0030](adr/0030-agents-verify-claude-code-facts-against-the-live-documentation.md)).

## Measuring it
`scripts/context-report.py` prints one line per finished worker session:

- Claude Code version and turns
- the context at the start of the review and of the pull request stage, and the peak
- the share of tool output that came from reading files through the shell
- the number of read, edit, write and shell calls, and the number of sleep calls

With no argument it reads the worktree sessions under `~/.claude/projects` (or `$CLAUDE_CONFIG_DIR`). A path argument reads one transcript or one directory.

It reads Claude Code's session transcripts, a format that is internal and changes without notice. So it fails with an `error:` line naming the version when it meets a format it does not understand. It is a diagnostic for the maintainer and never an input to the pipeline, so it lives in `scripts/` and not in a plugin. It looks at finished sessions; the process view is the live reading of the one that is running.
