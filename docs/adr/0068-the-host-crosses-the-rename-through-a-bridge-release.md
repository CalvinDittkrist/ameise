# 0068. The host crosses the rename through a bridge release

Date: 2026-09-29
Status: accepted
Extends: [0050](0050-the-host-installs-every-factory-release-and-the-factory-drains-on-signal.md) (the update tick across a repository rename)

## Context
- The host installs every factory release after it verifies the build attestation against the repository it knows ([ADR 0050](0050-the-host-installs-every-factory-release-and-the-factory-drains-on-signal.md)). Spec #302.
- The repository becomes `CalvinDittkrist/ameise`, and a binary that knows the old name would verify against it.

## Decision
- The bridge release is a factory release that carries the new repository name and is tagged before the repository is renamed.
- Its attestation names the old repository, so the binary on the host verifies and installs it itself.
- A tick that finds no repository under the new name yet ends with an error line and changes nothing.
- The repository is renamed only while the factory is paused and holds no run.
- The runbook describes the install by hand, the way out when the host refuses a release after the rename.

## Consequences
- Every binary on the host was verified by the one before it.
- The service, its user, its directories and the routing label keep their names, so the host needs no new setup.
