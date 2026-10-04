# 0027. The factory's isolation boundary is the host

Date: 2026-09-21
Status: accepted

## Context
- On a developer's machine isolation is layered: the worktree, the permission prompts, an optional sandbox ([security model](../security.md)).
- Unattended, every command goes through unasked.
- An inherited variable once let the prototype's worker start a session on the maintainer's machine.

## Decision
The factory's isolation boundary is a dedicated host, with a machine user, a cleaned environment, a process group per worker and no container per run.

## Consequences
- The machine user's token reaches the connected repositories and nothing else.
- The host holds no Claude Code login, SSH key or maintainer credential beyond the worker's subscription.
- A worker's process group ends with its run. A process that leaves the group, as with `nohup`, gets a warning on the run.
- Workers run with the auto permission mode. The host is treated as compromised and keeps nothing not already on GitHub.
- The blast radius is the host and the token's repositories, never a developer's machine.
- The machine user's commits and pull requests are its own, so the maintainer can review them.
- The layers gain a third case, the dedicated host. A run needing more containment belongs in a sandbox.
- Rejected: a container per run. On a Raspberry Pi it costs an image per repository, a second toolchain and a slower gate.
