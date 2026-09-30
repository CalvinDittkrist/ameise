# 0070. CI pins what it runs

Date: 2026-09-30
Status: accepted

## Context
- The workflows named actions by a movable tag such as `@v7`, and the factory release signs its binaries with what they run.
- GitHub's [secure use reference](https://docs.github.com/en/actions/reference/security/secure-use) calls a commit SHA the only immutable pin.
- CI and the release built with Go 1.26, `factory/go.mod` named the unsupported 1.25, and a maintainer's machine ran 1.27.
- Nothing checked the factory against the Go vulnerability database, which the [Go security best practices](https://go.dev/doc/security/best-practices) name first.

## Decision
- Every action is pinned to a commit SHA with its version in a comment. Dependabot moves both.
- `factory/go.mod` alone names the Go version, now 1.27. Every `setup-go` reads it with `go-version-file`.
- `make vuln` runs a pinned govulncheck. The factory release runs it before it builds, and the workflow `vuln` every Monday.
- Tests in `tests/test_release.py` hold all three.

## Consequences
- An action changes only through a pull request that names the new commit.
- Dependabot raises no security alert for a SHA pin. Its weekly updates carry the fix.
- A new Go minor is one line in `factory/go.mod`, plus the runbook's install command for the host.
- `make check` stays offline, so a newly published vulnerability fails a release or the weekly run, not an unrelated pull request.
- Rejected: `golang/govulncheck-action`. It installs govulncheck unpinned and checks with its own latest Go.
- Rejected for now: the Playwright image by digest. A test already holds its tag to the lockfile.
