# Contract fixtures

The rules the controller and the factory share, stated as cases with inputs and the expected output. Each peer reads these files in its own tests, so neither drifts from the other without a red test ([ADR 0038](../docs/adr/0038-the-local-workflow-and-the-factory-are-peers.md)).

- `base-branch.json`: the base branch rule. The controller's `test/projects.test.ts` holds its projects to it.
