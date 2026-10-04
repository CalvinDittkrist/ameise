import { type ChildProcess, execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { testPaths } from '../src/hunt.js'
import { api, canApi, canPages, canPull, canPulls, checkout, cleanup, cli, gated, type Machine, machine, read, reading, record, start, tools, worktree } from './controller.js'

afterEach(cleanup)

let m: Machine
let dir: string
let server: ChildProcess
beforeEach(async () => {
  m = await machine()
  m.env = { ...m.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' }
  // The worker's hunt.sh, which the controller reads the hunt record with, calls these.
  tools(m, ['sed', 'awk', 'grep', 'wc', 'tr', 'head', 'sort', 'date', 'mv', 'mkdir', 'dirname', 'rm', 'cut', 'ls', 'basename'])
  const s = await start(m)
  expect(s.running, s.stderr).toBe(true)
  server = s.process
  dir = checkout(m, 'repo', { origin: 'https://github.com/owner/repo.git', originHead: 'main' })
  canPulls(m, 'owner/repo', [])
  canApi(m, 'repos/owner/repo/issues?labels=ready-for-agent&state=open&per_page=100', [])
  canApi(m, 'repos/owner/repo/issues?labels=spec&state=open&per_page=100', [])
  canPages(m, 'repos/owner/repo/branches?per_page=100', [[]])
  expect((await api(m, 'POST', '/api/projects', { path: dir })).status).toBe(201)
})

interface Record {
  id: string
  kind: string
  issue: number | null
  branch: string
  base: string
  worktree: string
  stage: string
  state: string
  note: string
  hunt?: { rounds: number; ended: string | null; removed: { test: string; path: string; why: string }[]; kept: { test: string }[] }
  history?: { stage: string; kind: string; result: string }[]
  session_id?: string
  workflow?: string
  node?: string
}

// up starts the controller again on the same machine.
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

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: 'pipe' }).trim()
const recordOf = (id: string) => JSON.parse(read(join(m.state, 'processes', `${id}.json`))) as Record
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
const board = async () =>
  ((await api(m, 'GET', '/api/board?' + new URLSearchParams({ project: dir }).toString())).body as { processes: { kind: string; state: string; stage: string; action: string; needs: boolean }[] }).processes

// tested gives the base a test file of the hunt's rule with two tests, and the gate.
function tested() {
  mkdirSync(join(dir, 'tests'))
  writeFileSync(join(dir, 'tests', 'test_login.py'), 'def test_constant():\n    assert 1\n')
  writeFileSync(join(dir, 'tests', 'test_logout.py'), 'def test_logout():\n    assert logout()\n')
  git(dir, 'add', 'tests')
  git(dir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'tests')
  gated(dir)
}

const script = '"$CLAUDE_PLUGIN_ROOT/scripts/hunt.sh"'
// playHunt cans the hunt session: a round whose hunter's reply is triaged, then the rest.
const playHunt = (reply: string, ...rest: string[]) =>
  writeFileSync(join(m.claude, 'hunt'), [`run bash ${script} round`, `run printf '${reply}\\n' | bash ${script} triage 1`, ...rest].join('\n') + '\n')

const hunted = async (): Promise<Record> => {
  const r = await api(m, 'POST', '/api/hunts', { project: dir })
  expect(r.status, JSON.stringify(r.body)).toBe(201)
  return (r.body as { record: Record }).record
}

