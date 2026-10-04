# factory

The factory is a Go service that works routed issues unattended on a host of its own. It is a peer of the local workflow and owns the delivery pipeline in Go ([ADR 0038](../docs/adr/0038-the-local-workflow-and-the-factory-are-peers.md), [ADR 0040](../docs/adr/0040-the-factory-owns-the-delivery-lifecycle-in-go.md)). It is no plugin and shares no code with the controller.

- It claims the head of its line by creating the issue's branch on GitHub ([ADR 0024](../docs/adr/0024-a-claim-is-the-creation-of-the-branch-through-the-api.md)).
- It runs the stages implement, gate, review, pr, ci, validate, merge and address-reviews in a worktree of its own clone.
- Each step that needs judgement runs one headless session.
- Its sessions run on its own prompts with the plugins off, so a host needs Claude Code, `git`, `gh` and the binary ([ADR 0042](../docs/adr/0042-the-factory-carries-its-own-prompts-and-updates-no-plugin.md)).
- Its read-only HTTP interface serves a dashboard built into the binary ([ADR 0033](../docs/adr/0033-the-dashboard-is-built-into-the-factory-binary.md)).

A host's setup, configuration and upkeep are in the [runbook](../docs/factory-runbook.md).

## Configuration
The [runbook](../docs/factory-runbook.md#configuration) documents every field. The facts a developer needs:

- `factory.example.json` is a host's configuration, rooted at `/var/lib/factory`, and runs paused.
- A configuration without `paused` is paused, and `-paused` never unpauses one.
- `"gate"` runs a command in the worktree, runs none, or hands the gate to CI through a draft pull request ([a gate on CI](../docs/factory-runbook.md#a-gate-on-ci)).
- `"simplify"`, default `true`, has the implement session run the bundled `/simplify` skill on its diff before it reports; a repository's own `simplify` stands over the host's.
- `"quota_axi"` is the path of a pinned [quota-axi](https://github.com/kunchenguid/quota-axi), version 0.1.49.
- Below `"quota_minimum"`, default 12 %, nothing starts ([ADR 0037](../docs/adr/0037-the-quota-check-waits-below-12-percent-of-the-workers-scope.md)).

## Run it here
A fake run works a canned queue with scripted workers: no tokens, no git, no GitHub. Its configuration is your own file.

- It sets `"paused": false` and a data directory this machine can write.
- It drops `"quota_axi"`, which would check this machine's own Claude quota.

```sh
make ui                                           # build the dashboard the binary embeds
go -C factory run . -fake -config factory.json    # the factory on a canned queue
npm --prefix factory/ui run dev                   # the dashboard with hot reload, against the factory beside it
```

The binary embeds the Vite build of `ui/` in `ui/dist/app`. A fresh clone has only a placeholder there, so `/` answers 404 until `make ui` has run, while the API works. The dashboard needs Node.

## Release
1. Bump `VERSION`, the one place the factory's version is written, and commit.
2. Run `scripts/release.sh factory --push` on `main`. It refuses another branch, a dirty tree, a red gate and a tag that exists.
3. The tag `factory/v<version>` makes CI attach static linux binaries for amd64 and arm64 to a GitHub release, with their checksums and build attestation.

`make binaries` builds the same files here.

## Develop
`make factory` runs the dashboard's lint and build, gofmt, vet, staticcheck, the Go tests and the dashboard's browser test. `make check` runs the whole gate and installs the dashboard's dependencies and Chromium. The tests start the real binary; [AGENTS.md](../AGENTS.md) names the helper and the rest.
