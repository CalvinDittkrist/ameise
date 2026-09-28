# Contract fixtures

The rules the controller and the factory share, stated as cases with inputs and the expected output. The controller's tests and the factory's tests both read them, so a change of a rule on one side fails the other.

- `fixture.json`: the contract between the local workflow and the factory: branch names, base branch, frontier, compact pin, labels ([ADR 0062](../docs/adr/0062-the-peers-share-a-contract-fixture-not-code.md)).
- `base-branch.json`: the base branch rule as a project reads it from its own settings file. The controller's `test/projects.test.ts` and the factory's `claim_test.go` hold both to it.
