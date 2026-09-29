// The package the controller is released as (ADR 0060): what npm pack puts into it and what the build
// bundles into it. The build ran before the tests (pretest), so dist is what a release would pack.
import { spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, test } from 'vitest'

const controller = fileURLToPath(new URL('..', import.meta.url))
const checkout = fileURLToPath(new URL('../../plugins', import.meta.url))
const bundle = fileURLToPath(new URL('../dist/plugins', import.meta.url))

const made: string[] = []
afterEach(() => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true })
})

// files are the files under dir, relative to it, with their contents.
function files(dir: string): Map<string, string> {
  const out = new Map<string, string>()
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const path = join(d, name)
      if (name === '__pycache__' || name === '.DS_Store') continue
      if (statSync(path).isDirectory()) walk(path)
      else out.set(relative(dir, path), readFileSync(path, 'utf8'))
    }
  }
  walk(dir)
  return out
}

test('the build bundles the worker, planner and repo-standards plugins as the checkout has them, and no other', () => {
  expect(readdirSync(bundle).sort()).toEqual(['planner', 'repo-standards', 'worker'])
  for (const name of ['worker', 'planner', 'repo-standards']) {
    expect(files(join(bundle, name)), name).toEqual(files(join(checkout, name)))
  }
})

test('the package carries the build, the bundled plugins and the scripted gh and claude, and no sources or tests', () => {
  // --ignore-scripts packs dist as the pretest build left it; the dashboard's build is the dashboard
  // test's to check, since the controller's tests do not build it.
  const r = spawnSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: controller, encoding: 'utf8' })
  expect(r.status, r.stderr).toBe(0)
  const [packed] = JSON.parse(r.stdout) as { name: string; version: string; files: { path: string }[] }[]
  const paths = (packed?.files ?? []).map((f) => f.path)
  expect(packed?.name).toBe('workflows-controller')
  expect(paths).toEqual(
    expect.arrayContaining([
      'package.json',
      'dist/main.js',
      'dist/session.js',
      'fake/gh',
      'fake/claude',
      'dist/plugins/worker/.claude-plugin/plugin.json',
      'dist/plugins/worker/skills/work/SKILL.md',
      'dist/plugins/planner/.claude-plugin/plugin.json',
      'dist/plugins/repo-standards/.claude-plugin/plugin.json',
    ]),
  )
  expect(paths.filter((p) => /^(src|test|scripts|node_modules)\//.test(p) || p.startsWith('dist/plugins/orchestrator/'))).toEqual([])
})

test('packing refuses a build without the dashboard or the plugins, and names the command that builds them', () => {
  const root = mkdtempSync(join(tmpdir(), 'wf-pack-'))
  made.push(root)
  mkdirSync(join(root, 'scripts'))
  cpSync(join(controller, 'scripts', 'check-pack.mjs'), join(root, 'scripts', 'check-pack.mjs'))
  mkdirSync(join(root, 'dist'))
  const r = spawnSync(process.execPath, ['scripts/check-pack.mjs'], { cwd: root, encoding: 'utf8' })
  expect(r.status).not.toBe(0)
  expect(r.stderr).toContain('error: the package would lack dist/dashboard/index.html; run npm --prefix dashboard ci && npm --prefix dashboard run build')
  expect(r.stderr).toContain('error: the package would lack dist/plugins/worker/.claude-plugin/plugin.json; run npm --prefix controller run build')
  expect(r.stderr).toContain('error: the package would lack dist/plugins/planner/.claude-plugin/plugin.json; run npm --prefix controller run build')
  expect(r.stderr).toContain('error: the package would lack dist/plugins/repo-standards/.claude-plugin/plugin.json; run npm --prefix controller run build')
})
