# Vision

This repository is my workflow for working with AI agents, with its best practices, and it is maintained and developed continuously. It optimises for high throughput, a workflow that is uniform but adapts to the repository, low token use, and security.

## Two kinds of workflow
I develop projects locally and through a factory (for example https://github.com/owainlewis/machinist). That needs more than one workflow. The local workflow and the factory are peers: the local workflow serves hands-on work, the factory serves unattended delivery ([ADR 0038](adr/0038-the-local-workflow-and-the-factory-are-peers.md)). Local and factory are separate units.

The local workflow is the controller, the program `ameise`. It holds the projects of one machine, runs their sessions headless and shows them in a dashboard ([ADR 0056](adr/0056-the-controller-replaces-the-orchestrator-and-runs-every-local-session-headless.md)). It installs from its GitHub release as one npm package with the dashboard and the worker, planner and repo-standards plugins at one version, so what I install is what was tested together ([ADR 0060](adr/0060-one-release-unit-bundles-the-plugins.md)).

The local workflow works through GitHub issues and has a planning mode that creates them.

## Every repository on one standard
The workflow has to apply to every repository of mine. They differ: some carry a lot of AI slop, and each runs different tests. Some are private and some public, and some need other branch settings, such as `staging` and `main`. So an independent workflow puts an existing repository on a conventional standard:

- it removes unnecessary files and AI slop and reduces the repository to a minimum
- it installs the plugins the workflow needs and removes every other skill
- it puts the GitHub side on the standard as well: milestones, project, branch rules
- each check runs in its own independent subagent

This is the `repo-standards` plugin; the standard itself is [docs/repo-standard.md](repo-standard.md).
