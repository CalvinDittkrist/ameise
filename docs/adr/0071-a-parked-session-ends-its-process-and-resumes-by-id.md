# 0071. A parked session ends its process and resumes by id

Date: 2026-10-04
Status: accepted

## Context
- A planning session parks between the maintainer's answers. A plan waits minutes to days for the next one.
- A live Claude Code process per parked plan would hold memory for nothing, and a controller restart would lose it.
- A resume sends the conversation again. It reads the unchanged prefix from the prompt cache within the cache's lifetime, one hour for Agent SDK turns on a subscription ([prompt caching](https://code.claude.com/docs/en/prompt-caching.md), checked 2026-10-04).
- The context report measured it: a median of 0.9 percent of the context re-cached at 679 resumes.

## Decision
- The controller closes the session's input when its turn ends. The process exits.
- The next message starts a new process that resumes the session by its id.
- Streaming input within a turn is kept.

## Consequences
- A parked session costs no memory and survives a controller restart.
- A resume keeps the prompt cache: the first turn after a maintainer message re-caches about one percent of the context.
- `ameise context-report` prints the resume share of each session, so a change that breaks the cache shows there.
- Rejected: a live process per parked session with streaming input across turns. The documentation states no cache or cost difference to a resume ([streaming input](https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode.md), checked 2026-10-04).
