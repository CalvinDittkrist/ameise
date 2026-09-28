# Contract fixtures

The rules the controller and the factory share, stated as cases with inputs and the expected output. The controller's tests read them today. The factory's tests do not read them yet, so only the controller is held to them until they do.

- `base-branch.json`: the base branch rule. The controller's `test/projects.test.ts` holds its projects to it.
