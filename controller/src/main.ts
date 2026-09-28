#!/usr/bin/env node
// workflows: with no command it starts the controller's server and opens the browser on it; every
// other command is a client of that running server.
import { spawn } from 'node:child_process'
import { readFileSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, resolve } from 'node:path'
import { address, type Config, ConfigError, configPath, loopback, readConfig, stateDir } from './config.js'
import { run, which } from './exec.js'
import { bundledWorker } from './session.js'
import type { Process, ProjectBoard } from './board.js'
import type { Listed } from './project.js'
import { identity, serve } from './server.js'

const usage = `usage:
  workflows [--fake]                 start the server and open the browser
  workflows projects                 list the projects
  workflows projects add <path>      add the checkout at <path> as a project
  workflows projects remove <path>   remove the project at <path>
  workflows board [<path>]           print the board of every project, or of the project at <path>
  workflows claim <issue> [--yolo] [--force] [--env NAME=VALUE]... [--project <path>]
                                     claim the issue into a work process of the project
  workflows abandon <issue> [--force] [--project <path>]
                                     remove the issue's worktree and process; branch and issue stay

--project names the checkout of the project; without it the project is the checkout of the current
directory. --force claims an issue that is not agent-ready, routed, held in a spec run or claimed on
origin, and abandons a worktree with work not on origin.

--fake answers GitHub with the scripted gh the tests use and plays the sessions with the scripted
claude, so nothing reaches GitHub or a model.`

function die(message: string): never {
  process.stderr.write(`error: ${message}\n`)
  process.exit(1)
}

function config(path: string): Config {
  try {
    return readConfig(path)
  } catch (err) {
    if (err instanceof ConfigError) die(err.message)
    throw err
  }
}

// The scripted gh ships beside the build: dist/main.js reaches fake/gh.
const fakeGh = fileURLToPath(new URL('../fake/gh', import.meta.url))
// The scripted claude beside it plays the sessions in fake mode.
const fakeClaude = fileURLToPath(new URL('../fake/claude', import.meta.url))
// The dashboard's build is written into this one: dist/main.js reaches dist/dashboard.
const dashboard = fileURLToPath(new URL('./dashboard', import.meta.url))

async function start(fake: boolean) {
  const path = configPath()
  const c = config(path)
  const gh = fake ? fakeGh : 'gh'
  try {
    await run(gh, ['--version'])
  } catch {
    die('gh is not installed; install the GitHub CLI (brew install gh, or https://cli.github.com) and log in with gh auth login')
  }
  try {
    await run(gh, ['auth', 'status', '--active', '--hostname', 'github.com'])
  } catch {
    die('gh is not logged in; run gh auth login')
  }
  // Fake mode plays its sessions on the scripted claude it ships, so it needs no claude of the machine.
  const claude = fake ? fakeClaude : which('claude')
  try {
    await run(claude, ['--version'])
  } catch {
    die('claude is not installed; npm install -g @anthropic-ai/claude-code')
  }
  const { host, port, url } = address(c.listen)
  const server = serve({ listen: c.listen, configPath: path, stateDir: stateDir(), gh, fake, runtime: { claude, worker: bundledWorker }, dashboard })
  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') die(`${c.listen} is in use; stop what listens there, or set another loopback address as listen in ${path}`)
    die(err.message)
  })
  server.listen(port, host, () => {
    process.stdout.write(`workflows on ${url} (fake=${fake}, config ${path})\n`)
    browse(url)
  })
  // A process page follows its log over a connection that never ends on its own, so a stop closes it.
  const stop = () => {
    server.close(() => process.exit(0))
    server.closeAllConnections()
  }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
}

