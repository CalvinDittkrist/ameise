# 0066. The product is named ameise and its parts keep their names

Date: 2026-09-29
Status: accepted
Extends: [0038](0038-the-local-workflow-and-the-factory-are-peers.md) (the two peers get a product name above them), [0060](0060-one-release-unit-bundles-the-plugins.md) (the release unit gets its name), [0056](0056-the-controller-replaces-the-orchestrator-and-runs-every-local-session-headless.md) (the local command it names `workflows` is now `ameise`)

## Context
- The repository, the local command, the marketplace and the machine's directories were all called `workflows`. Spec #302.
- That word is a common noun, the directory GitHub reads its workflows from, and a package on npm that belongs to someone else.
- The package name `workflows-controller` came with the controller skeleton and was never decided.

## Decision
- The product is `ameise`: the local workflow and the factory, two peers in one repository.
- The command, the npm package, the marketplace and the repository carry that name. The configuration and state directories and the program's own variables (`AMEISE_`) follow it.
- The parts keep their names: controller, dashboard, factory, planner, worker, repo-standards.
- These stay: the release tags and commands, the factory's names on the host, the label vocabulary, the prefix `WF_` and the word "workflow" as a term.
- Only a title a person reads carries the product beside the peer: "ameise controller" and "ameise factory".

## Consequences
- A maintainer installs and starts the program under one name.
- A repository on the standard keeps its `WF_` settings.
