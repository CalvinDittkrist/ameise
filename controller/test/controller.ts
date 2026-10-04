// The tests' way to the controller: the built binary, started in fake mode on a machine of its own
// and watched over its API, its files and its output. That machine is a temporary directory with the
// configuration, the state, a PATH and a canned GitHub.
import { type ChildProcess, execFileSync, spawn, spawnSync } from 'node:child_process'
import {
  accessSync,
  chmodSync,
  constants,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
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
  // make runs the gate command make check; the rest are what the controller and the scripted tools call.
  for (const tool of ['git', 'bash', 'cat', 'pgrep', 'make']) symlinkSync(which(tool), join(bin, tool))
  // A merge the gate makes and a commit of the scripted claude are made in this machine's name.
  writeFileSync(join(root, '.gitconfig'), '[user]\n\tname = t\n\temail = t@t\n')
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

// start starts the server in fake mode and returns once it listens, or with how it exited. The free port
// of the machine can be taken by another process between freePort and the start, so a start that finds
// its address in use moves the machine to another free port and starts again.
export async function start(m: Machine, args: string[] = ['--fake']): Promise<Exit & { running: boolean; process: ChildProcess }> {
  for (let attempt = 1; ; attempt++) {
    const s = await startOnce(m, args)
    if (s.running || attempt >= 5 || !s.stderr.includes(`${m.listen} is in use`)) return s
    await move(m)
  }
}

// move gives the machine another free loopback port, in its configuration too.
async function move(m: Machine) {
  const listen = `127.0.0.1:${await freePort()}`
  const config = JSON.parse(readFileSync(m.config, 'utf8')) as Record<string, unknown>
  if (config.listen === m.listen) writeFileSync(m.config, JSON.stringify({ ...config, listen }, null, 2) + '\n')
  m.listen = listen
  m.url = `http://${listen}`
}

function startOnce(m: Machine, args: string[]): Promise<Exit & { running: boolean; process: ChildProcess }> {
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

// gated gives the checkout the gate command make check, which runs the recipe, and moves origin's base
// to the commit that adds it, so a worktree claimed from origin has it.
export function gated(dir: string, recipe = '@:', base = 'main') {
  writeFileSync(join(dir, 'Makefile'), `check:\n\t${recipe}\n`)
  const git = (...args: string[]) => execFileSync('git', ['-C', dir, ...args], { stdio: 'pipe' })
  git('add', 'Makefile')
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'add the gate')
  git('update-ref', `refs/remotes/origin/${base}`, 'HEAD')
}

// tools links more of this machine's commands into the machine's PATH, such as the ones a plugin's script
// calls that the controller does not.
export function tools(m: Machine, names: string[]) {
  for (const tool of names) symlinkSync(which(tool), join(m.bin, tool))
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
export function canApi(m: Pick<Machine, 'github'>, endpoint: string, answer: unknown) {
  writeFileSync(apiFile(m, endpoint), JSON.stringify(answer))
}

// apiFile is the file of the fake GitHub that answers the endpoint. An endpoint that is also the
// directory of longer ones keeps its answer in the file @ of that directory, as fake/gh reads it.
export function apiFile(m: Pick<Machine, 'github'>, endpoint: string): string {
  let at = join(m.github, 'api')
  for (const part of endpoint.split('/').slice(0, -1)) {
    at = join(at, part)
    if (existsSync(at) && !statSync(at).isDirectory()) {
      renameSync(at, `${at}.answer`)
      mkdirSync(at)
      renameSync(`${at}.answer`, join(at, '@'))
    }
  }
  mkdirSync(at, { recursive: true })
  const file = join(m.github, 'api', endpoint)
  return existsSync(file) && statSync(file).isDirectory() ? join(file, '@') : file
}

// failApi makes gh api <endpoint> fail with the message, as a GitHub that answers an error other than
// not found does.
export function failApi(m: Machine, endpoint: string, message: string) {
  apiFile(m, endpoint)
  writeFileSync(`${join(m.github, 'api', endpoint)}.fails`, message + '\n')
}

// canPages cans the answer of gh api --paginate <endpoint> as GitHub writes it over several pages: one
// JSON array per page, one after the other.
export function canPages(m: Machine, endpoint: string, pages: unknown[][]) {
  writeFileSync(apiFile(m, endpoint), pages.map((p) => JSON.stringify(p)).join('\n'))
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

// canPull cans the number gh pr create gives the next pull request of a repository, and the readings gh
// pr view answers of it in their order, the last one for good (see fake/gh).
export function canPull(m: Machine, repository: string, number: number, readings: unknown[]) {
  const dir = join(m.github, 'repos', repository)
  mkdirSync(join(dir, 'pulls', `${number}.readings`), { recursive: true })
  writeFileSync(join(dir, 'next-pull'), `${number}\n`)
  readings.forEach((r, i) => {
    const file = join(dir, 'pulls', `${number}.readings`, String(i).padStart(3, '0'))
    // The reactions of a reading are what the GraphQL query answers once gh pr view answered it.
    const { reactions, ...view } = r as { reactions?: unknown }
    writeFileSync(`${file}.json`, JSON.stringify(view))
    if (reactions !== undefined) writeFileSync(`${file}.reactions`, JSON.stringify(reactions))
  })
}

// groupsOf makes reactions, each a login and a content that is THUMBS_UP unless given, into the reaction
// groups the GraphQL query answers: a login with [bot] is a Bot reactor, named without it, as GitHub does.
function groupsOf(reactions: { login: string; content?: string }[]) {
  const groups = new Map<string, { __typename: string; login: string }[]>()
  for (const x of reactions) {
    const content = x.content ?? 'THUMBS_UP'
    const bot = x.login.endsWith('[bot]')
    groups.set(content, [...(groups.get(content) ?? []), { __typename: bot ? 'Bot' : 'User', login: x.login.replace(/\[bot\]$/, '') }])
  }
  return [...groups].map(([content, nodes]) => ({ content, reactors: { nodes } }))
}

// reading is a reading of an open pull request as gh pr view answers it: mergeable, with checks of the
// given conclusions, and with the reviews given, each with the association of its author when given; its
// merge state is clean unless it conflicts or is given, and more adds fields. Its reactions on the pull
// request, each a login and a content that is THUMBS_UP unless given, are answered by the GraphQL query.
// A green one has a check that passed and a bot's review.
export function reading(
  number: number,
  o: {
    mergeable?: string
    mergeState?: string
    checks?: Record<string, string>
    reviews?: { login: string; state: string; association?: string; body?: string; at?: string }[]
    reactions?: { login: string; content?: string }[]
    state?: string
    more?: Record<string, unknown>
  } = {},
) {
  const checks = o.checks ?? { gate: 'SUCCESS' }
  const mergeable = o.mergeable ?? 'MERGEABLE'
  return {
    number,
    url: `https://github.com/owner/repo/pull/${number}`,
    state: o.state ?? 'OPEN',
    mergeable,
    mergeStateStatus: o.mergeState ?? (mergeable === 'CONFLICTING' ? 'DIRTY' : 'CLEAN'),
    statusCheckRollup: Object.entries(checks).map(([name, conclusion]) =>
      conclusion === 'PENDING' ? { name, status: 'IN_PROGRESS', conclusion: null } : { name, status: 'COMPLETED', conclusion, detailsUrl: `https://github.com/owner/repo/actions/runs/7/job/${name}` },
    ),
    reviews: (o.reviews ?? [{ login: 'chatgpt-codex-connector', state: 'COMMENTED' }]).map((r, i) => ({
      id: `R-${r.login}-${r.at ?? i}`,
      author: { login: r.login },
      ...(r.association ? { authorAssociation: r.association } : {}),
      state: r.state,
      body: r.body ?? 'Looked.',
      submittedAt: r.at ?? `2026-09-30T10:0${i}:00Z`,
    })),
    ...(o.reactions ? { reactions: groupsOf(o.reactions) } : {}),
    ...o.more,
  }
}

// canGreen cans pull request 1 of a repository as green from its first reading, so a process goes on
// from its review to ready.
export const canGreen = (m: Machine, repository: string) => canPull(m, repository, 1, [reading(1)])
