import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import { connect } from 'node:net'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { api, canRepo, checkout, cleanup, cli, type Machine, machine, read, start } from './controller.js'

afterEach(cleanup)

let m: Machine
beforeEach(async () => {
  m = await machine()
  const s = await start(m)
  expect(s.running, s.stderr).toBe(true)
})

// snapshot is every file under dir with its content, to see that a write touched nothing else.
function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const name of readdirSync(dir, { recursive: true }) as string[]) {
    const path = join(dir, name)
    if (statSync(path).isFile()) out[name] = readFileSync(path, 'utf8')
  }
  return out
}

interface Case {
  name: string
  declared: string | null
  origin_head: string | null
  github_default: string | null
  base: string
}
const fixture = JSON.parse(read(fileURLToPath(new URL('../../contract/base-branch.json', import.meta.url)))) as { cases: Case[] }

test.each(fixture.cases.map((c, i) => [c.name, c, i] as const))('the base follows the contract fixture: %s', async (_, c, i) => {
  const repository = `owner/repo-${i}`
  const dir = checkout(m, `repo-${i}`, {
    origin: `https://github.com/${repository}.git`,
    ...(c.declared === null ? {} : { declared: c.declared }),
    ...(c.origin_head === null ? {} : { originHead: c.origin_head }),
  })
  if (c.github_default !== null) canRepo(m, repository, c.github_default)
  const added = await api(m, 'POST', '/api/projects', { path: dir })
  expect(added).toEqual({ status: 201, body: { path: dir, owner: 'owner', name: `repo-${i}`, base: c.base } })
})

// The shared fixture states the same rule for both peers, with an empty field for a step that answers nothing.
interface SharedCase {
  case: string
  explicit: string
  origin_head: string
  github_default: string
  base: string
}
const shared = JSON.parse(read(fileURLToPath(new URL('../../contract/fixture.json', import.meta.url)))) as { base_branch: { cases: SharedCase[] } }

test.each(shared.base_branch.cases.map((c, i) => [c.case, c, i] as const))('the base follows the shared contract fixture: %s', async (_, c, i) => {
  const repository = `owner/shared-${i}`
  const dir = checkout(m, `shared-${i}`, {
    origin: `https://github.com/${repository}.git`,
    ...(c.explicit === '' ? {} : { declared: c.explicit }),
    ...(c.origin_head === '' ? {} : { originHead: c.origin_head }),
  })
  if (c.github_default !== '') canRepo(m, repository, c.github_default)
  const added = await api(m, 'POST', '/api/projects', { path: dir })
  expect(added).toEqual({ status: 201, body: { path: dir, owner: 'owner', name: `shared-${i}`, base: c.base } })
})

test('adding a project through the CLI and the API writes its path alone into the configuration and touches nothing else', async () => {
  const a = checkout(m, 'a', { origin: 'git@github.com:owner/a.git', originHead: 'main' })
  const b = checkout(m, 'b', { origin: 'https://github.com/owner/b', originHead: 'trunk' })
  mkdirSync(join(b, 'sub'))
  const state = snapshot(m.state)
  const sources = snapshot(join(m.root, 'src'))

  const r = cli(m, ['projects', 'add', 'a'], join(m.root, 'src'))
  expect(r.stderr).toBe('')
  expect(r.stdout).toBe(`added ${a}  owner/a  base main\n`)
  expect(await api(m, 'POST', '/api/projects', { path: join(b, 'sub') })).toEqual({
    status: 201,
    body: { path: b, owner: 'owner', name: 'b', base: 'trunk' },
  })

  expect(JSON.parse(read(m.config))).toEqual({ listen: m.listen, quota_axi: '', quota_minimum: 12, notifications: true, notifier: '', terminal: '', projects: [a, b] })
  expect(snapshot(m.state)).toEqual(state)
  expect(snapshot(join(m.root, 'src'))).toEqual(sources)
  expect(readdirSync(join(m.root, 'config', 'ameise'))).toEqual(['config.json'])
  expect(cli(m, ['projects']).stdout).toBe(`${a}  owner/a  base main\n${b}  owner/b  base trunk\n`)
})

