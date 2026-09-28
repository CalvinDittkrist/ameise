import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { api, canApi, canPages, canPulls, checkout, cleanup, cli, type Machine, machine, read, record, start, worktree } from './controller.js'

afterEach(cleanup)

let m: Machine
beforeEach(async () => {
  m = await machine()
  const s = await start(m)
  expect(s.running, s.stderr).toBe(true)
})

interface FixtureIssue {
  number: number
  title: string
  blocked_by?: number
  assignees?: string[]
  pull_request?: boolean
  parent?: number
}
interface Frontier {
  query: string
  routing_label: string
  issues: FixtureIssue[]
  parents: { number: number; title: string; labels: string[] }[]
  free: number[]
}
const fixture = (JSON.parse(read(fileURLToPath(new URL('../../contract/fixture.json', import.meta.url)))) as { frontier: Frontier }).frontier

const stamp = '2026-09-20T10:00:00Z'
const issue = (number: number, title: string, labels: string[], more: Record<string, unknown> = {}) => ({
  number,
  title,
  state: 'open',
  created_at: stamp,
  updated_at: stamp,
  assignees: [],
  labels: labels.map((name) => ({ name })),
  issue_dependencies_summary: { blocked_by: 0, blocking: 0 },
  ...more,
})

// project adds a checkout of owner/<name> as a project, with no pull requests, no agent-ready issue and
// no open spec unless the test cans them.
async function project(name: string): Promise<string> {
  const dir = checkout(m, name, { origin: `https://github.com/owner/${name}.git`, originHead: 'main' })
  canPulls(m, `owner/${name}`, [])
  canApi(m, `repos/owner/${name}/${fixture.query}`, [])
  canApi(m, `repos/owner/${name}/issues?labels=spec&state=open&per_page=100`, [])
  expect((await api(m, 'POST', '/api/projects', { path: dir })).status).toBe(201)
  return dir
}

// canFixture cans the fixture's issues as GitHub lists them, each with the labels given, and the
// fixture's parents where the fixture names one.
function canFixture(name: string, labels: string[]) {
  const parents = new Map(fixture.parents.map((p) => [p.number, p]))
  const issues = fixture.issues.map((i) => {
    const more: Record<string, unknown> = {}
    if (i.blocked_by) more.issue_dependencies_summary = { blocked_by: i.blocked_by }
    if (i.assignees) more.assignees = i.assignees.map((login) => ({ login }))
    if (i.pull_request) more.pull_request = { url: `https://api.github.com/repos/owner/${name}/pulls/${i.number}` }
    if (i.parent) {
      more.parent_issue_url = `https://api.github.com/repos/owner/${name}/issues/${i.parent}`
      const p = parents.get(i.parent)
      // a parent the fixture names nowhere cannot be read
      if (p) canApi(m, `repos/owner/${name}/issues/${i.number}/parent`, issue(p.number, p.title, p.labels))
    }
    return issue(i.number, i.title, labels, more)
  })
  canApi(m, `repos/owner/${name}/${fixture.query}`, issues)
}

interface Board {
  path: string
  processes: Record<string, unknown>[]
  frontier: { number: number; title: string; milestone: string | null }[]
  acceptance: { number: number; title: string; milestone: string | null }[]
  notes: string[]
}

async function boardOf(dir: string): Promise<Board> {
  const r = await api(m, 'GET', '/api/board?' + new URLSearchParams({ project: dir }).toString())
  expect(r.status).toBe(200)
  return r.body as Board
}

test('the frontier follows the contract fixture: the unrouted issues give its free set, the routed ones none', async () => {
  const unrouted = await project('unrouted')
  const routed = await project('routed')
  canFixture('unrouted', ['ready-for-agent'])
  canFixture('routed', ['ready-for-agent', fixture.routing_label])

  const free = await boardOf(unrouted)
  expect(free.frontier.map((i) => i.number), 'frontier: the controller offers another set than the contract fixture names').toEqual(fixture.free)
  expect(free.notes).toEqual([
    "could not read the parent of 1 ready-for-agent issue(s); they are left out, since a ticket of a spec run is the factory's",
  ])
  expect((await boardOf(routed)).frontier, 'frontier: the controller offers routed issues; they are the factory\'s').toEqual([])
  expect(read(m.ghLog).split('\n')).toContain(`api repos/owner/unrouted/${fixture.query}`)
})

