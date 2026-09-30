import { type ChildProcess, execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { api, canApi, canIssue, canPages, canPull, canPulls, checkout, cleanup, cli, gated, type Machine, machine, play, read, reading, start } from './controller.js'

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

interface Attempt {
  stage: string
  kind: string
  result: string
  commit?: string
  pr?: number
  url?: string
  checks?: { name: string; url?: string; state: string }[]
  reviews?: string[]
  commits?: string[]
}

interface Record {
  id: string
  state: string
  stage: string
  note: string
  worktree: string
  wait?: string
  pull?: { number: number; url: string }
  checks?: { name: string; state: string }[]
  history?: Attempt[]
}

const green = 'PR #7 is green: it merges, its checks pass and no review asks for changes'

// playAuthor cans the author session of the pull request, playFix the fix session of the ci stage and
// playReviewer every reviewer.
const playAuthor = (session: string) => writeFileSync(join(m.claude, 'author'), session + '\n')
const playFix = (session: string) => writeFileSync(join(m.claude, 'ci'), session + '\n')
const playReviewer = (session: string) => writeFileSync(join(m.claude, 'reviewer'), session + '\n')

const claim = async (env: string[] = []): Promise<Record> => {
  const r = await api(m, 'POST', '/api/processes', { project: dir, issue: 144, env: ['WF_REVIEWERS=code', ...env] })
  expect(r.status, JSON.stringify(r.body)).toBe(201)
  return (r.body as { record: Record }).record
}

const recordOf = (id: string) => JSON.parse(read(join(m.state, 'processes', `${id}.json`))) as Record
const events = (id: string) =>
  read(join(m.state, 'processes', `${id}.events.jsonl`))
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l) as { event: string; wait?: string; state?: string })

async function until(id: string, done: (r: Record) => boolean): Promise<Record> {
  for (let i = 0; i < 400; i++) {
    const r = recordOf(id)
    if (done(r)) return r
    await new Promise((d) => setTimeout(d, 50))
  }
  throw new Error(`the process ${id} did not get there: ${JSON.stringify(recordOf(id))}`)
}
const ended = (id: string) => until(id, (r) => !['running', 'waiting', 'created'].includes(r.state))

