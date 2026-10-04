#!/usr/bin/env bash
# PROTOTYPE, throwaway. Question: does the bundled /simplify run inside a worker
# session the way the controller starts it (worker agent, worker plugin, no
# background tasks), despite the worker's Agent(worker:...) allowlist, and which
# diff does it pick on a branch without upstream?
#
# Run: ./prototype-simplify.sh [simplify target]
# Look at: the summary at the end and prototype-simplify.log (stream-json).
set -euo pipefail
root=$(cd "$(dirname "$0")" && pwd)
wt="$root/.claude/worktrees/prototype-simplify"
branch=prototype-tmp/simplify
log="$root/prototype-simplify.log"
target=${1:-}

cleanup() {
  git -C "$root" worktree remove --force "$wt" 2>/dev/null || true
  git -C "$root" branch -D "$branch" 2>/dev/null || true
}
cleanup
git -C "$root" worktree add -q -b "$branch" "$wt" HEAD
mkdir -p "$wt/prototype"
cat >"$wt/prototype/clunky.ts" <<'TS'
// Prototype fixture: deliberately clunky code for /simplify to clean up.
export function sumPositive(values: number[]): number {
  let total = 0
  for (let i = 0; i < values.length; i++) {
    const v = values[i]
    if (v > 0) {
      total = total + v
    } else {
      total = total + 0
    }
  }
  return total
}

export function sumNegative(values: number[]): number {
  let total = 0
  for (let i = 0; i < values.length; i++) {
    const v = values[i]
    if (v < 0) {
      total = total + v
    } else {
      total = total + 0
    }
  }
  return total
}

export function isEmpty(values: number[]): boolean {
  if (values.length === 0) {
    return true
  } else {
    return false
  }
}

export function uniqueSorted(values: number[]): number[] {
  const seen: Record<string, boolean> = {}
  const out: number[] = []
  for (let i = 0; i < values.length; i++) {
    if (seen[String(values[i])] !== true) {
      seen[String(values[i])] = true
      out.push(values[i])
    }
  }
  for (let i = 0; i < out.length; i++) {
    for (let j = 0; j < out.length - 1; j++) {
      if (out[j] > out[j + 1]) {
        const t = out[j]
        out[j] = out[j + 1]
        out[j + 1] = t
      }
    }
  }
  return out
}
TS
git -C "$wt" add prototype/clunky.ts
git -C "$wt" -c user.name=prototype -c user.email=prototype@example.invalid commit -q -m "feat: add clunky number helpers (prototype fixture)"
echo "fixture commit: $(git -C "$wt" log --oneline -1)"
echo "upstream: $(git -C "$wt" rev-parse --abbrev-ref '@{upstream}' 2>&1 || true)"

if [ -n "$target" ]; then
  simplify="/simplify $target"
else
  simplify="/simplify"
fi
prompt="You are the worker on branch $branch of this checkout; the base branch is origin/main. The implementation of the issue is committed already (see git log). Before you report, run the bundled Claude Code skill $simplify on the branch's changes, apply what it finds, verify with a single linter or test if one applies to the files you touched, and commit the result in conventional commits. Never push. Then end with one paragraph in plain text: whether /simplify ran, how many review agents it started, exactly which git range or command it used to find the changed code, and what it changed."

echo "running claude in $wt ..."
(
  cd "$wt"
  CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1 WF_CONTROLLER=1 \
  claude -p "$prompt" \
    --agent worker \
    --plugin-dir "$root/plugins/worker" \
    --plugin-dir "$root/plugins/repo-standards" \
    --permission-mode auto \
    --output-format stream-json --verbose \
    >"$log" 2>"$log.err" || echo "claude exited $?"
)

echo
echo "== summary (from $log)"
node - "$log" <<'JS'
const fs = require('fs')
const lines = fs.readFileSync(process.argv[2], 'utf8').split('\n').filter(Boolean)
const uses = new Map()
const results = new Map()
let final = ''
for (const line of lines) {
  let m; try { m = JSON.parse(line) } catch { continue }
  if (m.type === 'assistant' && m.message?.content) {
    for (const c of m.message.content) if (c.type === 'tool_use') uses.set(c.id, c)
  }
  if (m.type === 'user' && m.message?.content) {
    for (const c of m.message.content) if (c.type === 'tool_result') results.set(c.tool_use_id, c)
  }
  if (m.type === 'result') final = m
}
const text = (r) => typeof r?.content === 'string' ? r.content : (r?.content || []).map((x) => x.text || '').join(' ')
for (const [id, u] of uses) {
  const r = results.get(id)
  const inp = JSON.stringify(u.input)
  const short = inp.length > 160 ? inp.slice(0, 160) + '…' : inp
  const flag = r?.is_error ? ' ERROR: ' + text(r).slice(0, 200) : ''
  if (['Skill', 'Agent', 'Task'].includes(u.name) || r?.is_error || /git (diff|log|merge-base|rev-parse|status)/.test(inp)) console.log(`${u.name} ${short}${flag}`)
}
console.log('--- counts:', [...uses.values()].reduce((a, u) => ((a[u.name] = (a[u.name] || 0) + 1), a), {}))
console.log('--- result:', final?.subtype, 'turns', final?.num_turns, 'cost', final?.total_cost_usd)
console.log(final?.result || '')
JS
echo
echo "== worktree after"
git -C "$wt" log --oneline origin/main..HEAD
git -C "$wt" status --short
echo
echo "worktree kept at $wt for inspection; run 'git worktree remove --force $wt && git branch -D $branch' to drop it"
