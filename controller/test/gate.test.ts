import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { api, canApi, canIssue, canPages, canPulls, checkout, cleanup, gated, type Machine, machine, play, read, start } from './controller.js'

afterEach(cleanup)

let m: Machine
let dir: string
beforeEach(async () => {
  m = await machine()
  const s = await start(m)
  expect(s.running, s.stderr).toBe(true)
  dir = checkout(m, 'repo', { origin: 'https://github.com/owner/repo.git', originHead: 'main' })
  canPulls(m, 'owner/repo', [])
  canApi(m, 'repos/owner/repo/issues?labels=ready-for-agent&state=open&per_page=100', [])
  canApi(m, 'repos/owner/repo/issues?labels=spec&state=open&per_page=100', [])
  canPages(m, 'repos/owner/repo/branches?per_page=100', [[]])
  expect((await api(m, 'POST', '/api/projects', { path: dir })).status).toBe(201)
  canIssue(m, 'owner/repo', 144, 'Board lists every project', ['ready-for-agent'])
})

interface Attempt {
  stage: string
  kind: string
  result: string
  at: string
  session_id?: string
  commits?: string[]
  commit?: string
  files?: string[]
  exit?: number | null
  tail?: string
  note?: string
}

interface Record {
  id: string
  state: string
  stage: string
  note: string
  worktree: string
  session_id?: string
  hold?: boolean
  history?: Attempt[]
}

// playGate cans the session a fix session of the gate plays, and resume what a resumed session plays.
const playGate = (session: string) => writeFileSync(join(m.claude, 'gate'), session + '\n')
const playResume = (session: string) => writeFileSync(join(m.claude, 'resume'), session + '\n')

const claim = async (env: string[] = []): Promise<Record> => {
  const r = await api(m, 'POST', '/api/processes', { project: dir, issue: 144, env })
  expect(r.status, JSON.stringify(r.body)).toBe(201)
  return (r.body as { record: Record }).record
}

const recordOf = (id: string) => JSON.parse(read(join(m.state, 'processes', `${id}.json`))) as Record

// until waits for the record of the process to satisfy done and answers it.
async function until(id: string, done: (r: Record) => boolean): Promise<Record> {
  for (let i = 0; i < 400; i++) {
    const r = recordOf(id)
    if (done(r)) return r
    await new Promise((d) => setTimeout(d, 50))
  }
  throw new Error(`the process ${id} did not get there: ${JSON.stringify(recordOf(id))}`)
}
const ended = (id: string) => until(id, (r) => r.state !== 'running')

