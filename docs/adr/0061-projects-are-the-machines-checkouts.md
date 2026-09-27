# 0061. Projects are the machine's checkouts

Date: 2026-09-27
Status: accepted

## Context
- The factory clones each connected repository into a data directory of its own.
- A developer's machine already holds a checkout of every repository the developer works on.

## Decision
- A project is a path to a checkout on this machine. The controller clones nothing.
- Owner, name, base branch and profile are derived from the checkout and GitHub on read, never stored.
- The controller refuses a path that is no git checkout or has no GitHub origin.
- Worktrees live under the checkout's Claude worktrees directory, so workspace trust covers them.
- The controller's state is a directory per machine in the user's data directory, apart from every checkout: one record per process and one event log.

## Consequences
- A repository is never cloned twice, and the configuration holds nothing that can go stale.
- Removing the controller leaves every checkout as it was.