test('a spec-run ticket with the human label, and an issue a process holds, are left out or offered as the rule says', async () => {
  const dir = await project('repo')
  worktree(dir, 'feat/7-taken-here')
  canApi(m, `repos/owner/repo/${fixture.query}`, [
    issue(5, 'Held in a spec run', ['ready-for-agent', 'factory:spec-run']),
    issue(6, 'In a spec run, for a person', ['ready-for-agent', 'factory:spec-run', 'ready-for-human']),
    issue(7, 'Taken here', ['ready-for-agent']),
    issue(8, 'Free', ['ready-for-agent'], { milestone: { title: 'v1.0.0' } }),
  ])
  expect((await boardOf(dir)).frontier).toEqual([
    { number: 6, title: 'In a spec run, for a person', milestone: null },
    { number: 8, title: 'Free', milestone: 'v1.0.0' },
  ])
})

test('the board joins the process records and the worktrees with their pull requests, and puts what waits for a person in needs you', async () => {
  const dir = await project('repo')
  const minutesAgo = (n: number) => new Date(Date.now() - n * 60000 - 20000).toISOString()
  const blocked = worktree(dir, 'feat/118-refuse-a-project')
  record(m, 'p118', {
    project: dir, kind: 'work', branch: 'feat/118-refuse-a-project', issue: 118, worktree: blocked,
    stage: 'implement', state: 'blocked', note: 'Asks: keep the project\nin the file?', updated_at: minutesAgo(41),
  })
  record(m, 'plan1', {
    project: dir, kind: 'plan', branch: 'plan/open-20260928-0011', stage: 'plan', state: 'input', note: 'Waiting for you', updated_at: minutesAgo(5),
  })
  record(m, 'other', { project: '/elsewhere', kind: 'work', branch: 'feat/1-other', state: 'blocked' })
  const green = worktree(dir, 'fix/131-log-the-sensor-drift')
  const pending = worktree(dir, 'feat/142-read-the-configuration')
  const bare = worktree(dir, 'hunt/tests-2026-09-27')
  worktree(dir, 'release/1.2')
  canPulls(m, 'owner/repo', [
    { number: 250, headRefName: 'fix/131-log-the-sensor-drift', isDraft: false, url: 'https://github.com/owner/repo/pull/250', statusCheckRollup: [{ conclusion: 'SUCCESS' }] },
    { number: 251, headRefName: 'feat/142-read-the-configuration', isDraft: false, url: 'https://github.com/owner/repo/pull/251', statusCheckRollup: [{ conclusion: 'SUCCESS' }, { status: 'IN_PROGRESS' }] },
  ])
  canApi(m, 'repos/owner/repo/issues?labels=spec&state=open&per_page=100', [
    issue(100, 'Offline mode', ['spec'], { milestone: { title: 'v2.0.0' } }),
    issue(101, 'Still open', ['spec']),
    issue(102, 'No tickets', ['spec']),
  ])
  canApi(m, 'repos/owner/repo/issues/100/sub_issues?per_page=100', [{ ...issue(1, 'a', []), state: 'closed' }, { ...issue(2, 'b', []), state: 'closed' }])
  canApi(m, 'repos/owner/repo/issues/101/sub_issues?per_page=100', [{ ...issue(3, 'c', []), state: 'closed' }, issue(4, 'd', [])])
  canApi(m, 'repos/owner/repo/issues/102/sub_issues?per_page=100', [])
  const state = snapshot(m.state)

  const b = await boardOf(dir)
  const rows = b.processes.map(({ since, ...p }) => ({ ...p, since: typeof since }))
  expect(rows).toEqual([
    {
      kind: 'work', state: 'blocked', stage: 'implement', issue: 118, branch: 'feat/118-refuse-a-project', worktree: blocked,
      pr: null, checks: null, since: 'string', note: 'Asks: keep the project in the file?', needs: true, action: 'Answer',
    },
    {
      kind: 'work', state: 'waiting', stage: 'ci', issue: 142, branch: 'feat/142-read-the-configuration', worktree: pending,
      pr: { number: 251, url: 'https://github.com/owner/repo/pull/251', draft: false }, checks: 'pending', since: 'string',
      note: 'PR #251, checks pending', needs: false, action: 'Open',
    },
    {
      kind: 'work', state: 'ready', stage: 'ci', issue: 131, branch: 'fix/131-log-the-sensor-drift', worktree: green,
      pr: { number: 250, url: 'https://github.com/owner/repo/pull/250', draft: false }, checks: 'pass', since: 'string',
      note: 'PR #250, checks pass', needs: true, action: 'Merge',
    },
    {
      kind: 'hunt', state: 'running', stage: 'hunt', issue: null, branch: 'hunt/tests-2026-09-27', worktree: bare,
      pr: null, checks: null, since: 'string', note: 'no process record; no pull request yet', needs: false, action: 'Open',
    },
    {
      kind: 'plan', state: 'input', stage: 'plan', issue: null, branch: 'plan/open-20260928-0011', worktree: null,
      pr: null, checks: null, since: 'string', note: 'Waiting for you', needs: true, action: 'Continue',
    },
  ])
  expect(b.acceptance).toEqual([{ number: 100, title: 'Offline mode', milestone: 'v2.0.0' }])
  expect(b.notes).toEqual([])

  const overall = (await api(m, 'GET', '/api/board')).body as { projects: Board[] }
  expect(overall.projects.map((p) => p.path)).toEqual([dir])
  expect(overall.projects[0]?.processes.map((p) => p.branch)).toEqual(b.processes.map((p) => p.branch))
  expect(snapshot(m.state), 'the board is derived, never stored').toEqual(state)

  const out = cli(m, ['board'])
  expect(out.stderr).toBe('')
  const lines = out.stdout.split('\n')
  expect(lines[0]).toBe(`${dir}  owner/repo  base main`)
  expect(lines[1]).toBe('  needs you  work  #118  feat/118-refuse-a-project  implement  blocked  no PR  41m  Asks: keep the project in the file?  [Answer]')
  expect(lines[2]).toMatch(/^ {2}running {4}work {2}#142 .* \[Open\]$/)
  expect(lines[3]).toMatch(/^ {2}needs you {2}work {2}#131 {2}fix\/131-log-the-sensor-drift {2}ci {2}ready {2}PR #250 pass {2}\d+s {2}PR #250, checks pass {2}\[Merge\]$/)
  expect(lines[4]).toMatch(/^ {2}running {4}hunt {2}- {2}hunt\/tests-2026-09-27 .* \[Open\]$/)
  expect(lines[5]).toBe('  needs you  plan  -  plan/open-20260928-0011  plan  input  no PR  5m  Waiting for you  [Continue]')
  expect(lines.slice(6)).toEqual(['  accept     #100  v2.0.0  Offline mode  [Accept]', ''])
  // The age of a worktree without a record is seconds since the test made its commit, and runs on.
  const seconds = (text: string) => text.replace(/ {2}\d+s {2}/g, '  Ns  ')
  expect(seconds(cli(m, ['board', dir]).stdout)).toBe(seconds(out.stdout))
})

test('a process waiting for approval needs a person, and a draft, red or unchecked pull request runs', async () => {
  const dir = await project('repo')
  record(m, 'p9', { project: dir, kind: 'work', branch: 'feat/9-approve-me', issue: 9, stage: 'pr', state: 'approval', note: 'Plan ready' })
  worktree(dir, 'feat/10-draft')
  worktree(dir, 'feat/11-red')
  worktree(dir, 'feat/12-unchecked')
  const pull = (number: number, branch: string, isDraft: boolean, statusCheckRollup: unknown[]) =>
    ({ number, headRefName: branch, isDraft, url: `https://github.com/owner/repo/pull/${number}`, statusCheckRollup })
  canPulls(m, 'owner/repo', [
    pull(20, 'feat/10-draft', true, [{ conclusion: 'SUCCESS' }]),
    pull(21, 'feat/11-red', false, [{ conclusion: 'SUCCESS' }, { conclusion: 'FAILURE' }]),
    pull(22, 'feat/12-unchecked', false, []),
  ])

  const rows = (await boardOf(dir)).processes.map((p) => [p.branch, p.state, p.checks, p.needs, p.action])
  expect(rows).toEqual([
    ['feat/10-draft', 'running', 'pass', false, 'Open'],
    ['feat/11-red', 'running', 'fail', false, 'Open'],
    ['feat/12-unchecked', 'running', 'none', false, 'Open'],
    ['feat/9-approve-me', 'approval', null, true, 'Approve'],
  ])
})

test('a fork pull request on a branch of the same name is not the process\'s, and a milestone is kept to one line', async () => {
  const dir = await project('repo')
  worktree(dir, 'feat/13-mine')
  canPulls(m, 'owner/repo', [
    { number: 30, headRefName: 'feat/13-mine', isCrossRepository: true, isDraft: false, url: 'https://github.com/owner/repo/pull/30', statusCheckRollup: [{ conclusion: 'SUCCESS' }] },
  ])
  canApi(m, `repos/owner/repo/${fixture.query}`, [issue(8, 'Free', ['ready-for-agent'], { milestone: { title: 'v1\nforged line\u001b[31m' } })])

  const b = await boardOf(dir)
  expect(b.processes.map((p) => [p.branch, p.pr, p.checks, p.action])).toEqual([['feat/13-mine', null, null, 'Open']])
  expect(b.frontier).toEqual([{ number: 8, title: 'Free', milestone: 'v1 forged line [31m' }])
})

test('a path inside a project asks for the board of the project it belongs to', async () => {
  const dir = await project('repo')
  const inner = join(dir, 'sub')
  mkdirSync(inner)
  expect((await boardOf(inner)).path).toBe(dir)
})

test('a standardize worktree is a process of its own, and a record of another kind or half written is left out', async () => {
  const dir = await project('repo')
  const tree = worktree(dir, 'chore/standardize')
  record(m, 'wrong', { project: dir, kind: 'plan', branch: 'feat/5-shaped-as-work', stage: 'plan', state: 'input', note: 'Wrong kind' })
  mkdirSync(join(m.state, 'processes'), { recursive: true })
  writeFileSync(join(m.state, 'processes', 'partial.json'), '{"project": "' + dir + '", "kind": "work", "bra')

  const rows = (await boardOf(dir)).processes.map((p) => [p.kind, p.branch, p.stage, p.worktree])
  expect(rows).toEqual([['standardize', 'chore/standardize', 'audit', tree]])
})

test('the specs and their sub-issues are read over every page GitHub answers', async () => {
  const dir = await project('repo')
  canPages(m, 'repos/owner/repo/issues?labels=spec&state=open&per_page=100', [
    [issue(100, 'Brackets ] and "quotes" [ in a title', ['spec'])],
    [issue(101, 'On the second page', ['spec']), issue(102, 'Open on the second page', ['spec'])],
  ])
  canPages(m, 'repos/owner/repo/issues/100/sub_issues?per_page=100', [[{ ...issue(1, 'a', []), state: 'closed' }], [{ ...issue(2, 'b', []), state: 'closed' }]])
  canPages(m, 'repos/owner/repo/issues/101/sub_issues?per_page=100', [[{ ...issue(3, 'c', []), state: 'closed' }]])
  canPages(m, 'repos/owner/repo/issues/102/sub_issues?per_page=100', [[{ ...issue(4, 'd', []), state: 'closed' }], [issue(5, 'e', [])]])

  const b = await boardOf(dir)
  expect(b.acceptance.map((i) => [i.number, i.title])).toEqual([
    [100, 'Brackets ] and "quotes" [ in a title'],
    [101, 'On the second page'],
  ])
  expect(b.notes).toEqual([])
})

test('what GitHub does not answer is a note on the board, not an empty section that reads as idle', async () => {
  const dir = checkout(m, 'quiet', { origin: 'https://github.com/owner/quiet.git', originHead: 'main' })
  await api(m, 'POST', '/api/projects', { path: dir })
  const b = await boardOf(dir)
  expect(b.frontier).toEqual([])
  expect(b.notes).toEqual([
    'could not read the pull requests; processes show none',
    'could not read the agent-ready issues; the frontier is empty, not idle',
    'could not read the open specs; ready for acceptance is empty, not idle',
  ])
  expect(cli(m, ['board']).stdout).toContain('  note: could not read the agent-ready issues; the frontier is empty, not idle\n')
})

test('a path that is no project has no board, and a project whose checkout is gone is listed with the reason', async () => {
  const r = await api(m, 'GET', '/api/board?project=%2Fnowhere')
  expect(r).toEqual({ status: 404, body: { error: '/nowhere is not a project; workflows projects lists them' } })
  expect(cli(m, ['board', '/nowhere']).stderr).toBe('error: /nowhere is not a project; workflows projects lists them\n')
  const dir = await project('gone')
  const config = JSON.parse(read(m.config)) as { projects: string[] }
  config.projects.push('/nowhere')
  writeFileSync(m.config, JSON.stringify(config))
  const all = (await api(m, 'GET', '/api/board')).body as { projects: { path: string; error?: string }[] }
  expect(all.projects.map((p) => [p.path, p.error])).toEqual([
    [dir, undefined],
    ['/nowhere', '/nowhere is not a git checkout; name the directory of a clone of a GitHub repository'],
  ])
})

// snapshot is every file under dir with its content.
function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const name of readdirSync(dir, { recursive: true }) as string[]) {
    const path = join(dir, name)
    if (statSync(path).isFile()) out[name] = readFileSync(path, 'utf8')
  }
  return out
}
