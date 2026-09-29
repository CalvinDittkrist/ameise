// The tests' way to the controller: the built binary, started in fake mode on a machine of its own
// and watched over its API, its files and its output. That machine is a temporary directory with the
// configuration, the state, a PATH and a canned GitHub.
import { type ChildProcess, execFileSync, spawn, spawnSync } from 'node:child_process'
import {
  accessSync,
  chmodSync,
  constants,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const binary = fileURLToPath(new URL('../dist/main.js', import.meta.url))

const started: ChildProcess[] = []
const made: string[] = []

// cleanup stops every server a test started, with the sessions it runs in its process group, and
// removes every machine it made.
export function cleanup() {
  for (const p of started.splice(0)) {
    try {
      if (p.pid !== undefined) process.kill(-p.pid, 'SIGKILL')
    } catch {
      // the group is gone already
    }
  }
  // A SIGKILL is delivered, not waited for: a process of the group can still write a file into its
  // machine while rmSync walks it, which fails with ENOTEMPTY. The retries outlast that last write.
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
}

function which(cmd: string): string {
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    try {
      accessSync(join(dir, cmd), constants.X_OK)
      return join(dir, cmd)
    } catch {
      // not in this directory
    }
  }
  throw new Error(`${cmd} is not on PATH`)
}

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer()
    s.on('error', reject)
    s.listen(0, '127.0.0.1', () => {
      const a = s.address()
      s.close(() => resolve(typeof a === 'object' && a ? a.port : 0))
    })
  })
}

export interface Machine {
  root: string
  env: NodeJS.ProcessEnv
  config: string
  state: string
  github: string
  ghLog: string
  // claude is the canned runtime of the scripted claude (see play), claudeLog what it was started with
  // and what it read.
  claude: string
  claudeLog: string
  opened: string
  bin: string
  url: string
  listen: string
  // binary is the controller this machine runs: the build itself, or a copy with a dashboard of the
  // test's own (see dashboard).
  binary: string
}

// machine makes a machine with a free loopback port in its configuration, a logged-in canned GitHub,
// a claude on its PATH and a browser that writes down the address it was opened on. Its PATH holds
// only the tools the controller calls, so a test can take one away.
export async function machine(): Promise<Machine> {
  // The real path, as git names a checkout's top: on macOS the temporary directory is behind a link.
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ameise-')))
  made.push(root)
  const bin = join(root, 'bin')
  mkdirSync(bin)
  for (const tool of ['git', 'bash', 'cat', 'pgrep']) symlinkSync(which(tool), join(bin, tool))
  script(join(bin, 'claude'), 'echo "2.0.0 (Claude Code, scripted)"')
  const opened = join(root, 'opened')
  const browser = join(root, 'browser')
  script(browser, `printf '%s\\n' "$1" >> '${opened}'`)
  const github = join(root, 'github')
  mkdirSync(github)
  const port = await freePort()
  const listen = `127.0.0.1:${port}`
  const config = join(root, 'config', 'ameise', 'config.json')
  mkdirSync(dirname(config), { recursive: true })
  writeFileSync(config, JSON.stringify({ listen }, null, 2) + '\n')
  const ghLog = join(root, 'gh.log')
  const claude = join(root, 'claude')
  mkdirSync(claude)
  const claudeLog = join(root, 'claude.log')
  const env = {
    HOME: root,
    PATH: bin,
    XDG_CONFIG_HOME: join(root, 'config'),
    XDG_DATA_HOME: join(root, 'data'),
    BROWSER: browser,
    AMEISE_FAKE_GH: github,
    AMEISE_FAKE_GH_LOG: ghLog,
    AMEISE_FAKE_CLAUDE: claude,
    AMEISE_FAKE_CLAUDE_LOG: claudeLog,
  }
  return { root, env, config, state: join(root, 'data', 'ameise'), github, ghLog, claude, claudeLog, opened, bin, url: `http://${listen}`, listen, binary }
}

// dashboard gives the machine a copy of the controller whose dashboard build is the files given, each
// a path under the build and its content, or no build at all when there are none. The copy stands
// beside the scripted gh and claude and the packages as the build does, so it runs the same way.
export function dashboard(m: Machine, files: Record<string, string> = {}) {
  const dist = join(m.root, 'controller', 'dist')
  cpSync(dirname(binary), dist, { recursive: true, filter: (from) => from !== join(dirname(binary), 'dashboard') })
  symlinkSync(fileURLToPath(new URL('../fake', import.meta.url)), join(m.root, 'controller', 'fake'))
  symlinkSync(fileURLToPath(new URL('../node_modules', import.meta.url)), join(m.root, 'controller', 'node_modules'))
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dist, 'dashboard', path)), { recursive: true })
    writeFileSync(join(dist, 'dashboard', path), content)
  }
  m.binary = join(dist, 'main.js')
}

export function script(path: string, body: string) {
  writeFileSync(path, `#!/bin/sh\n${body}\n`)
  chmodSync(path, 0o755)
}

export interface Exit {
  code: number | null
  stdout: string
  stderr: string
}

