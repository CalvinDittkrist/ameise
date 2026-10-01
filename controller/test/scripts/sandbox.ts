// The tests' way to the shell scripts that stay shell: the plugins' injections and standard check, and the
// repository's own release tooling. Each test gets a sandbox: a temporary git repository with one commit on main
// and a bin directory first on PATH that holds the scripted gh of the controller's fake mode (fake/gh, its GitHub
// canned in the sandbox) and the curl and claude shims of controller/test/shims. A script runs as a user runs it,
// with bash, through spawnSync and without a shell, and with a git that reads no configuration of the host.
import { spawnSync, type SpawnSyncReturns } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach } from 'vitest'
import { apiFile } from '../controller.js'

export const root = fileURLToPath(new URL('../../..', import.meta.url))
export const worker = join(root, 'plugins', 'worker', 'scripts')
export const standards = join(root, 'plugins', 'repo-standards', 'scripts')
const shims = fileURLToPath(new URL('../shims', import.meta.url))
const fakeGh = fileURLToPath(new URL('../../fake/gh', import.meta.url))

// The host's git configuration (a global ignore file, hooks, aliases) must not change what a test sees.
export const isolation = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }

// The host's environment without what would change a script's answer: the workflow's own variables, the shims'
// and the fake's settings, a Claude Code session's settings (facts.sh reads CLAUDE_CODE_DISABLE_BACKGROUND_TASKS)
// and a make's (a make that finds MAKELEVEL or MAKEFLAGS acts as a sub-make and prints "Entering directory"
// lines into what a script under test says).
export function hostEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !/^(WF_|SHIM_|AMEISE_|CLAUDE_CODE_|MAKE|MFLAGS)/.test(k)) env[k] = v
  return env
}

export interface Result {
  code: number | null
  stdout: string
  stderr: string
}

export function result(r: SpawnSyncReturns<string>): Result {
  return { code: r.status, stdout: r.stdout, stderr: r.stderr }
}

export interface RunOptions {
  cwd?: string
  stdin?: string
  env?: Record<string, string>
}

export class Sandbox {
  readonly base: string
  readonly repo: string
  readonly bin: string
  // github is the canned GitHub the scripted gh answers from (see fake/gh), ghLog every call it was given.
  readonly github: string
  readonly ghLog: string
  private readonly log: string
  private readonly argvLog: string

  constructor() {
    // The real path, as git names a checkout's top: on macOS the temporary directory is behind a link.
    this.base = realpathSync(mkdtempSync(join(tmpdir(), 'ameise-script-')))
    this.repo = join(this.base, 'repo')
    this.bin = join(this.base, 'bin')
    this.github = join(this.base, 'github')
    this.ghLog = join(this.base, 'gh.log')
    this.log = join(this.base, 'calls.log')
    this.argvLog = join(this.base, 'calls.argv.log')
    for (const d of [this.repo, this.bin, this.github]) mkdirSync(d)
    symlinkSync(fakeGh, join(this.bin, 'gh'))
    for (const tool of ['curl', 'claude']) symlinkSync(join(shims, tool), join(this.bin, tool))
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
    const r = spawnSync('git', args, { cwd, env: { ...hostEnv(), ...isolation }, encoding: 'utf8' })
    if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`)
    return r.stdout
  }

  write(path: string, text = '', at = this.repo) {
    const p = join(at, path)
    mkdirSync(dirname(p), { recursive: true })
    writeFileSync(p, text)
  }

  read(path: string, at = this.repo): string {
    return readFileSync(join(at, path), 'utf8')
  }

  exists(path: string, at = this.repo): boolean {
    return existsSync(join(at, path))
  }

  remove(path: string, at = this.repo) {
    rmSync(join(at, path), { recursive: true, force: true })
  }

  // commit writes the files and commits them.
  commit(files: Record<string, string>, message = 'files') {
    for (const [path, text] of Object.entries(files)) this.write(path, text)
    this.git('add', '.')
    this.git('commit', '-qm', message)
  }

  // onGitHub gives the repository the origin the scripted gh reads its name from, github.com/<nwo>.
  onGitHub(nwo = 'o/r') {
    this.git('remote', 'add', 'origin', `https://github.com/${nwo}.git`)
  }

  // answer cans the answer of gh api <endpoint>, JSON unless it is text: an empty text is the empty 204 of an
  // endpoint such as vulnerability-alerts.
  answer(endpoint: string, data: unknown) {
    writeFileSync(apiFile(this, endpoint), typeof data === 'string' ? data : JSON.stringify(data))
  }

  // projects cans the projects linked to the repository, which gh api graphql answers.
  projects(nwo: string, nodes: unknown[]) {
    mkdirSync(join(this.github, 'repos', nwo), { recursive: true })
    writeFileSync(join(this.github, 'repos', nwo, 'projects.json'), JSON.stringify(nodes))
  }

  env(extra: Record<string, string> = {}): Record<string, string> {
    const host = hostEnv()
    return {
      ...host,
      PATH: `${this.bin}:${host.PATH ?? ''}`,
      AMEISE_FAKE_GH: this.github,
      AMEISE_FAKE_GH_LOG: this.ghLog,
      SHIM_LOG: this.log,
      SHIM_ARGV_LOG: this.argvLog,
      ...isolation,
      ...extra,
    }
  }

  // run runs a script with bash in the repository, or in cwd.
  run(script: string, args: string[] = [], o: RunOptions = {}): Result {
    return result(spawnSync('bash', [script, ...args], { cwd: o.cwd ?? this.repo, env: this.env(o.env), input: o.stdin ?? '', encoding: 'utf8' }))
  }

  // calls are what the curl and claude shims logged, one call a line, such as 'claude plugin install ...'.
  calls(): string[] {
    return existsSync(this.log) ? readFileSync(this.log, 'utf8').split('\n').filter((l) => l !== '') : []
  }

  // argvCalls are the same calls as their argv, so quoting and word splitting stay visible. The shims write \x1f
  // between arguments and \x1e for a newline inside one, so an argument of several lines stays one call.
  argvCalls(): string[][] {
    if (!existsSync(this.argvLog)) return []
    return readFileSync(this.argvLog, 'utf8')
      .split('\n')
      .filter((l) => l !== '')
      .map((l) => l.split('\x1f').map((a) => a.replaceAll('\x1e', '\n')))
  }

  // ghCalls are the calls the scripted gh was given, without the gh in front.
  ghCalls(): string[] {
    return existsSync(this.ghLog) ? readFileSync(this.ghLog, 'utf8').split('\n').filter((l) => l !== '') : []
  }

  resetCalls() {
    for (const f of [this.log, this.argvLog, this.ghLog]) rmSync(f, { force: true })
  }

  cleanup() {
    rmSync(this.base, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
}

// sandbox gives each test a sandbox of its own, removed after it.
export function sandbox(): () => Sandbox {
  let s: Sandbox | undefined
  afterEach(() => {
    s?.cleanup()
    s = undefined
  })
  return () => (s ??= new Sandbox())
}
