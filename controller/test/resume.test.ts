// The resume of an interrupted work process: the delivery graph's mapping names the node it enters,
// from the stage, the fixing flag and the session id of a record of the previous release, which has no
// workflow and no node, or from the node of a record whose node names its stage.
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { api, canApi, canGreen, canIssue, canPages, canPulls, checkout, cleanup, gated, type Machine, machine, read, record, start, worktree } from './controller.js'

afterEach(cleanup)

const id = 'owner-repo-144'
const branch = 'feat/144-board-lists-every-project'
const session = '0b5c3a6e-1111-4222-8333-444455556666'
// hang is a recipe that runs for 30 s; the machine's PATH has no sleep.
const hang = `${process.execPath} -e 'setTimeout(() => {}, 30000)'`

let m: Machine
let dir: string
let tree: string
beforeEach(async () => {
  m = await machine()
  const s = await start(m)
  expect(s.running, s.stderr).toBe(true)
  dir = checkout(m, 'repo', { origin: 'https://github.com/owner/repo.git', originHead: 'main' })
  canPulls(m, 'owner/repo', [])
  canGreen(m, 'owner/repo')
  canApi(m, 'repos/owner/repo/issues?labels=ready-for-agent&state=open&per_page=100', [])
  canApi(m, 'repos/owner/repo/issues?labels=spec&state=open&per_page=100', [])
  canPages(m, 'repos/owner/repo/branches?per_page=100', [[]])
  expect((await api(m, 'POST', '/api/projects', { path: dir })).status).toBe(201)
  canIssue(m, 'owner/repo', 144, 'Board lists every project', ['ready-for-agent'])
  // The gate holds, so a node that runs it again stays on it.
  gated(dir, hang)
  tree = worktree(dir, branch)
})

interface Event {
  event: string
  stage?: string
  resume?: string
}

interface Resumed {
  workflow?: string
  node?: string
  stage: string
  fixing?: boolean
  session_id?: string
}

const file = (path: string) => (existsSync(path) ? read(path) : '')

const events = (): Event[] =>
  file(join(m.state, 'processes', `${id}.events.jsonl`))
    .split('\n')
    .filter((l) => l !== '')
    .map((l) => JSON.parse(l) as Event)

// interrupted writes the record of #144 as a stop leaves it, in the shape of the previous release: no
// workflow and no node, unless the fields name them.
function interrupted(fields: Record<string, unknown>) {
  const now = new Date().toISOString()
  record(m, id, {
    id,
    project: dir,
    kind: 'work',
    branch,
    issue: 144,
    worktree: tree,
    base: 'origin/main',
    mode: 'manual',
    env: {},
    state: 'interrupted',
    note: 'the controller stopped',
    history: [],
    created_at: now,
    updated_at: now,
    ...fields,
  })
}

// resume resumes #144 and answers its record as the resume entered it and the first event of what runs.
async function resume(first: string): Promise<{ record: Resumed; start: Event }> {
  const r = await api(m, 'POST', '/api/processes/resume', { project: dir, issue: 144 })
  expect(r.status, JSON.stringify(r.body)).toBe(200)
  for (let i = 0; i < 200; i++) {
    const start = events().find((e) => e.event === first)
    if (start) return { record: (r.body as { record: Resumed }).record, start }
    await new Promise((d) => setTimeout(d, 50))
  }
  throw new Error(`no ${first} event after the resume: ${JSON.stringify(events())}`)
}

const claudeLog = () => file(m.claudeLog)

// logged waits until the scripted claude has logged the text, the first message of a session the
// controller started, and answers its log.
async function logged(text: string): Promise<string> {
  for (let i = 0; i < 200 && !claudeLog().includes(text); i++) await new Promise((d) => setTimeout(d, 50))
  expect(claudeLog()).toContain(text)
  return claudeLog()
}

// A round of the review whose code reviewer asked for a fix.
const fixRound = {
  stage: 'review',
  kind: 'round',
  result: 'fix',
  at: '2026-10-01T00:00:00Z',
  round: 1,
  verdicts: [{ reviewer: 'code', verdict: 'fix', findings: [{ id: 'code-1-1', severity: 'S2', where: 'src/a.ts:1', claim: 'The limit is off by one', fix: 'Move the bound' }] }],
}
const passRound = { ...fixRound, result: 'pass', verdicts: [{ reviewer: 'code', verdict: 'pass', findings: [] }] }