// cli runs one command of the binary to its end.
export function cli(m: Machine, args: string[], cwd?: string): Exit {
  const r = spawnSync(process.execPath, [m.binary, ...args], { env: m.env, cwd, encoding: 'utf8', timeout: 20000 })
  return { code: r.status, stdout: r.stdout, stderr: r.stderr }
}

// start starts the server in fake mode and returns once it listens, or with how it exited.
export function start(m: Machine, args: string[] = ['--fake']): Promise<Exit & { running: boolean; process: ChildProcess }> {
  // The server leads a process group of its own, so cleanup stops the sessions it started with it.
  const p = spawn(process.execPath, [m.binary, ...args], { env: m.env, stdio: ['ignore', 'pipe', 'pipe'], detached: true })
  started.push(p)
  let stdout = ''
  let stderr = ''
  return new Promise((resolve) => {
    p.stdout.on('data', (d: Buffer) => {
      stdout += d
      if (stdout.includes('ameise on ')) resolve({ running: true, code: null, stdout, stderr, process: p })
    })
    p.stderr.on('data', (d: Buffer) => (stderr += d))
    p.on('exit', (code) => resolve({ running: false, code, stdout, stderr, process: p }))
  })
}

export async function api(m: Machine, method: string, path: string, body?: unknown): Promise<{ status: number; body: unknown }> {
  const res = await fetch(m.url + path, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return { status: res.status, body: await res.json() }
}

export interface Checkout {
  origin?: string
  originHead?: string
  declared?: string
}

// checkout makes a git checkout at root/name with the given origin URL, the head origin points at
// and the WF_BASE_BRANCH its settings declare.
export function checkout(m: Machine, name: string, c: Checkout = {}): string {
  const dir = join(m.root, 'src', name)
  mkdirSync(dir, { recursive: true })
  const git = (...args: string[]) => execFileSync('git', ['-C', dir, ...args], { stdio: 'pipe' })
  git('init', '-q', '-b', 'main')
  if (c.declared !== undefined) {
    mkdirSync(join(dir, '.claude'))
    writeFileSync(join(dir, '.claude', 'settings.json'), JSON.stringify({ env: { WF_BASE_BRANCH: c.declared } }))
  }
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init')
  if (c.origin !== undefined) git('remote', 'add', 'origin', c.origin)
  if (c.originHead !== undefined) {
    git('update-ref', `refs/remotes/origin/${c.originHead}`, 'HEAD')
    git('symbolic-ref', 'refs/remotes/origin/HEAD', `refs/remotes/origin/${c.originHead}`)
  }
  return dir
}

// canRepo cans a repository on the fake GitHub with the default branch it names.
export function canRepo(m: Machine, repository: string, defaultBranch: string) {
  const dir = join(m.github, 'repos', repository)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'default-branch'), defaultBranch + '\n')
}

export function read(path: string): string {
  return readFileSync(path, 'utf8')
}

// play cans the session the scripted claude plays next, such as 'ready <message>' (see fake/claude).
// Without one a session runs until it is stopped.
export function play(m: Machine, session: string) {
  writeFileSync(join(m.claude, 'play'), session + '\n')
}

// canApi cans the answer of gh api <endpoint> on the fake GitHub, an endpoint such as
// repos/<owner>/<name>/issues?labels=spec&state=open&per_page=100.
export function canApi(m: Machine, endpoint: string, answer: unknown) {
  const file = join(m.github, 'api', endpoint)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(answer))
}

// canPages cans the answer of gh api --paginate <endpoint> as GitHub writes it over several pages: one
// JSON array per page, one after the other.
export function canPages(m: Machine, endpoint: string, pages: unknown[][]) {
  const file = join(m.github, 'api', endpoint)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, pages.map((p) => JSON.stringify(p)).join('\n'))
}

// canIssue cans an issue of a repository, as gh issue view answers it: its state OPEN or CLOSED and its
// labels by name.
export function canIssue(m: Machine, repository: string, number: number, title: string, labels: string[], state = 'OPEN') {
  mkdirSync(join(m.github, 'repos', repository, 'issues'), { recursive: true })
  writeFileSync(join(m.github, 'repos', repository, 'issues', `${number}.json`), JSON.stringify({ number, title, state, labels: labels.map((name) => ({ name })) }))
}

// canPulls cans the open pull requests of a repository, as gh pr list answers them.
export function canPulls(m: Machine, repository: string, pulls: unknown[]) {
  mkdirSync(join(m.github, 'repos', repository), { recursive: true })
  writeFileSync(join(m.github, 'repos', repository, 'pulls.json'), JSON.stringify(pulls))
}

// worktree adds a worktree of the checkout on a new branch, where the local workflow keeps them.
export function worktree(dir: string, branch: string): string {
  const path = join(dir, '.claude', 'worktrees', branch.replace(/\//g, '-'))
  execFileSync('git', ['-C', dir, 'worktree', 'add', '-q', '-b', branch, path], { stdio: 'pipe' })
  return path
}

// record writes a process record into the machine's state directory, as the controller keeps one.
export function record(m: Machine, id: string, r: Record<string, unknown>) {
  mkdirSync(join(m.state, 'processes'), { recursive: true })
  writeFileSync(join(m.state, 'processes', `${id}.json`), JSON.stringify(r))
}
