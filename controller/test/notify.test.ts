import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { api, canApi, canIssue, canPages, canPulls, checkout, cleanup, type Machine, machine, play, read, script, start } from './controller.js'

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
  ['blocked', 'blocked Keep the project in the file, or drop it?', 'Keep the project in the file, or drop it?'],
  ['ready', 'ready Pull request #7 is green', 'Pull request #7 is green'],
  ['failed', 'silent', 'the implement session exited without a result'],
])('a process that turns %s sends one notification and carries a badge until its page is opened', async (state, session, note) => {
  play(m, session)
  const claimed = await api(m, 'POST', '/api/processes', { project: dir, issue: 144 })
  expect(claimed.status, JSON.stringify(claimed.body)).toBe(201)
  const r = await settled(1)
  expect(r).toMatchObject({ state, unseen: true })
  expect(notifications()).toEqual([`repo #144 ${state} | ${note}`])

  expect(await api(m, 'POST', '/api/processes/seen', { id: r.id })).toEqual({ status: 200, body: { id: r.id } })
  expect(await row()).toMatchObject({ state, unseen: false })
  // Opening the page again sends nothing more.
  await api(m, 'POST', '/api/processes/seen', { id: r.id })
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
  play(m, 'ready Done')
  expect((await api(m, 'POST', '/api/processes', { project: dir, issue: 144 })).status).toBe(201)
  for (let i = 0; i < 200 && (await row())?.state === 'running'; i++) await new Promise((done) => setTimeout(done, 50))
  expect(await row()).toMatchObject({ state: 'ready', unseen: true })
  for (let i = 0; i < 100 && !stderr.includes('no display'); i++) await new Promise((done) => setTimeout(done, 50))
  expect(stderr).toMatch(/^warning: the notification "repo #144 ready" was not sent: .*notifier: no display$/m)
})

test('seen refuses an id that is no process', async () => {
  expect(await api(m, 'POST', '/api/processes/seen', { id: 'work-1-deadbeef' })).toEqual({ status: 404, body: { error: 'work-1-deadbeef is not a process of this machine' } })
  expect((await api(m, 'POST', '/api/processes/seen', { id: '../config' })).status).toBe(400)
})
