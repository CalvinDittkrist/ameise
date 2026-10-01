// The helper of the tests of the standardize steps: a temporary repository with one commit on main, and a step
// run in it against the gh and claude shims of tests/shims, whose stateful GitHub lives in a directory of JSON
// files (SHIM_WS). The steps run as the controller runs them, in this process, and every command they start gets
// the shims first on PATH and a git that reads no configuration of the host.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach } from 'vitest'
import { type Ctx, step } from '../src/standard/lib.js'

export const root = fileURLToPath(new URL('../..', import.meta.url))
export const shims = join(root, 'tests', 'shims')

// What the host's environment would change: the workflow's own variables, the shims' settings of a suite this
// one runs in, the settings of a Claude Code session and of a make that runs the suite.
for (const k of Object.keys(process.env)) if (/^(WF_|SHIM_|CLAUDE_CODE_|MAKE|MFLAGS)/.test(k)) delete process.env[k]
const isolation = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }

export interface Ran {
  code: number
  lines: string[]
  // out is the lines as the script printed them, one a line.
  out: string
}

export class Fixture {
  readonly base: string
  readonly repo: string
  readonly ws: string
  readonly log: string

  constructor() {
    this.base = realpathSync(mkdtempSync(join(tmpdir(), 'ameise-standard-')))
    this.repo = join(this.base, 'repo')
    this.ws = join(this.base, 'github')
    this.log = join(this.base, 'calls.log')
    mkdirSync(this.repo)
    mkdirSync(this.ws)
    mkdirSync(join(this.base, 'wt'))
    this.git('init', '-q', '-b', 'main')
    this.git('config', 'user.email', 't@example.com')
    this.git('config', 'user.name', 't')
    this.write('README.md', 'hello\n')
    this.git('add', '.')
    this.git('commit', '-qm', 'init')
  }

  git(...args: string[]): string {
    return this.gitIn(this.repo, ...args)
  }

  gitIn(cwd: string, ...args: string[]): string {
    return execFileSync('git', args, { cwd, env: { ...process.env, ...isolation }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  }

  write(path: string, text = 'x\n', at = this.repo) {
    const p = join(at, path)
    mkdirSync(dirname(p), { recursive: true })
    writeFileSync(p, text)
  }

  read(path: string, at = this.repo): string {
    return readFileSync(join(at, path), 'utf8')
  }

  // put writes a file of the shim's GitHub, JSON unless it is text.
  put(name: string, data: unknown) {
    writeFileSync(join(this.ws, name), typeof data === 'string' ? data : JSON.stringify(data))
  }

  github<T = unknown>(name: string): T {
    return JSON.parse(readFileSync(join(this.ws, name), 'utf8')) as T
  }

  // env is what every command of a step gets: the shims first on PATH, their logs, and git isolated from the host.
  env(extra: Record<string, string> = {}): Record<string, string> {
    return {
      PATH: `${shims}:${process.env.PATH ?? ''}`,
      SHIM_LOG: this.log,
      SHIM_ARGV_LOG: join(this.base, 'calls.argv.log'),
      SHIM_WT_ROOT: join(this.base, 'wt'),
      SHIM_MAIN: this.repo,
      ...isolation,
      ...extra,
    }
  }

  // run runs a step in the repository, or in cwd, against the shims' GitHub unless github is false.
  async run(work: (c: Ctx) => Promise<number | void>, opts: { cwd?: string; env?: Record<string, string>; github?: boolean; template?: string } = {}): Promise<Ran> {
    const env = this.env({ ...(opts.github === false ? {} : { SHIM_WS: this.ws }), ...opts.env })
    const r = await step({ root: opts.cwd ?? this.repo, gh: join(shims, 'gh'), env, ...(opts.template ? { template: opts.template } : {}) }, work)
    return { ...r, out: r.lines.map((l) => l + '\n').join('') }
  }

  // calls are the commands the shims logged, one a line.
  calls(): string[] {
    return existsSync(this.log) ? readFileSync(this.log, 'utf8').split('\n').filter((l) => l !== '') : []
  }

  resetCalls() {
    rmSync(this.log, { force: true })
    rmSync(join(this.base, 'calls.argv.log'), { force: true })
  }

  remove() {
    rmSync(this.base, { recursive: true, force: true })
  }
}

// fixture gives each test a repository of its own, removed after it.
export function fixture(): () => Fixture {
  let f: Fixture | undefined
  afterEach(() => {
    f?.remove()
    f = undefined
  })
  return () => (f ??= new Fixture())
}

// section is the lines of out that start with one of keys, in order; a key ending in ':' matches that line exactly
// plus the indented block below it.
export function section(out: string, ...keys: string[]): string[] {
  const result: string[] = []
  let block = false
  for (const line of out.split('\n')) {
    if (line.startsWith('  ') && block) {
      result.push(line)
      continue
    }
    block = false
    for (const k of keys) {
      if (line === k) {
        result.push(line)
        block = true
      } else if (line.startsWith(k + ' ')) result.push(line)
    }
  }
  return result
}
