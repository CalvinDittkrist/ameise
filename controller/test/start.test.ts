import { existsSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { api, cleanup, cli, machine, read, start } from './controller.js'

afterEach(cleanup)

test('workflows starts the server on the configured address, opens the browser there and answers the project list', async () => {
  const m = await machine()
  const s = await start(m)
  expect(s.running, s.stderr).toBe(true)
  expect(await api(m, 'GET', '/api/projects')).toEqual({ status: 200, body: [] })
  await expect.poll(() => existsSync(m.opened) && read(m.opened)).toBe(`${m.url}\n`)
  expect(readdirSync(m.state)).toContain('events.jsonl')
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
  const s = await start(m)
  expect(s.running).toBe(false)
  expect(s.code).not.toBe(0)
  expect(s.stderr).toBe('error: claude is not installed; npm install -g @anthropic-ai/claude-code\n')
})

test.each([
  ['not JSON', '{"listen": ', /is not JSON .*; correct it or remove it/],
  ['an unknown field', '{"repositories": []}', /unknown field "repositories"; the fields are listen, /],
  ['a listen address off this machine', '{"listen": "0.0.0.0:7420"}', /listen "0\.0\.0\.0:7420" is not a loopback address; write it as "127\.0\.0\.1:<port>"/],
  ['a quota minimum that is no percentage', '{"quota_minimum": 120}', /quota_minimum 120 is not a percentage; write it as a whole number/],
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

test('the CLI against a stopped server says to start workflows and fails', async () => {
  const m = await machine()
  for (const args of [['projects'], ['projects', 'add', m.root], ['projects', 'remove', m.root]]) {
    const r = cli(m, args)
    expect(r.code).toBe(1)
    expect(r.stderr).toBe(`error: workflows is not running on ${m.url}; start it with workflows\n`)
  }
})
