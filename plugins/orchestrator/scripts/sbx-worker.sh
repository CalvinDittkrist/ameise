#!/usr/bin/env bash
# Run a worker session inside a Docker Sandbox (sbx) for one worktree.
# Usage: sbx-worker.sh <worktree-path> [-- <claude args...>]
# The sandbox is named wf-<repo>-<branch>. Plugins are installed inside the sandbox from the
# marketplace named in WF_MARKETPLACE (default CalvinDittkrist/ameise).
set -euo pipefail
path="${1:-}"; [ -n "$path" ] || { echo "usage: sbx-worker.sh <worktree-path> [-- <claude args...>]" >&2; exit 1; }
shift; [ "${1:-}" = "--" ] && shift
command -v sbx >/dev/null 2>&1 || { echo "error: sbx (Docker Sandboxes) is not installed" >&2; exit 1; }
path=$(cd "$path" && pwd)
repo=$(basename "$(dirname "$(git -C "$path" rev-parse --path-format=absolute --git-common-dir)")")
branch=$(git -C "$path" rev-parse --abbrev-ref HEAD | tr '/' '-')
name="wf-$repo-$branch"
market="${WF_MARKETPLACE:-CalvinDittkrist/ameise}"

boxes=$(sbx ls 2>/dev/null || true)
if ! grep -q "^$name\b" <<<"$boxes"; then
  # Mount only this worktree read-write; the shared skills store stays read-only.
  sbx create claude "$path" --name "$name" --skills readonly -e WF_MODE -e WF_ISSUE -e WF_BASE_BRANCH -q
fi
# Every start reconciles the plugins, so a reused sandbox loads the plugins the session settings name. It first
# uninstalls worker and repo-standards installed from any other marketplace, which installing them from ameise would
# leave loaded beside them. It does so at user scope only, the scope it installs at: project and local scope are
# settings files in the mounted worktree, and an uninstall there would leave a change on the branch. A plugin still
# listed afterwards is the repository's to move, and a warning names it. Each step already done is a no-op.
others='claude plugin list --json 2>/dev/null | grep -oE "\"(worker|repo-standards)@[^\"]+\"" | tr -d "\"" | grep -v "@ameise\$" | sort -u'
reconcile="for id in \$($others); do claude plugin uninstall \"\$id\" --scope user >/dev/null 2>&1; done; left=\$($others); [ -z \"\$left\" ] || echo \"warning: plugins of another marketplace stay loaded inside the sandbox beside those of ameise: \$left; the repository enables them at project or local scope, so enable them from ameise in its settings\" >&2; claude plugin marketplace add '$market' >/dev/null 2>&1; claude plugin install worker@ameise --scope user >/dev/null && claude plugin install repo-standards@ameise --scope user >/dev/null"
sbx exec "$name" sh -c "$reconcile" \
  || echo "warning: plugin install inside sandbox failed; the worker skills may be missing" >&2
exec sbx run --name "$name" -- "$@"
