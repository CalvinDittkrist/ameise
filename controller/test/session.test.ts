import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { api, canApi, canGreen, canIssue, canPages, canPulls, checkout, cleanup, cli, gated, type Machine, machine, play, read, start } from './controller.js'

afterEach(cleanup)

let m: Machine
let dir: string
beforeEach(async () => {
  m = await machine()
  // The shell that starts the controller may hold the workflow's variables and Herdr's.
  m.env = { ...m.env, WF_MODE: 'leaked-mode', WF_ISSUE: '999', HERDR_ENV: '1' }
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
  // The issue's body and comments, which only the session itself may read.
  const file = join(m.github, 'repos', 'owner', 'repo', 'issues', '144.json')
  writeFileSync(file, JSON.stringify({ ...JSON.parse(read(file)), body: 'SECRET-BODY-TEXT', comments: [{ body: 'SECRET-COMMENT-TEXT' }] }))
})

interface Record {
  id: string
  state: string
  stage: string
  note: string
  branch: string
  worktree: string
  session_id?: string
  history?: { stage: string; kind: string; result: string; at: string; session_id?: string; commits?: string[]; commit?: string; exit?: number }[]
}

const claim = async (mode: 'manual' | 'yolo' = 'manual'): Promise<Record> => {
  const r = await api(m, 'POST', '/api/processes', { project: dir, issue: 144, mode, env: ['WF_REVIEWERS=code'] })
  expect(r.status, JSON.stringify(r.body)).toBe(201)
  return (r.body as { record: Record }).record
}

const recordOf = (id: string) => JSON.parse(read(join(m.state, 'processes', `${id}.json`))) as Record
const events = (id: string) =>
  read(join(m.state, 'processes', `${id}.events.jsonl`))
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l) as { event: string; message?: { type: string; session_id?: string }; state?: string; note?: string })

// ended waits for the process's session to end and answers its record.
async function ended(id: string): Promise<Record> {
  for (let i = 0; i < 200; i++) {
    const r = recordOf(id)
    if (!['running', 'waiting'].includes(r.state)) return r
    await new Promise((done) => setTimeout(done, 50))
  }
  throw new Error(`the session of ${id} did not end: ${JSON.stringify(recordOf(id))}`)
}

const board = async () =>
  ((await api(m, 'GET', '/api/board?' + new URLSearchParams({ project: dir }).toString())).body as { processes: { issue: number; state: string; stage: string; note: string; needs: boolean; action: string }[] })
    .processes

// started is what the scripted claude was started with: its arguments, and the lines it read.
function started(): { args: string[]; read: string[] } {
  const lines = read(m.claudeLog).trimEnd().split('\n')
  return { args: lines.filter((l) => !l.startsWith('< ')), read: lines.filter((l) => l.startsWith('< ')).map((l) => l.slice(2)) }
}