test('owner, name and base are derived on read, so a changed checkout shows at once', async () => {
  const a = checkout(m, 'a', { origin: 'https://github.com/owner/a.git', originHead: 'main' })
  await api(m, 'POST', '/api/projects', { path: a })
  execFileSync('git', ['-C', a, 'remote', 'set-url', 'origin', 'https://github.com/other/renamed.git'])
  execFileSync('git', ['-C', a, 'update-ref', 'refs/remotes/origin/dev', 'HEAD'])
  execFileSync('git', ['-C', a, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/dev'])
  expect((await api(m, 'GET', '/api/projects')).body).toEqual([{ path: a, owner: 'other', name: 'renamed', base: 'dev' }])
})

test('a path that is no git checkout is refused by the CLI and the API with the reason', async () => {
  const plain = join(m.root, 'plain')
  mkdirSync(plain)
  const before = read(m.config)
  const reason = `${plain} is not a git checkout; name the directory of a clone of a GitHub repository`
  expect(cli(m, ['projects', 'add', plain])).toEqual({ code: 1, stdout: '', stderr: `error: ${reason}\n` })
  expect(await api(m, 'POST', '/api/projects', { path: plain })).toEqual({ status: 400, body: { error: reason } })
  expect(read(m.config)).toBe(before)
})

test('a checkout whose origin is not on GitHub, or that has none, is refused by the CLI and the API with the reason', async () => {
  const gitlab = checkout(m, 'gitlab', { origin: 'https://gitlab.com/owner/repo.git' })
  const none = checkout(m, 'none')
  const before = read(m.config)
  const offGitHub = `the origin of ${gitlab} is https://gitlab.com/owner/repo.git, which is not on GitHub; a project is a clone of a GitHub repository`
  expect(cli(m, ['projects', 'add', gitlab]).stderr).toBe(`error: ${offGitHub}\n`)
  expect(await api(m, 'POST', '/api/projects', { path: gitlab })).toEqual({ status: 400, body: { error: offGitHub } })
  const noOrigin = `${none} has no origin; add the GitHub repository as origin with git remote add origin <url>`
  expect(cli(m, ['projects', 'add', none]).stderr).toBe(`error: ${noOrigin}\n`)
  expect(await api(m, 'POST', '/api/projects', { path: none })).toEqual({ status: 400, body: { error: noOrigin } })
  const token = checkout(m, 'token', { origin: 'https://user:secret-token@gitlab.com/owner/repo.git' })
  const refused = await api(m, 'POST', '/api/projects', { path: token })
  expect(refused).toEqual({
    status: 400,
    body: { error: `the origin of ${token} is https://gitlab.com/owner/repo.git, which is not on GitHub; a project is a clone of a GitHub repository` },
  })
  const query = checkout(m, 'query', { origin: 'https://gitlab.com/owner/repo.git?access_token=secret#frag' })
  const cleaned = `the origin of ${query} is https://gitlab.com/owner/repo.git, which is not on GitHub; a project is a clone of a GitHub repository`
  expect(cli(m, ['projects', 'add', query]).stderr).toBe(`error: ${cleaned}\n`)
  expect(await api(m, 'POST', '/api/projects', { path: query })).toEqual({ status: 400, body: { error: cleaned } })
  const malformed = checkout(m, 'malformed', { origin: 'https://alice:secret@bad host/owner/repo.git' })
  const hidden = `the origin of ${malformed} is https://bad host/owner/repo.git, which is not on GitHub; a project is a clone of a GitHub repository`
  expect(cli(m, ['projects', 'add', malformed]).stderr).toBe(`error: ${hidden}\n`)
  expect(await api(m, 'POST', '/api/projects', { path: malformed })).toEqual({ status: 400, body: { error: hidden } })
  const slashed = checkout(m, 'slashed', { origin: 'https://al/ice:secret@bad host/owner/repo.git' })
  const slashedHidden = `the origin of ${slashed} is https://bad host/owner/repo.git, which is not on GitHub; a project is a clone of a GitHub repository`
  expect(cli(m, ['projects', 'add', slashed]).stderr).toBe(`error: ${slashedHidden}\n`)
  expect(await api(m, 'POST', '/api/projects', { path: slashed })).toEqual({ status: 400, body: { error: slashedHidden } })
  expect(read(m.config)).toBe(before)
})

test('adding and removing a project keeps a change made to the configuration by hand while the server runs', async () => {
  const a = checkout(m, 'a', { origin: 'https://github.com/owner/a.git', originHead: 'main' })
  const b = checkout(m, 'b', { origin: 'https://github.com/owner/b.git', originHead: 'main' })
  writeFileSync(m.config, JSON.stringify({ listen: m.listen, quota_minimum: 30, notifications: false }, null, 2) + '\n')
  expect((await api(m, 'POST', '/api/projects', { path: a })).status).toBe(201)
  expect(JSON.parse(read(m.config))).toEqual({ listen: m.listen, quota_axi: '', quota_minimum: 30, notifications: false, notifier: '', terminal: '', projects: [a] })
  const edited = JSON.parse(read(m.config)) as Record<string, unknown>
  writeFileSync(m.config, JSON.stringify({ ...edited, quota_minimum: 40, projects: [a, b] }, null, 2) + '\n')
  expect((await api(m, 'DELETE', '/api/projects', { path: a })).status).toBe(200)
  expect(JSON.parse(read(m.config))).toEqual({ listen: m.listen, quota_axi: '', quota_minimum: 40, notifications: false, notifier: '', terminal: '', projects: [b] })
})

test('adding and removing a project keeps a private configuration private', async () => {
  const a = checkout(m, 'a', { origin: 'https://github.com/owner/a.git', originHead: 'main' })
  chmodSync(m.config, 0o600)
  expect((await api(m, 'POST', '/api/projects', { path: a })).status).toBe(201)
  expect(statSync(m.config).mode & 0o777).toBe(0o600)
  expect((await api(m, 'DELETE', '/api/projects', { path: a })).status).toBe(200)
  expect(statSync(m.config).mode & 0o777).toBe(0o600)
})

test('adding a project that is known already is refused with 409 and changes nothing', async () => {
  const a = checkout(m, 'a', { origin: 'https://github.com/owner/a.git', originHead: 'main' })
  expect((await api(m, 'POST', '/api/projects', { path: a })).status).toBe(201)
  const before = read(m.config)
  expect(await api(m, 'POST', '/api/projects', { path: a })).toEqual({ status: 409, body: { error: `${a} is already a project` } })
  expect(read(m.config)).toBe(before)
})

test('removing by a path that is not absolute is refused with 400 and changes nothing', async () => {
  const a = checkout(m, 'a', { origin: 'https://github.com/owner/a.git', originHead: 'main' })
  await api(m, 'POST', '/api/projects', { path: a })
  const before = read(m.config)
  const reason = 'path is not an absolute path; name the checkout as an absolute path'
  expect(await api(m, 'DELETE', '/api/projects', { path: 'a' })).toEqual({ status: 400, body: { error: reason } })
  expect(await api(m, 'DELETE', '/api/projects', {})).toEqual({ status: 400, body: { error: reason } })
  expect(read(m.config)).toBe(before)
})

test('a listen changed by hand while the server runs does not lock the running server out of its own API', async () => {
  const a = checkout(m, 'a', { origin: 'https://github.com/owner/a.git', originHead: 'main' })
  const b = checkout(m, 'b', { origin: 'https://github.com/owner/b.git', originHead: 'main' })
  const edited = JSON.parse(read(m.config)) as Record<string, unknown>
  writeFileSync(m.config, JSON.stringify({ ...edited, listen: '127.0.0.1:1' }, null, 2) + '\n')
  expect((await api(m, 'POST', '/api/projects', { path: a })).status).toBe(201)
  expect((await api(m, 'POST', '/api/projects', { path: b })).status).toBe(201)
  expect((await api(m, 'GET', '/api/projects')).status).toBe(200)
  expect(cli(m, ['projects'])).toEqual({ code: 0, stdout: `${a}  owner/a  base main\n${b}  owner/b  base main\n`, stderr: '' })
})

test('a project added to the configuration by hand while the server runs is listed at once', async () => {
  const a = checkout(m, 'a', { origin: 'https://github.com/owner/a.git', originHead: 'main' })
  const edited = JSON.parse(read(m.config)) as Record<string, unknown>
  writeFileSync(m.config, JSON.stringify({ ...edited, projects: [a] }, null, 2) + '\n')
  expect(await api(m, 'GET', '/api/projects')).toEqual({ status: 200, body: [{ path: a, owner: 'owner', name: 'a', base: 'main' }] })
})

test('a body larger than a path needs is refused with 413 and changes nothing', async () => {
  const before = read(m.config)
  const res = await fetch(m.url + '/api/projects', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: '/' + 'x'.repeat(100 * 1024) }),
  })
  expect(res.status).toBe(413)
  expect(read(m.config)).toBe(before)
})

