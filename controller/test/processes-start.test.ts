import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { api, canApi, canIssue, canPages, canPulls, checkout, cleanup, type Machine, machine, start } from './controller.js'

afterEach(cleanup)

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { encoding: 'utf8', stdio: 'pipe' }).trim()

interface World {
  m: Machine
  dir: string
}

// world starts a controller on a machine of its own with the project owner/repo, whose GitHub has the
// agent-ready issue #144 and the spec #100 with its closed ticket #101.
async function world(): Promise<World> {
  const m = await machine()
  m.env = { ...m.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' }
  const s = await start(m)
  expect(s.running, s.stderr).toBe(true)
  const dir = checkout(m, 'repo', { origin: 'https://github.com/owner/repo.git', originHead: 'main' })
  // The base carries a test, which a hunt needs to start.
  mkdirSync(join(dir, 'tests'), { recursive: true })
  writeFileSync(join(dir, 'tests', 'test_login.py'), 'def test_login():\n    assert True\n')
  git(dir, 'add', '-A')
  git(dir, 'commit', '-q', '-m', 'a test')
  git(dir, 'update-ref', 'refs/remotes/origin/main', 'HEAD')
  // origin in fake mode is the canned GitHub's repository, which a standardize pushes to.
  const bare = join(m.github, 'git', 'owner', 'repo.git')
  mkdirSync(bare, { recursive: true })
  git(bare, 'init', '-q', '--bare', '-b', 'main')
  git(dir, 'push', '-q', bare, 'HEAD:main')
  canPulls(m, 'owner/repo', [])
  canApi(m, 'repos/owner/repo', { full_name: 'owner/repo', default_branch: 'main', visibility: 'private', private: true, permissions: { admin: true }, owner: { login: 'owner', type: 'User' } })
  canApi(m, 'repos/owner/repo/issues?labels=ready-for-agent&state=open&per_page=100', [])
  canApi(m, 'repos/owner/repo/issues?labels=spec&state=open&per_page=100', [])
  canPages(m, 'repos/owner/repo/branches?per_page=100', [[]])
  canIssue(m, 'owner/repo', 144, 'Board lists every project', ['ready-for-agent'])
  canIssue(m, 'owner/repo', 100, 'Offline mode', ['spec'])
  canApi(m, 'repos/owner/repo/issues/100', { id: 5100, number: 100, title: 'Offline mode', state: 'open', body: '## User stories\n1. As a user, I work offline.', labels: [{ name: 'spec' }], milestone: { title: 'v1.0.0' } })
  canPages(m, 'repos/owner/repo/issues/100/sub_issues?per_page=100', [[{ id: 5101, number: 101, title: 'Cache the pages', state: 'closed' }]])
  canApi(m, 'repos/owner/repo/issues/101', { id: 5101, number: 101, state: 'closed', labels: [], milestone: null })
  canPages(m, 'repos/owner/repo/issues/101/timeline?per_page=100', [[]])
  canPages(m, 'repos/owner/repo/issues/100/comments?per_page=100', [[]])
  expect((await api(m, 'POST', '/api/projects', { path: dir })).status).toBe(201)
  return { m, dir }
}

// shape is what a start answers that does not depend on the machine: its status, its fields, the
// fields of its record with their kind, stage and branch, and its warnings and quota.
function shape(r: { status: number; body: unknown }) {
  const body = r.body as { record?: Record<string, unknown>; warnings?: unknown; quota?: unknown }
  const record = body.record ?? {}
  return {
    status: r.status,
    fields: Object.keys(body).sort(),
    record: { fields: Object.keys(record).sort(), kind: record.kind, stage: record.stage, branch: record.branch, route: record.route },
    warnings: body.warnings,
    quota: body.quota,
  }
}

const starts: { name: string; route: string; graph: string; body: Record<string, unknown>; fields: string[]; kind: string }[] = [
  { name: 'a claim', route: '/api/processes', graph: 'delivery', body: { issue: 144 }, fields: ['quota', 'record', 'warnings'], kind: 'work' },
  { name: 'a plan', route: '/api/plans', graph: 'plan', body: { idea: 'retry queue' }, fields: ['record'], kind: 'plan' },
  { name: 'an acceptance', route: '/api/acceptances', graph: 'plan', body: { spec: 100 }, fields: ['record'], kind: 'plan' },
  { name: 'a hunt', route: '/api/hunts', graph: 'hunt', body: {}, fields: ['record', 'warnings'], kind: 'hunt' },
  { name: 'a standardize', route: '/api/standardize', graph: 'standardize', body: {}, fields: ['record'], kind: 'standardize' },
]

test.each(starts)('$name starts through POST /api/processes/start with the answer of its own route', async ({ route, graph, body, fields, kind }) => {
  const [old, now] = await Promise.all([world(), world()])
  const before = await api(old.m, 'POST', route, { project: old.dir, ...body })
  const after = await api(now.m, 'POST', '/api/processes/start', { project: now.dir, graph, ...body })
  expect(after.status, JSON.stringify(after.body)).toBe(201)
  expect(shape(after)).toEqual(shape(before))
  expect(shape(after)).toMatchObject({ fields, record: { kind } })
})

test.each([
  ['an unknown graph', { graph: 'work' }, 'graph "work" is not a process graph'],
  ['a missing graph', {}, 'graph is missing'],
])('%s is refused with the graphs a process starts on, before the body or the project is read', async (_, extra, named) => {
  const { m } = await world()
  const r = await api(m, 'POST', '/api/processes/start', { project: 'not a path', ...extra })
  expect(r).toEqual({ status: 400, body: { error: `${named}; send one of delivery, hunt, standardize, plan` } })
})

test.each([
  ['delivery', '/api/processes', { issue: 'one' }, 'issue is not an issue number; send it as a whole number, such as 42'],
  ['plan', '/api/plans', { idea: 'a', issue: 1 }, 'a plan starts from an idea or from an issue, not both; send one of them, or neither for an open session'],
  ['plan', '/api/acceptances', { spec: 'one' }, 'spec is not an issue number; send it as a whole number, such as 42'],
])('a bad body for the %s graph gets the refusal of %s through both routes, before the project is read', async (graph, route, body, error) => {
  const { m } = await world()
  const refused = { status: 400, body: { error } }
  expect(await api(m, 'POST', route, { project: '/nowhere', ...body })).toEqual(refused)
  expect(await api(m, 'POST', '/api/processes/start', { project: '/nowhere', graph, ...body })).toEqual(refused)
})

test('a start of a known graph on an unknown project gets the 404 of its route', async () => {
  const { m } = await world()
  const old = await api(m, 'POST', '/api/hunts', { project: '/nowhere' })
  expect(old.status).toBe(404)
  expect(await api(m, 'POST', '/api/processes/start', { project: '/nowhere', graph: 'hunt' })).toEqual(old)
})
