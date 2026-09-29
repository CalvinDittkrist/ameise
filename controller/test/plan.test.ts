import { type ChildProcess, execFileSync } from 'node:child_process'
import { existsSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { api, canApi, canIssue, canPages, canPulls, checkout, cleanup, cli, type Machine, machine, play, read, start } from './controller.js'

afterEach(cleanup)

let m: Machine
let dir: string
let server: ChildProcess
beforeEach(async () => {
  m = await machine()
  // A capture commits, so the machine's git has an author.
  m.env = { ...m.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' }
  const s = await start(m)
  expect(s.running, s.stderr).toBe(true)
  server = s.process
  dir = checkout(m, 'repo', { origin: 'https://github.com/owner/repo.git', originHead: 'main' })
  canPulls(m, 'owner/repo', [])
  canApi(m, 'repos/owner/repo/issues?labels=ready-for-agent&state=open&per_page=100', [])
  canApi(m, 'repos/owner/repo/issues?labels=spec&state=open&per_page=100', [])
  canPages(m, 'repos/owner/repo/branches?per_page=100', [[]])
  expect((await api(m, 'POST', '/api/projects', { path: dir })).status).toBe(201)
  canIssue(m, 'owner/repo', 12, 'Fix login timeout', ['needs-triage'])
  const file = join(m.github, 'repos', 'owner', 'repo', 'issues', '12.json')
  writeFileSync(file, JSON.stringify({ ...JSON.parse(read(file)), body: 'SECRET-BODY-TEXT' }))
})

interface Record {
  id: string
  kind: string
  route: string
  topic?: string
  issue: number | null
  state: string
  stage: string
  note: string
  branch: string
  base: string
  worktree: string
  session_id?: string
}

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: 'pipe' }).trim()

const planned = async (body: { idea?: string; issue?: number }): Promise<Record> => {
  const r = await api(m, 'POST', '/api/plans', { project: dir, ...body })
  expect(r.status, JSON.stringify(r.body)).toBe(201)
  return (r.body as { record: Record }).record
}

const recordOf = (id: string) => JSON.parse(read(join(m.state, 'processes', `${id}.json`))) as Record

// waiting waits for the planner to end its turn and answers the record.
async function waiting(id: string): Promise<Record> {
  for (let i = 0; i < 200; i++) {
    const r = recordOf(id)
    if (r.state !== 'running' && r.state !== 'created') return r
    await new Promise((done) => setTimeout(done, 50))
  }
  throw new Error(`the session of ${id} did not end its turn: ${JSON.stringify(recordOf(id))}`)
}

const board = async () =>
  ((await api(m, 'GET', '/api/board?' + new URLSearchParams({ project: dir }).toString())).body as { processes: { kind: string; issue: number | null; branch: string; state: string; needs: boolean; action: string }[] })
    .processes

// sessions are the runs of the scripted claude, in order: each one's arguments and the lines it read.
function sessions(): { args: string[]; read: string[] }[] {
  const out: { args: string[]; read: string[] }[] = []
  for (const line of read(m.claudeLog).trimEnd().split('\n')) {
    if (line.startsWith('< ')) out.at(-1)?.read.push(line.slice(2))
    else if (out.length === 0 || (out.at(-1)?.read.length ?? 0) > 0) out.push({ args: [line], read: [] })
    else out.at(-1)?.args.push(line)
  }
  return out
}
const flag = (args: string[], name: string) => args[args.indexOf(name) + 1]
const prompt = (s: { read: string[] }) => s.read.find((l) => l.includes('"type":"user"')) ?? ''

