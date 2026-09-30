import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { api, canApi, canIssue, canPages, canPulls, checkout, cleanup, gated, type Machine, machine, play, read, script, start } from './controller.js'

afterEach(cleanup)

let m: Machine
let dir: string
let sent: string
let stderr: string
beforeEach(async () => {
  m = await machine()
  // The scripted notifier writes down each notification it is given, one line of title and body.
  sent = join(m.root, 'notified')
  script(join(m.root, 'notifier'), `printf '%s | %s\\n' "$1" "$2" >> '${sent}'`)
  writeFileSync(m.config, JSON.stringify({ listen: m.listen, notifier: join(m.root, 'notifier') }, null, 2) + '\n')
  const s = await start(m)
  expect(s.running, s.stderr).toBe(true)
  stderr = ''
  s.process.stderr?.on('data', (d: Buffer) => (stderr += d))
  dir = checkout(m, 'repo', { origin: 'https://github.com/owner/repo.git', originHead: 'main' })
  gated(dir)
  canPulls(m, 'owner/repo', [])
  canApi(m, 'repos/owner/repo/issues?labels=ready-for-agent&state=open&per_page=100', [])
  canApi(m, 'repos/owner/repo/issues?labels=spec&state=open&per_page=100', [])
  canPages(m, 'repos/owner/repo/branches?per_page=100', [[]])
  expect((await api(m, 'POST', '/api/projects', { path: dir })).status).toBe(201)
  canIssue(m, 'owner/repo', 144, 'Board lists every project', ['ready-for-agent'])
})

interface Row {
  id: string | null
  issue: number
  state: string
  unseen: boolean
}

const row = async () =>
  ((await api(m, 'GET', '/api/board?' + new URLSearchParams({ project: dir }).toString())).body as { processes: Row[] }).processes.find((p) => p.issue === 144)

const notifications = () => {
  try {
    return read(sent).trimEnd().split('\n')
  } catch {
    return []
  }
}

// settled waits until the process has left running and its notification, if any, has been sent.
async function settled(want: number): Promise<Row> {
  for (let i = 0; i < 200; i++) {
    const r = await row()
    if (r && r.state !== 'running' && notifications().length >= want) return r
    await new Promise((done) => setTimeout(done, 50))
  }
  throw new Error(`the process did not settle: ${JSON.stringify(await row())}, notified ${JSON.stringify(notifications())}`)
}

test.each([
  ['blocked', 'blocked Keep the project in the file, or drop it?', 'Keep the project in the file, or drop it\\?'],
  ['ready', 'complete Implemented the board', 'the review passed in round 1'],
  ['failed', 'silent', 'the implement session exited without a result'],
])('a process that turns %s sends one notification and carries a badge until its page is opened', async (state, session, note) => {
  play(m, session)
  const claimed = await api(m, 'POST', '/api/processes', { project: dir, issue: 144 })
  expect(claimed.status, JSON.stringify(claimed.body)).toBe(201)
  const r = await settled(1)
  expect(r).toMatchObject({ state, unseen: true })
  expect(notifications()).toEqual([expect.stringMatching(new RegExp(`^repo #144 ${state} \\| ${note}$`))])

  expect(await api(m, 'POST', '/api/processes/seen', { id: r.id })).toEqual({ status: 200, body: { id: r.id } })
  expect(await row()).toMatchObject({ state, unseen: false })
  // Opening the page again sends nothing more.
  await api(m, 'POST', '/api/processes/seen', { id: r.id })
  await new Promise((done) => setTimeout(done, 200))
  expect(notifications()).toHaveLength(1)
})

