import { type ChildProcess, execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { api, canApi, canGreen, canIssue, canPages, canPulls, checkout, cleanup, cli, gated, type Machine, machine, play, read, start } from './controller.js'

afterEach(cleanup)

const identity = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' }
let m: Machine
let dir: string
let server: ChildProcess
beforeEach(async () => {
  m = await machine()
  // The sessions commit in a home without a git identity.
  m.env = { ...m.env, ...identity }
  server = await up()
  dir = checkout(m, 'repo', { origin: 'https://github.com/owner/repo.git', originHead: 'main' })
  canPulls(m, 'owner/repo', [])
  canGreen(m, 'owner/repo')
  canApi(m, 'repos/owner/repo/issues?labels=ready-for-agent&state=open&per_page=100', [])
  canApi(m, 'repos/owner/repo/issues?labels=spec&state=open&per_page=100', [])
  canPages(m, 'repos/owner/repo/branches?per_page=100', [[]])
  expect((await api(m, 'POST', '/api/projects', { path: dir })).status).toBe(201)
  canIssue(m, 'owner/repo', 144, 'Board lists every project', ['ready-for-agent'])
  gated(dir)
  play(m, 'commit board.txt\ncomplete Implemented the board')
})

async function up(): Promise<ChildProcess> {
  const s = await start(m)
  expect(s.running, s.stderr).toBe(true)
  return s.process
}

interface Finding {
  id: string
  severity: string
  where: string
  claim: string
}

interface Attempt {
  stage: string
  kind: string
  result: string
  commit?: string
  session_id?: string
  round?: number
  verdicts?: { reviewer: string; verdict: string; session_id?: string; findings: Finding[]; note?: string }[]
  fixes?: { finding: string; outcome: string; note: string }[]
}

interface Record {
  id: string
  state: string
  stage: string
  note: string
  worktree: string
  session_id?: string
  panel?: string
  history?: Attempt[]
}

// playReviewer cans what the named reviewer plays, or every reviewer without a file of its own; playFix
// cans the fix session of the review. node stands in for the tools the machine's PATH does not have.
const playReviewer = (name: string, session: string) => writeFileSync(join(m.claude, name === '' ? 'reviewer' : `reviewer-${name}`), session + '\n')
const playFix = (session: string) => writeFileSync(join(m.claude, 'review'), session + '\n')
const node = (js: string) => `${process.execPath} -e '${js}'`

const claim = async (env: string[] = []): Promise<Record> => {
  const r = await api(m, 'POST', '/api/processes', { project: dir, issue: 144, env })
  expect(r.status, JSON.stringify(r.body)).toBe(201)
  return (r.body as { record: Record }).record
}

const recordOf = (id: string) => JSON.parse(read(join(m.state, 'processes', `${id}.json`))) as Record

async function until(id: string, done: (r: Record) => boolean): Promise<Record> {
  for (let i = 0; i < 400; i++) {
    const r = recordOf(id)
    if (done(r)) return r
    await new Promise((d) => setTimeout(d, 50))
  }
  throw new Error(`the process ${id} did not get there: ${JSON.stringify(recordOf(id))}`)
}
const ended = (id: string) => until(id, (r) => !['running', 'waiting'].includes(r.state))

const shape = (r: Record) => (r.history ?? []).map((h) => `${h.stage} ${h.kind} ${h.result}`)
const rounds = (r: Record) => (r.history ?? []).filter((h) => h.kind === 'round')
const verdicts = (a: Attempt | undefined) => Object.fromEntries((a?.verdicts ?? []).map((v) => [v.reviewer, v.verdict]))
const head = (r: Record) => execFileSync('git', ['-C', r.worktree, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()

const board = async () =>
  ((await api(m, 'GET', '/api/board?' + new URLSearchParams({ project: dir }).toString())).body as { processes: { issue: number; state: string; stage: string; note: string }[] }).processes

test('after the gate passes every reviewer runs in parallel, and a panel that passes ends the process ready', async () => {
  // Each reviewer marks that it runs, then waits up to 10 s for the other to run too.
  const marks = join(m.root, 'marks')
  mkdirSync(marks)
  playReviewer(
    '',
    `run ${node(`const fs = require("fs"), p = require("path"); const d = ${JSON.stringify(marks)}; fs.writeFileSync(p.join(d, process.env.AMEISE_STAGE), ""); const end = Date.now() + 10000; while (fs.readdirSync(d).length < 2 && Date.now() < end) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50); if (fs.readdirSync(d).length < 2) fs.writeFileSync(p.join(d, "alone"), "")`)}\nverdict pass`,
  )
  const r = await claim(['WF_REVIEWERS=code,docs'])
  const done = await ended(r.id)
  expect(done).toMatchObject({ state: 'ready', stage: 'ci', note: 'PR #1 is green: it merges, its checks pass and no review asks for changes', panel: 'pass' })
  expect(shape(done)).toEqual(['implement session complete', 'gate run pass', 'review round pass', 'pr open opened', 'ci wait green'])
  const [round] = rounds(done)
  expect(round).toMatchObject({ round: 1, commit: head(done) })
  expect(round?.verdicts).toEqual([
    { reviewer: 'code', verdict: 'pass', session_id: expect.stringMatching(/^fake-session-/), findings: [] },
    { reviewer: 'docs', verdict: 'pass', session_id: expect.stringMatching(/^fake-session-/), findings: [] },
  ])
  expect(readdirSync(marks).sort()).toEqual(['reviewer-code', 'reviewer-docs'])
  // The reviewers are no session of the process: the record keeps the implement session's id.
  expect(done.session_id).toBe(done.history?.[0]?.session_id)
})

// decided are the decisions of the PreToolUse hook of Bash the scripted claude logged, in log order.
const decided = () =>
  read(m.claudeLog)
    .split('\n')
    .filter((l) => l.startsWith('! The hook '))
    .map((l) => l.slice(2))

// The read commands the briefs name, in the forms the briefs and the reviewers use them.
const reads = ['gh issue view 144 --repo owner/repo', 'gh issue view 144 --repo owner/repo --comments', 'git diff origin/main...HEAD', 'git diff origin/main...HEAD --stat', 'git log --oneline origin/main..HEAD', 'git status --short', 'git show HEAD~1:board.txt']
// Calls that share a prefix with them but read a file of the host, write one, open a browser or run more
// than one command.
const others = [
  'git diff --no-index /dev/null /etc/passwd',
  'git diff --output=/tmp/out origin/main...HEAD',
  'git log --output=/tmp/out',
  'git show --ext-diff HEAD',
  'git -C /etc diff',
  'gh issue view 144 --web',
  'git diff origin/main...HEAD; rm -rf .',
  'git diff $(cat /etc/passwd)',
  'git diff ~/.ssh/id_ed25519',
]

test('every session allows the read commands its brief names without a card, and no other form of them', async () => {
  play(m, [...reads, ...others].map((c) => `bash ${c}`).join('\n') + '\ncommit board.txt\ncomplete Implemented the board')
  playReviewer('', [...reads, ...others].map((c) => `bash ${c}`).join('\n') + '\nverdict pass')
  const r = await claim(['WF_REVIEWERS=code,docs'])
  expect(await ended(r.id)).toMatchObject({ state: 'ready', panel: 'pass' })
  const allowed = (c: string) => `The hook allowed ${c}.`
  const through = (c: string) => `The hook let ${c} through.`
  // The implement session in the auto mode and both reviewers in the default mode.
  for (const c of reads) expect(decided().filter((d) => d === allowed(c)), c).toHaveLength(3)
  for (const c of others) expect(decided().filter((d) => d === through(c)), c).toHaveLength(3)
  // The reads are allowed by the hook, not by a prefix rule that would allow every argument.
  expect(read(m.claudeLog).split('\n')).not.toContain('--allowedTools')
})

test('with the gate form none a fix session of the review goes straight to the next round', async () => {
  // make check would fail, so no round would follow if it ran.
  gated(dir, 'false')
  playReviewer('code', 'finding S2 src/board.ts:3 The limit is off by one\nverdict fix')
  playFix(`run ${node(`require("fs").rmSync(${JSON.stringify(join(m.claude, 'reviewer-code'))})`)}\nfixed code-1-1 Took the limit down by one\ncomplete Fixed the findings`)
  const r = await claim(['WF_REVIEWERS=code', 'WF_GATE=none'])
  const done = await ended(r.id)
  expect(done).toMatchObject({ state: 'ready', stage: 'ci', note: 'PR #1 is green: it merges, its checks pass and no review asks for changes', panel: 'pass' })
  expect(shape(done)).toEqual(['implement session complete', 'gate run skipped', 'review round fix', 'review session complete', 'gate run skipped', 'review round pass', 'pr open opened', 'ci wait green'])
})

test('a fix verdict starts one fix session with every finding, the gate runs again, and the next round runs the reviewers that said fix', async () => {
  playReviewer('code', 'finding S2 src/board.ts:3 The limit is off by one\nfinding S3 src/board.ts:9 The name reads oddly\nverdict fix')
  // The fix session commits, and takes the code reviewer's play away, so its next round passes.
  playFix(`commit fixed.txt\nrun ${node(`require("fs").rmSync(${JSON.stringify(join(m.claude, 'reviewer-code'))})`)}\nfixed code-1-1 Took the limit down by one\ndeclined code-1-2 The name is the issue's own\ncomplete Fixed the findings`)
  const r = await claim(['WF_REVIEWERS=code,security'])
  const done = await ended(r.id)
  expect(done).toMatchObject({ state: 'ready', stage: 'ci', note: 'PR #1 is green: it merges, its checks pass and no review asks for changes', panel: 'pass' })
  expect(shape(done)).toEqual(['implement session complete', 'gate run pass', 'review round fix', 'review session complete', 'gate run pass', 'review round pass', 'pr open opened', 'ci wait green'])
  const [first, second] = rounds(done)
  expect(verdicts(first)).toEqual({ code: 'fix', security: 'pass' })
  expect(first?.verdicts?.[0]?.findings).toEqual([
    { id: 'code-1-1', severity: 'S2', where: 'src/board.ts:3', claim: 'The limit is off by one', fix: 'Fix it.' },
    { id: 'code-1-2', severity: 'S3', where: 'src/board.ts:9', claim: 'The name reads oddly', fix: 'Fix it.' },
  ])
  // Only the reviewer that said fix runs again.
  expect(second).toMatchObject({ round: 2, commit: head(done) })
  expect(verdicts(second)).toEqual({ code: 'pass' })
  const fix = done.history?.[3]
  expect(fix).toMatchObject({
    commits: [expect.stringMatching(/ fix: write fixed\.txt$/)],
    fixes: [
      { finding: 'code-1-1', outcome: 'fixed', note: 'Took the limit down by one' },
      { finding: 'code-1-2', outcome: 'declined', note: "The name is the issue's own" },
    ],
  })
  // The fix session is a fresh session of its own stage, and the gate ran again on its commit.
  expect(fix?.session_id).not.toBe(done.history?.[0]?.session_id)
  expect(read(m.claudeLog + '.env')).toMatch(/AMEISE_STAGE="review"/)
  expect(done.history?.[4]).toMatchObject({ kind: 'run', result: 'pass', commit: head(done) })
})

test('a review that spends its rounds ends with a failed panel, and the process goes on ready', async () => {
  playReviewer('tests', 'finding S1 test/board.test.ts:1 Nothing tests the limit\nverdict fix')
  playFix('complete Nothing to change')
  const r = await claim(['WF_REVIEWERS=code,tests', 'WF_REVIEW_ROUNDS=2'])
  const done = await ended(r.id)
  expect(done).toMatchObject({ state: 'ready', stage: 'ci', panel: 'failed', note: 'PR #1 is green: it merges, its checks pass and no review asks for changes' })
  expect(shape(done)).toEqual(['implement session complete', 'gate run pass', 'review round fix', 'review session complete', 'gate run pass', 'review round fix', 'pr open opened', 'ci wait green'])
  expect(rounds(done).map(verdicts)).toEqual([{ code: 'pass', tests: 'fix' }, { tests: 'fix' }])
  expect(rounds(done)[1]?.verdicts?.[0]?.findings.map((f) => f.id)).toEqual(['tests-2-1'])
  expect(await board()).toMatchObject([{ issue: 144, state: 'ready', stage: 'ci' }])
})

test('a reviewer that reports no verdict ends the process failed with the reason', async () => {
  playReviewer('docs', 'silent')
  const r = await claim(['WF_REVIEWERS=code,docs'])
  const done = await ended(r.id)
  expect(done).toMatchObject({ state: 'failed', stage: 'review', note: 'review round 1: the reviewer docs exited without a result' })
  expect(verdicts(rounds(done)[0])).toEqual({ code: 'pass', docs: 'failed' })
})

test('a pass verdict with a finding of S2 is a fix verdict', async () => {
  playReviewer('code', 'finding S2 src/board.ts:3 The limit is off by one\nverdict pass')
  playFix(`run ${node(`require("fs").rmSync(${JSON.stringify(join(m.claude, 'reviewer-code'))})`)}\nfixed code-1-1 Took the limit down by one\ncomplete Fixed the finding`)
  const r = await claim(['WF_REVIEWERS=code'])
  const done = await ended(r.id)
  expect(done).toMatchObject({ state: 'ready', stage: 'ci', note: 'PR #1 is green: it merges, its checks pass and no review asks for changes', panel: 'pass' })
  expect(rounds(done).map(verdicts)).toEqual([{ code: 'fix' }, { code: 'pass' }])
})

test('a fix verdict without a finding ends the process failed with the reason', async () => {
  playReviewer('code', 'verdict fix')
  const r = await claim(['WF_REVIEWERS=code'])
  const done = await ended(r.id)
  expect(done).toMatchObject({ state: 'failed', stage: 'review', note: 'review round 1: the reviewer code said fix without a finding' })
  expect(shape(done)).toEqual(['implement session complete', 'gate run pass', 'review round failed'])
})

test("a reviewer's permission allows that one call, and the process keeps no allowance of it", async () => {
  playReviewer('code', 'permit npm test\npermit npm test\nverdict pass')
  const r = await claim(['WF_REVIEWERS=code'])
  const log = join(m.state, 'processes', `${r.id}.events.jsonl`)
  const cards = () =>
    read(log)
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as { event: string; request?: string })
      .filter((e) => e.event === 'permission')
  const card = async (n: number): Promise<string> => {
    for (let i = 0; i < 400; i++) {
      const c = existsSync(log) ? cards() : []
      if (c.length >= n) return c[n - 1]?.request ?? ''
      await new Promise((done) => setTimeout(done, 50))
    }
    throw new Error(`no permission card ${n}`)
  }
  // Allow for this process on a reviewer's card allows that call, and the same call asks again.
  expect((await api(m, 'POST', '/api/processes/answer', { id: r.id, request: await card(1), answer: 'process' })).status).toBe(200)
  expect((await api(m, 'POST', '/api/processes/answer', { id: r.id, request: await card(2), answer: 'once' })).status).toBe(200)
  const done = await ended(r.id)
  expect(done).toMatchObject({ state: 'ready', stage: 'ci', panel: 'pass' })
  expect((recordOf(r.id) as { allowed?: string[] }).allowed ?? []).toEqual([])
})

test('a review knob that is wrong ends the process failed with the reason', async () => {
  const r = await claim(['WF_REVIEWERS=code,style'])
  const done = await ended(r.id)
  expect(done).toMatchObject({ state: 'failed', stage: 'review', note: 'WF_REVIEWERS names style, which is no reviewer; the reviewers are code, security, docs, tests, senior' })
  expect(shape(done)).toEqual(['implement session complete', 'gate run pass'])
})

test('a stop while the reviewers run marks the process interrupted, and a resume runs the round again', async () => {
  // Without an end a reviewer runs until it is stopped; a message meanwhile is refused.
  playReviewer('code', 'say Reading the diff')
  const r = await claim(['WF_REVIEWERS=code'])
  await until(r.id, (x) => x.stage === 'review')
  expect((await api(m, 'POST', '/api/processes/message', { id: r.id, text: 'go on' })).status).toBe(409)
  const exited = new Promise((done) => server.once('exit', done))
  server.kill('SIGTERM')
  await exited
  expect(recordOf(r.id)).toMatchObject({ state: 'interrupted', stage: 'review', note: 'the controller stopped while its reviewers ran; resume it to run the round again' })

  server = await up()
  playReviewer('code', 'verdict pass')
  expect(cli(m, ['resume', '144', '--project', dir]).stderr).toBe('')
  const done = await until(r.id, (x) => !['running', 'waiting'].includes(x.state) && x.state !== 'interrupted')
  expect(done).toMatchObject({ state: 'ready', stage: 'ci', panel: 'pass' })
  expect(shape(done)).toEqual(['implement session complete', 'gate run pass', 'review round pass', 'pr open opened', 'ci wait green'])
})

test('a stop while the fix session of the review runs marks it interrupted, and a resume goes on with that session', async () => {
  playReviewer('code', 'finding S2 src/a.ts:1 Off by one\nverdict fix')
  // Without an end the fix session runs until it is stopped.
  playFix('say Looking into it')
  const r = await claim(['WF_REVIEWERS=code'])
  const fixing = await until(r.id, (x) => x.stage === 'review' && x.state === 'running' && (x.history ?? []).length === 3 && !!x.session_id)
  const exited = new Promise((done) => server.once('exit', done))
  server.kill('SIGTERM')
  await exited
  expect(recordOf(r.id)).toMatchObject({ state: 'interrupted', stage: 'review', session_id: fixing.session_id, note: 'the controller stopped while the fix session of its review ran; resume it to go on' })

  server = await up()
  writeFileSync(join(m.claude, 'resume'), 'fixed code-1-1 Done\ncomplete Fixed it\n')
  playReviewer('code', 'verdict pass')
  expect(cli(m, ['resume', '144', '--project', dir]).stderr).toBe('')
  const done = await until(r.id, (x) => !['running', 'waiting'].includes(x.state) && x.state !== 'interrupted')
  expect(done).toMatchObject({ state: 'ready', stage: 'ci', note: 'PR #1 is green: it merges, its checks pass and no review asks for changes' })
  expect(shape(done)).toEqual(['implement session complete', 'gate run pass', 'review round fix', 'review session complete', 'gate run pass', 'review round pass', 'pr open opened', 'ci wait green'])
  expect(done.history?.[3]).toMatchObject({ session_id: fixing.session_id, fixes: [{ finding: 'code-1-1', outcome: 'fixed' }] })
  expect(existsSync(join(done.worktree, 'board.txt'))).toBe(true)
})

test('a stop before the fix session of the review reports its id resumes a fresh fix session with the findings of its round', async () => {
  playReviewer('code', 'finding S2 src/a.ts:1 Off by one\nverdict fix')
  playFix('say Looking into it')
  const r = await claim(['WF_REVIEWERS=code'])
  await until(r.id, (x) => x.stage === 'review' && x.state === 'running' && (x.history ?? []).length === 3 && !!x.session_id)
  const exited = new Promise((done) => server.once('exit', done))
  server.kill('SIGTERM')
  await exited
  // The stop came before the fix session reported its id, as the record then holds none.
  const file = join(m.state, 'processes', `${r.id}.json`)
  const stopped = recordOf(r.id) as Record & { fixing?: boolean }
  delete stopped.session_id
  expect(stopped.fixing).toBe(true)
  writeFileSync(file, JSON.stringify(stopped))

  server = await up()
  expect(recordOf(r.id)).toMatchObject({ state: 'interrupted', stage: 'review' })
  playFix('fixed code-1-1 Done\ncomplete Fixed it')
  playReviewer('code', 'verdict pass')
  expect(cli(m, ['resume', '144', '--project', dir]).stderr).toBe('')
  const done = await until(r.id, (x) => !['running', 'waiting'].includes(x.state) && x.state !== 'interrupted')
  expect(done).toMatchObject({ state: 'ready', stage: 'ci', panel: 'pass', note: 'PR #1 is green: it merges, its checks pass and no review asks for changes' })
  expect(shape(done)).toEqual(['implement session complete', 'gate run pass', 'review round fix', 'review session complete', 'gate run pass', 'review round pass', 'pr open opened', 'ci wait green'])
  expect(done.history?.[3]).toMatchObject({ fixes: [{ finding: 'code-1-1', outcome: 'fixed' }] })
})

test('a message to a ready process goes on as the implement session, and every reviewer reviews its work again', async () => {
  const r = await claim(['WF_REVIEWERS=code,docs'])
  expect(await ended(r.id)).toMatchObject({ state: 'ready', stage: 'ci', panel: 'pass' })
  writeFileSync(join(m.claude, 'resume'), 'commit more.txt\ncomplete Added more\n')
  playReviewer('code', 'verdict pass')
  expect((await api(m, 'POST', '/api/processes/message', { id: r.id, text: 'add more' })).status).toBe(200)
  const done = await until(r.id, (x) => x.state === 'ready' && rounds(x).length === 2)
  expect(done).toMatchObject({ stage: 'ci', panel: 'pass', note: 'PR #1 is green: it merges, its checks pass and no review asks for changes' })
  expect(shape(done)).toEqual(['implement session complete', 'gate run pass', 'review round pass', 'pr open opened', 'ci wait green', 'implement session complete', 'gate run pass', 'review round pass', 'pr open opened', 'ci wait green'])
  expect(rounds(done)[1]).toMatchObject({ round: 1, commit: head(done) })
  expect(verdicts(rounds(done)[1])).toEqual({ code: 'pass', docs: 'pass' })
})
