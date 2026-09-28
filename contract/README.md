# Contract fixtures

The rules the controller and the factory share, stated as cases with inputs and the expected output. The controller's tests and the factory's tests both read them, so a change of a rule on one side fails the other.

- `base-branch.json`: the base branch rule. The controller's `test/projects.test.ts` and the factory's `claim_test.go` hold both to it.
