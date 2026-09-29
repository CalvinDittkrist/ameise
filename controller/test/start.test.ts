import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { api, cleanup, cli, freePort, machine, read, script, start } from './controller.js'

afterEach(cleanup)

test('ameise starts the server on the configured address, opens the browser there and answers the project list', async () => {
  const m = await machine()
  const s = await start(m)
  expect(s.running, s.stderr).toBe(true)
  expect(await api(m, 'GET', '/api/projects')).toEqual({ status: 200, body: [] })
  // The browser opens after the server listens, which a machine busy with other tests delays past the
  // second expect.poll waits by default.
  await expect.poll(() => existsSync(m.opened) && read(m.opened), { timeout: 10000 }).toBe(`${m.url}\n`)
  expect(readdirSync(m.state)).toContain('events.jsonl')
})

test.each(['SIGTERM', 'SIGINT'] as const)('%s stops the server and exits 0', async (signal) => {
  const m = await machine()
  const s = await start(m)
  expect(s.running, s.stderr).toBe(true)
  const exited = new Promise<number | null>((resolve) => s.process.on('exit', (code) => resolve(code)))
  s.process.kill(signal)
  expect(await exited).toBe(0)
})

test('a missing gh login stops the start with one line that says to log in', async () => {
  const m = await machine()
  writeFileSync(join(m.github, 'logged-out'), '')
  const s = await start(m)
  expect(s.running).toBe(false)
  expect(s.code).not.toBe(0)
  expect(s.stderr).toBe('error: gh is not logged in; run gh auth login\n')
})

test('a missing claude stops the start with one line that says how to install it', async () => {
  const m = await machine()
  rmSync(join(m.bin, 'claude'))
  // Out of fake mode the controller asks the gh on its PATH, which is logged in here.
  script(join(m.bin, 'gh'), 'exit 0')
  const s = await start(m, [])
  expect(s.running).toBe(false)
  expect(s.code).not.toBe(0)
  expect(s.stderr).toBe('error: claude is not installed; npm install -g @anthropic-ai/claude-code\n')
})

test('fake mode starts without a claude on the machine, on the scripted claude it ships', async () => {
  const m = await machine()
  rmSync(join(m.bin, 'claude'))
  const s = await start(m)
  expect(s.running, s.stderr).toBe(true)
})

test.each([
  ['not JSON', '{"listen": ', /is not JSON .*; correct it or remove it/],
  ['an unknown field', '{"repositories": []}', /unknown field "repositories"; the fields are listen, /],
  ['a listen address off this machine', '{"listen": "0.0.0.0:7420"}', /listen "0\.0\.0\.0:7420" is not a loopback address; write it as "127\.0\.0\.1:<port>"/],
  ['a listen address that is no IPv4 address', '{"listen": "127.999.999.999:7420"}', /listen "127\.999\.999\.999:7420" is not a loopback address; write it as "127\.0\.0\.1:<port>"/],
  ['a quota minimum that is no percentage', '{"quota_minimum": 120}', /quota_minimum 120 is not a percentage; write it as a whole number/],
  ['a notifier that is no command name', '{"notifier": false}', /notifier is not a string; name the command a notification is sent through/],
  ['a project named twice', '{"projects": ["/src/repo", "/src/repo"]}', /projects names \/src\/repo twice; keep one of them/],
  ['a relative project path', '{"projects": ["src/repo"]}', /projects is not a list of absolute paths; write each project as the path of its checkout/],
])('a configuration with %s stops the start with one line that names the fix', async (_, content, fault) => {
  const m = await machine()
  writeFileSync(m.config, content)
  const s = await start(m)
  expect(s.running).toBe(false)
  expect(s.code).not.toBe(0)
  expect(s.stderr.split('\n')).toHaveLength(2)
  expect(s.stderr).toMatch(new RegExp(`^error: ${m.config}: |^error: ${m.config} `))
  expect(s.stderr).toMatch(fault)
})

test('the CLI against a stopped server says to start ameise and fails', async () => {
  const m = await machine()
  for (const args of [['projects'], ['projects', 'add', m.root], ['projects', 'remove', m.root]]) {
    const r = cli(m, args)
    expect(r.code).toBe(1)
    expect(r.stderr).toBe(`error: ameise is not running on ${m.url}; start it with ameise\n`)
  }
})

test('the CLI does not take another service on a stale recorded address for ameise', async () => {
  const m = await machine()
  const port = await freePort()
  let requests = 0
  const other = createServer((_req, res) => {
    requests++
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end('[]')
  })
  await new Promise<void>((resolve) => other.listen(port, '127.0.0.1', resolve))
  try {
    const record = join(m.state, 'listen')
    mkdirSync(m.state, { recursive: true })
    writeFileSync(record, `127.0.0.1:${port}\n`)
    // The CLI runs beside the test, not in its place, so the service in this process can answer it.
    const r = await new Promise<{ code: number | null; stderr: string }>((resolve) =>
      execFile(process.execPath, [m.binary, 'projects', 'add', m.root], { env: m.env }, (err, _stdout, stderr) =>
        resolve({ code: err ? (typeof err.code === 'number' ? err.code : null) : 0, stderr }),
      ),
    )
    expect(r.code).toBe(1)
    expect(r.stderr).toBe(`error: ameise is not running on ${m.url}; start it with ameise\n`)
    expect(existsSync(record)).toBe(false)
    expect(requests).toBe(1)
  } finally {
    await new Promise((resolve) => other.close(resolve))
  }
})

test('directories under the old name are neither read, moved nor changed', async () => {
  const m = await machine()
  const oldConfig = join(m.root, 'config', 'workflows')
  const oldState = join(m.root, 'data', 'workflows')
  mkdirSync(oldConfig, { recursive: true })
  mkdirSync(oldState, { recursive: true })
  writeFileSync(join(oldConfig, 'config.json'), JSON.stringify({ listen: '127.0.0.1:1', projects: ['/src/old'] }) + '\n')
  writeFileSync(join(oldState, 'events.jsonl'), '{"old": true}\n')
  writeFileSync(join(oldState, 'listen'), '127.0.0.1:1\n')
  const s = await start(m)
  expect(s.running, s.stderr).toBe(true)
  expect(await api(m, 'GET', '/api/projects')).toEqual({ status: 200, body: [] })
  expect(cli(m, ['projects']).stderr).toBe('')
  expect(readdirSync(m.state)).toContain('events.jsonl')
  expect(read(join(m.state, 'events.jsonl'))).not.toContain('"old"')
  expect(readdirSync(oldConfig)).toEqual(['config.json'])
  expect(read(join(oldConfig, 'config.json'))).toBe(JSON.stringify({ listen: '127.0.0.1:1', projects: ['/src/old'] }) + '\n')
  expect(readdirSync(oldState).sort()).toEqual(['events.jsonl', 'listen'])
  expect(read(join(oldState, 'events.jsonl'))).toBe('{"old": true}\n')
  expect(read(join(oldState, 'listen'))).toBe('127.0.0.1:1\n')
})