test('implement with a session id goes on with the session by its id', async () => {
  interrupted({ stage: 'implement', session_id: session })
  const { record: r, start } = await resume('session-start')
  expect(r).toMatchObject({ workflow: 'delivery', node: 'implement', stage: 'implement', session_id: session })
  expect(start).toMatchObject({ stage: 'implement', resume: session })
  expect((await logged(`--resume=${session}`)).split('\n')).toContain(`--resume=${session}`)
})

test('implement without a session id starts a fresh session with the brief', async () => {
  interrupted({ stage: 'implement', fixing: true })
  const { record: r, start } = await resume('session-start')
  expect(r).toMatchObject({ workflow: 'delivery', node: 'implement', stage: 'implement', fixing: false })
  expect(start.resume).toBeUndefined()
  expect(await logged('Implement issue #144')).not.toContain('--resume')
})

test('a gate that fixed nothing runs the gate again', async () => {
  interrupted({ stage: 'gate', session_id: session })
  const { record: r } = await resume('gate-start')
  expect(r).toMatchObject({ workflow: 'delivery', node: 'gate', stage: 'gate', fixing: false })
})

test('a fix session of the gate with a session id goes on with it by its id', async () => {
  interrupted({ stage: 'gate', fixing: true, session_id: session })
  const { record: r, start } = await resume('session-start')
  expect(r).toMatchObject({ workflow: 'delivery', node: 'gate-fix', stage: 'gate', fixing: true })
  expect(start).toMatchObject({ stage: 'gate', resume: session })
  expect((await logged(`--resume=${session}`)).split('\n')).toContain(`--resume=${session}`)
})

test('a fix session of the gate without a session id runs the gate again', async () => {
  interrupted({ stage: 'gate', fixing: true })
  const { record: r } = await resume('gate-start')
  expect(r).toMatchObject({ workflow: 'delivery', node: 'gate', stage: 'gate', fixing: false })
})

test('a review that fixed nothing runs the round again', async () => {
  interrupted({ stage: 'review', session_id: session, history: [fixRound] })
  const { record: r } = await resume('review-start')
  expect(r).toMatchObject({ workflow: 'delivery', node: 'review', stage: 'review', fixing: false })
})

test('a fix session of the review with a session id goes on with it by its id', async () => {
  interrupted({ stage: 'review', fixing: true, session_id: session, history: [fixRound] })
  const { record: r, start } = await resume('session-start')
  expect(r).toMatchObject({ workflow: 'delivery', node: 'review-fix', stage: 'review', fixing: true })
  expect(start).toMatchObject({ stage: 'review', resume: session })
  expect((await logged(`--resume=${session}`)).split('\n')).toContain(`--resume=${session}`)
})

test('a fix session of the review without a session id starts afresh with the findings of the last round', async () => {
  interrupted({ stage: 'review', fixing: true, history: [fixRound] })
  const { record: r, start } = await resume('session-start')
  expect(r).toMatchObject({ workflow: 'delivery', node: 'review-fix', stage: 'review', fixing: true })
  expect(start.resume).toBeUndefined()
  expect(await logged('The limit is off by one')).not.toContain('--resume')
})

test('a fix session of the review without a session id whose last round was no fix runs the round again', async () => {
  interrupted({ stage: 'review', fixing: true, history: [fixRound, passRound] })
  const { record: r } = await resume('review-start')
  expect(r).toMatchObject({ workflow: 'delivery', node: 'review', stage: 'review', fixing: false })
})

test('the pr stage runs again whatever its flag and session id', async () => {
  interrupted({ stage: 'pr', fixing: true, session_id: session })
  const { record: r } = await resume('pr-start')
  expect(r).toMatchObject({ workflow: 'delivery', node: 'pr', stage: 'pr', fixing: false })
})

test('a ci stage that fixed nothing waits again', async () => {
  interrupted({ stage: 'ci', session_id: session })
  const { record: r } = await resume('ci-start')
  expect(r).toMatchObject({ workflow: 'delivery', node: 'ci', stage: 'ci', fixing: false })
})

