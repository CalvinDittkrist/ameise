# Controller

`workflows` is the local peer of the factory: one program per machine that holds the projects of this machine and serves them over a local API. It is TypeScript and shares no code with the factory.

## Commands
- `workflows` starts the server on the configured loopback address and opens the browser there (`BROWSER` names another browser).
- `workflows --fake` does the same against the scripted `fake/gh`, so nothing reaches GitHub.
- `workflows projects` lists the projects with their derived facts.
- `workflows projects add <path>` adds the checkout at `<path>`; `workflows projects remove <path>` removes it.
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
- A project is the absolute path of a checkout, stored as the top of its working tree. Adding and removing a project reads this file again and rewrites its `projects`, so a change made by hand while the server runs is kept. The rewrite fills in any field the file lacks with its default. A changed `listen` takes effect at the next start.

## Projects
Owner and name come from the checkout's origin, which must be on GitHub. The base branch follows the base branch rule, whose cases [`contract/base-branch.json`](../contract/base-branch.json) states:
1. `WF_BASE_BRANCH` in the env block of the checkout's `.claude/settings.json`, when git accepts it as a branch name,
2. the head `origin` points at,
3. the default branch GitHub names,
4. `main`.

All of them are derived on every read and never stored. A path that is no git checkout, or whose origin is missing or not on GitHub, is refused with the reason.

## API
- `GET /api/projects`: the projects, each `{path, owner, name, base}`, or `{path, error}` when its checkout no longer derives.
- `POST /api/projects` with `{"path": "<absolute path>"}`: adds a project and answers `201`. `400` with `{error}` refuses it, `409` says it is a project already.
- `DELETE /api/projects` with `{"path": "<absolute path>"}`: removes a project and answers `200`. `400` with `{error}` refuses a path that is not absolute, `404` says it is no project.
- A body larger than 64 KiB is refused with `413`.

The server answers only a `Host` that names it, and takes a write only as `application/json`, so a page of another site cannot write through the browser. It answers any other `Host` with `403` and a write of another type with `415`. Every refusal carries `{error}` with the reason.

## State
One directory per machine: `$XDG_DATA_HOME/workflows`, else `~/.local/share/workflows`. It holds the event log `events.jsonl`.

## Development
- `make controller` runs eslint, the type check and the tests.
- The tests build the binary and start it in fake mode on a temporary machine: its own configuration, state, `PATH` and canned GitHub (see `fake/gh`).
- They watch it over the API, its files and its output.