const shape = (r: Record) => (r.history ?? []).map((h) => `${h.stage} ${h.kind} ${h.result}`)
const head = (r: Record) => execFileSync('git', ['-C', r.worktree, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
const ghCalls = () => read(m.ghLog).trim().split('\n')
const body = () => read(join(m.github, 'repos', 'owner', 'repo', 'pulls', '7.body'))

const board = async () =>
  ((await api(m, 'GET', '/api/board?' + new URLSearchParams({ project: dir }).toString())).body as { processes: { issue: number; state: string; stage: string; action: string }[] }).processes

test('the pr stage opens the pull request with the author title and body, the gate result and the panel, never as a draft, and asks the bot reviewers', async () => {
  playAuthor('body Lists every project on the board.\npull feat: list every project on the board')
  canPull(m, 'owner/repo', 7, [reading(7)])
  const r = await claim()
  const done = await ended(r.id)
  expect(done).toMatchObject({ state: 'ready', stage: 'ci', note: green, pull: { number: 7, url: 'https://github.com/owner/repo/pull/7' } })
  expect(shape(done)).toEqual(['implement session complete', 'gate run pass', 'review round pass', 'pr open opened', 'ci wait green'])
  expect(done.history?.[3]).toMatchObject({ pr: 7, commit: head(done) })

  const create = ghCalls().find((c) => c.startsWith('pr create '))
  expect(create).toMatch(/^pr create --repo owner\/repo --base main --head feat\/144-board-lists-every-project --title feat: list every project on the board --body-file /)
  expect(create).not.toContain('--draft')
  expect(ghCalls()).toContain('pr edit 7 --repo owner/repo --add-reviewer chatgpt-codex-connector')
  const text = body()
  expect(text).toContain('Closes #144')
  expect(text).toContain('Lists every project on the board.')
  expect(text).toContain(`## Verification\n\nThe gate \`make check\` passed at ${head(done).slice(0, 7)}.\nThe review panel passed in round 1: code pass.`)

  // Ready shows the merge as the process's action.
  expect(await board()).toMatchObject([{ issue: 144, state: 'ready', stage: 'ci', action: 'Merge' }])
})

test('a failed panel is named in the pull request, which is opened all the same', async () => {
  playReviewer('finding S1 test/board.test.ts:1 Nothing tests the limit\nverdict fix')
  canPull(m, 'owner/repo', 7, [reading(7)])
  const r = await claim(['WF_REVIEW_ROUNDS=1', 'WF_PR_BOT_REVIEWERS='])
  const done = await ended(r.id)
  expect(done).toMatchObject({ state: 'ready', stage: 'ci', note: green })
  expect(body()).toContain('The review panel failed: it spent its 1 round(s) with code not passing (code fix).')
  expect(body()).toContain('- code-1-1 S1 `test/board.test.ts:1`: Nothing tests the limit')
  // With no bot reviewer, none is asked.
  expect(ghCalls().some((c) => c.startsWith('pr edit '))).toBe(false)
})

test('an open pull request of the branch takes the push, and no other is opened', async () => {
  canPulls(m, 'owner/repo', [{ number: 7, headRefName: 'feat/144-board-lists-every-project', isCrossRepository: false, url: 'https://github.com/owner/repo/pull/7', isDraft: false }])
  canPull(m, 'owner/repo', 7, [reading(7)])
  const r = await claim()
  const done = await ended(r.id)
  expect(done).toMatchObject({ state: 'ready', stage: 'ci', note: green, pull: { number: 7 } })
  expect(shape(done)).toEqual(['implement session complete', 'gate run pass', 'review round pass', 'pr open found', 'ci wait green'])
  expect(ghCalls().some((c) => c.startsWith('pr create '))).toBe(false)
})

test('the ci stage waits for the checks, then for the bot review within the review wait, and shows what it waits for', async () => {
  canPull(m, 'owner/repo', 7, [reading(7, { checks: { gate: 'PENDING' } }), reading(7, { checks: { gate: 'PENDING' } }), reading(7, { reviews: [] })])
  const r = await claim(['WF_PR_REVIEW_WAIT=2'])
  const waiting = await until(r.id, (x) => x.wait?.startsWith('the checks') === true)
  expect(waiting).toMatchObject({ state: 'waiting', stage: 'ci', wait: 'the checks: 1 of 1 pending', note: 'PR #7: waiting for the checks: 1 of 1 pending', checks: [{ name: 'gate', state: 'pending' }] })
  // A message meanwhile is refused: no session runs to take it.
  expect((await api(m, 'POST', '/api/processes/message', { id: r.id, text: 'go on' })).status).toBe(409)
  const bots = await until(r.id, (x) => x.wait?.startsWith('a review of') === true)
  expect(bots).toMatchObject({ state: 'waiting', wait: expect.stringMatching(/^a review of chatgpt-codex-connector, until 20[0-9-]+T[0-9:.]+Z$/), checks: [{ name: 'gate', state: 'pass' }] })
  // No bot reviewed within the wait: the pull request is green without it.
  const done = await ended(r.id)
  expect(done).toMatchObject({ state: 'ready', note: green })
  expect(done.wait).toBeUndefined()
  expect(events(r.id).filter((e) => e.event === 'ci-wait').map((e) => e.wait)).toEqual(['the checks: 1 of 1 pending', bots.wait])
})

test('a conflict starts a fix session of the ci stage, whose commit is pushed and waited on again', async () => {
  canPull(m, 'owner/repo', 7, [reading(7, { mergeable: 'CONFLICTING', checks: {} }), reading(7)])
  playFix('commit merged.txt\ncomplete Merged the base')
  const r = await claim()
  const done = await ended(r.id)
  expect(done).toMatchObject({ state: 'ready', stage: 'ci', note: green })
  expect(shape(done)).toEqual(['implement session complete', 'gate run pass', 'review round pass', 'pr open opened', 'ci wait conflicts', 'ci session complete', 'ci wait green'])
  const fix = done.history?.[5]
  expect(fix?.commits).toEqual([expect.stringMatching(/ fix: write merged\.txt$/)])
  expect(done.history?.[6]).toMatchObject({ commit: head(done) })
})

test('failed checks start fix sessions within the repair budget, and a spent budget ends the process failed', async () => {
  const failing = reading(7, { checks: { gate: 'FAILURE', lint: 'SUCCESS' } })
  canPull(m, 'owner/repo', 7, [failing])
  playFix('commit fixed.txt\ncomplete Fixed the gate')
  const r = await claim(['WF_CI_REPAIR_ROUNDS=1'])
  const done = await ended(r.id)
  expect(done).toMatchObject({ state: 'failed', stage: 'ci', note: 'the ci stage spent its 1 repair round(s): checks failed on PR #7: gate' })
  expect(shape(done)).toEqual(['implement session complete', 'gate run pass', 'review round pass', 'pr open opened', 'ci wait checks-failed', 'ci session complete', 'ci wait checks-failed'])
  expect(done.history?.[4]?.checks).toEqual([
    { name: 'gate', url: 'https://github.com/owner/repo/actions/runs/7/job/gate', state: 'fail' },
    { name: 'lint', url: 'https://github.com/owner/repo/actions/runs/7/job/lint', state: 'pass' },
  ])
  expect(await board()).toMatchObject([{ issue: 144, state: 'failed', stage: 'ci', action: 'Open' }])
})

test('a standing request for changes is never green: the process is blocked with who asked', async () => {
  canPull(m, 'owner/repo', 7, [
    reading(7, {
      reviews: [
        { login: 'chatgpt-codex-connector', state: 'COMMENTED' },
        { login: 'ada', state: 'CHANGES_REQUESTED' },
      ],
    }),
  ])
  const r = await claim()
  const done = await ended(r.id)
  expect(done).toMatchObject({ state: 'blocked', stage: 'ci', note: expect.stringMatching(/^PR #7 is not green: ada requested changes; /) })
  expect(done.history?.at(-1)).toMatchObject({ stage: 'ci', kind: 'wait', result: 'review-comments', reviews: ['ada requested changes'] })
  expect(await board()).toMatchObject([{ issue: 144, state: 'blocked', action: 'Answer' }])
})

test('a stop while the ci stage waits marks the process interrupted, and a resume waits again', async () => {
  canPull(m, 'owner/repo', 7, [reading(7, { checks: { gate: 'PENDING' } })])
  const r = await claim()
  await until(r.id, (x) => x.state === 'waiting' && x.wait !== undefined)
  const exited = new Promise((done) => server.once('exit', done))
  server.kill('SIGTERM')
  await exited
  expect(recordOf(r.id)).toMatchObject({ state: 'interrupted', stage: 'ci', note: 'the controller stopped while its ci stage waited on the pull request; resume it to wait again' })

  server = await up()
  canPull(m, 'owner/repo', 7, [reading(7, { checks: { gate: 'PENDING' } }), reading(7)])
  expect(cli(m, ['resume', '144', '--project', dir]).stderr).toBe('')
  const done = await until(r.id, (x) => !['running', 'waiting', 'interrupted'].includes(x.state))
  expect(done).toMatchObject({ state: 'ready', stage: 'ci', note: green })
  expect(shape(done)).toEqual(['implement session complete', 'gate run pass', 'review round pass', 'pr open opened', 'ci wait green'])
})

test('a bot review that arrives within the review wait ends the wait at once', async () => {
  const quiet = reading(7, { reviews: [] })
  canPull(m, 'owner/repo', 7, [quiet, quiet, reading(7)])
  const r = await claim(['WF_PR_REVIEW_WAIT=600'])
  const done = await ended(r.id)
  expect(done).toMatchObject({ state: 'ready', stage: 'ci', note: green })
  const waits = events(r.id).filter((e) => e.event === 'ci-wait').map((e) => e.wait)
  expect(waits).toEqual([expect.stringMatching(/^a review of chatgpt-codex-connector, until /)])
})

test('an empty rollup in a repository with workflows waits for GitHub to register the checks', async () => {
  // The base has a workflow, so the worktree claimed from it has one.
  mkdirSync(join(dir, '.github', 'workflows'), { recursive: true })
  writeFileSync(join(dir, '.github', 'workflows', 'ci.yml'), 'on: push\n')
  const git = (...args: string[]) => execFileSync('git', ['-C', dir, ...args], { stdio: 'pipe' })
  git('add', '.github')
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'ci: add a workflow')
  git('update-ref', 'refs/remotes/origin/main', 'HEAD')
  canPull(m, 'owner/repo', 7, [reading(7, { checks: {} }), reading(7)])
  const r = await claim()
  const done = await ended(r.id)
  expect(done).toMatchObject({ state: 'ready', stage: 'ci', note: green })
  expect(events(r.id).filter((e) => e.event === 'ci-wait').map((e) => e.wait)).toEqual(['GitHub to register the checks of the workflows'])
})

test('a closed pull request ends the process failed', async () => {
  canPull(m, 'owner/repo', 7, [reading(7, { state: 'CLOSED' })])
  const r = await claim()
  const done = await ended(r.id)
  expect(done).toMatchObject({ state: 'failed', stage: 'ci', note: expect.stringMatching(/^PR #7 is closed, /) })
  expect(done.history?.at(-1)).toMatchObject({ stage: 'ci', kind: 'wait', result: 'closed', pr: 7 })
})

test('an unresolved review thread is never green: the process is blocked', async () => {
  canPull(m, 'owner/repo', 7, [reading(7)])
  writeFileSync(join(m.github, 'repos', 'owner', 'repo', 'pulls', '7.threads.json'), JSON.stringify([{ isResolved: true }, { isResolved: false }]))
  const r = await claim()
  const done = await ended(r.id)
  expect(done).toMatchObject({ state: 'blocked', stage: 'ci', note: expect.stringMatching(/^PR #7 is not green: 1 review thread\(s\) not resolved; /) })
  expect(done.history?.at(-1)).toMatchObject({ result: 'review-comments', reviews: ['1 review thread(s) not resolved'] })
})

test('an author session that reports no pull request ends the pr stage failed', async () => {
  playAuthor('silent')
  canPull(m, 'owner/repo', 7, [reading(7)])
  const r = await claim()
  const done = await ended(r.id)
  expect(done).toMatchObject({ state: 'failed', stage: 'pr', note: expect.stringMatching(/^the author session wrote no pull request: /) })
  expect(ghCalls().some((c) => c.startsWith('pr create '))).toBe(false)
})

test('a gh pr create that fails ends the pr stage failed', async () => {
  // No pull request is canned, so gh pr create fails.
  const r = await claim()
  const done = await ended(r.id)
  expect(done).toMatchObject({ state: 'failed', stage: 'pr', note: expect.stringMatching(/^could not open the pull request of feat\/144-board-lists-every-project: /) })
  expect(done.pull).toBeUndefined()
})

test('a bot reviewer GitHub refuses is a note, and the pull request goes on to its wait', async () => {
  canPull(m, 'owner/repo', 7, [reading(7)])
  writeFileSync(join(m.github, 'repos', 'owner', 'repo', 'unreviewable'), '')
  const r = await claim()
  const done = await ended(r.id)
  expect(done).toMatchObject({ state: 'ready', stage: 'ci', note: green })
  const notes = events(r.id).filter((e) => e.event === 'pr-note') as { note?: string }[]
  expect(notes).toEqual([expect.objectContaining({ note: expect.stringMatching(/^could not ask chatgpt-codex-connector for a review of PR #7: /) })])
})

test('a stop while the author session runs marks the pr stage interrupted, and a resume runs the stage again', async () => {
  playAuthor('say Reading the diff')
  canPull(m, 'owner/repo', 7, [reading(7)])
  const r = await claim()
  await until(r.id, (x) => x.stage === 'pr' && x.state === 'running')
  const exited = new Promise((done) => server.once('exit', done))
  server.kill('SIGTERM')
  await exited
  expect(recordOf(r.id)).toMatchObject({ state: 'interrupted', stage: 'pr', note: 'the controller stopped while its pr stage ran; resume it to open the pull request' })
  expect(ghCalls().some((c) => c.startsWith('pr create '))).toBe(false)

  server = await up()
  playAuthor('pull feat: list every project on the board')
  expect(cli(m, ['resume', '144', '--project', dir]).stderr).toBe('')
  const done = await until(r.id, (x) => !['running', 'waiting', 'interrupted'].includes(x.state))
  expect(done).toMatchObject({ state: 'ready', stage: 'ci', note: green, pull: { number: 7 } })
  expect(shape(done)).toEqual(['implement session complete', 'gate run pass', 'review round pass', 'pr open opened', 'ci wait green'])
  expect(ghCalls().filter((c) => c.startsWith('pr create '))).toHaveLength(1)
})

test('a fix session of the ci stage that is blocked waits for the answer, which resumes it into the wait', async () => {
  canPull(m, 'owner/repo', 7, [reading(7, { checks: { gate: 'FAILURE' } }), reading(7)])
  playFix('blocked Skip the flaky check?')
  const r = await claim()
  const blocked = await ended(r.id)
  expect(blocked).toMatchObject({ state: 'blocked', stage: 'ci', note: 'Skip the flaky check?' })
  expect(shape(blocked)).toEqual(['implement session complete', 'gate run pass', 'review round pass', 'pr open opened', 'ci wait checks-failed', 'ci session blocked'])

  writeFileSync(join(m.claude, 'resume'), 'commit fixed.txt\ncomplete Fixed the check\n')
  expect((await api(m, 'POST', '/api/processes/message', { id: r.id, text: 'fix it instead' })).status).toBe(200)
  const done = await until(r.id, (x) => !['running', 'waiting', 'blocked'].includes(x.state))
  expect(done).toMatchObject({ state: 'ready', stage: 'ci', note: green })
  expect(shape(done)).toEqual(['implement session complete', 'gate run pass', 'review round pass', 'pr open opened', 'ci wait checks-failed', 'ci session blocked', 'ci session complete', 'ci wait green'])
  expect(done.history?.at(-1)).toMatchObject({ commit: head(done) })
})
