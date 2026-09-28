// The tests' way to the controller: the built binary, started in fake mode on a machine of its own
// and watched over its API, its files and its output. That machine is a temporary directory with the
// configuration, the state, a PATH and a canned GitHub.
import { type ChildProcess, execFileSync, spawn, spawnSync } from 'node:child_process'
import { accessSync, chmodSync, constants, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const binary = fileURLToPath(new URL('../dist/main.js', import.meta.url))

const started: ChildProcess[] = []
const made: string[] = []

// cleanup stops every server a test started and removes every machine it made.
export function cleanup() {
  for (const p of started.splice(0)) p.kill('SIGKILL')
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true })
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
  opened: string
  bin: string
  url: string
  listen: string
}

// machine makes a machine with a free loopback port in its configuration, a logged-in canned GitHub,
// a claude on its PATH and a browser that writes down the address it was opened on. Its PATH holds
// only the tools the controller calls, so a test can take one away.
export async function machine(): Promise<Machine> {
  const root = mkdtempSync(join(tmpdir(), 'workflows-'))
  made.push(root)
  const bin = join(root, 'bin')
  mkdirSync(bin)
  for (const tool of ['git', 'bash', 'cat']) symlinkSync(which(tool), join(bin, tool))
  script(join(bin, 'claude'), 'echo "2.0.0 (Claude Code, scripted)"')
  const opened = join(root, 'opened')
  const browser = join(root, 'browser')
  script(browser, `printf '%s\\n' "$1" >> '${opened}'`)
  const github = join(root, 'github')
  mkdirSync(github)
  const port = await freePort()
  const listen = `127.0.0.1:${port}`
  const config = join(root, 'config', 'workflows', 'config.json')
  mkdirSync(dirname(config), { recursive: true })
  writeFileSync(config, JSON.stringify({ listen }, null, 2) + '\n')
  const ghLog = join(root, 'gh.log')
  const env = {
    HOME: root,
    PATH: bin,
    XDG_CONFIG_HOME: join(root, 'config'),
    XDG_DATA_HOME: join(root, 'data'),
    BROWSER: browser,
    WORKFLOWS_FAKE_GH: github,
    WORKFLOWS_FAKE_GH_LOG: ghLog,
  }
  return { root, env, config, state: join(root, 'data', 'workflows'), github, ghLog, opened, bin, url: `http://${listen}`, listen }
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
  const r = spawnSync(process.execPath, [binary, ...args], { env: m.env, cwd, encoding: 'utf8', timeout: 20000 })
  return { code: r.status, stdout: r.stdout, stderr: r.stderr }
}

// start starts the server in fake mode and returns once it listens, or with how it exited.
export function start(m: Machine, args: string[] = ['--fake']): Promise<Exit & { running: boolean; process: ChildProcess }> {
  const p = spawn(process.execPath, [binary, ...args], { env: m.env, stdio: ['ignore', 'pipe', 'pipe'] })
  started.push(p)
  let stdout = ''
  let stderr = ''
  return new Promise((resolve) => {
    p.stdout.on('data', (d: Buffer) => {
      stdout += d
      if (stdout.includes('workflows on ')) resolve({ running: true, code: null, stdout, stderr, process: p })
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
