# Controller

`workflows` is the local peer of the factory: one program per machine that holds the projects of this machine and serves them over a local API. It is TypeScript and shares no code with the factory.

## Commands
- `workflows` starts the server on the configured loopback address and opens the browser there (`BROWSER` names another browser).
- `workflows --fake` does the same against the scripted `fake/gh`, so nothing reaches GitHub.
- `workflows projects` lists the projects with their derived facts.
- `workflows projects add <path>` adds the checkout at `<path>`; `workflows projects remove <path>` removes it.
- `workflows board [<path>]` prints the board of every project, or of the project at `<path>`.
  - It prints a line per project, then one per process, frontier issue, spec ready for acceptance and note.
- `workflows claim <issue> [--yolo] [--force] [--env NAME=VALUE]... [--project <path>]` claims the issue into a work process; see [Claim and abandon](#claim-and-abandon).
- `workflows abandon <issue> [--force] [--project <path>]` removes the issue's worktree and process.
- `workflows merge <pr> [--project <path>]` merges a ready pull request; see [Merge](#merge).
- `workflows release <vX.Y.Z> [--project <path>]` releases a finished milestone; see [Release](#release).
- `workflows accept <spec> [--project <path>]` opens a plan process on a spec; see [Acceptance start](#acceptance-start).
  - Without `--project` each acts on the project of the current directory.
- Every command but the first talks to the running server. Without one it prints `error:` with the command that starts it and exits non-zero.

## Start
The start stops with one `error:` line that names the fix when:
- the configuration is malformed,
- `gh` is missing or not logged in,
- `claude` is missing.

## Configuration
One file per machine: `$XDG_CONFIG_HOME/workflows/config.json`, else `~/.config/workflows/config.json`. Without it the defaults hold.

```json
{
  "listen": "127.0.0.1:7420",
  "quota_axi": "",
  "quota_minimum": 12,
  "notifications": true,
  "projects": ["/home/me/src/repo"]
}
```

- `listen` is a loopback address; the controller is never reachable from another machine.
- `quota_axi` names the quota-axi command; empty switches the quota check off. `quota_minimum` is a percentage.
- A project is the absolute path of a checkout, stored as the top of its working tree.
- Listing, adding and removing projects read this file again, so a change made by hand while the server runs shows at once and is kept.
- The rewrite fills in any field the file lacks with its default.
- A changed `listen` takes effect at the next start. Until then the CLI finds the server at the address it started on.

## Projects
Owner and name come from the checkout's origin, which must be on GitHub. The base branch follows the base branch rule, whose cases [`contract/base-branch.json`](../contract/base-branch.json) states:
1. `WF_BASE_BRANCH` in the env block of the checkout's `.claude/settings.json`, when git accepts it as a branch name,
2. the head `origin` points at,
3. the default branch GitHub names,
4. `main`.

All of them are derived on every read and never stored. A path that is no git checkout, or whose origin is missing or not on GitHub, is refused with the reason.

## Board
The board is derived on every request from the state directory, git and GitHub, and stored nowhere. A project's board is its facts and:
- `processes`: one per worktree of the checkout whose branch names a process kind, and one per process record in the state directory.
  - Each has `kind`, `state`, `stage`, `issue`, `branch`, `worktree`, `pr`, `checks`, `since` and a one-line `note`.
  - The kind comes from the branch: `plan/` is `plan`, `hunt/` is `hunt`, `chore/standardize` is `standardize`, an issue branch is `work`.
  - A record decides state, stage and note. A worktree without one is read from its pull request: green and not a draft is `ready`, pending checks `waiting`, anything else `running`.
  - A claimed process is `created` until its first session starts.
  - `blocked`, `approval`, `ready` and `input` wait for a person: `needs` is true and `action` is `Answer`, `Approve`, `Merge` or `Continue`. Every other process runs, with the action `Open`.
- `frontier`: the agent-ready issues without assignee, open blocker, routing label or process of this machine.
  - A ticket of a spec run is held unless it carries `ready-for-human`; one whose parent cannot be read is held too.
  - The tests hold it to the frontier of the [contract fixture](../contract/fixture.json).
- `acceptance`: the open specs that have sub-issues, all of them closed, and no process of this machine.
- `notes`: what GitHub did not answer, so an empty section reads as unknown and not as idle.

## Claim and abandon
A claim takes an issue of a project into a work process. It refuses, with the reason and `409`:
- an issue that is not `ready-for-agent`,
- an issue routed to the factory (`factory`),
- a ticket of a spec run without `ready-for-human`: it carries `factory:spec-run`, or its parent does,
- an issue whose branch is on origin already, which another claimer created,
- an issue that has a process on this machine already: a worktree of its branch or a process record.

Force lifts the first four and never the last. Each refusal it lifts comes back as a warning. On a branch on origin it adopts that branch, so the worktree goes on from its work. A closed issue is refused always.

The mode is `manual` or `yolo`. The overrides set worker knobs for the process, each `NAME=VALUE`: `WF_REVIEWERS`, `WF_REVIEW_ROUNDS`, `WF_CI_REPAIR_ROUNDS`, `WF_PR_BOT_REVIEWERS`, `WF_PR_REVIEW_WAIT`, `WF_HANDOFF_TOKENS`, `WF_CONTEXT_MAX_AGE`, `WF_HANDOFF_SESSION_MS`, `WF_HANDOFF_POLL_SECONDS` and `WF_DOCS_TIMEOUT`, the knobs the local claim accepts. A malformed override, another name or a name given twice is refused with `400` before anything is created.

A claim then:
1. names the branch by the branch contract of the [contract fixture](../contract/fixture.json): `<type>/<number>-<slug>`,
2. creates it from `origin/<base>` and its worktree in `.claude/worktrees/` of the checkout, which git ignores through `.git/info/exclude`,
3. assigns the issue to the user gh is logged in as, and undoes the two when GitHub refuses,
4. writes the process record `processes/<id>.json` with the mode and the overrides, in the state `created`,
5. opens its event log `processes/<id>.events.jsonl`.

No session starts yet. In fake mode the claim fetches nothing and branches from what the checkout has of origin.

An abandon removes the worktree, the record and the event log. It leaves the branch and the issue, assignment included. It refuses a worktree whose branch has commits on no branch of origin, or changes not committed, unless forced.

## Merge
A merge takes a ready pull request of a project into its base, by the rules of the orchestrator's merge. It refuses, with the reason and `409`, a pull request that is:
- not open, a draft, or in conflict, or whose conflicts GitHub has not computed yet,
- not green: a check failed or pending, or a merge state other than `CLEAN`,
- asked for changes.

It refuses a worktree of the branch with commits on no branch of origin, or changes not committed, since the merge removes it. Then it:
1. squash-merges the pull request and deletes its branch on origin,
2. removes the worktree, the local branch, the record and the event log of its process,
3. closes the issue of the head branch when the base is not the default branch, since GitHub closes a linked issue only there, with a comment that names the pull request.

A promotion from `dev` or `main` gets a merge commit and keeps its branch. A pull request from a fork keeps every local branch and closes no issue.

## Release
A release takes a milestone named as `v1.2.3`. It refuses, with `409`, a milestone that is missing, closed or has open issues, and a tag of that name that exists. The default branch decides the model:
- `main`: the release tags the head of `main`.
- `dev`: it opens the promotion `chore(release): <milestone>` from `dev` to `main`, or finds it, and merges it as a merge does. It tags the merge commit.
  - A promotion that is not green answers `waiting` with the reason; the next release goes on from it.
  - Another open promotion is refused.

Then it publishes the release with generated notes and closes the milestone.

## Acceptance start
An acceptance start opens a plan process on a spec ready for acceptance: its branch `plan/<slug of the title>` from `origin/<base>`, its worktree, and a record with the route `accept` in the state `created`. It refuses, with `409`, an issue that is not an open spec, a spec without tickets or with a ticket open, and a spec that has a process. The spec then leaves `acceptance`. No session starts yet.

## API
- `GET /`: the [dashboard](../dashboard/README.md), which `npm --prefix dashboard run build` writes into `dist/dashboard`.
- Without that build `/` answers `404` with the command, and the API works.
- `GET /api/projects`: the projects, each `{path, owner, name, base}`, or `{path, error}` when its checkout no longer derives.
- `POST /api/projects` with `{"path": "<absolute path>"}`: adds a project and answers `201`. `400` with `{error}` refuses it, `409` says it is a project already.
- `DELETE /api/projects` with `{"path": "<absolute path>"}`: removes a project and answers `200`. `400` with `{error}` refuses a path that is not absolute, `404` says it is no project.
- `GET /api/board`: the [board](#board) of every project, `{projects: [...]}`, each a project's board or `{path, error}`.
- `GET /api/board?project=<path>`: the board of the project at that checkout; `404` says it is no project.
- `POST /api/processes` with `{"project": "<path>", "issue": <n>, "mode": "manual"|"yolo", "env": ["NAME=VALUE", ...], "force": false}`: claims the issue and answers `201` with `{record, warnings}`.
  - `400` refuses a malformed request, `404` a path that is no project, `409` an issue a claim refuses, `502` a GitHub that does not answer.
- `DELETE /api/processes` with `{"project": "<path>", "issue": <n>, "force": false}`: abandons the issue's process and answers `200` with `{issue, branch, worktree}`.
  - `404` says the issue has no process, `409` refuses work not on origin.
- `POST /api/merges` with `{"project": "<path>", "pr": <n>}`: merges the pull request and answers `200` with `{pr, title, method, base, branch, kept, worktree, closed, warnings}`.
  - `409` refuses a pull request that is not ready or work not on origin, `502` a GitHub that does not answer.
- `POST /api/releases` with `{"project": "<path>", "milestone": "v1.2.3"}`: releases the milestone and answers `201` with `{status: "released", milestone, model, target, release, promotion}`.
  - `202` with `{status: "waiting", milestone, model, promotion, reason}` says the promotion is not green yet. `409` refuses the milestone.
- `POST /api/acceptances` with `{"project": "<path>", "spec": <n>}`: opens the plan process and answers `201` with `{record}`; `409` refuses the spec.
- A body larger than 64 KiB is refused with `413`.

The server answers only a `Host` that names it, and takes a write only as `application/json`, so a page of another site cannot write through the browser. It answers any other `Host` with `403` and a write of another type with `415`. Every refusal carries `{error}` with the reason.

## State
One directory per machine: `$XDG_DATA_HOME/workflows`, else `~/.local/share/workflows`. It holds the event log `events.jsonl`, a record per process in `processes/<id>.json` with its event log `processes/<id>.events.jsonl` and, while the server runs, `listen`: the address it started on, which the CLI reads first.

## Development
- `make controller` runs eslint, the type check and the tests. `make dashboard` builds the dashboard into this build and reads it in a browser.
- The tests build the binary and start it in fake mode on a temporary machine: its own configuration, state, `PATH` and canned GitHub (see `fake/gh`).
- They watch it over the API, its files and its output.
