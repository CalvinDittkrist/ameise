# {{REPO}}

<!-- The instruction source for every agent; CLAUDE.md imports it. Keep under 200 lines. Only what an agent cannot infer from the code. -->

## Commands
- Gate: `make check` runs everything CI gates on. Run it before you push.
- Build/run: `{{RUN_CMD}}`

## Conventions
- Branches: `<type>/<issue>-<slug>` (type: feat, fix, docs, chore). Conventional commits. No agent co-authors.
- Docs: `docs/architecture.md` is the map. Update it when a change makes it stale.
- `docs/adr/` holds at most 20 hard decisions that hold today. Edit one in place when it changes, and delete one that no longer holds.
- A smaller rule goes with its reason into the document of its area.
- Tests prove behaviour through public interfaces; no source-grepping tests.

## Gotchas
- <!-- non-obvious things: env setup, slow tests, flaky areas, forbidden operations -->
