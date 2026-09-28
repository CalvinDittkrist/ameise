# 0060. One release unit bundles the plugins

Date: 2026-09-27
Status: accepted

## Context
- Each plugin is released on its own version, and the controller ([ADR 0056](0056-the-controller-replaces-the-orchestrator-and-runs-every-local-session-headless.md)) loads the plugins its sessions need.
- A controller of one version with plugins of another would be a pair nobody tested.

## Decision
- One npm package carries the controller, the built dashboard and the worker, planner and repo-standards plugins, at one version.
- The release runs through the repository's release script and tags `controller/vX.Y.Z`.
- The controller loads the plugins from the package's bundled copies.
- The marketplace keeps pointing at the same plugin directories for use by hand.

## Consequences
- A maintainer installs one package and starts one program.
- The controller and its plugins are tested and released together.
- The factory keeps its own release ([ADR 0050](0050-the-host-installs-every-factory-release-and-the-factory-drains-on-signal.md)).
