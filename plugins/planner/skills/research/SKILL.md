---
name: research
description: Settle a fact from outside the repo (docs, specs, a dependency's source) with the read-only reader subagent on sonnet and bring the answer into the session.
disable-model-invocation: true
argument-hint: <question>
---
Spawn the `planner:reader` subagent with the Agent tool for this question: $ARGUMENTS

Brief it: answer from primary sources only (official docs, the dependency's source, the spec). Cite every claim with its URL or path. Say what could not be verified. Reply in under 300 words.

Claude Code facts (plugin manifest, skill or agent frontmatter, hooks, settings, permissions, model names, CLI flags) come from the current documentation, never from memory: the index is `https://code.claude.com/docs/llms.txt` and every page is that path with `.md` (`https://code.claude.com/docs/en/<slug>.md`).

In a session the controller started, the subagent runs in the foreground and its report is the result of the Agent call. A session started by hand may run it in the background: then keep working on the rest of the frontier and take the report from its completion notification. Never report an answer before the report is there.

Quote the answer with its sources to the user and carry it into the spec or ticket where the decision lands, under its `## Sources` section with the URL and the date it was checked, so the implementing session inherits the fact instead of looking it up again. Nothing is written to the repo.