test('a fix session of the ci stage with a session id goes on with it by its id', async () => {
  interrupted({ stage: 'ci', fixing: true, session_id: session })
  const { record: r, start } = await resume('session-start')
  expect(r).toMatchObject({ workflow: 'delivery', node: 'ci-fix', stage: 'ci', fixing: true })
  expect(start).toMatchObject({ stage: 'ci', resume: session })
  expect((await logged(`--resume=${session}`)).split('\n')).toContain(`--resume=${session}`)
})

test('a fix session of the ci stage without a session id waits again', async () => {
  interrupted({ stage: 'ci', fixing: true })
  const { record: r } = await resume('ci-start')
  expect(r).toMatchObject({ workflow: 'delivery', node: 'ci', stage: 'ci', fixing: false })
})

test('an address-reviews session with a session id goes on with it by its id', async () => {
  interrupted({ stage: 'address-reviews', fixing: true, session_id: session })
  const { record: r, start } = await resume('session-start')
  expect(r).toMatchObject({ workflow: 'delivery', node: 'address-reviews', stage: 'address-reviews', fixing: true })
  expect(start).toMatchObject({ stage: 'address-reviews', resume: session })
  expect((await logged(`--resume=${session}`)).split('\n')).toContain(`--resume=${session}`)
})

test('an address-reviews stage that fixed nothing waits again on the ci stage', async () => {
  interrupted({ stage: 'address-reviews', session_id: session })
  const { record: r } = await resume('ci-start')
  expect(r).toMatchObject({ workflow: 'delivery', node: 'ci', stage: 'ci', fixing: false })
})

test('an address-reviews session without a session id waits again on the ci stage', async () => {
  interrupted({ stage: 'address-reviews', fixing: true })
  const { record: r } = await resume('ci-start')
  expect(r).toMatchObject({ workflow: 'delivery', node: 'ci', stage: 'ci', fixing: false })
})

test('a record whose node names its stage resumes at that node', async () => {
  interrupted({ stage: 'gate', workflow: 'delivery', node: 'gate-fix', session_id: session })
  const { record: r, start } = await resume('session-start')
  expect(r).toMatchObject({ workflow: 'delivery', node: 'gate-fix', stage: 'gate', fixing: true })
  expect(start).toMatchObject({ stage: 'gate', resume: session })
})

test('a record whose node names its stage keeps the rules of the session id', async () => {
  interrupted({ stage: 'ci', workflow: 'delivery', node: 'ci-fix' })
  const { record: r } = await resume('ci-start')
  expect(r).toMatchObject({ workflow: 'delivery', node: 'ci', stage: 'ci', fixing: false })
})

test('a record whose node disagrees with its stage resumes through the table', async () => {
  interrupted({ stage: 'gate', workflow: 'delivery', node: 'review-fix', fixing: true, session_id: session })
  const { record: r, start } = await resume('session-start')
  expect(r).toMatchObject({ workflow: 'delivery', node: 'gate-fix', stage: 'gate', fixing: true })
  expect(start).toMatchObject({ stage: 'gate', resume: session })
})

test('an adopted record carries its workflow and node, and its resume starts a fresh implement session', async () => {
  const other = worktree(dir, 'fix/8-by-hand')
  canIssue(m, 'owner/repo', 8, 'By hand', ['ready-for-agent'])
  const a = await api(m, 'POST', '/api/processes/adopt', { project: dir, issue: 8 })
  expect(a.status, JSON.stringify(a.body)).toBe(201)
  expect((a.body as { record: Resumed & { worktree: string } }).record).toMatchObject({ workflow: 'delivery', node: 'implement', stage: 'implement', worktree: other })
  const r = await api(m, 'POST', '/api/processes/resume', { project: dir, issue: 8 })
  expect(r.status, JSON.stringify(r.body)).toBe(200)
  expect((r.body as { record: Resumed }).record).toMatchObject({ workflow: 'delivery', node: 'implement' })
  expect(await logged('Implement issue #8')).not.toContain('--resume')
})

test('a second resume while the first runs is refused', async () => {
  interrupted({ stage: 'gate' })
  await resume('gate-start')
  const again = await api(m, 'POST', '/api/processes/resume', { project: dir, issue: 144 })
  expect(again.status).toBe(409)
  expect((again.body as { error: string }).error).toBe('#144 is running, not interrupted; only an interrupted session resumes')
})