test('a plan from an idea opens a plan branch and starts the planner with its plugin, its brief and its settings', async () => {
  play(m, 'ready Which part of offline mode first?')
  const r = await planned({ idea: 'Offline mode' })
  expect(r).toMatchObject({ kind: 'plan', route: 'idea', topic: 'Offline mode', issue: null, branch: 'plan/offline-mode', base: 'origin/main', state: 'running', stage: 'plan' })
  expect(r.worktree).toBe(join(dir, '.claude', 'worktrees', 'plan-offline-mode'))
  expect(git(r.worktree, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('plan/offline-mode')
  expect(git(dir, 'config', 'branch.plan/offline-mode.description')).toBe('topic: Offline mode')

  // The session ends its turn: the process waits for the maintainer, who continues it.
  expect(await waiting(r.id)).toMatchObject({ state: 'input', note: 'Which part of offline mode first?' })
  expect(await board()).toMatchObject([{ kind: 'plan', issue: null, branch: 'plan/offline-mode', state: 'input', needs: true, action: 'Continue' }])

  const [s] = sessions()
  expect(s).toBeDefined()
  const args = s?.args ?? []
  expect(flag(args, '--plugin-dir')).toBe(resolve(fileURLToPath(new URL('../../plugins/planner', import.meta.url))))
  expect(flag(args, '--agent')).toBe('planner')
  // A planner reports no structured result.
  expect(args).not.toContain('--json-schema')
  const settings = JSON.parse(flag(args, '--settings') ?? '{}') as { env: { [k: string]: string }; enabledPlugins: { [k: string]: boolean } }
  expect(settings.env).toMatchObject({ WF_PLAN: 'offline-mode', WF_PLAN_CONTROLLER: '1', WF_BASE_BRANCH: 'main' })
  expect(settings.env.WF_PLAN_ISSUE).toBeUndefined()
  expect(settings.enabledPlugins).toMatchObject({ 'planner@workflows': false, 'worker@workflows': false })
  const brief = prompt(s ?? { read: [] })
  expect(brief).toContain('/planner:plan')
  expect(brief).toContain('Planner session: offline-mode')
  expect(brief).toContain('Topic: Offline mode')
  expect(brief).toContain('you do not implement')
})

test('a plan from an issue names the issue and the read of it, and carries none of its text', async () => {
  play(m, 'ready Triage it?')
  const r = await planned({ issue: 12 })
  expect(r).toMatchObject({ route: 'issue', issue: 12, topic: 'Fix login timeout', branch: 'plan/fix-login-timeout' })
  expect(git(dir, 'config', 'branch.plan/fix-login-timeout.description')).toBe('issue: #12')
  await waiting(r.id)
  const s = sessions()[0] ?? { args: [], read: [] }
  expect((JSON.parse(flag(s.args, '--settings') ?? '{}') as { env: { [k: string]: string } }).env.WF_PLAN_ISSUE).toBe('12')
  const brief = prompt(s)
  expect(brief).toContain('Issue: #12')
  expect(brief).toContain('gh issue view 12 --repo owner/repo')
  expect(read(m.claudeLog)).not.toContain('SECRET-BODY-TEXT')
  expect(await board()).toMatchObject([{ kind: 'plan', issue: 12, state: 'input' }])

  // One issue has one process.
  const again = await api(m, 'POST', '/api/plans', { project: dir, issue: 12 })
  expect(again.status).toBe(409)
  expect((again.body as { error: string }).error).toMatch(/#12 has a process already on plan\/fix-login-timeout/)
})

test('a plan with nothing opens an open session', async () => {
  play(m, 'ready What is your question?')
  const r = await planned({})
  expect(r.route).toBe('open')
  expect(r.branch).toMatch(/^plan\/open-\d{8}-\d{6}$/)
  expect(git(dir, 'config', `branch.${r.branch}.description`)).toMatch(/^open: \d{8}-\d{6}$/)
  await waiting(r.id)
  expect(prompt(sessions()[0] ?? { read: [] })).toContain('Open session: no topic')
})

test('a plan is refused with the reason before anything is created', async () => {
  const both = await api(m, 'POST', '/api/plans', { project: dir, idea: 'x', issue: 12 })
  expect(both.status).toBe(400)
  expect((both.body as { error: string }).error).toMatch(/not both/)
  canIssue(m, 'owner/repo', 13, 'Old', [], 'CLOSED')
  const closed = await api(m, 'POST', '/api/plans', { project: dir, issue: 13 })
  expect(closed.status).toBe(409)
  expect((closed.body as { error: string }).error).toMatch(/#13 of owner\/repo is CLOSED/)
  const blank = await api(m, 'POST', '/api/plans', { project: dir, idea: '!!!' })
  expect(blank.status).toBe(400)
  expect(git(dir, 'worktree', 'list')).not.toContain('plan')
  expect(existsSync(join(m.state, 'processes'))).toBe(false)
})

test('a message continues the planner by its session id, and a slash command reaches it as the maintainer wrote it', async () => {
  play(m, 'ready Which part first?')
  const r = await planned({ idea: 'Offline mode' })
  const first = await waiting(r.id)
  const said = await api(m, 'POST', '/api/processes/message', { id: r.id, text: '/planner:grill' })
  expect(said.status, JSON.stringify(said.body)).toBe(200)
  expect(said.body).toMatchObject({ delivered: 'resumed' })
  await new Promise((done) => setTimeout(done, 100))
  expect(await waiting(r.id)).toMatchObject({ state: 'input' })
  const second = sessions()[1] ?? { args: [], read: [] }
  expect(second.args).toContain(`--resume=${first.session_id ?? ''}`)
  expect(flag(second.args, '--agent')).toBe('planner')
  expect(prompt(second)).toContain('"content":"/planner:grill"')
})

test('a capture moves the prototype to its own branch and leaves the plan branch clean, and a finish removes the plan', async () => {
  play(m, 'ready Here is the prototype.')
  const r = await planned({ idea: 'Offline mode' })
  await waiting(r.id)
  writeFileSync(join(r.worktree, 'proto.html'), '<p>proto</p>\n')
  git(r.worktree, 'add', 'proto.html')
  writeFileSync(join(r.worktree, 'notes.txt'), 'untracked\n')

  const c = await api(m, 'POST', '/api/processes/capture', { id: r.id, name: 'State Machine' })
  expect(c.status, JSON.stringify(c.body)).toBe(201)
  expect(c.body).toMatchObject({ branch: 'prototype/offline-mode-state-machine', url: 'https://github.com/owner/repo/tree/prototype/offline-mode-state-machine' })
  expect(git(dir, 'show', 'prototype/offline-mode-state-machine:proto.html')).toBe('<p>proto</p>')
  expect(git(dir, 'show', 'prototype/offline-mode-state-machine:notes.txt')).toBe('untracked')
  expect(git(dir, 'rev-parse', 'prototype/offline-mode-state-machine~1')).toBe(git(dir, 'rev-parse', 'origin/main'))
  // The plan branch carries no commit, and its worktree is clean on it.
  expect(git(r.worktree, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('plan/offline-mode')
  expect(git(dir, 'rev-list', '--count', 'plan/offline-mode', '--not', 'origin/main')).toBe('0')
  expect(git(r.worktree, 'status', '--porcelain')).toBe('')

  const nothing = await api(m, 'POST', '/api/processes/capture', { id: r.id, name: 'again' })
  expect(nothing.status).toBe(409)
  expect((nothing.body as { error: string }).error).toMatch(/nothing to capture/)

  // A change not captured is refused unless forced.
  writeFileSync(join(r.worktree, 'more.txt'), 'more\n')
  const dirty = await api(m, 'POST', '/api/processes/finish', { id: r.id })
  expect(dirty.status).toBe(409)
  expect((dirty.body as { error: string }).error).toMatch(/changes not captured/)
  const f = await api(m, 'POST', '/api/processes/finish', { id: r.id, force: true })
  expect(f.status, JSON.stringify(f.body)).toBe(200)
  expect(f.body).toMatchObject({ branch: 'plan/offline-mode', worktree: r.worktree })
  expect(existsSync(r.worktree)).toBe(false)
  expect(git(dir, 'branch', '--list', 'plan/offline-mode')).toBe('')
  expect(existsSync(join(m.state, 'processes', `${r.id}.json`))).toBe(false)
  expect(await board()).toEqual([])
  // The prototype branch stays.
  expect(git(dir, 'branch', '--list', 'prototype/offline-mode-state-machine')).not.toBe('')
})

test('a finish refuses a commit on the plan branch, and stops a session that runs', async () => {
  // Without a play the session runs until it is stopped.
  const r = await planned({ idea: 'Offline mode' })
  for (let i = 0; i < 100 && !recordOf(r.id).session_id; i++) await new Promise((done) => setTimeout(done, 50))
  const session = recordOf(r.id).session_id ?? ''
  expect(session).toMatch(/^fake-session-\d+$/)
  const capture = await api(m, 'POST', '/api/processes/capture', { id: r.id, name: 'x' })
  expect(capture.status).toBe(409)
  expect((capture.body as { error: string }).error).toMatch(/at work in its worktree/)

  git(r.worktree, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'oops')
  const refused = await api(m, 'POST', '/api/processes/finish', { id: r.id })
  expect(refused.status).toBe(409)
  expect((refused.body as { error: string }).error).toMatch(/1 commit\(s\) not on origin\/main, and a plan branch carries none/)
  git(r.worktree, 'reset', '-q', '--hard', 'origin/main')
  const f = await api(m, 'POST', '/api/processes/finish', { id: r.id })
  expect(f.status, JSON.stringify(f.body)).toBe(200)
  expect(existsSync(r.worktree)).toBe(false)
  // The scripted claude names its session by its pid; the finish answered once it had exited.
  expect(alive(Number(session.replace('fake-session-', '')))).toBe(false)
})

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

test('a capture or a finish of a process that is no plan is refused', async () => {
  expect((await api(m, 'POST', '/api/processes/capture', { id: 'plan-nothing', name: 'x' })).status).toBe(404)
  const r = await planned({ idea: 'Offline mode' })
  const unnamed = await api(m, 'POST', '/api/processes/capture', { id: r.id, name: '  ' })
  expect(unnamed.status).toBe(400)
})

test('the CLI opens a plan from the words of an idea', async () => {
  play(m, 'ready Which part first?')
  const c = cli(m, ['plan', 'Offline', 'mode', '--project', dir])
  expect(c.code, c.stderr).toBe(0)
  expect(c.stdout).toMatch(/^plan Offline mode {2}plan\/offline-mode {2}from origin\/main {2}running\n/)
})

test('a plan whose session the controller stops waits for a message that resumes it', async () => {
  const r = await planned({ idea: 'Offline mode' })
  for (let i = 0; i < 100 && !recordOf(r.id).session_id; i++) await new Promise((done) => setTimeout(done, 50))
  const exited = new Promise((done) => server.once('exit', done))
  server.kill('SIGTERM')
  await exited
  expect(recordOf(r.id)).toMatchObject({ state: 'input', note: 'the controller stopped while the planner session ran; write to it to go on' })
  const s = await start(m)
  expect(s.running, s.stderr).toBe(true)
  expect(await board()).toMatchObject([{ kind: 'plan', state: 'input', action: 'Continue' }])
  play(m, 'ready Where were we?')
  const said = await api(m, 'POST', '/api/processes/message', { id: r.id, text: 'Go on' })
  expect(said.body).toMatchObject({ delivered: 'resumed' })
  await new Promise((done) => setTimeout(done, 100))
  expect(await waiting(r.id)).toMatchObject({ state: 'input', note: 'Where were we?' })
})
