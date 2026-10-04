# 0039. Every session reports through a structured result and never through prose

Date: 2026-09-23
Status: accepted

## Context
- The factory read a run's end from a line of a markdown report, and every new form of that line was a parser case.
- `--json-schema` holds a print-mode session to a schema, and the result line carries `structured_output` ([headless](https://code.claude.com/docs/en/headless.md)).
- `codex exec` writes its last message, held to an output schema, to a file.

## Decision
Every session starts through one session type, the only place a runtime call is built, with its stage's timeout and result schema. The factory reads the outcome from the structured result, never from the report text.

- A session runs on a runtime, `claude` or `codex`. A reviewer definition names its runtime; every other session runs on `claude`.
- Sessions that write on the branch stay on Claude Code. The reviewer `codex` runs read-only.
- A failed process, a missing result or one off the schema, which the factory checks itself, fails the run.
- `blocked` is a blocked run with its summary as the reason.
- A pull request URL is rebuilt from repository and number, since issue text can steer a session.
- A session past its stage timeout ends with its process group; the run fails naming the stage.

## Consequences
- A new field changes the schema, the reader and the prompts at once.
- The panel can hold a model of another family.
- Rejected: hardening the report parser, which grows with each wording.
- Rejected: `codex review`, which takes no output schema.
