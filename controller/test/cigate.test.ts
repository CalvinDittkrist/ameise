import { type ChildProcess, execFileSync } from 'node:child_process'
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { api, canApi, canIssue, canPages, canPull, canPulls, checkout, cleanup, cli, gated, type Machine, machine, play, read, reading, start } from './controller.js'

afterEach(cleanup)

const identity = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' }
const branch = 'feat/144-board-lists-every-project'
let m: Machine
let dir: string
let server: ChildProcess
beforeEach(async () => {
  m = await machine()
  // The sessions and the merge of the base commit in a home without a git identity.
  m.env = { ...m.env, ...identity }
  server = await up()
  dir = checkout(m, 'repo', { origin: 'https://github.com/owner/repo.git', originHead: 'main' })
  canPulls(m, 'owner/repo', [])
  canApi(m, 'repos/owner/repo/issues?labels=ready-for-agent&state=open&per_page=100', [])
  canApi(m, 'repos/owner/repo/issues?labels=spec&state=open&per_page=100', [])
  canPages(m, 'repos/owner/repo/branches?per_page=100', [[]])
  expect((await api(m, 'POST', '/api/projects', { path: dir })).status).toBe(201)
  canIssue(m, 'owner/repo', 144, 'Board lists every project', ['ready-for-agent'])
  // The Makefile's gate would fail, so a pass is the checks' and never make check's.
  gated(dir, 'false')
  play(m, 'commit board.txt\ncomplete Implemented the board')
})

async function up(): Promise<ChildProcess> {
  const s = await start(m)
  expect(s.running, s.stderr).toBe(true)
  return s.process
}

async function restart() {
  const exited = new Promise((done) => server.once('exit', done))
  server.kill('SIGTERM')
  await exited
  server = await up()
}

interface Check {
  name: string
  url?: string
  state: string
}

interface Attempt {
  stage: string
  kind: string
  result: string
  commit?: string
  gate?: string
  pr?: number
  checks?: Check[]
  tail?: string
  note?: string
}

interface Record {
  id: string
  state: string
  stage: string
  note: string
  worktree: string
  wait?: string
  pull?: { number: number; url: string }
  draft?: boolean
  readied?: string
  checks?: Check[]
  history?: Attempt[]
}

const playGate = (session: string) => writeFileSync(join(m.claude, 'gate'), session + '\n')
const playReviewer = (session: string) => writeFileSync(join(m.claude, 'reviewer'), session + '\n')

