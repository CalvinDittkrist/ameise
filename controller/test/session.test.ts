import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { api, canApi, canIssue, canPages, canPulls, checkout, cleanup, cli, type Machine, machine, play, read, start } from './controller.js'

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
}

const claim = async (): Promise<Record> => {
  const r = await api(m, 'POST', '/api/processes', { project: dir, issue: 144, mode: 'yolo', env: ['WF_REVIEWERS=2'] })
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
    if (r.state !== 'running') return r
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

test('a claim starts a session in the worktree with the worker plugin and the session settings, and a ready report ends the process ready', async () => {
  play(m, 'ready Pull request #7 is green and waits for your merge')
  const r = await claim()
  expect(r).toMatchObject({ state: 'running', stage: 'implement' })
  const done = await ended(r.id)
  expect(done).toMatchObject({ state: 'ready', stage: 'implement', note: 'Pull request #7 is green and waits for your merge' })
  expect(done.session_id).toMatch(/^fake-session-/)

  // The stream is in the event log, the session's id with it.
  const log = events(r.id)
  expect(log.map((e) => e.event)).toEqual(['claimed', 'session-start', 'stream', 'stream', 'stream', 'session-end'])
  expect(log.filter((e) => e.event === 'stream').map((e) => e.message?.type)).toEqual(['system', 'assistant', 'result'])
  expect(log.at(-1)).toMatchObject({ state: 'ready', note: 'Pull request #7 is green and waits for your merge' })

  const { args } = started()
  const flag = (name: string) => args[args.indexOf(name) + 1]
  expect(flag('--plugin-dir')).toBe(resolve(fileURLToPath(new URL('../../plugins/worker', import.meta.url))))
  expect(flag('--permission-mode')).toBe('auto')
  expect(args).toContain('--setting-sources=user,project,local')
  const settings = JSON.parse(flag('--settings') ?? '{}') as { env: { [k: string]: string }; autoCompactWindow: number; statusLine?: unknown }
  expect(settings.env).toMatchObject({ WF_MODE: 'yolo', WF_ISSUE: '144', WF_BASE_BRANCH: 'main', WF_REVIEWERS: '2', CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: '80' })
  expect(settings.autoCompactWindow).toBe(312500)
  // No status line: the worker's checkpoint answers unavailable and no handoff is attempted.
  expect(settings.statusLine).toBeUndefined()

  expect(await board()).toMatchObject([{ issue: 144, state: 'ready', stage: 'implement', note: 'Pull request #7 is green and waits for your merge', needs: true, action: 'Merge' }])
})

test('the brief names the issue, the branch, the base and the read of the issue, and carries no text of it', async () => {
  play(m, 'ready done')
  const r = await claim()
  await ended(r.id)
  const prompt = started().read.find((l) => l.includes('"type":"user"')) ?? ''
  expect(prompt).toContain('#144')
  expect(prompt).toContain(r.branch)
  expect(prompt).toContain('origin/main')
  expect(prompt).toContain('gh issue view 144 --repo owner/repo')
  expect(read(m.claudeLog)).not.toMatch(/SECRET-|Board lists every project/)
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

test('an abandon stops the running session, which writes nothing after it', async () => {
  // Without a play the session runs until it is stopped.
  const r = await claim()
  for (let i = 0; i < 100 && !recordOf(r.id).session_id; i++) await new Promise((done) => setTimeout(done, 50))
  const sessionId = recordOf(r.id).session_id ?? ''
  expect(sessionId).toMatch(/^fake-session-\d+$/)
  const a = await api(m, 'DELETE', '/api/processes', { project: dir, issue: 144, force: true })
  expect(a.status, JSON.stringify(a.body)).toBe(200)
  await new Promise((done) => setTimeout(done, 300))
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
  for (let i = 0; i < 100 && alive(); i++) await new Promise((done) => setTimeout(done, 50))
  expect(alive()).toBe(false)
})