test('a claim starts a session in the worktree with the worker plugin and the session settings, and its complete report starts the gate, whose pass starts the review', async () => {
  play(m, 'commit board.txt\ncomplete Implemented the board')
  const r = await claim()
  expect(r).toMatchObject({ state: 'running', stage: 'implement' })
  const done = await ended(r.id)
  const head = execFileSync('git', ['-C', r.worktree, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  expect(done).toMatchObject({ state: 'ready', stage: 'ci', note: 'PR #1 is green: it merges, its checks pass and no review asks for changes', panel: 'pass' })
  expect(done.session_id).toMatch(/^fake-session-/)
  // The record carries each stage's attempt: the implement session with its commits, the gate's run, the
  // review's round, the opening of the pull request and the ci stage's green.
  expect(done.history).toMatchObject([
    { stage: 'implement', kind: 'session', result: 'complete', session_id: done.session_id, commits: [expect.stringMatching(/^[0-9a-f]{7,} fix: write board\.txt$/)] },
    { stage: 'gate', kind: 'run', result: 'pass', commit: head, exit: 0 },
    { stage: 'review', kind: 'round', result: 'pass', round: 1, verdicts: [{ reviewer: 'code', verdict: 'pass', findings: [] }] },
    { stage: 'pr', kind: 'open', result: 'opened', commit: head, pr: 1, url: 'https://github.com/owner/repo/pull/1' },
    { stage: 'ci', kind: 'wait', result: 'green', commit: head, pr: 1, checks: [{ name: 'gate', state: 'pass' }] },
  ])
  expect(done.history?.every((h) => !Number.isNaN(Date.parse(h.at)))).toBe(true)

  // The stream is in the event log, the session's id with it; a reviewer's stream is not.
  const log = events(r.id)
  expect(log.map((e) => e.event)).toEqual(['claimed', 'session-start', 'stream', 'stream', 'stream', 'session-end', 'gate-start', 'gate', 'gate-end', 'review-start', 'review', 'review-end', 'pr-start', 'pr-end', 'ci-start', 'ci-end'])
  expect(log.filter((e) => e.event === 'stream').map((e) => e.message?.type)).toEqual(['system', 'assistant', 'result'])
  expect(log.find((e) => e.event === 'gate-end')).toMatchObject({ state: 'pass', note: `the gate passed at ${head.slice(0, 7)}` })
  expect(log.at(-1)).toMatchObject({ state: 'ready', note: 'PR #1 is green: it merges, its checks pass and no review asks for changes' })

  const { args } = started()
  const flag = (name: string) => args[args.indexOf(name) + 1]
  // The bundled copies of the build, the worker's and repo-standards', and no other: for the implement
  // session, for the reviewer, which runs as the worker's reviewer agent without the tools that write, and
  // for the author session of the pull request, which runs without them too.
  const bundled = (name: string) => resolve(fileURLToPath(new URL(`../dist/plugins/${name}`, import.meta.url)))
  expect(args.flatMap((a, i) => (a === '--plugin-dir' ? [args[i + 1]] : []))).toEqual([bundled('worker'), bundled('repo-standards'), bundled('worker'), bundled('repo-standards'), bundled('worker'), bundled('repo-standards')])
  expect(flag('--agent')).toBe('worker')
  expect(args[args.lastIndexOf('--agent') + 1]).toBe('worker:code-reviewer')
  expect(args[args.lastIndexOf('--disallowedTools') + 1]).toMatch(/Edit,Write/)
  expect(flag('--permission-mode')).toBe('auto')
  // A reviewer runs in the default mode, where no classifier allows a write.
  expect(args[args.lastIndexOf('--permission-mode') + 1]).toBe('default')
  expect(args).toContain('--setting-sources=user,project,local')
  const settings = JSON.parse(flag('--settings') ?? '{}') as { env: { [k: string]: string }; autoCompactWindow: number; statusLine?: unknown; enabledPlugins: { [k: string]: boolean } }
  // The bundled plugins are the only copies: every marketplace copy of the workflow's plugins is off.
  expect(settings.enabledPlugins).toEqual({ 'worker@ameise': false, 'planner@ameise': false, 'orchestrator@ameise': false, 'repo-standards@ameise': false })
  expect(settings.env).toMatchObject({ WF_MODE: 'manual', WF_ISSUE: '144', WF_BASE_BRANCH: 'main', WF_CONTROLLER: '1', WF_REVIEWERS: 'code', CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: '80' })
  expect(settings.autoCompactWindow).toBe(312500)
  // No status line: the process view measures the context from the usage events.
  expect(settings.statusLine).toBeUndefined()
  // The runtime runs without the controller's own workflow and Herdr variables.
  const env = read(m.claudeLog + '.env')
    .split('\n')
    .map((l) => l.replace(/^declare -x /, '').split('=')[0] ?? '')
  expect(env.filter((name) => /^(WF_|HERDR_)/.test(name))).toEqual([])
  expect(env).toContain('HOME')

  expect(await board()).toMatchObject([{ issue: 144, state: 'ready', stage: 'ci', note: 'PR #1 is green: it merges, its checks pass and no review asks for changes', needs: true, action: 'Merge' }])
})

test('a yolo session runs with the mode yolo', async () => {
  play(m, 'blocked Which way?')
  const r = await claim('yolo')
  await ended(r.id)
  const { args } = started()
  expect((JSON.parse(args[args.indexOf('--settings') + 1] ?? '{}') as { env: { [k: string]: string } }).env.WF_MODE).toBe('yolo')
})

test('every session of a work process is started with the skill allowlist of a work session and no other skill', async () => {
  play(m, 'commit board.txt\ncomplete Implemented the board')
  const r = await claim()
  await ended(r.id)
  // The implement session, the reviewer and the author of the pull request each send it in their
  // initialize request.
  const lists = started()
    .read.filter((l) => l.includes('"subtype":"initialize"'))
    .map((l) => (JSON.parse(l) as { request: { skills?: string[] } }).request.skills)
  expect(lists.length).toBeGreaterThanOrEqual(3)
  for (const list of lists) expect(list).toEqual(['simplify', 'worker:docs', 'repo-standards:adr', 'repo-standards:docs-check'])
})

test('a work session leaves simplify out of its allowlist when a personal skill of that name shadows the bundled one', async () => {
  mkdirSync(join(m.root, '.claude', 'skills', 'simplify'), { recursive: true })
  writeFileSync(join(m.root, '.claude', 'skills', 'simplify', 'SKILL.md'), '---\nname: simplify\ndescription: mine\n---\nmine\n')
  play(m, 'commit board.txt\ncomplete Implemented the board')
  const r = await claim()
  await ended(r.id)
  const lists = started()
    .read.filter((l) => l.includes('"subtype":"initialize"'))
    .map((l) => (JSON.parse(l) as { request: { skills?: string[] } }).request.skills)
  expect(lists.length).toBeGreaterThanOrEqual(1)
  for (const list of lists) expect(list).toEqual(['worker:docs', 'repo-standards:adr', 'repo-standards:docs-check'])
})

test('the brief names the issue, the branch, the base and the read of the issue, and carries no text of it', async () => {
  play(m, 'complete done')
  const r = await claim()
  await ended(r.id)
  const prompt = started().read.find((l) => l.includes('"type":"user"')) ?? ''
  expect(prompt).toContain('#144')
  expect(prompt).toContain(r.branch)
  expect(prompt).toContain('origin/main')
  expect(prompt).toContain('gh issue view 144 --repo owner/repo')
  expect(read(m.claudeLog)).not.toMatch(/SECRET-|Board lists every project/)
})

test('an adopted branch with a shell character in its name ends the process failed before any session starts', async () => {
  play(m, 'complete done')
  const branch = 'fix/144-board$(touch${IFS}pwned)'
  canPages(m, 'repos/owner/repo/branches?per_page=100', [[{ name: 'main' }, { name: branch }]])
  const git = (...args: string[]) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: 'pipe' }).trim()
  git('update-ref', `refs/remotes/origin/${branch}`, git('rev-parse', 'HEAD'))
  const c = await api(m, 'POST', '/api/processes', { project: dir, issue: 144, mode: 'yolo', force: true })
  expect(c.status, JSON.stringify(c.body)).toBe(201)
  const r = (c.body as { record: Record }).record
  expect(r.branch).toBe(branch)
  const done = await ended(r.id)
  expect(done.state).toBe('failed')
  expect(done.note).toMatch(/has characters the brief does not carry/)
  expect(existsSync(m.claudeLog)).toBe(false)
  expect(events(r.id).filter((e) => e.event === 'stream')).toEqual([])
})