// browse opens the dashboard in the browser the environment names in BROWSER, else in the platform's
// own. A browser that does not open costs nothing: the address is printed above.
function browse(url: string) {
  const [cmd, ...args] = process.env.BROWSER
    ? [process.env.BROWSER, url]
    : process.platform === 'darwin'
      ? ['open', url]
      : process.platform === 'win32'
        ? ['cmd', '/c', 'start', '', url]
        : ['xdg-open', url]
  if (!cmd) return
  const child = spawn(cmd, args, { stdio: 'ignore', detached: true })
  child.on('error', () => process.stderr.write(`warning: no browser opened; open ${url}\n`))
  child.unref()
}

// running is the address the server wrote into the state directory when it started, or '' when
// there is none.
function running(): string {
  try {
    return readFileSync(join(stateDir(), 'listen'), 'utf8').trim()
  } catch {
    return ''
  }
}

// call sends one request to the running server and dies with the fix when none runs. It tries the
// address the server started on first, since a listen changed in the file takes effect only at the
// next start. The configured address comes after it, since a server that was killed leaves its record.
// An address is taken only when its answer to GET / carries the server's identity header, so no
// request reaches another service that took the port. A recorded address no workflows answers on is
// stale, and its record is removed.
async function call(method: string, path: string, body?: unknown): Promise<unknown> {
  const { url } = address(config(configPath()).listen)
  const started = running()
  const candidates = [...(started && loopback(started) ? [{ url: address(started).url, record: true }] : []), { url, record: false }]
  let found: string | undefined
  for (const c of candidates) {
    if (await workflows(c.url)) {
      found = c.url
      break
    }
    if (c.record) rmSync(join(stateDir(), 'listen'), { force: true })
  }
  if (!found) die(`workflows is not running on ${url}; start it with workflows`)
  const res = await fetch(found + path, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const answer = (await res.json().catch(() => ({}))) as { error?: string }
  if (!res.ok) die(answer.error ?? `${method} ${path} answered ${res.status}`)
  return answer
}

// workflows says whether the server at url is this controller.
async function workflows(url: string): Promise<boolean> {
  try {
    const res = await fetch(url + '/')
    await res.body?.cancel()
    return res.headers.get(identity) === '1'
  } catch {
    return false
  }
}

function line(p: Listed): string {
  return 'error' in p ? `${p.path}  error: ${p.error}` : `${p.path}  ${p.owner}/${p.name}  base ${p.base}`
}

// age is the time since an instant, in its largest whole unit.
export function age(since: string | null, now = Date.now()): string {
  const t = since === null ? NaN : Date.parse(since)
  if (Number.isNaN(t)) return '-'
  const s = Math.max(0, Math.floor((now - t) / 1000))
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m`
  if (s < 86400) return `${Math.floor(s / 3600)}h`
  return `${Math.floor(s / 86400)}d`
}

function processLine(p: Process): string {
  const pr = p.pr ? `PR #${p.pr.number}${p.pr.draft ? ' draft' : ''} ${p.checks}` : 'no PR'
  const issue = p.issue === null ? '-' : `#${p.issue}`
  return `  ${p.needs ? 'needs you' : 'running  '}  ${p.kind}  ${issue}  ${p.branch}  ${p.stage}  ${p.state}  ${pr}  ${age(p.since)}  ${p.note || '-'}  [${p.action}]`
}

// boardLines is the board as text: a line per project, then one per process, frontier issue, spec
// ready for acceptance and note.
function boardLines(b: ProjectBoard | { path: string; error: string }): string[] {
  if ('error' in b) return [`${b.path}  error: ${b.error}`]
  return [
    `${b.path}  ${b.owner}/${b.name}  base ${b.base}`,
    ...b.processes.map(processLine),
    ...b.frontier.map((i) => `  ready      #${i.number}  ${i.milestone ?? '-'}  ${i.title}  [Claim]`),
    ...b.acceptance.map((i) => `  accept     #${i.number}  ${i.milestone ?? '-'}  ${i.title}  [Accept]`),
    ...b.notes.map((n) => `  note: ${n}`),
  ]
}

// processCommand runs claim or abandon: the issue, then its flags in any order.
async function processCommand(command: 'claim' | 'abandon', args: string[]) {
  let issue: number | undefined
  let project = process.cwd()
  let force = false
  let mode = 'manual'
  const env: string[] = []
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string
    const value = () => {
      const v = args[++i]
      if (v === undefined) die(`${a} needs a value; workflows help lists the commands`)
      return v
    }
    if (a === '--force') force = true
    else if (a === '--yolo' && command === 'claim') mode = 'yolo'
    else if (a === '--env' && command === 'claim') env.push(value())
    else if (a === '--project') project = resolve(value())
    else if (/^#?[0-9]+$/.test(a) && issue === undefined) issue = Number(a.replace(/^#/, ''))
    else die(`unexpected argument ${a}; workflows help lists the commands`)
  }
  if (issue === undefined) die(`${command} needs an issue number; workflows help lists the commands`)
  if (command === 'abandon') {
    const a = (await call('DELETE', '/api/processes', { project, issue, force })) as { branch: string; worktree: string | null }
    process.stdout.write(`abandoned #${issue}  ${a.branch}  worktree ${a.worktree ?? 'none'} removed; the branch and the issue are untouched\n`)
    return
  }
  const c = (await call('POST', '/api/processes', { project, issue, mode, env, force })) as {
    record: { branch: string; worktree: string; base: string; start?: string; mode: string; env: Record<string, string>; state: string }
    warnings: string[]
    quota: string[]
  }
  for (const w of [...c.warnings, ...c.quota]) process.stderr.write(`warning: ${w}\n`)
  const r = c.record
  const knobs = Object.entries(r.env).map(([k, v]) => `${k}=${v}`)
  process.stdout.write(`claimed #${issue}  ${r.branch}  from ${r.start ?? r.base}  ${r.mode}${knobs.length ? '  ' + knobs.join(' ') : ''}  ${r.state}\n  ${r.worktree}\n`)
}

async function main(argv: string[]) {
  const [command, sub, arg, ...rest] = argv
  if (command === 'claim' || command === 'abandon') return processCommand(command, argv.slice(1))
  if (command === undefined || command === '--fake') {
    if (sub !== undefined) die(`unexpected argument ${sub}; workflows help lists the commands`)
    return start(command === '--fake')
  }
  if (command === 'help' || command === '--help' || command === '-h') {
    process.stdout.write(usage + '\n')
    return
  }
  if (command === 'board') {
    if (arg !== undefined) die(`unexpected argument ${arg}; workflows help lists the commands`)
    const boards =
      sub === undefined
        ? ((await call('GET', '/api/board')) as { projects: (ProjectBoard | { path: string; error: string })[] }).projects
        : [(await call('GET', '/api/board?' + new URLSearchParams({ project: resolve(sub) }).toString())) as ProjectBoard]
    for (const b of boards) process.stdout.write(boardLines(b).map((l) => l + '\n').join(''))
    return
  }
  if (command !== 'projects' || rest.length > 0) die(`unknown command ${argv.join(' ')}; workflows help lists the commands`)
  if (sub === undefined || sub === 'list') {
    if (arg !== undefined) die(`unexpected argument ${arg}; workflows help lists the commands`)
    for (const p of (await call('GET', '/api/projects')) as Listed[]) process.stdout.write(line(p) + '\n')
    return
  }
  if ((sub === 'add' || sub === 'remove') && arg !== undefined) {
    const path = resolve(arg)
    if (sub === 'add') process.stdout.write('added ' + line((await call('POST', '/api/projects', { path })) as Listed) + '\n')
    else process.stdout.write(`removed ${((await call('DELETE', '/api/projects', { path })) as { path: string }).path}\n`)
    return
  }
  die(`unknown command ${argv.join(' ')}; workflows help lists the commands`)
}

main(process.argv.slice(2)).catch((err: Error) => die(err.message))
