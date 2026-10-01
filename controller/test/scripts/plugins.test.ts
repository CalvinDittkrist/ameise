// The plugins as files: their manifests, the frontmatter of their skills and agents, the scripts their skills
// inject, and the copy of the label vocabulary repo-standards carries; beside them the error lines of the gate's
// Go part and the browser images of CI.
import { accessSync, constants, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join, relative } from 'node:path'
import { describe, expect, test } from 'vitest'
import { spawnSync } from 'node:child_process'
import { root, standards } from './sandbox.js'

const plugins = readdirSync(join(root, 'plugins'))
  .filter((p) => existsSync(join(root, 'plugins', p, '.claude-plugin', 'plugin.json')))
  .sort()
const read = (path: string) => readFileSync(join(root, path), 'utf8')
const json = (path: string) => JSON.parse(read(path))
const frontmatter = (path: string) => read(path).split('---')[1]!
const list = (dir: string, suffix = '') => (existsSync(join(root, dir)) ? readdirSync(join(root, dir)).filter((f) => f.endsWith(suffix)) : [])
const skills = (plugin: string) => list(`plugins/${plugin}/skills`).filter((s) => existsSync(join(root, 'plugins', plugin, 'skills', s, 'SKILL.md')))
const agents = (plugin: string) => list(`plugins/${plugin}/agents`, '.md').map((a) => a.replace(/\.md$/, ''))

// fields are the frontmatter of an agent as key and value, one a line.
function fields(path: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of frontmatter(path).trim().split('\n')) {
    const at = line.indexOf(': ')
    out[line.slice(0, at)] = line.slice(at + 2)
  }
  return out
}

// declaredTools are the tools of an agent file, each name mapped to its specifier list: `Agent(a, b)` is
// { Agent: ['a', 'b'] }, a bare `Bash` is { Bash: null }. Split on the comma alone, outside parentheses: a tool
// written without the space after it is still a granted tool, and the commas of a specifier list belong to it.
function declaredTools(path: string): Record<string, string[] | null> {
  const declared = /^tools: (.+)$/m.exec(frontmatter(path))
  expect(declared, `${path} declares no tools`).not.toBeNull()
  const tools: Record<string, string[] | null> = {}
  for (const entry of declared![1]!.split(/,(?![^(]*\))/)) {
    const [name, inner] = entry.trim().split(/\((.*)/s)
    tools[name!] = inner ? inner.replace(/\)$/, '').split(',').map((i) => i.trim()) : null
  }
  return tools
}