test('a hunt that removed a test keeps the hunt record and goes through the gate, the review, the pr and the ci stages', async () => {
  tested()
  playHunt(
    'candidate: tests/test_login.py | test_constant | cannot-fail | asserts the constant 1 | high\\ncandidate: tests/test_logout.py | test_logout | mocks-subject | logout may be stubbed | medium',
    'run git rm -q tests/test_login.py && git commit -q -m "test: remove test_constant"',
    `run printf 'remove: tests/test_login.py | test_constant | cannot-fail | asserts the constant 1\\nwhy: it cannot fail\\nstill_proven: no, it touched no behaviour\\n' | bash ${script} removed`,
    `run bash ${script} round`,
    `run printf 'no candidates\\n' | bash ${script} triage 1`,
    `run bash ${script} round`,
    'complete Removed test_constant',
  )
  canPull(m, 'owner/repo', 7, [reading(7)])
  const r = await hunted()
  expect(r).toMatchObject({ kind: 'hunt', issue: null, stage: 'hunt', branch: expect.stringMatching(/^hunt\/tests-[0-9]{4}-[0-9]{2}-[0-9]{2}$/) as unknown })
  const done = await ended(r.id)
  expect(done).toMatchObject({ state: 'ready', stage: 'ci', hunt: { rounds: 2, ended: 'round 2 found no new candidate', removed: [{ path: 'tests/test_login.py', test: 'test_constant', why: 'it cannot fail' }], kept: [{ test: 'test_logout' }] } })
  expect(shape(done)).toEqual(['hunt session complete', 'gate run pass', 'review round pass', 'pr open opened', 'ci wait green'])
  // The pull request closes no issue.
  expect(read(join(m.github, 'repos', 'owner', 'repo', 'pulls', '7.body'))).not.toMatch(/Closes #/)
})

test('a hunt session that reports complete before hunt.sh ended the hunt waits for input and opens no pull request', async () => {
  tested()
  playHunt('no candidates', 'complete hunt: nothing removed')
  const r = await hunted()
  const done = await ended(r.id)
  expect(done).toMatchObject({ state: 'input', stage: 'hunt', hunt: { rounds: 1, ended: null } })
  expect(done.note).toMatch(/before hunt\.sh ended the hunt/)
  expect(read(m.ghLog)).not.toMatch(/^pr create/m)
})

test('a hunt that removed nothing opens no pull request, ends done with that message, and a finish removes it', async () => {
  tested()
  playHunt('no candidates', `run bash ${script} round`, 'complete hunt: nothing removed')
  const r = await hunted()
  const done = await ended(r.id)
  expect(done).toMatchObject({ state: 'done', stage: 'hunt', hunt: { rounds: 1, removed: [], ended: 'round 1 found no new candidate' } })
  expect(done.note).toMatch(/^the hunt removed nothing in 1 round, so no pull request opens/)
  expect(shape(done)).toEqual(['hunt session complete'])
  expect(read(m.ghLog)).not.toMatch(/^pr create/m)
  expect(await board()).toMatchObject([{ kind: 'hunt', state: 'done', stage: 'hunt', action: 'Finish', needs: true }])

  const f = await api(m, 'POST', '/api/processes/finish', { id: r.id })
  expect(f.status, JSON.stringify(f.body)).toBe(200)
  expect(git(dir, 'branch', '--list', 'hunt/*')).toBe('')
  expect(await board()).toEqual([])
})

test('a hunt is refused while a hunt branch exists here or on origin, and while the base has no test file', async () => {
  const none = await api(m, 'POST', '/api/hunts', { project: dir })
  expect(none.status).toBe(409)
  expect((none.body as { error: string }).error).toMatch(/no test file on origin\/main matches the conventions of a test hunt: .*There is nothing to hunt here\.$/)

  tested()
  git(dir, 'branch', 'hunt/tests-2026-01-01')
  const here = await api(m, 'POST', '/api/hunts', { project: dir })
  expect(here.status).toBe(409)
  expect((here.body as { error: string }).error).toMatch(/the hunt branch hunt\/tests-2026-01-01 exists already/)
  git(dir, 'branch', '-D', 'hunt/tests-2026-01-01')

  canPages(m, 'repos/owner/repo/branches?per_page=100', [[{ name: 'main' }, { name: 'hunt/tests-2026-01-02' }]])
  const origin = cli(m, ['hunt', '--project', dir])
  expect(origin.code).toBe(1)
  expect(origin.stderr).toMatch(/the hunt branch hunt\/tests-2026-01-02 exists on origin/)

  canPages(m, 'repos/owner/repo/branches?per_page=100', [[]])
  writeFileSync(join(m.claude, 'hunt'), 'wait\n')
  const ok = cli(m, ['hunt', '--project', dir])
  expect(ok.code, ok.stderr).toBe(0)
  expect(ok.stdout).toMatch(/^hunt hunt-[0-9a-f]{12} {2}hunt\/tests-/)
  // One hunt at a time.
  const twice = await api(m, 'POST', '/api/hunts', { project: dir })
  expect(twice.status).toBe(409)
  expect((twice.body as { error: string }).error).toMatch(/a test hunt runs already/)
  void server
})

test('a hunt that removed nothing keeps a worktree with changes or commits on no branch of origin, unless the finish is forced', async () => {
  tested()
  playHunt('no candidates', `run bash ${script} round`, 'complete hunt: nothing removed')
  const r = await hunted()
  const done = await ended(r.id)
  expect(done.state).toBe('done')

  writeFileSync(join(done.worktree, 'scratch.txt'), 'left\n')
  const dirty = await api(m, 'POST', '/api/processes/finish', { id: r.id })
  expect(dirty.status).toBe(409)
  expect((dirty.body as { error: string }).error).toMatch(/has changes not committed; commit them, or finish with force to lose them$/)

  git(done.worktree, 'add', 'scratch.txt')
  git(done.worktree, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'scratch')
  const unpushed = await api(m, 'POST', '/api/processes/finish', { id: r.id })
  expect(unpushed.status).toBe(409)
  expect((unpushed.body as { error: string }).error).toMatch(/^hunt\/tests-.* has 1 commit\(s\) on no branch of origin; push them, or finish with force to lose them$/)
  expect(recordOf(r.id).state).toBe('done')
  expect(git(dir, 'branch', '--list', 'hunt/*')).not.toBe('')

  const forced = await api(m, 'POST', '/api/processes/finish', { id: r.id, force: true })
  expect(forced.status, JSON.stringify(forced.body)).toBe(200)
  expect(git(dir, 'branch', '--list', 'hunt/*')).toBe('')
  expect(await board()).toEqual([])
})

test('a controller killed mid-hunt finds the hunt interrupted at its next start, and a resume by its id goes on with its session', async () => {
  tested()
  writeFileSync(join(m.claude, 'hunt'), 'wait\n')
  const r = await hunted()
  const running = await until(r.id, (x) => !!x.session_id)
  await down('SIGKILL')
  server = await up()
  const stopped = recordOf(r.id)
  expect(stopped).toMatchObject({ kind: 'hunt', state: 'interrupted', stage: 'hunt', session_id: running.session_id, note: 'the controller stopped while its hunt session ran; resume it to go on' })
  expect(await board()).toMatchObject([{ kind: 'hunt', state: 'interrupted', needs: true, action: 'Resume' }])

  // A worktree on another branch, or gone, refuses the resume and leaves the hunt interrupted.
  git(stopped.worktree, 'checkout', '-q', '-b', 'other')
  const moved = await api(m, 'POST', '/api/processes/resume', { id: r.id })
  expect(moved.status).toBe(409)
  expect((moved.body as { error: string }).error).toBe(`the worktree ${stopped.worktree} of ${r.id} is not on ${stopped.branch}, so its session cannot go on there; finish it`)
  git(stopped.worktree, 'checkout', '-q', stopped.branch)
  git(stopped.worktree, 'branch', '-q', '-D', 'other')

  renameSync(stopped.worktree, `${stopped.worktree}.away`)
  const gone = await api(m, 'POST', '/api/processes/resume', { id: r.id })
  expect(gone.status).toBe(409)
  expect((gone.body as { error: string }).error).toBe(`the worktree ${stopped.worktree} of ${r.id} is gone, so its session cannot go on there; finish it`)
  renameSync(`${stopped.worktree}.away`, stopped.worktree)
  expect(recordOf(r.id).state).toBe('interrupted')

  writeFileSync(join(m.claude, 'resume'), [`run bash ${script} round`, `run printf 'no candidates\\n' | bash ${script} triage 1`, `run bash ${script} round`, 'complete hunt: nothing removed'].join('\n') + '\n')
  const resumed = await api(m, 'POST', '/api/processes/resume', { id: r.id })
  expect(resumed.status, JSON.stringify(resumed.body)).toBe(200)
  const done = await ended(r.id)
  expect(done).toMatchObject({ state: 'done', stage: 'hunt', session_id: running.session_id, hunt: { rounds: 1, removed: [] } })
  expect(read(m.claudeLog).split('\n')).toContain(`--resume=${running.session_id}`)

  // Only an interrupted hunt resumes.
  const again = await api(m, 'POST', '/api/processes/resume', { id: r.id })
  expect(again.status).toBe(409)
  expect((again.body as { error: string }).error).toBe(`${r.id} is done, not interrupted; only an interrupted session resumes`)
})

test('a resume by id refuses a process that is not a hunt', async () => {
  record(m, 'work-1', { id: 'work-1', project: dir, kind: 'work', branch: 'feat/9-asks', issue: 9, base: 'main', worktree: dir, stage: 'implement', state: 'interrupted', note: 'stopped' })
  const refused = await api(m, 'POST', '/api/processes/resume', { id: 'work-1' })
  expect(refused.status).toBe(409)
  expect((refused.body as { error: string }).error).toBe('work-1 is a work process, not a hunt')
})

const file = (path: string) => (existsSync(path) ? read(path) : '')
const events = (id: string) =>
  file(join(m.state, 'processes', `${id}.events.jsonl`))
    .split('\n')
    .filter((l) => l !== '')
    .map((l) => JSON.parse(l) as { event: string; stage?: string; state?: string; resume?: string })

test('a message to a hunt waiting on input resumes its hunt session by its id, whose next complete reads the hunt record again', async () => {
  tested()
  playHunt('no candidates', 'complete hunt: nothing removed')
  const r = await hunted()
  const waiting = await ended(r.id)
  expect(waiting).toMatchObject({ state: 'input', workflow: 'hunt', node: 'hunt-record', hunt: { rounds: 1, ended: null } })
  expect(events(r.id).map((e) => e.event)).toContain('hunt-unended')

  writeFileSync(join(m.claude, 'resume'), [`run bash ${script} round`, 'complete hunt: nothing removed'].join('\n') + '\n')
  const sent = await api(m, 'POST', '/api/processes/message', { id: r.id, text: 'Run the rounds until hunt.sh ends the hunt' })
  expect(sent.body).toMatchObject({ delivered: 'resumed' })
  const done = await until(r.id, (x) => x.state === 'done')
  expect(done).toMatchObject({ stage: 'hunt', node: 'hunt-record', session_id: waiting.session_id, hunt: { rounds: 1, ended: 'round 1 found no new candidate' } })
  expect(done.note).toMatch(/^the hunt removed nothing in 1 round, so no pull request opens/)
  const log = events(r.id)
  const from = log.findIndex((e) => e.event === 'message')
  expect(log.slice(from).find((e) => e.event === 'session-start')).toMatchObject({ stage: 'hunt', resume: waiting.session_id })
  expect(log.slice(from).find((e) => e.event === 'hunt-end')).toMatchObject({ state: 'done' })
  expect(read(m.claudeLog).split('\n')).toContain(`--resume=${waiting.session_id}`)
})

test('a hunt whose hunt record cannot be read after its session reported complete parks failed with an event and opens no pull request', async () => {
  tested()
  // The session points the worktree's .git at nothing, so hunt.sh json finds no git directory to read.
  playHunt('no candidates', `run bash ${script} round`, "run printf 'gitdir: /nonexistent\\n' > .git", 'complete hunt: nothing removed')
  const r = await hunted()
  const done = await ended(r.id)
  expect(done).toMatchObject({ state: 'failed', stage: 'hunt' })
  expect(done.note).toMatch(/^could not read the hunt record: /)
  expect(events(r.id).find((e) => e.event === 'hunt-end')).toMatchObject({ stage: 'hunt', state: 'failed' })
  expect(read(m.ghLog)).not.toMatch(/^pr create/m)
})

test('a message to a ready hunt runs its hunt session again, whose complete goes through the gate once more', async () => {
  tested()
  playHunt(
    'candidate: tests/test_login.py | test_constant | cannot-fail | asserts the constant 1 | high',
    'run git rm -q tests/test_login.py && git commit -q -m "test: remove test_constant"',
    `run printf 'remove: tests/test_login.py | test_constant | cannot-fail | asserts the constant 1\\nwhy: it cannot fail\\nstill_proven: no, it touched no behaviour\\n' | bash ${script} removed`,
    `run bash ${script} round`,
    'complete Removed test_constant',
  )
  canPull(m, 'owner/repo', 7, [reading(7)])
  const r = await hunted()
  const ready = await ended(r.id)
  expect(ready).toMatchObject({ state: 'ready', stage: 'ci', workflow: 'hunt' })
  const before = shape(ready).length

  writeFileSync(join(m.claude, 'resume'), 'complete Looked again\n')
  const sent = await api(m, 'POST', '/api/processes/message', { id: r.id, text: 'Look again' })
  expect(sent.body).toMatchObject({ delivered: 'resumed' })
  const again = await until(r.id, (x) => x.state === 'ready' && shape(x).length > before + 1)
  expect(shape(again).slice(before, before + 2)).toEqual(['hunt session complete', 'gate run pass'])
  const log = events(r.id)
  const from = log.findIndex((e) => e.event === 'message')
  expect(log.slice(from).find((e) => e.event === 'session-start')).toMatchObject({ stage: 'hunt', resume: ready.session_id })
})

// interruptedHunt writes a hunt record on a worktree of its branch, as a stop leaves it.
function interruptedHunt(fields: { [key: string]: unknown }): string {
  const branch = 'hunt/tests-2026-10-01'
  const id = 'hunt-000000000001'
  const now = new Date().toISOString()
  record(m, id, { id, project: dir, kind: 'hunt', branch, issue: null, worktree: worktree(dir, branch), base: 'origin/main', mode: 'manual', env: {}, state: 'interrupted', note: 'the controller stopped', history: [], created_at: now, updated_at: now, ...fields })
  return id
}

test('a hunt record with the delivery workflow, interrupted in ci, resumes at the ci node of the hunt graph', async () => {
  const id = interruptedHunt({ stage: 'ci', workflow: 'delivery', node: 'ci', session_id: '0b5c3a6e-1111-4222-8333-444455556666' })
  const resumed = await api(m, 'POST', '/api/processes/resume', { id })
  expect(resumed.status, JSON.stringify(resumed.body)).toBe(200)
  expect((resumed.body as { record: Record }).record).toMatchObject({ workflow: 'hunt', node: 'ci', stage: 'ci' })
  for (let i = 0; i < 200 && !events(id).some((e) => e.event === 'ci-start'); i++) await new Promise((d) => setTimeout(d, 50))
  expect(events(id).some((e) => e.event === 'ci-start')).toBe(true)
})

test('a hunt record without workflow, interrupted in its hunt session, resumes that session by its id', async () => {
  const session = '0b5c3a6e-1111-4222-8333-444455556666'
  const id = interruptedHunt({ stage: 'hunt', session_id: session })
  writeFileSync(join(m.claude, 'resume'), 'wait\n')
  const resumed = await api(m, 'POST', '/api/processes/resume', { id })
  expect(resumed.status, JSON.stringify(resumed.body)).toBe(200)
  expect((resumed.body as { record: Record }).record).toMatchObject({ workflow: 'hunt', node: 'hunt', stage: 'hunt', state: 'running', note: 'hunt session resumed' })
  for (let i = 0; i < 200 && !file(m.claudeLog).includes(`--resume=${session}`); i++) await new Promise((d) => setTimeout(d, 50))
  expect(read(m.claudeLog).split('\n')).toContain(`--resume=${session}`)
  expect(events(id).find((e) => e.event === 'session-start')).toMatchObject({ stage: 'hunt', resume: session })
})

test.each([
  ['tests/test_login.py', true],
  ['pkg/login_test.py', true],
  ['pkg/login_test.go', true],
  ['src/login.test.ts', true],
  ['src/login.spec.jsx', true],
  ['web/login.test.mts', true],
  ['tests/helpers.py', true],
  ['spec/models/user.rb', true],
  ['a/tests/b/run.sh', true],
  ['tests/fixtures/test_data.py', false],
  ['pkg/testdata/x_test.go', false],
  ['src/__snapshots__/a.test.ts', false],
  ['node_modules/lib/a.spec.js', false],
  ['vendor/x/y_test.go', false],
  ['src/login.py', false],
  ['src/testing.py', false],
  ['tests/README.md', false],
  ['tests/data.json', false],
  ['src/login.test.py', false],
  ['test_login.py.orig', false],
])('the test-file rule of a hunt takes %s: %s', (path, taken) => {
  expect(testPaths([path])).toEqual(taken ? [path] : [])
})
