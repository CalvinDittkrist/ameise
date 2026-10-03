// A message to a parked work process is an event on its node of the delivery graph: each park of the
// delivery table takes the edge to its next node, which resumes the session by its id with the message.
// A fix session the resume route goes on with reaches its next node through the engine as well.
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { api, canApi, canGreen, canIssue, canPages, canPulls, checkout, cleanup, gated, type Machine, machine, play, read, start } from './controller.js'

afterEach(cleanup)

const identity = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' }
let m: Machine
let dir: string
beforeEach(async () => {
  m = await machine()
  m.env = { ...m.env, ...identity }
  const s = await start(m)
  expect(s.running, s.stderr).toBe(true)
  dir = checkout(m, 'repo', { origin: 'https://github.com/owner/repo.git', originHead: 'main' })
  gated(dir)
  canPulls(m, 'owner/repo', [])
  canGreen(m, 'owner/repo')
  canApi(m, 'repos/owner/repo/issues?labels=ready-for-agent&state=open&per_page=100', [])
  canApi(m, 'repos/owner/repo/issues?labels=spec&state=open&per_page=100', [])
  canPages(m, 'repos/owner/repo/branches?per_page=100', [[]])
  expect((await api(m, 'POST', '/api/projects', { path: dir })).status).toBe(201)
  canIssue(m, 'owner/repo', 144, 'Board lists every project', ['ready-for-agent'])
})

interface Record {
  id: string
  state: string
  stage: string
  note: string
  node?: string
  fixing?: boolean
  panel?: string
  session_id?: string
  history?: { stage: string; kind: string; result: string; session_id?: string }[]
}

const file = (id: string) => join(m.state, 'processes', `${id}.json`)
const recordOf = (id: string) => JSON.parse(read(file(id))) as Record
const events = (id: string) =>
  read(join(m.state, 'processes', `${id}.events.jsonl`))
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l) as { event: string; stage?: string; state?: string; resume?: string; text?: string })
// turned are the turns of the process the controller announced, by their state.
const turned = (id: string) => {
  const log = join(m.state, 'events.jsonl')
  if (!existsSync(log)) return []
  return read(log)
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l) as { event: string; process?: string; state?: string })
    .filter((e) => e.event === 'turned' && e.process === id)
    .map((e) => e.state)
}

async function until(id: string, done: (r: Record) => boolean): Promise<Record> {
  for (let i = 0; i < 400; i++) {
    const r = recordOf(id)
    if (done(r)) return r
    await new Promise((d) => setTimeout(d, 50))
  }
  throw new Error(`the process ${id} did not get there: ${JSON.stringify(recordOf(id))}`)
}

// parked claims the issue, whose implement session parks blocked, and changes its record to the park given.
async function parked(change: Partial<Record>): Promise<Record> {
  play(m, 'blocked Keep the old flag, or drop it?')
  const r = await api(m, 'POST', '/api/processes', { project: dir, issue: 144, env: ['WF_REVIEWERS=code'] })
  expect(r.status, JSON.stringify(r.body)).toBe(201)
  const id = (r.body as { record: Record }).record.id
  const blocked = await until(id, (x) => x.state === 'blocked')
  // The record names no node, so the park is read from its stage and its fixing flag.
  writeFileSync(file(id), JSON.stringify({ ...blocked, node: undefined, ...change }))
  return recordOf(id)
}

const playResume = (session: string) => writeFileSync(join(m.claude, 'resume'), session + '\n')

