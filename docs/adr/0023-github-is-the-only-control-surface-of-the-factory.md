# 0023. GitHub is the only control surface of the factory

Date: 2026-09-21
Status: accepted

## Context
- The factory runs on its own host and is watched from a phone as often as from a desk.
- A writing endpoint on the host needs authentication, authorisation and an audit trail, and duplicates GitHub's state.
- Two surfaces for one decision drift apart, and the maintainer already decides on GitHub.

## Decision
GitHub is the only thing the factory host and a developer's machine share, and the only surface that steers the factory.

## Consequences
- Route: add the routing label to an agent-ready issue.
- Release a blocked, failed or timed-out run: answer on the issue, remove the assignee.
- Cancel: remove the routing label or close the issue.
- Ask for changes: a "changes requested" review, or a bot's review within the repair budget, queues a follow-up run.
- Merge: a person, on GitHub. The factory has no yolo mode.
- The pause is the operator's: `"paused"` in the configuration file, read on every poll.
- Notifications: a review request when a run ends `ready`, a mention otherwise.
- The HTTP interface and its dashboard read and never write: every method but `GET` and `HEAD` gets 405, so no button steers.
- It binds one address, never a wildcard, loopback by default.
- Steering lags by a poll, and what has no GitHub gesture has no way in.
- Rejected: steering through the factory's own interface.