const claim = async (env: string[] = [], issue = 144): Promise<Record> => {
  const r = await api(m, 'POST', '/api/processes', { project: dir, issue, env: [...(env.some((e) => e.startsWith('WF_GATE=')) ? [] : ['WF_GATE=ci']), 'WF_REVIEWERS=code', ...env] })
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
const ended = (id: string) => until(id, (r) => !['running', 'waiting', 'created', 'interrupted'].includes(r.state))
const waiting = (id: string) => until(id, (r) => r.stage === 'gate' && r.state === 'waiting')

const shape = (r: Record) => (r.history ?? []).map((h) => `${h.stage} ${h.kind} ${h.result}`)
const head = (r: Record) => execFileSync('git', ['-C', r.worktree, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
const ghCalls = () => read(m.ghLog).trim().split('\n')
const creates = () => ghCalls().filter((c) => c.startsWith('pr create '))
const gateRun = (r: Record, result = 'pass') => (r.history ?? []).find((h) => h.stage === 'gate' && h.kind === 'run' && h.result === result)

const events = (id: string) =>
  read(join(m.state, 'processes', `${id}.events.jsonl`))
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l) as { event: string; wait?: string })
const ciWaits = (id: string) => events(id).filter((e) => e.event === 'ci-wait').map((e) => e.wait ?? '')

// workflow commits a workflow into the base, so the worktree claimed from it has it.
function workflow(text: string) {
  mkdirSync(join(dir, '.github', 'workflows'), { recursive: true })
  writeFileSync(join(dir, '.github', 'workflows', 'ci.yml'), text)
  const git = (...args: string[]) => execFileSync('git', ['-C', dir, ...args], { stdio: 'pipe', env: { ...process.env, ...identity } })
  git('add', '.github')
  git('commit', '-q', '-m', 'ci: add a workflow')
  git('update-ref', 'refs/remotes/origin/main', 'HEAD')
}

const board = async () =>
  ((await api(m, 'GET', '/api/board?' + new URLSearchParams({ project: dir }).toString())).body as {
    processes: { issue: number; state: string; stage: string; pr: { number: number; draft: boolean } | null }[]
  }).processes

// readings adds readings of a pull request after those it has, so the gate reads them next.
function readings(n: number, more: unknown[]) {
  const d = join(m.github, 'repos', 'owner', 'repo', 'pulls', `${n}.readings`)
  const had = readdirSync(d).filter((f) => f.endsWith('.json')).length
  more.forEach((r, i) => writeFileSync(join(d, `${String(had + i).padStart(3, '0')}.json`), JSON.stringify(r)))
}

test('a gate on CI pushes, opens the draft and passes on two readings a poll apart that show the same checks', async () => {
  // The second reading shows a check the first did not, so the pass waits for the third. The draft is
  // marked ready by hand meanwhile, which changes nothing.
  canPull(m, 'owner/repo', 1, [reading(1), { ...reading(1, { checks: { gate: 'SUCCESS', browser: 'SUCCESS' } }), isDraft: false }])
  const r = await claim()
  const done = await ended(r.id)
  // The record drops its draft flag and notes when the pr stage marked the draft ready.
  expect(done).toMatchObject({ state: 'ready', stage: 'ci', pull: { number: 1, url: 'https://github.com/owner/repo/pull/1' }, draft: false })
  expect(Date.parse(done.readied ?? '')).toBeGreaterThan(0)
  expect(shape(done)).toEqual(['implement session complete', 'gate run pass', 'review round pass', 'pr open finished', 'ci wait green'])
  expect(gateRun(done)).toMatchObject({ gate: 'ci', pr: 1, commit: head(done), checks: [{ name: 'gate', state: 'pass' }, { name: 'browser', state: 'pass' }] })

  expect(creates()).toEqual([expect.stringMatching(new RegExp(`^pr create --repo owner/repo --base main --head ${branch} --title Board lists every project --body-file \\S+ --draft$`))])
  // The pr stage finishes the draft: the author's title, the composed body, out of draft.
  expect(ghCalls()).toContain('pr view 1 --repo owner/repo --json state')
  expect(ghCalls()).toContainEqual(expect.stringMatching(/^pr edit 1 --repo owner\/repo --title Fake pull request --body-file \S+$/))
  expect(ghCalls()).toContain('pr ready 1 --repo owner/repo')
  expect(ghCalls()).toContain('pr edit 1 --repo owner/repo --add-reviewer chatgpt-codex-connector')
  expect(ghCalls().indexOf('pr edit 1 --repo owner/repo --add-reviewer chatgpt-codex-connector')).toBeGreaterThan(ghCalls().indexOf('pr ready 1 --repo owner/repo'))
  const body = read(join(m.github, 'repos', 'owner', 'repo', 'pulls', '1.body'))
  expect(body).toMatch(/^Closes #144\n\n## Summary\n\nThe change\.\n\n## Evidence\n\nThe gate on CI `ci` passed at [0-9a-f]{7}: gate pass, browser pass\.\n[^]*\n\n## Merge Danger\n/)
  expect(body).not.toContain('## Verification')
  // The reviewers get the checks read as the gate result.
  expect(read(m.claudeLog)).toContain('The gate on CI ci passed at')
})

test('a failed check starts a fix session with the end of its failed log, and the gate reads the new head', async () => {
  canPull(m, 'owner/repo', 1, [reading(1, { checks: { gate: 'FAILURE' } }), reading(1)])
  mkdirSync(join(m.github, 'repos', 'owner', 'repo', 'runs'), { recursive: true })
  writeFileSync(join(m.github, 'repos', 'owner', 'repo', 'runs', '7.log'), 'gate\tStep\tBuilding\ngate\tStep\tError: expected 2 lists, got 3\n')
  playGate('commit fixed.txt\ncomplete Fixed the count')
  const r = await claim()
  const done = await ended(r.id)
  expect(done).toMatchObject({ state: 'ready', stage: 'ci' })
  expect(shape(done)).toEqual(['implement session complete', 'gate run fail', 'gate session complete', 'gate run pass', 'review round pass', 'pr open finished', 'ci wait green'])
  const failed = gateRun(done, 'fail')
  expect(failed?.tail).toContain('Error: expected 2 lists, got 3')
  expect(ghCalls()).toContain('run view 7 --repo owner/repo --log-failed')
  expect(read(m.claudeLog)).toContain('Error: expected 2 lists, got 3')
  expect(gateRun(done)?.commit).toBe(head(done))
  expect(gateRun(done)?.commit).not.toBe(failed?.commit)
  expect(creates()).toHaveLength(1)
})

test('a failed check past WF_GATE_ROUNDS ends the process failed naming the check', async () => {
  canPull(m, 'owner/repo', 1, [reading(1, { checks: { gate: 'SUCCESS', browser: 'FAILURE' } })])
  const r = await claim(['WF_GATE_ROUNDS=0'])
  const done = await ended(r.id)
  expect(done).toMatchObject({ state: 'failed', stage: 'gate', note: expect.stringMatching(/^the gate spent its 0 fix session\(s\): ci failed at [0-9a-f]{7} on PR #1: browser; /) })
  expect(shape(done)).toEqual(['implement session complete', 'gate run fail'])
})

test('a named check that never appears ends the process failed naming it once WF_CHECKS_GRACE has passed', async () => {
  canPull(m, 'owner/repo', 1, [reading(1, { checks: { check: 'SUCCESS' } })])
  const r = await claim(['WF_GATE=ci:check,browser', 'WF_CHECKS_GRACE=1'])
  expect(await waiting(r.id)).toMatchObject({ wait: 'the checks browser to appear' })
  const done = await ended(r.id)
  expect(done).toMatchObject({ state: 'failed', stage: 'gate', note: expect.stringMatching(/^the gate ci:check,browser names the check\(s\) browser, which PR #1 did not show on [0-9a-f]{7} within the checks grace of 1 s/) })
  expect(gateRun(done, 'missing')).toMatchObject({ checks: [{ name: 'check', state: 'pass' }] })
})

test('a head with no check ends the process failed once WF_CHECKS_GRACE has passed', async () => {
  canPull(m, 'owner/repo', 1, [reading(1, { checks: {} })])
  const r = await claim(['WF_CHECKS_GRACE=0'])
  const done = await ended(r.id)
  expect(done).toMatchObject({ state: 'failed', stage: 'gate', note: expect.stringMatching(/^the gate on CI read no check on [0-9a-f]{7} of PR #1 within the checks grace of 0 s/) })
})

test('a draft that conflicts with the base gets the base merged in, and the gate reads its new head', async () => {
  play(m, 'wait\ncommit board.txt\ncomplete Implemented the board')
  canPull(m, 'owner/repo', 1, [reading(1, { mergeable: 'CONFLICTING' }), reading(1)])
  const r = await claim()
  await until(r.id, (x) => x.stage === 'implement' && x.state === 'running')
  // The base moves on while the session works.
  writeFileSync(join(dir, 'base.txt'), 'the base\n')
  const git = (...args: string[]) => execFileSync('git', ['-C', dir, ...args], { stdio: 'pipe', env: { ...process.env, ...identity } })
  git('add', 'base.txt')
  git('commit', '-q', '-m', 'base')
  git('update-ref', 'refs/remotes/origin/main', 'HEAD')
  expect((await api(m, 'POST', '/api/processes/message', { id: r.id, text: 'go on' })).status).toBe(200)
  const done = await ended(r.id)
  expect(done).toMatchObject({ state: 'ready', stage: 'ci' })
  expect(shape(done)).toEqual(['implement session complete', 'gate run pass', 'review round pass', 'pr open finished', 'ci wait green'])
  expect(read(join(done.worktree, 'base.txt'))).toBe('the base\n')
  expect(gateRun(done)?.commit).toBe(head(done))
})

test('a merge of the base that conflicts in files starts a fix session, and the gate reads the draft again', async () => {
  play(m, 'wait\ncommit board.txt\ncomplete Implemented the board')
  playGate('run git merge -X ours --no-edit origin/main\ncomplete Merged the base')
  canPull(m, 'owner/repo', 1, [reading(1, { mergeable: 'CONFLICTING' }), reading(1)])
  const r = await claim()
  await until(r.id, (x) => x.stage === 'implement' && x.state === 'running')
  // The base moves on while the session works, with a file of the same name.
  writeFileSync(join(dir, 'board.txt'), 'the base\n')
  const git = (...args: string[]) => execFileSync('git', ['-C', dir, ...args], { stdio: 'pipe', env: { ...process.env, ...identity } })
  git('add', 'board.txt')
  git('commit', '-q', '-m', 'base')
  git('update-ref', 'refs/remotes/origin/main', 'HEAD')
  expect((await api(m, 'POST', '/api/processes/message', { id: r.id, text: 'go on' })).status).toBe(200)
  const done = await ended(r.id)
  expect(done).toMatchObject({ state: 'ready', stage: 'ci' })
  expect(shape(done)).toEqual(['implement session complete', 'gate merge conflict', 'gate session complete', 'gate run pass', 'review round pass', 'pr open finished', 'ci wait green'])
  expect(done.history?.[1]).toMatchObject({ pr: 1, files: ['board.txt'] })
  expect(gateRun(done)?.commit).toBe(head(done))
  expect(creates()).toHaveLength(1)
})

test('a gate on CI past WF_GATE_TIMEOUT ends the process failed naming the wait', async () => {
  canPull(m, 'owner/repo', 1, [reading(1, { checks: { gate: 'PENDING' } })])
  const r = await claim(['WF_GATE_TIMEOUT=1'])
  const done = await ended(r.id)
  expect(done).toMatchObject({ state: 'failed', stage: 'gate', note: expect.stringMatching(/^the gate on CI ran past the gate timeout of 1 s \(WF_GATE_TIMEOUT\) on PR #1 at [0-9a-f]{7}, waiting for the checks: 1 of 1 pending$/) })
  expect(shape(done)).toEqual(['implement session complete'])
})

test('a draft closed while the gate reads it ends the process failed naming it', async () => {
  canPull(m, 'owner/repo', 1, [reading(1, { state: 'CLOSED' })])
  const r = await claim()
  const done = await ended(r.id)
  expect(done).toMatchObject({ state: 'failed', stage: 'gate', note: expect.stringMatching(/^the gate's draft PR #1 is closed, so its checks cannot gate the branch/) })
})

test('the pr stage opens a pull request when the gate\'s draft was closed after the gate passed', async () => {
  // The gate reads the draft open twice; the pr stage reads it closed, so it opens another.
  canPull(m, 'owner/repo', 1, [reading(1), reading(1), reading(1, { state: 'CLOSED' })])
  // Without an end the reviewer runs until it is stopped, and the draft is closed meanwhile.
  playReviewer('say Reading the diff')
  const r = await claim()
  await until(r.id, (x) => x.stage === 'review' && x.state === 'running')
  await restart()
  rmSync(join(m.github, 'repos', 'owner', 'repo', 'draft-1.json'))
  canPull(m, 'owner/repo', 2, [reading(2)])
  playReviewer('verdict pass')
  expect(cli(m, ['resume', '144', '--project', dir]).stderr).toBe('')
  const done = await ended(r.id)
  expect(done).toMatchObject({ state: 'ready', stage: 'ci', pull: { number: 2 } })
  expect(shape(done)).toEqual(['implement session complete', 'gate run pass', 'review round pass', 'pr open opened', 'ci wait green'])
  expect(creates()).toHaveLength(2)
  expect(ghCalls()).not.toContain('pr ready 1 --repo owner/repo')
})

test('a pull request of somebody else on the branch ends the process failed naming it, with no draft and no comment', async () => {
  canPulls(m, 'owner/repo', [{ number: 9, headRefName: branch, baseRefName: 'main', isCrossRepository: false, isDraft: false, url: 'https://github.com/owner/repo/pull/9', author: { login: 'someone' } }])
  canPull(m, 'owner/repo', 1, [reading(1)])
  const r = await claim()
  const done = await ended(r.id)
  expect(done).toMatchObject({ state: 'failed', stage: 'gate', note: expect.stringMatching(/^the branch feat\/144-board-lists-every-project has a pull request open that is not this process's: #9 of someone/) })
  expect(creates()).toEqual([])
  expect(ghCalls().some((c) => c.startsWith('issue comment') || c.includes('/comments'))).toBe(false)
})

test('a stop while the gate waits interrupts it, and a resume takes the draft over and reads the head again', async () => {
  canPull(m, 'owner/repo', 1, [reading(1, { checks: { gate: 'PENDING' } })])
  const r = await claim()
  expect(await waiting(r.id)).toMatchObject({ pull: { number: 1 }, draft: true, wait: 'the checks: 1 of 1 pending', checks: [{ name: 'gate', state: 'pending' }] })
  // The board reads the gate while its draft exists.
  expect(await board()).toMatchObject([{ issue: 144, stage: 'gate', state: 'waiting', pr: { number: 1, draft: true } }])

  await restart()
  expect(recordOf(r.id)).toMatchObject({ state: 'interrupted', stage: 'gate', pull: { number: 1 } })
  expect(cli(m, ['resume', '144', '--project', dir]).stderr).toBe('')
  await until(r.id, (x) => x.state === 'waiting')
  readings(1, [reading(1), reading(1)])
  const done = await ended(r.id)
  expect(done).toMatchObject({ state: 'ready', stage: 'ci', pull: { number: 1 } })
  expect(shape(done)).toEqual(['implement session complete', 'gate run pass', 'review round pass', 'pr open finished', 'ci wait green'])
  expect(creates()).toHaveLength(1)
})

test('a resume after the gate on CI passed goes on with the review and opens no second pull request', async () => {
  canPull(m, 'owner/repo', 1, [reading(1)])
  // Without an end the reviewer runs until it is stopped.
  playReviewer('say Reading the diff')
  const r = await claim()
  await until(r.id, (x) => x.stage === 'review' && x.state === 'running')
  await restart()
  expect(recordOf(r.id)).toMatchObject({ state: 'interrupted', stage: 'review' })
  playReviewer('verdict pass')
  expect(cli(m, ['resume', '144', '--project', dir]).stderr).toBe('')
  const done = await ended(r.id)
  expect(done).toMatchObject({ state: 'ready', stage: 'ci', pull: { number: 1 } })
  expect(shape(done)).toEqual(['implement session complete', 'gate run pass', 'review round pass', 'pr open finished', 'ci wait green'])
  expect(creates()).toHaveLength(1)
})

interface DraftCase {
  case: string
  number: number
  title: string
  draft_title: string
  body: string
}
interface TakeoverCase {
  case: string
  recorded: number
  open: { number: number; author: string }[]
  outcome: 'take over' | 'open' | 'end'
}
const fixture = (JSON.parse(read(fileURLToPath(new URL('../../contract/fixture.json', import.meta.url)))) as {
  draft: { cases: DraftCase[]; takeover: { login: string; cases: TakeoverCase[] } }
}).draft

test('the gate\'s draft agrees with the contract fixture for its title and body', async () => {
  for (const c of fixture.cases) {
    canIssue(m, 'owner/repo', c.number, c.title, ['ready-for-agent'])
    canPull(m, 'owner/repo', c.number, [reading(c.number, { checks: {} })])
    const r = await claim(['WF_CHECKS_GRACE=0'], c.number)
    await ended(r.id)
    const create = creates().at(-1) ?? ''
    expect(/ --title (.*) --body-file /.exec(create)?.[1], c.case).toBe(c.draft_title)
    expect(read(join(m.github, 'repos', 'owner', 'repo', 'pulls', `${c.number}.body`)), c.case).toBe(c.body)
  }
})

test.each(fixture.takeover.cases)('the gate on CI follows the contract fixture\'s takeover: $case', async (c) => {
  writeFileSync(join(m.github, 'login'), fixture.takeover.login + '\n')
  const pulls = c.open.map((p) => ({ number: p.number, headRefName: branch, baseRefName: 'main', isCrossRepository: false, isDraft: true, url: `https://github.com/owner/repo/pull/${p.number}`, author: { login: p.author } }))
  canPull(m, 'owner/repo', 104, [reading(104, { checks: { gate: 'PENDING' } })])
  let id: string
  let before = 0
  if (c.recorded > 0) {
    // A gate on CI opens the recorded draft, and the controller stops while it waits.
    id = (await claim()).id
    await waiting(id)
    expect(recordOf(id).pull?.number).toBe(c.recorded)
    await restart()
    rmSync(join(m.github, 'repos', 'owner', 'repo', `draft-${c.recorded}.json`), { force: true })
    canPulls(m, 'owner/repo', pulls)
    before = creates().length
    expect(cli(m, ['resume', '144', '--project', dir]).stderr).toBe('')
  } else {
    canPulls(m, 'owner/repo', pulls)
    id = (await claim()).id
  }
  const done = await until(id, (x) => x.stage === 'gate' && ['waiting', 'failed'].includes(x.state))
  const opened = creates().length - before
  if (c.outcome === 'end') {
    expect(done).toMatchObject({ state: 'failed', note: expect.stringMatching(/has a pull request open that is not this process's/) })
    expect(opened).toBe(0)
  } else {
    expect(done).toMatchObject({ state: 'waiting', pull: { number: 104 } })
    expect(opened).toBe(c.outcome === 'open' ? 1 : 0)
  }
})

test('a readied draft whose workflows run on ready_for_review is not green until a check has finished since the ready', async () => {
  workflow('on:\n  pull_request:\n    types: [opened, synchronize, ready_for_review]\n')
  canPull(m, 'owner/repo', 1, [reading(1)])
  const r = await claim()
  // The draft's checks finished before the ready, so they are not the pull request's.
  const waited = await until(r.id, (x) => x.stage === 'ci' && /^the checks of marking the draft ready for review, until /.test(x.wait ?? ''))
  expect(waited.state).toBe('waiting')
  const finished = reading(1)
  finished.statusCheckRollup = finished.statusCheckRollup.map((c) => ({ ...c, completedAt: new Date(Date.now() + 60_000).toISOString() }))
  readings(1, [finished])
  const done = await ended(r.id)
  expect(done).toMatchObject({ state: 'ready', stage: 'ci', draft: false })
  expect(shape(done)).toEqual(['implement session complete', 'gate run pass', 'review round pass', 'pr open finished', 'ci wait green'])
})

test('a readied draft whose workflows run on ready_for_review goes green once WF_CHECKS_GRACE has passed with no new check', async () => {
  workflow('on: [pull_request_target, ready_for_review]\n')
  canPull(m, 'owner/repo', 1, [reading(1)])
  const r = await claim(['WF_CHECKS_GRACE=1'])
  const done = await ended(r.id)
  expect(done).toMatchObject({ state: 'ready', stage: 'ci', draft: false })
  expect(ciWaits(r.id)).toContainEqual(expect.stringMatching(/^the checks of marking the draft ready for review, until /))
})

test('a readied draft without a workflow on ready_for_review goes on with its green checks and waits for the bot review after the ready', async () => {
  workflow('on: pull_request\n')
  canPull(m, 'owner/repo', 1, [reading(1, { reviews: [] })])
  const r = await claim(['WF_PR_REVIEW_WAIT=600'])
  const waited = await until(r.id, (x) => x.stage === 'ci' && /^a review of chatgpt-codex-connector, until /.test(x.wait ?? ''))
  // The draft's checks finished before the ready, and the bot reviews no draft: its wait counts from the ready.
  const until_ = Date.parse((waited.wait ?? '').replace(/^a review of chatgpt-codex-connector, until /, ''))
  expect(until_).toBeGreaterThanOrEqual(Date.parse(waited.readied ?? '') + 600_000)
  readings(1, [reading(1)])
  const done = await ended(r.id)
  expect(done).toMatchObject({ state: 'ready', stage: 'ci', draft: false })
  expect(ciWaits(r.id).filter((w) => w.startsWith('the checks of marking'))).toEqual([])
})
