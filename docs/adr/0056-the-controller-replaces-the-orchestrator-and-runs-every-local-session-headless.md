# 0056. The controller replaces the orchestrator and runs every local session headless

Date: 2026-09-27
Status: accepted
Supersedes: [0003](0003-herdr-worktree-per-issue.md), [0020](0020-the-pane-measures-the-context-and-the-worktree-carries-the-value.md), [0029](0029-a-worker-resets-its-context-by-a-handoff-not-by-compaction.md)

## Context
- An orchestrator agent in a Herdr pane steers the local workflow through shell scripts, Herdr and hooks. State lives in git directories, a status line and Herdr. Spec #253.
- There is no view over several repositories and no place to answer a session's question but its pane.

## Decision
- `workflows` is a local controller: one program per machine that holds projects, worktrees and processes and serves a dashboard on loopback.
- The dashboard is the control surface. Every action is a click or a CLI command against the controller's API, which is the only writer.
- Every local session runs headless through the Agent SDK. A permission the classifier does not settle, and every question, reaches the process view as a dialog.
- Implement compacts at the compact pin and never hands over. The process view shows its context size from the usage events.
- The orchestrator plugin and Herdr are removed.

## Consequences
- The steering lives in one program, and a person sees every project on one board.
- The status line, the checkpoint and the handoff go.
- A session opens in a terminal by its session id when the dashboard lacks something.
- Rejected: the Vercel AI SDK harnesses, which have no sandbox for a local directory.
