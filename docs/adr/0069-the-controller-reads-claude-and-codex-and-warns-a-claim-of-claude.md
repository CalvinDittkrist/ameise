# 0069. The controller reads Claude and Codex and warns a claim of Claude

Date: 2026-09-30
Status: accepted
Amends: [0065](0065-the-controller-warns-of-the-quota-and-notifies-a-turn.md)

## Context
- The quota read Claude alone, the one runtime a work process spends. Issue #326, which refines #325, adds Codex beside it.
- A switched-off check answered one unknown reading per runtime, which looked like a broken quota-axi.
- A `quota_axi` such as `npx quota-axi` is run as one program name and can never work.

## Decision
- The quota reads Claude, then Codex, each under its own 30 second bound and both at once.
- A claim warns of Claude alone below `quota_minimum`. A Codex below it is marked `below` and warns no claim.
- With `quota_axi` empty the quota answers `off: true` and no runtime.
- The configuration refuses a `quota_axi` with whitespace. Its message names a global npm install and the absolute path `command -v quota-axi` prints, never `npx`.

## Consequences
- The quota shows more than a claim spends: the runtimes read and the runtime a claim warns of are two facts.
- The dashboard names the claimed runtime too, so its claim dialog warns as the controller does.
- Rejected: warning a claim of Codex. No stage of a work process runs on it, so the warning would stop no spending.