test('a session stopped by an abandon that is then refused ends failed and sends one notification', async () => {
  // The session runs until it is stopped and leaves a change behind as it stops, so the abandon refuses.
  play(m, 'litter unfinished.txt')
  const claimed = await api(m, 'POST', '/api/processes', { project: dir, issue: 144 })
  expect(claimed.status, JSON.stringify(claimed.body)).toBe(201)
  const file = join(m.state, 'processes', `${(claimed.body as { record: { id: string } }).record.id}.json`)
  for (let i = 0; i < 100 && !(JSON.parse(read(file)) as { session_id?: string }).session_id; i++) await new Promise((done) => setTimeout(done, 50))
  const refused = await api(m, 'DELETE', '/api/processes', { project: dir, issue: 144 })
  expect(refused.status, JSON.stringify(refused.body)).toBe(409)
  expect(refused.body).toMatchObject({ error: expect.stringMatching(/changes not committed/) })
  const r = await settled(1)
  expect(r).toMatchObject({ state: 'failed', unseen: true })
  expect(notifications()).toEqual([expect.stringMatching(/^repo #144 failed \| the implement session was stopped by an abandon that was refused: /)])
  await new Promise((done) => setTimeout(done, 200))
  expect(notifications()).toHaveLength(1)
})

test('with notifications off a process sends none and still carries its badge', async () => {
  writeFileSync(m.config, JSON.stringify({ ...JSON.parse(read(m.config)), notifications: false }, null, 2) + '\n')
  play(m, 'blocked Which base?')
  expect((await api(m, 'POST', '/api/processes', { project: dir, issue: 144 })).status).toBe(201)
  for (let i = 0; i < 200 && (await row())?.state === 'running'; i++) await new Promise((done) => setTimeout(done, 50))
  expect(await row()).toMatchObject({ state: 'blocked', unseen: true })
  await new Promise((done) => setTimeout(done, 200))
  expect(notifications()).toEqual([])
  expect(read(join(m.state, 'events.jsonl'))).toContain('"event":"turned"')
})

test('a notifier that fails leaves the process as it ended and says so on stderr', async () => {
  script(join(m.root, 'notifier'), 'echo "no display" >&2; exit 1')
  play(m, 'complete Done')
  expect((await api(m, 'POST', '/api/processes', { project: dir, issue: 144 })).status).toBe(201)
  for (let i = 0; i < 200 && (await row())?.state === 'running'; i++) await new Promise((done) => setTimeout(done, 50))
  expect(await row()).toMatchObject({ state: 'ready', unseen: true })
  for (let i = 0; i < 100 && !stderr.includes('no display'); i++) await new Promise((done) => setTimeout(done, 50))
  expect(stderr).toMatch(/^warning: the notification "repo #144 ready" was not sent: .*notifier: no display$/m)
})

test('a notifier that cannot be started leaves the controller running and says so on stderr', async () => {
  // A NUL in the command name makes the spawn throw before any notifier runs.
  writeFileSync(m.config, JSON.stringify({ ...JSON.parse(read(m.config)), notifier: 'notifier\u0000x' }, null, 2) + '\n')
  play(m, 'complete Done')
  expect((await api(m, 'POST', '/api/processes', { project: dir, issue: 144 })).status).toBe(201)
  for (let i = 0; i < 100 && !stderr.includes('was not sent'); i++) await new Promise((done) => setTimeout(done, 50))
  expect(stderr).toMatch(/^warning: the notification "repo #144 ready" was not sent: /m)
  expect(await row()).toMatchObject({ state: 'ready', unseen: true })
})

test('a turn that cannot be logged still sends its notification', async () => {
  play(m, 'litter unfinished.txt')
  const claimed = await api(m, 'POST', '/api/processes', { project: dir, issue: 144 })
  expect(claimed.status, JSON.stringify(claimed.body)).toBe(201)
  const file = join(m.state, 'processes', `${(claimed.body as { record: { id: string } }).record.id}.json`)
  for (let i = 0; i < 100 && !(JSON.parse(read(file)) as { session_id?: string }).session_id; i++) await new Promise((done) => setTimeout(done, 50))
  // A directory in place of the event log makes every append to it fail.
  rmSync(join(m.state, 'events.jsonl'))
  mkdirSync(join(m.state, 'events.jsonl'))
  expect((await api(m, 'DELETE', '/api/processes', { project: dir, issue: 144 })).status).toBe(409)
  expect(await settled(1)).toMatchObject({ state: 'failed', unseen: true })
  expect(notifications()).toEqual([expect.stringMatching(/^repo #144 failed \| /)])
  expect(stderr).toMatch(/the turn to failed was not logged/)
})

test('with no notifier configured the platform notifier shows the note, even one that starts with a dash', async () => {
  // Scripted stand-ins for the platform notifiers write down each argument they are given, one a line.
  for (const tool of ['notify-send', 'osascript']) script(join(m.bin, tool), `for a in "$@"; do printf '%s\\n' "$a"; done >> '${sent}'`)
  writeFileSync(m.config, JSON.stringify({ ...JSON.parse(read(m.config)), notifier: '' }, null, 2) + '\n')
  play(m, 'blocked --urgency=critical')
  expect((await api(m, 'POST', '/api/processes', { project: dir, issue: 144 })).status).toBe(201)
  expect(await settled(1)).toMatchObject({ state: 'blocked', unseen: true })
  const script_ = ['-e', 'on run argv', '-e', 'display notification (item 2 of argv) with title (item 1 of argv)', '-e', 'end run']
  const args = process.platform === 'darwin' ? [...script_, 'repo #144 blocked', '--urgency=critical'] : ['--', 'repo #144 blocked', '--urgency=critical']
  for (let i = 0; i < 100 && notifications().length < args.length; i++) await new Promise((done) => setTimeout(done, 50))
  expect(notifications()).toEqual(args)
})

test('seen refuses an id that is no process', async () => {
  expect(await api(m, 'POST', '/api/processes/seen', { id: 'work-1-deadbeef' })).toEqual({ status: 404, body: { error: 'work-1-deadbeef is not a process of this machine' } })
  expect((await api(m, 'POST', '/api/processes/seen', { id: '../config' })).status).toBe(400)
})
