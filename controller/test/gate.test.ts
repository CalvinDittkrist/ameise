import { type ChildProcess, execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { api, canApi, canGreen, cli, canIssue, canPages, canPulls, checkout, cleanup, gated, type Machine, machine, play, read, script, start } from './controller.js'

afterEach(cleanup)

const identity = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' }
let m: Machine
let dir: string
let server: ChildProcess
beforeEach(async () => {
  m = await machine()
  // The sessions and the gate commit and merge in a home without a git identity.
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
})

async function up(): Promise<ChildProcess> {
  const s = await start(m)
  expect(s.running, s.stderr).toBe(true)
  return s.process
}

// hang is a recipe that runs for 30 s; the machine's PATH has no sleep.
const hang = `${process.execPath} -e 'setTimeout(() => {}, 30000)'`

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
const ended = (id: string) => until(id, (r) => !['running', 'waiting'].includes(r.state))

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
  // The gate's pass starts the review, whose reviewers pass.
  expect(done).toMatchObject({ state: 'ready', stage: 'ci', note: 'PR #1 is green: it merges, its checks pass and no review asks for changes' })
  expect(shape(done)).toEqual(['implement session complete', 'gate run fail', 'gate session complete', 'gate run pass', 'review round pass', 'pr open opened', 'ci wait green'])
  const [implement, failed, fix, passed] = done.history ?? []
  expect(failed).toMatchObject({ exit: 2, tail: expect.stringMatching(/Error 1/) })
  expect(fix).toMatchObject({ session_id: expect.stringMatching(/^fake-session-/), commits: [expect.stringMatching(/ fix: write fixed\.txt$/)] })
  expect(fix?.session_id).not.toBe(implement?.session_id)
  expect(passed).toMatchObject({ commit: head(done), exit: 0 })
  // The fix session is a fresh session of its own stage: no resume, and no agent of the worker's pipeline.
  const log = read(m.claudeLog)
  expect(log).not.toMatch(/--resume/)
  expect(log.split('\n').filter((l, i, all) => l === '--agent' && !all[i + 1]?.includes('reviewer'))).toHaveLength(1)
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
  const git = (...args: string[]) => execFileSync('git', ['-C', dir, ...args], { stdio: 'pipe', env: { ...process.env, ...identity } })
  git('add', 'a.txt')
  git('commit', '-q', '-m', 'base')
  git('update-ref', 'refs/remotes/origin/main', 'HEAD')
  expect((await say(r.id, 'go on')).status).toBe(200)
  const done = await ended(r.id)
  expect(done).toMatchObject({ state: 'ready', stage: 'ci' })
  expect(shape(done)).toEqual(['implement session complete', 'gate merge conflict', 'gate session complete', 'gate run pass', 'review round pass', 'pr open opened', 'ci wait green'])
  expect(done.history?.[1]).toMatchObject({ files: ['a.txt'] })
  expect(read(join(done.worktree, 'a.txt'))).toBe('a.txt\n')
})

