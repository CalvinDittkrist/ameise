import { type ChildProcess, execFileSync } from 'node:child_process'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { api, canApi, canIssue, canPages, canPulls, checkout, cleanup, cli, type Machine, machine, play, read, record, start, worktree } from './controller.js'

afterEach(cleanup)

let m: Machine
let dir: string
let server: ChildProcess
beforeEach(async () => {
  m = await machine()
  server = await up()
  dir = checkout(m, 'repo', { origin: 'https://github.com/owner/repo.git', originHead: 'main' })
  canPulls(m, 'owner/repo', [])
  canApi(m, 'repos/owner/repo/issues?labels=ready-for-agent&state=open&per_page=100', [])
  canApi(m, 'repos/owner/repo/issues?labels=spec&state=open&per_page=100', [])
  canPages(m, 'repos/owner/repo/branches?per_page=100', [[]])
  expect((await api(m, 'POST', '/api/projects', { path: dir })).status).toBe(201)
  canIssue(m, 'owner/repo', 144, 'Board lists every project', ['ready-for-agent'])
})

async function up(): Promise<ChildProcess> {
  const s = await start(m)
  expect(s.running, s.stderr).toBe(true)
  return s.process
}

// down stops the controller with the signal and waits for it to exit.
async function down(signal: NodeJS.Signals) {
  const exited = new Promise((done) => server.once('exit', done))
  server.kill(signal)
  await exited
}

interface Record {
  id: string
  state: string
  stage: string
  note: string
  branch: string
  worktree: string
  session_id?: string
}

const recordOf = (id: string) => JSON.parse(read(join(m.state, 'processes', `${id}.json`))) as Record
const lastEvent = (id: string) => JSON.parse(read(join(m.state, 'processes', `${id}.events.jsonl`)).trim().split('\n').at(-1) ?? '{}') as { event: string; state?: string }

const board = async () =>
  ((await api(m, 'GET', '/api/board?' + new URLSearchParams({ project: dir }).toString())).body as {
    processes: { issue: number; state: string; stage: string; note: string; needs: boolean; action: string }[]
  }).processes

async function until<T>(read: () => T, done: (v: T) => boolean, what: string): Promise<T> {
  for (let i = 0; i < 200; i++) {
    const v = read()
    if (done(v)) return v
    await new Promise((d) => setTimeout(d, 50))
  }
  throw new Error(`${what} did not happen`)
}

// running claims #144 without a play, so its session runs until it is stopped, and answers its record
// once the session has its id.
async function running(): Promise<Record> {
  const r = await api(m, 'POST', '/api/processes', { project: dir, issue: 144 })
  expect(r.status, JSON.stringify(r.body)).toBe(201)
  const id = (r.body as { record: Record }).record.id
  return until(() => recordOf(id), (x) => !!x.session_id, 'the session id')
}