test('a blocked report ends the process blocked with the question on the board', async () => {
  play(m, 'blocked Keep the old flag, or drop it?')
  const r = await claim()
  expect(await ended(r.id)).toMatchObject({ state: 'blocked', note: 'Keep the old flag, or drop it?' })
  expect(await board()).toMatchObject([{ issue: 144, state: 'blocked', note: 'Keep the old flag, or drop it?', needs: true, action: 'Answer' }])
  const b = cli(m, ['board', dir])
  expect(b.stdout).toMatch(/needs you {2}work {2}#144 .* implement {2}blocked .*Keep the old flag, or drop it\?/)
})

test('a session that exits without a result ends the process failed with the reason', async () => {
  play(m, 'silent')
  const r = await claim()
  const done = await ended(r.id)
  expect(done.state).toBe('failed')
  expect(done.note).toMatch(/exited without a result/)
  expect(await board()).toMatchObject([{ issue: 144, state: 'failed', needs: true, action: 'Open' }])
})

test('a runtime that cannot start ends the process failed with the reason', async () => {
  play(m, 'broken claude: not logged in; run claude /login')
  const r = await claim()
  const done = await ended(r.id)
  expect(done.state).toBe('failed')
  expect(done.note).toMatch(/claude: not logged in; run claude \/login/)
  expect(events(r.id).at(-1)).toMatchObject({ event: 'session-end', state: 'failed' })
})

test('an abandon stops the running session and waits for its runtime to exit before it removes the worktree', async () => {
  // Without a play the session runs until it is stopped.
  const r = await claim()
  for (let i = 0; i < 100 && !recordOf(r.id).session_id; i++) await new Promise((done) => setTimeout(done, 50))
  const sessionId = recordOf(r.id).session_id ?? ''
  expect(sessionId).toMatch(/^fake-session-\d+$/)
  // A clean worktree needs no force: the abandon stops the session and checks the worktree again.
  const a = await api(m, 'DELETE', '/api/processes', { project: dir, issue: 144 })
  expect(a.status, JSON.stringify(a.body)).toBe(200)
  expect(existsSync(join(m.state, 'processes', `${r.id}.json`))).toBe(false)
  expect(existsSync(join(m.state, 'processes', `${r.id}.events.jsonl`))).toBe(false)
  expect(readFileSync(m.claudeLog, 'utf8')).toContain('"type":"user"')
  // The scripted claude names its session by its pid; the abandon has ended that process.
  const pid = Number(sessionId.replace('fake-session-', ''))
  const alive = () => {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }
  // The abandon answered only once the session's runtime had exited.
  expect(alive()).toBe(false)
})