test('a fix session that is blocked waits in needs you with its commits, and the answer resumes it into the gate', async () => {
  gated(dir, 'test -f fixed.txt')
  play(m, 'complete Implemented the board')
  playGate('commit partial.txt\nblocked Skip the flaky test?')
  const r = await claim()
  const blocked = await ended(r.id)
  expect(blocked).toMatchObject({ state: 'blocked', stage: 'gate', note: 'Skip the flaky test?' })
  expect(blocked.history?.[2]?.commits).toEqual([expect.stringMatching(/partial\.txt$/)])
  // Open in terminal resumes the fix session as it ran: without the worker's agent.
  const opened = join(m.root, 'terminal.log')
  const terminal = join(m.root, 'terminal')
  script(terminal, `printf '%s\\n' "$1" >> '${opened}'`)
  writeFileSync(m.config, JSON.stringify({ ...(JSON.parse(read(m.config)) as object), terminal }))
  expect((await api(m, 'POST', '/api/processes/terminal', { id: r.id })).status).toBe(200)
  const body = read(read(opened).trim())
  expect(body).toContain(`'--resume' '${blocked.session_id}'`)
  expect(body).not.toContain("'--agent'")
  expect(await board()).toMatchObject([{ issue: 144, state: 'blocked', stage: 'gate', note: 'Skip the flaky test?', needs: true, action: 'Answer' }])

  playResume('commit fixed.txt\ncomplete Fixed it instead')
  expect((await say(r.id, 'No, fix it')).body).toMatchObject({ delivered: 'resumed' })
  const done = await until(r.id, (x) => !['running', 'waiting'].includes(x.state) && x.state !== 'blocked')
  expect(done).toMatchObject({ state: 'ready', stage: 'ci' })
  expect(shape(done)).toEqual(['implement session complete', 'gate run fail', 'gate session blocked', 'gate session complete', 'gate run pass', 'review round pass', 'pr open opened', 'ci wait green'])
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

  // A restart keeps the held session waiting for the maintainer's message.
  const exited = new Promise((done) => server.once('exit', done))
  server.kill('SIGTERM')
  await exited
  server = await up()
  expect(recordOf(r.id)).toMatchObject({ state: 'input', stage: 'implement', note: expect.stringMatching(/held open/) })

  playResume('complete Renamed the flag as well')
  expect((await say(r.id, 'Rename the flag too')).body).toMatchObject({ delivered: 'resumed' })
  const done = await until(r.id, (x) => !['running', 'waiting'].includes(x.state) && x.state !== 'input')
  expect(done).toMatchObject({ state: 'ready', stage: 'ci' })
  expect(shape(done)).toEqual(['implement session complete', 'implement session complete', 'gate run pass', 'review round pass', 'pr open opened', 'ci wait green'])

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

test('a gate command that runs past WF_GATE_TIMEOUT is ended and counts as a failure', async () => {
  gated(dir, hang)
  play(m, 'complete Implemented the board')
  const r = await claim(['WF_GATE_TIMEOUT=1', 'WF_GATE_ROUNDS=0'])
  const done = await ended(r.id)
  expect(done).toMatchObject({ state: 'failed', stage: 'gate' })
  expect(done.note).toMatch(/^the gate spent its 0 fix session\(s\): make check failed at [0-9a-f]{7} with make check ran past the gate timeout of 1 s/)
  expect(shape(done)).toEqual(['implement session complete', 'gate run fail'])
})

test('a message to a process whose gate command runs is refused', async () => {
  gated(dir, hang)
  play(m, 'complete Implemented the board')
  const r = await claim()
  await until(r.id, (x) => x.stage === 'gate')
  const refused = await say(r.id, 'go on')
  expect(refused.status).toBe(409)
  expect(recordOf(r.id)).toMatchObject({ state: 'running', stage: 'gate' })
})

test('a stop while the gate runs marks the process interrupted, and a resume runs the gate again', async () => {
  // The gate hangs until the file go is in the worktree.
  gated(dir, `test -f go || ${hang}`)
  play(m, 'complete Implemented the board')
  const r = await claim()
  const gating = await until(r.id, (x) => x.stage === 'gate')
  const exited = new Promise((done) => server.once('exit', done))
  server.kill('SIGTERM')
  await exited
  expect(recordOf(r.id)).toMatchObject({ state: 'interrupted', stage: 'gate', note: 'the controller stopped while its gate ran; resume it to run the gate again' })

  server = await up()
  writeFileSync(join(gating.worktree, 'go'), '')
  const resumed = cli(m, ['resume', '144', '--project', dir])
  expect(resumed.stderr).toBe('')
  const done = await until(r.id, (x) => !['running', 'waiting'].includes(x.state) && x.state !== 'interrupted')
  expect(done).toMatchObject({ state: 'ready', stage: 'ci' })
  expect(shape(done)).toEqual(['implement session complete', 'gate run pass', 'review round pass', 'pr open opened', 'ci wait green'])
  expect(done.history?.[1]).toMatchObject({ kind: 'run', result: 'pass', dirty: true })
})

test('a gate knob that is no whole number ends the process failed with the reason', async () => {
  gated(dir)
  play(m, 'complete Implemented the board')
  const r = await claim(['WF_GATE_ROUNDS=abc'])
  const done = await ended(r.id)
  expect(done).toMatchObject({ state: 'failed', stage: 'gate', note: 'WF_GATE_ROUNDS=abc is not a whole number of at least 0; set it as such, or leave it out for 3' })
  expect(shape(done)).toEqual(['implement session complete'])
})

test('a gate without WF_GATE runs make check, and the record names it', async () => {
  gated(dir)
  play(m, 'complete Implemented the board')
  const r = await claim()
  const done = await ended(r.id)
  expect(done).toMatchObject({ state: 'ready', stage: 'ci' })
  expect(done.history?.[1]).toMatchObject({ kind: 'run', result: 'pass', gate: 'make check' })
})

test('a gate with a command form runs that command in the worktree without a shell', async () => {
  // make check fails; the command WF_GATE names runs the target ok, which writes its argument into a file.
  gated(dir, "false\nok:\n\t@printf '%s' '$(WORD)' > ran.txt")
  play(m, 'complete Implemented the board')
  const r = await claim(['WF_GATE=make  ok WORD=word'])
  const done = await ended(r.id)
  expect(done).toMatchObject({ state: 'ready', stage: 'ci' })
  expect(shape(done)).toEqual(['implement session complete', 'gate run pass', 'review round pass', 'pr open opened', 'ci wait green'])
  expect(done.history?.[1]).toMatchObject({ kind: 'run', result: 'pass', gate: 'make ok WORD=word', dirty: true })
  expect(read(join(done.worktree, 'ran.txt'))).toBe('word')
})

test('a gate with the form none runs no gate and goes to the review, and the record names the form', async () => {
  // make check would fail, so a pass means it never ran.
  gated(dir, 'false')
  play(m, 'complete Implemented the board')
  const r = await claim(['WF_GATE=none'])
  const done = await ended(r.id)
  expect(done).toMatchObject({ state: 'ready', stage: 'ci', note: 'PR #1 is green: it merges, its checks pass and no review asks for changes' })
  expect(shape(done)).toEqual(['implement session complete', 'gate run skipped', 'review round pass', 'pr open opened', 'ci wait green'])
  expect(done.history?.[1]).toMatchObject({ kind: 'run', result: 'skipped', gate: 'none', commit: head(done) })
})

test('a WF_GATE the settings turn wrong after the claim ends the process failed at the gate', async () => {
  gated(dir)
  play(m, 'wait\ncomplete Implemented the board')
  const r = await claim()
  mkdirSync(join(dir, '.claude'), { recursive: true })
  writeFileSync(join(dir, '.claude', 'settings.json'), JSON.stringify({ env: { WF_GATE: 'ci:' } }))
  expect((await say(r.id, 'go on')).status).toBe(200)
  const done = await ended(r.id)
  expect(done).toMatchObject({ state: 'failed', stage: 'gate', note: expect.stringMatching(/^WF_GATE=ci: is no gate form: ci:<jobs> names jobs separated by commas; the forms are /) })
  expect(shape(done)).toEqual(['implement session complete'])
})

test('a gate command that leaves changes passes with changes not committed', async () => {
  // The machine's PATH has no touch; node writes the file.
  gated(dir, `${process.execPath} -e 'require("fs").writeFileSync("made.txt", "")'`)
  play(m, 'complete Implemented the board')
  const r = await claim()
  const done = await ended(r.id)
  expect(done).toMatchObject({ state: 'ready', stage: 'ci' })
  expect(done.history?.[1]).toMatchObject({ kind: 'run', result: 'pass', dirty: true })
})

test('a stop while a fix session of the gate runs marks it interrupted, and a resume goes on with that session', async () => {
  gated(dir, 'test -f fixed.txt')
  play(m, 'complete Implemented the board')
  // Without an end the fix session runs until it is stopped.
  playGate('say Looking into it')
  const r = await claim()
  const fixing = await until(r.id, (x) => x.stage === 'gate' && x.state === 'running' && (x.history ?? []).length === 2 && !!x.session_id)
  const exited = new Promise((done) => server.once('exit', done))
  server.kill('SIGTERM')
  await exited
  expect(recordOf(r.id)).toMatchObject({ state: 'interrupted', stage: 'gate', session_id: fixing.session_id, note: 'the controller stopped while the fix session of its gate ran; resume it to go on' })

  server = await up()
  playResume('commit fixed.txt\ncomplete Wrote the missing file')
  expect(cli(m, ['resume', '144', '--project', dir]).stderr).toBe('')
  const done = await until(r.id, (x) => !['running', 'waiting'].includes(x.state) && x.state !== 'interrupted')
  expect(done).toMatchObject({ state: 'ready', stage: 'ci' })
  expect(shape(done)).toEqual(['implement session complete', 'gate run fail', 'gate session complete', 'gate run pass', 'review round pass', 'pr open opened', 'ci wait green'])
  expect(done.history?.[2]?.session_id).toBe(fixing.session_id)
})