// The parks of the delivery table, in the order its edges are checked, with the stage, the fixing flag
// and the node the message takes the process to.
const rows: { park: string; change: Partial<Record>; stage: string; fixing: boolean; node: string }[] = [
  { park: 'ready, past implement', change: { stage: 'ci', state: 'ready', fixing: false, panel: 'pass' }, stage: 'implement', fixing: false, node: 'implement' },
  { park: 'ci, not fixing', change: { stage: 'ci', state: 'blocked', fixing: false }, stage: 'ci', fixing: true, node: 'ci-fix' },
  { park: 'implement', change: { stage: 'implement', state: 'blocked' }, stage: 'implement', fixing: false, node: 'implement' },
  { park: 'gate', change: { stage: 'gate', state: 'failed', fixing: false }, stage: 'gate', fixing: true, node: 'gate-fix' },
  { park: 'review', change: { stage: 'review', state: 'failed', fixing: false }, stage: 'review', fixing: true, node: 'review-fix' },
  { park: 'pr', change: { stage: 'pr', state: 'failed', fixing: false }, stage: 'implement', fixing: false, node: 'implement' },
  { park: 'ci fix', change: { stage: 'ci', state: 'blocked', fixing: true }, stage: 'ci', fixing: true, node: 'ci-fix' },
  { park: 'address reviews', change: { stage: 'address-reviews', state: 'blocked', fixing: true }, stage: 'address-reviews', fixing: true, node: 'address-reviews' },
]

test.each(rows)('a message to a process parked on $park resumes its session in the $node node', async ({ change, stage, fixing, node }) => {
  const before = await parked(change)
  playResume('blocked Which name should it take?')
  const sent = await api(m, 'POST', '/api/processes/message', { id: before.id, text: 'Drop it' })
  expect(sent.body).toMatchObject({ delivered: 'resumed' })
  const after = await until(before.id, (x) => x.state === 'blocked' && x.note === 'Which name should it take?')
  expect(after).toMatchObject({ stage, fixing, node, workflow: 'delivery', session_id: before.session_id })
  expect(after.panel).toBeUndefined()
  // The next node resumes the session by its id, with the message as its first turn.
  const log = events(before.id)
  const from = log.findIndex((e) => e.event === 'message')
  expect(log.slice(from).map((e) => `${e.event} ${e.stage ?? ''} ${e.state ?? ''}`.trim())).toEqual(
    expect.arrayContaining([`session-start ${stage}`, `session-end ${stage} blocked`]),
  )
  expect(log.slice(from).find((e) => e.event === 'session-start')).toMatchObject({ stage, resume: before.session_id })
  expect(read(m.claudeLog)).toContain(`--resume=${before.session_id}`)
})

test('a blocked implement session parks blocked on its node, is announced once, and its answer resumes implement into the gate', async () => {
  play(m, 'blocked Keep the old flag, or drop it?')
  const r = await api(m, 'POST', '/api/processes', { project: dir, issue: 144, env: ['WF_REVIEWERS=code'] })
  const id = (r.body as { record: Record }).record.id
  const blocked = await until(id, (x) => x.state === 'blocked')
  expect(blocked).toMatchObject({ stage: 'implement', node: 'implement', note: 'Keep the old flag, or drop it?' })
  await until(id, () => turned(id).length > 0)
  expect(turned(id)).toEqual(['blocked'])
  playResume('complete Dropped the flag')
  expect((await api(m, 'POST', '/api/processes/message', { id, text: 'Drop it' })).body).toMatchObject({ delivered: 'resumed' })
  const done = await until(id, (x) => x.state === 'ready')
  expect((done.history ?? []).map((h) => `${h.stage} ${h.kind} ${h.result}`)).toEqual([
    'implement session blocked',
    'implement session complete',
    'gate run pass',
    'review round pass',
    'pr open opened',
    'ci wait green',
  ])
})

test('a fix session of the review the resume route goes on with reaches the gate through the engine', async () => {
  const before = await parked({ stage: 'review', state: 'interrupted', fixing: true })
  playResume('complete Fixed the findings')
  const resumed = await api(m, 'POST', '/api/processes/resume', { project: dir, issue: 144 })
  expect(resumed.status, JSON.stringify(resumed.body)).toBe(200)
  expect((resumed.body as { record: Record }).record).toMatchObject({ stage: 'review', node: 'review-fix', state: 'running', note: 'fix session of the review resumed' })
  const done = await until(before.id, (x) => x.state === 'ready')
  expect((done.history ?? []).map((h) => `${h.stage} ${h.kind} ${h.result}`)).toEqual([
    'implement session blocked',
    'review session complete',
    'gate run pass',
    'review round pass',
    'pr open opened',
    'ci wait green',
  ])
  expect(done.history?.[1]?.session_id).toBe(before.session_id)
})