test('a stop marks the running session interrupted with its id, the restart shows every process as it was, and a resume goes on by the id', async () => {
  const r = await running()
  const sessionId = r.session_id ?? ''
  record(m, 'p9', { project: dir, kind: 'work', branch: 'feat/9-asks', issue: 9, stage: 'implement', state: 'blocked', note: 'Keep the flag?' })

  await down('SIGTERM')
  const stopped = recordOf(r.id)
  expect(stopped).toMatchObject({ state: 'interrupted', session_id: sessionId, note: 'the controller stopped while its implement session ran; resume it to go on' })
  expect(lastEvent(r.id)).toMatchObject({ event: 'session-end', state: 'interrupted' })

  server = await up()
  expect(await board()).toMatchObject([
    { issue: 144, state: 'interrupted', stage: 'implement', needs: true, action: 'Resume' },
    { issue: 9, state: 'blocked', note: 'Keep the flag?', needs: true, action: 'Answer' },
  ])

  play(m, 'ready Pull request #7 is green')
  const resumed = cli(m, ['resume', '144', '--project', dir])
  expect(resumed.stderr).toBe('')
  expect(resumed.stdout).toMatch(/^resumed #144 {2}feat\/144-board-lists-every-project {2}running {2}implement session resumed\n/)
  const done = await until(() => recordOf(r.id), (x) => x.state !== 'running', 'the end of the resumed session')
  expect(done).toMatchObject({ state: 'ready', note: 'Pull request #7 is green', session_id: sessionId })
  // The runtime was started on the session it resumes, in the same worktree.
  expect(read(m.claudeLog).split('\n')).toContain(`--resume=${sessionId}`)

  const again = await api(m, 'POST', '/api/processes/resume', { project: dir, issue: 144 })
  expect(again.status).toBe(409)
  expect((again.body as { error: string }).error).toBe('#144 is ready, not interrupted; only an interrupted session resumes')
})

test('a controller killed with its session running finds it interrupted at its next start, and a lost worktree refuses the resume', async () => {
  const r = await running()
  await down('SIGKILL')
  expect(recordOf(r.id).state).toBe('running')
  server = await up()
  expect(recordOf(r.id)).toMatchObject({ state: 'interrupted', session_id: r.session_id })

  await down('SIGKILL')
  rmSync(r.worktree, { recursive: true, force: true })
  record(m, r.id, { ...recordOf(r.id), state: 'running' })
  server = await up()
  expect(recordOf(r.id).note).toBe(`the controller stopped while its implement session ran, and its worktree ${r.worktree} is gone; abandon it`)
  const refused = await api(m, 'POST', '/api/processes/resume', { project: dir, issue: 144 })
  expect(refused.status).toBe(409)
  expect((refused.body as { error: string }).error).toMatch(/is gone, so its session cannot go on there; abandon #144$/)
  expect(recordOf(r.id).state).toBe('interrupted')
})

test('a worktree the state does not know is foreign, a claim of its issue names it, and an adopt makes it a process a resume starts', async () => {
  const tree = worktree(dir, 'fix/8-by-hand')
  worktree(dir, 'feat/12-left-over')
  canIssue(m, 'owner/repo', 8, 'By hand', ['ready-for-agent'])
  expect(await board()).toMatchObject([
    { issue: 12, state: 'foreign', stage: 'implement', note: 'not started by this controller; adopt it or remove it', needs: true, action: 'Adopt' },
    { issue: 8, state: 'foreign', needs: true, action: 'Adopt' },
  ])
  const foreign = await api(m, 'POST', '/api/processes', { project: dir, issue: 8, force: true })
  expect(foreign.status).toBe(409)
  expect(foreign.body).toMatchObject({ process: { id: null, branch: 'fix/8-by-hand', worktree: tree, state: 'foreign' } })

  const a = await api(m, 'POST', '/api/processes/adopt', { project: dir, issue: 8 })
  expect(a.status, JSON.stringify(a.body)).toBe(201)
  const adopted = (a.body as { record: Record }).record
  expect(adopted).toMatchObject({ branch: 'fix/8-by-hand', worktree: tree, state: 'interrupted', stage: 'implement' })
  expect(adopted.session_id).toBeUndefined()
  expect((await board()).find((p) => p.issue === 8)).toMatchObject({ state: 'interrupted', needs: true, action: 'Resume' })
  expect((await api(m, 'POST', '/api/processes/adopt', { project: dir, issue: 8 })).status).toBe(409)

  // A claim of an issue whose process exists is refused, and the answer names the process.
  const claimed = await api(m, 'POST', '/api/processes', { project: dir, issue: 8 })
  expect(claimed.status).toBe(409)
  expect(claimed.body).toMatchObject({
    error: `#8 has a process already: ${adopted.id}, interrupted on fix/8-by-hand; open it on the board, or abandon it first`,
    process: { id: adopted.id, branch: 'fix/8-by-hand', worktree: tree, state: 'interrupted' },
  })

  // A process adopted without a session starts a fresh one.
  play(m, 'blocked Which flag?')
  expect((await api(m, 'POST', '/api/processes/resume', { project: dir, issue: 8 })).status).toBe(200)
  const done = await until(() => recordOf(adopted.id), (x) => x.state !== 'running', 'the end of the session')
  expect(done).toMatchObject({ state: 'blocked', note: 'Which flag?' })
  expect(read(m.claudeLog)).toContain('/worker:work Work issue #8')
  expect(read(m.claudeLog)).not.toContain('--resume=')

  // The other foreign worktree is removed as an abandon removes any.
  expect((await api(m, 'DELETE', '/api/processes', { project: dir, issue: 12 })).status).toBe(200)
  expect((await api(m, 'POST', '/api/processes/adopt', { project: dir, issue: 12 })).status).toBe(404)
})

test('an adopt takes the worktree on the branch it names, and a resume refuses a worktree path reused for another branch', async () => {
  const first = worktree(dir, 'fix/8-by-hand')
  const second = worktree(dir, 'feat/8-again')
  canIssue(m, 'owner/repo', 8, 'By hand', ['ready-for-agent'])

  const unnamed = await api(m, 'POST', '/api/processes/adopt', { project: dir, issue: 8 })
  expect(unnamed.status).toBe(409)
  expect((unnamed.body as { error: string }).error).toMatch(/^#8 has more than one worktree: .*; name the branch to adopt$/)
  expect((await api(m, 'POST', '/api/processes/adopt', { project: dir, issue: 8, branch: 'feat/8-other' })).status).toBe(404)

  const a = await api(m, 'POST', '/api/processes/adopt', { project: dir, issue: 8, branch: 'feat/8-again' })
  expect(a.status, JSON.stringify(a.body)).toBe(201)
  const adopted = (a.body as { record: Record }).record
  expect(adopted).toMatchObject({ branch: 'feat/8-again', worktree: second })

  // The adopted worktree is removed by hand and its path taken by the other branch.
  execFileSync('git', ['-C', dir, 'worktree', 'remove', '--force', first], { stdio: 'pipe' })
  execFileSync('git', ['-C', dir, 'worktree', 'remove', '--force', second], { stdio: 'pipe' })
  execFileSync('git', ['-C', dir, 'worktree', 'add', '-q', second, 'fix/8-by-hand'], { stdio: 'pipe' })
  const refused = await api(m, 'POST', '/api/processes/resume', { project: dir, issue: 8 })
  expect(refused.status).toBe(409)
  expect((refused.body as { error: string }).error).toBe(
    `the worktree ${second} of #8 is on fix/8-by-hand, not on feat/8-again, so its session cannot go on there; abandon #8`,
  )
  expect(recordOf(adopted.id).state).toBe('interrupted')
})