const head = (r: Record) => execFileSync('git', ['-C', r.worktree, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
const shape = (r: Record) => (r.history ?? []).map((h) => `${h.stage} ${h.kind} ${h.result}`)

const board = async () =>
  ((await api(m, 'GET', '/api/board?' + new URLSearchParams({ project: dir }).toString())).body as { processes: { issue: number; state: string; stage: string; note: string; needs: boolean; action: string }[] })
    .processes

const say = (id: string, text: string) => api(m, 'POST', '/api/processes/message', { id, text })

test('a gate that fails starts a fresh fix session, and the gate runs again on what it committed', async () => {
  gated(dir, 'test -f fixed.txt')
  play(m, 'commit board.txt\ncomplete Implemented the board')
  playGate('commit fixed.txt\ncomplete Wrote the missing file')
  const r = await claim()
  const done = await ended(r.id)
  expect(done).toMatchObject({ state: 'ready', stage: 'gate', note: `the gate passed at ${head(done).slice(0, 7)}` })
  expect(shape(done)).toEqual(['implement session complete', 'gate run fail', 'gate session complete', 'gate run pass'])
  const [implement, failed, fix, passed] = done.history ?? []
  expect(failed).toMatchObject({ exit: 2, tail: expect.stringMatching(/Error 1/) })
  expect(fix).toMatchObject({ session_id: expect.stringMatching(/^fake-session-/), commits: [expect.stringMatching(/ fix: write fixed\.txt$/)] })
  expect(fix?.session_id).not.toBe(implement?.session_id)
  expect(passed).toMatchObject({ commit: head(done), exit: 0 })
  // The fix session is a fresh session of its own stage: no resume, and no agent of the worker's pipeline.
  const log = read(m.claudeLog)
  expect(log).not.toMatch(/--resume/)
  expect(log.split('\n').filter((l) => l === '--agent')).toHaveLength(1)
  expect(read(m.claudeLog + '.env')).toMatch(/AMEISE_STAGE="gate"/)
})

test('a gate that still fails once its budget is spent ends the process failed with the end of its output', async () => {
  gated(dir, 'test -f fixed.txt')
  play(m, 'complete Implemented the board')
  playGate('complete Nothing to fix')
  const r = await claim(['WF_GATE_ROUNDS=1'])
  const done = await ended(r.id)
  expect(done.state).toBe('failed')
  expect(done.stage).toBe('gate')
  expect(done.note).toMatch(/^the gate spent its 1 fix session\(s\): make check failed at [0-9a-f]{7} with exit 2; the end of its output:\n[\s\S]*Error 1/)
  expect(shape(done)).toEqual(['implement session complete', 'gate run fail', 'gate session complete', 'gate run fail'])
  expect(await board()).toMatchObject([{ issue: 144, state: 'failed', stage: 'gate', needs: true, action: 'Open' }])
})

test('a merge of the base that conflicts starts a fix session, and the gate passes on its merge', async () => {
  gated(dir)
  play(m, 'wait\ncommit a.txt\ncomplete Implemented the board')
  playGate('run git merge -X ours --no-edit origin/main\ncomplete Merged the base')
  const r = await claim()
  await until(r.id, (x) => !!x.session_id)
  // The base moves on while the session works, with a file of the same name.
  writeFileSync(join(dir, 'a.txt'), 'the base\n')
  const git = (...args: string[]) => execFileSync('git', ['-C', dir, ...args], { stdio: 'pipe' })
  git('add', 'a.txt')
  git('commit', '-q', '-m', 'base')
  git('update-ref', 'refs/remotes/origin/main', 'HEAD')
  expect((await say(r.id, 'go on')).status).toBe(200)
  const done = await ended(r.id)
  expect(done).toMatchObject({ state: 'ready', stage: 'gate' })
  expect(shape(done)).toEqual(['implement session complete', 'gate merge conflict', 'gate session complete', 'gate run pass'])
  expect(done.history?.[1]).toMatchObject({ files: ['a.txt'] })
  expect(read(join(done.worktree, 'a.txt'))).toBe('a.txt\n')
})

test('a fix session that is blocked waits in needs you, and the answer resumes it into the gate', async () => {
  gated(dir, 'test -f fixed.txt')
  play(m, 'complete Implemented the board')
  playGate('blocked Skip the flaky test?')
  const r = await claim()
  const blocked = await ended(r.id)
  expect(blocked).toMatchObject({ state: 'blocked', stage: 'gate', note: 'Skip the flaky test?' })
  expect(await board()).toMatchObject([{ issue: 144, state: 'blocked', stage: 'gate', note: 'Skip the flaky test?', needs: true, action: 'Answer' }])

  playResume('commit fixed.txt\ncomplete Fixed it instead')
  expect((await say(r.id, 'No, fix it')).body).toMatchObject({ delivered: 'resumed' })
  const done = await until(r.id, (x) => x.state !== 'running' && x.state !== 'blocked')
  expect(done).toMatchObject({ state: 'ready', stage: 'gate' })
  expect(shape(done)).toEqual(['implement session complete', 'gate run fail', 'gate session blocked', 'gate session complete', 'gate run pass'])
  expect(done.history?.[3]?.session_id).toBe(done.history?.[2]?.session_id)
})

test('a hold keeps the implement session open at its complete, and its next complete starts the gate', async () => {
  gated(dir)
  play(m, 'wait\ncomplete Implemented the board')
  const r = await claim()
  await until(r.id, (x) => !!x.session_id)
  const held = await api(m, 'POST', '/api/processes/hold', { id: r.id, hold: true })
  expect(held).toEqual({ status: 200, body: { id: r.id, hold: true } })
  expect((await say(r.id, 'go on')).status).toBe(200)
  const open = await ended(r.id)
  expect(open).toMatchObject({ state: 'input', stage: 'implement', hold: false, note: expect.stringMatching(/held open/) })
  expect(shape(open)).toEqual(['implement session complete'])
  expect(await board()).toMatchObject([{ issue: 144, state: 'input', stage: 'implement', needs: true, action: 'Continue' }])

  playResume('complete Renamed the flag as well')
  expect((await say(r.id, 'Rename the flag too')).body).toMatchObject({ delivered: 'resumed' })
  const done = await until(r.id, (x) => x.state !== 'running' && x.state !== 'input')
  expect(done).toMatchObject({ state: 'ready', stage: 'gate' })
  expect(shape(done)).toEqual(['implement session complete', 'implement session complete', 'gate run pass'])

  // Past implement there is nothing to hold.
  const late = await api(m, 'POST', '/api/processes/hold', { id: r.id, hold: true })
  expect(late.status).toBe(409)
})

test('a fix session that runs past the stage timeout ends the process failed', async () => {
  gated(dir, 'test -f fixed.txt')
  play(m, 'complete Implemented the board')
  // Without an end the fix session runs until it is stopped.
  playGate('say Looking into it')
  const r = await claim(['WF_STAGE_TIMEOUT=1'])
  const done = await ended(r.id)
  expect(done).toMatchObject({ state: 'failed', stage: 'gate', note: 'the fix session of the gate ran past its stage timeout of 1 s' })
  expect(shape(done)).toEqual(['implement session complete', 'gate run fail', 'gate session failed'])
})