test('removing a project through the CLI and the API rewrites the configuration and touches nothing else', async () => {
  const a = checkout(m, 'a', { origin: 'https://github.com/owner/a.git', originHead: 'main' })
  const b = checkout(m, 'b', { origin: 'https://github.com/owner/b.git', originHead: 'main' })
  await api(m, 'POST', '/api/projects', { path: a })
  await api(m, 'POST', '/api/projects', { path: b })
  const state = snapshot(m.state)
  const sources = snapshot(join(m.root, 'src'))

  expect(cli(m, ['projects', 'remove', a])).toEqual({ code: 0, stdout: `removed ${a}\n`, stderr: '' })
  expect(JSON.parse(read(m.config)).projects).toEqual([b])
  expect(await api(m, 'DELETE', '/api/projects', { path: b })).toEqual({ status: 200, body: { path: b } })
  expect(JSON.parse(read(m.config)).projects).toEqual([])
  expect(cli(m, ['projects', 'remove', b]).stderr).toBe(`error: ${b} is not a project; ameise projects lists them\n`)

  expect(snapshot(m.state)).toEqual(state)
  expect(snapshot(join(m.root, 'src'))).toEqual(sources)
})

test('a write the page of another site could send is turned away', async () => {
  const a = checkout(m, 'a', { origin: 'https://github.com/owner/a.git', originHead: 'main' })
  const before = read(m.config)
  const plain = await fetch(m.url + '/api/projects', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: JSON.stringify({ path: a }) })
  expect(plain.status).toBe(415)
  // fetch sets Host itself, so the rebound name goes through node's own client.
  const rebound = await new Promise<number>((resolve, reject) => {
    const req = request(m.url + '/api/projects', { method: 'POST', headers: { 'content-type': 'application/json', host: 'evil.example' } }, (res) => {
      res.resume()
      resolve(res.statusCode ?? 0)
    })
    req.on('error', reject)
    req.end(JSON.stringify({ path: a }))
  })
  expect(rebound).toBe(403)
  expect(read(m.config)).toBe(before)
})

test('a request target URL cannot read is answered with 400 and the server keeps running', async () => {
  const { hostname, port } = new URL(m.url)
  const answer = await new Promise<string>((resolve, reject) => {
    const socket = connect(Number(port), hostname, () => socket.end(`GET //[ HTTP/1.1\r\nHost: ${m.url.slice('http://'.length)}\r\nConnection: close\r\n\r\n`))
    let data = ''
    socket.setEncoding('utf8')
    socket.on('data', (chunk: string) => (data += chunk))
    socket.on('end', () => resolve(data))
    socket.on('error', reject)
  })
  expect(answer.split('\r\n')[0]).toBe('HTTP/1.1 400 Bad Request')
  expect((await api(m, 'GET', '/api/projects')).status).toBe(200)
})