describe('the plugins', () => {
  test('the marketplace lists every plugin with matching names', () => {
    const listed = Object.fromEntries((json('.claude-plugin/marketplace.json').plugins as { name: string; source: string }[]).map((p) => [p.name, p.source]))
    for (const plugin of plugins) {
      const manifest = json(`plugins/${plugin}/.claude-plugin/plugin.json`)
      expect(manifest.name).toBe(plugin)
      expect(listed[plugin]).toBe(`./plugins/${plugin}`)
      expect(manifest.version).toMatch(/^\d+\.\d+\.\d+$/)
    }
  })

  test('every skill and agent has a frontmatter name matching its file', () => {
    for (const plugin of plugins) {
      for (const skill of skills(plugin)) {
        const fm = frontmatter(`plugins/${plugin}/skills/${skill}/SKILL.md`)
        expect(fm, skill).toContain(`name: ${skill}\n`)
        expect(fm, skill).toContain('description:')
      }
      for (const agent of agents(plugin)) expect(frontmatter(`plugins/${plugin}/agents/${agent}.md`), agent).toContain(`name: ${agent}\n`)
    }
  })

  // The model and effort of an agent are a decision. A session agent names its own model; every subagent runs on
  // sonnet at its effort and none inherits.
  test('the models and efforts of the agents match their role', () => {
    const expected: Record<string, [string, string | null]> = {
      'worker/agents/worker.md': ['opus', null],
      'planner/agents/planner.md': ['fable', null],
    }
    for (const rel of [
      'worker/agents/code-reviewer.md',
      'worker/agents/security-reviewer.md',
      'worker/agents/docs-reviewer.md',
      'worker/agents/test-reviewer.md',
      'worker/agents/senior-reviewer.md',
      'worker/agents/test-hunter.md',
      'worker/agents/docs-lookup.md',
      'repo-standards/agents/agent-config-auditor.md',
      'repo-standards/agents/docs-auditor.md',
      'repo-standards/agents/files-auditor.md',
      'repo-standards/agents/security-auditor.md',
      'repo-standards/agents/tests-ci-auditor.md',
      'repo-standards/agents/workspace-auditor.md',
    ])
      expected[rel] = ['sonnet', 'high']
    const all = plugins.flatMap((p) => agents(p).map((a) => `${p}/agents/${a}.md`)).sort()
    // Every agent file has a decided value, so a new agent cannot slip in on a default.
    expect(all).toEqual(Object.keys(expected).sort())
    for (const rel of all) {
      const fm = frontmatter(`plugins/${rel}`)
      const model = /^model: (.+)$/m.exec(fm)?.[1]
      const effort = /^effort: (.+)$/m.exec(fm)?.[1] ?? null
      // claude plugin validate accepts any string here, so a typo like "fabel" or "hgih" is only caught by this.
      expect(['fable', 'opus', 'sonnet', 'haiku'], rel).toContain(model)
      if (effort !== null) expect(['low', 'medium', 'high', 'xhigh', 'max'], rel).toContain(effort)
      expect([model, effort], rel).toEqual(expected[rel])
    }
  })

  // readOnly expects an agent that only judges: no edit tool and no agent tool, neither granted nor reachable. One
  // that reports to the controller also has StructuredOutput, which hands its result over and changes nothing.
  function readOnly(path: string, reports = false) {
    const f = fields(path)
    expect(f.tools!.split(', '), path).toEqual(['Read', 'Grep', 'Glob', 'Bash', ...(reports ? ['StructuredOutput'] : [])])
    expect(f.disallowedTools!.split(', '), path).toEqual(expect.arrayContaining(['Edit', 'Write', 'NotebookEdit', 'Agent']))
    expect(f, path).not.toHaveProperty('mcpServers')
  }

  test('every auditor is read-only by its declared tools', () => {
    expect(agents('repo-standards').sort()).toEqual(['files', 'agent-config', 'docs', 'tests-ci', 'workspace', 'security'].map((n) => `${n}-auditor`).sort())
    for (const agent of agents('repo-standards')) readOnly(`plugins/repo-standards/agents/${agent}.md`, true)
  })

  test('the documentation lookup is read-only by its declared tools', () => {
    readOnly('plugins/worker/agents/docs-lookup.md')
  })

  // A hunter reads repository files and nothing else: without a shell it can neither run a test nor change a file,
  // whatever the files it reads tell it to do.
  test('the hunter is read-only and has no shell by its declared tools', () => {
    const f = fields('plugins/worker/agents/test-hunter.md')
    expect(f.tools!.split(', ')).toEqual(['Read', 'Grep', 'Glob'])
    expect(f.disallowedTools!.split(', ')).toEqual(expect.arrayContaining(['Bash', 'Edit', 'Write', 'NotebookEdit', 'Agent']))
    expect(f).not.toHaveProperty('mcpServers')
  })

  test('the test hunt skill is user-invoked only', () => {
    expect(frontmatter('plugins/worker/skills/hunt-tests/SKILL.md')).toContain('disable-model-invocation: true\n')
  })

  // The controller drives the stages (ADR 0063): the worker plugin holds prompts, and a script only where a skill
  // injects or runs it.
  test('the worker plugin carries skills and agents and no hook', () => {
    expect(existsSync(join(root, 'plugins/worker/hooks')), 'the worker plugin carries a hooks directory').toBe(false)
    expect(json('plugins/worker/.claude-plugin/plugin.json')).not.toHaveProperty('hooks')
    const used = new Set<string>()
    for (const skill of skills('worker')) for (const [, name] of read(`plugins/worker/skills/${skill}/SKILL.md`).matchAll(/\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/([\w.-]+)/g)) used.add(name!)
    const scripts = list('plugins/worker/scripts', '.sh').filter((s) => s !== 'lib.sh')
    expect(scripts.sort(), 'a worker script no skill runs is steering the controller owns').toEqual([...used].sort())
  })

  // The controller writes GitHub, captures prototypes, finishes plans and runs acceptances (ADR 0063): the planner
  // plugin holds prompts and nothing that runs.
  test('the planner plugin carries skills and agents and no hook or script', () => {
    expect(existsSync(join(root, 'plugins/planner/hooks')), 'the planner plugin carries a hooks directory').toBe(false)
    expect(existsSync(join(root, 'plugins/planner/scripts')), 'the planner plugin carries a scripts directory').toBe(false)
    expect(json('plugins/planner/.claude-plugin/plugin.json')).not.toHaveProperty('hooks')
    for (const skill of skills('planner')) expect(read(`plugins/planner/skills/${skill}/SKILL.md`), skill).not.toContain('${CLAUDE_PLUGIN_ROOT}/scripts/')
  })

  // The worker's main context holds issue text written by someone else, so its own tool list carries no free web
  // access; the documentation arrives through the pinned script and a lookup subagent (issue #44, ADR 0030).
  test('the worker reaches the documentation through its script and not through the web tools', () => {
    const tools = declaredTools('plugins/worker/agents/worker.md')
    for (const tool of ['WebFetch', 'WebSearch']) expect(tools, `worker.md lists ${tool}; the documentation is read with /worker:docs`).not.toHaveProperty(tool)
  })

  // A subagent's declared tools are granted, not intersected with the worker's, so a bare `Agent` hands the worker
  // every built-in type, the ones with WebFetch and WebSearch among them. The allowlist names the plugin's own
  // subagents and nothing else (ADR 0030).
  test('the worker spawns its own subagents and no other type', () => {
    const own = agents('worker')
      .filter((a) => a !== 'worker')
      .map((a) => `worker:${a}`)
    const allowed = declaredTools('plugins/worker/agents/worker.md').Agent
    expect(allowed, 'worker.md has no Agent(...) allowlist; a bare Agent spawns every built-in type').toBeTruthy()
    expect([...allowed!].sort()).toEqual(own.sort())
  })

  test('every planner skill is user-invoked only', () => {
    expect(skills('planner')).toContain('accept')
    for (const skill of skills('planner')) expect(frontmatter(`plugins/planner/skills/${skill}/SKILL.md`), skill).toContain('disable-model-invocation: true\n')
  })

  // A forked skill's !`command` fails silently without a matching allowed-tools rule (verified on 2.1.274).
  test('every inline command in a skill is pre-approved', () => {
    for (const plugin of plugins)
      for (const skill of skills(plugin)) {
        const [, fm, body] = read(`plugins/${plugin}/skills/${skill}/SKILL.md`).split('---')
        const rules = [...fm!.matchAll(/Bash\(([^)]+)\)/g)].map((m) => m[1]!)
        for (const [, cmd] of body!.matchAll(/!`([^`]+)`/g)) {
          const script = cmd!.split(/\s+/)[0]!
          expect(script.startsWith('${CLAUDE_PLUGIN_ROOT}/scripts/'), `${skill}: ${cmd} must be a plugin script`).toBe(true)
          expect(
            rules.some((r) => script === r.replace(/\*+$/, '')),
            `${skill}: no allowed-tools rule for ${cmd}`,
          ).toBe(true)
        }
      }
  })

  test('the scripts the skills and hooks name exist and are executable', () => {
    for (const plugin of plugins) {
      const texts = skills(plugin).map((s) => read(`plugins/${plugin}/skills/${s}/SKILL.md`))
      if (existsSync(join(root, 'plugins', plugin, 'hooks/hooks.json'))) texts.push(read(`plugins/${plugin}/hooks/hooks.json`))
      for (const text of texts)
        for (const [, name] of text.matchAll(/\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/([\w.-]+)/g)) {
          const script = join(root, 'plugins', plugin, 'scripts', name!)
          expect(existsSync(script), script).toBe(true)
          expect(statSync(script).mode & 0o111, `${script} not executable`).not.toBe(0)
        }
    }
  })
})

// repo-standards carries a copy of the label vocabulary, and the contract fixture states it (ADR 0062); a copy that
// differs from the fixture is a bug. The controller carries another copy, which its own test holds to the fixture.
describe('the label vocabulary of repo-standards', () => {
  const copy = relative(root, join(standards, 'lib.sh'))
  const fixture = json('contract/fixture.json')

  // vocabulary is WF_LABELS as workspace.sh feeds it into its label loop, sourced outside a git repository,
  // because reading the vocabulary must not need one. Split like every shell reader of the value: a pipe in the
  // description belongs to the description.
  function vocabulary(): [string, string, string][] {
    const dir = mkdtempSync(join(tmpdir(), 'ameise-labels-'))
    try {
      const r = spawnSync('bash', ['-c', '. "$1/lib.sh"; printf "%s\\n" "$WF_LABELS"', '_', standards], { cwd: dir, encoding: 'utf8' })
      expect(r.status, r.stderr).toBe(0)
      return r.stdout
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          const at = line.indexOf('|')
          const next = line.indexOf('|', at + 1)
          expect(at > 0 && next > at, `${copy} has a label that is not name|color|description: ${JSON.stringify(line)}`).toBe(true)
          return [line.slice(0, at), line.slice(at + 1, next), line.slice(next + 1)]
        })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  test('follows the contract fixture', () => {
    const want = (fixture.labels.vocabulary as { name: string; color: string; description: string }[]).map((l) => [l.name, l.color, l.description])
    const have = vocabulary()
    expect(have.length, `no labels read from ${copy}`).toBeGreaterThan(0)
    // Change the fixture first, then every copy; do not adjust this test.
    expect(have, `${copy} differs from the contract fixture`).toEqual(want)
  })

  // The frontier rule of the contract fixture leaves an issue with the routing label to the factory; a repository
  // that lacks the label could not be routed by the name the peers read.
  test('carries the routing label of the fixture', () => {
    expect(
      vocabulary().map(([name]) => name),
      `the fixture routes by a label ${copy} does not define`,
    ).toContain(fixture.frontier.routing_label)
  })
})

function which(cmd: string): string | undefined {
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    try {
      accessSync(join(dir, cmd), constants.X_OK)
      return join(dir, cmd)
    } catch {
      // not in this directory
    }
  }
  return undefined
}

// `factory-go`, the Go part of `make factory`: a tool it needs and cannot find is named with its fix.
describe('the gate of the factory', () => {
  // gate runs the recipe with nothing on PATH but the named tools, each a stub that succeeds and prints nothing. It
  // is the Go part alone: `make factory` builds the dashboard first, which needs an npm this PATH has not.
  function gate(...tools: string[]) {
    const path = mkdtempSync(join(tmpdir(), 'ameise-gate-'))
    try {
      for (const tool of tools) {
        writeFileSync(join(path, tool), '#!/bin/sh\nexit 0\n')
        chmodSync(join(path, tool), 0o755)
      }
      return spawnSync(which('make')!, ['factory-go'], { cwd: root, env: { PATH: path, HOME: path }, encoding: 'utf8' })
    } finally {
      rmSync(path, { recursive: true, force: true })
    }
  }

  test('names a missing go with the fix', () => {
    const r = gate()
    expect(r.status).not.toBe(0)
    expect(r.stderr).toContain('error: go not installed; brew install go')
  })

  test('fails when gofmt cannot run instead of passing', () => {
    const r = gate('go')
    expect(r.status).not.toBe(0)
    expect(r.stderr).toContain('error: gofmt could not run')
  })

  test('names a missing staticcheck with the pinned install', () => {
    const r = gate('go', 'gofmt')
    expect(r.status).not.toBe(0)
    const named = /error: staticcheck not installed; go install honnef\.co\/go\/tools\/cmd\/staticcheck@([0-9.]+)/.exec(r.stderr)
    expect(named, r.stderr).not.toBeNull()
    // Local and CI findings match only while both run the same version.
    const ci = read('.github/workflows/ci.yml')
    expect(ci).toContain(`go install honnef.co/go/tools/cmd/staticcheck@${named![1]}\n`)
    // CI installs it only when its cache misses, so the cached binary has to be keyed by that version too.
    expect([...ci.matchAll(/key: staticcheck-([0-9.]+)-/g)].map((m) => m[1])).toEqual([named![1]])
  })
})

// CI runs each browser test in Playwright's image, which carries one browser build. A tag behind the lockfile
// leaves the test without its browser, and `playwright install` in the gate would fetch it without the system
// libraries the image was chosen to carry.
test.each([
  ['factory-browser', 'factory/ui'],
  ['local', 'dashboard'],
])('the CI job %s runs the image of the Playwright its lockfile installs', (job, ui) => {
  const ci = read('.github/workflows/ci.yml')
  const block = new RegExp(`^  ${job}:\\n([\\s\\S]*?)(?=^  \\S|(?![\\s\\S]))`, 'm').exec(ci)
  expect(block, `no job ${job} in ci.yml`).not.toBeNull()
  const tag = /image: mcr\.microsoft\.com\/playwright:v([0-9.]+)-noble\n/.exec(block![1]!)
  expect(tag, `job ${job} runs in no Playwright image`).not.toBeNull()
  expect(tag![1]).toBe(json(`${ui}/package-lock.json`).packages['node_modules/playwright-core'].version)
})
