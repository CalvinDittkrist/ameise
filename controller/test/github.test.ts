// The GitHub tools of a planner session: the scripted claude calls them through the SDK as a planner
// session does, and the tests watch what the scripted gh was asked and what the event log holds.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { vocabulary } from '../src/github.js'
import { api, canApi, canPages, canPulls, checkout, cleanup, type Machine, machine, play, read, start } from './controller.js'

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
})

// A planner session that plays the steps, one a line, then ends its turn.
async function planner(...steps: string[]): Promise<Record<string, unknown>[]> {
  play(m, [...steps, 'ready done'].join('\n'))
  const r = await api(m, 'POST', '/api/plans', { project: dir, idea: 'Offline mode' })
  expect(r.status, JSON.stringify(r.body)).toBe(201)
  const id = (r.body as { record: { id: string } }).record.id
  const file = join(m.state, 'processes', `${id}.json`)
  for (let i = 0; i < 400; i++) {
    if ((JSON.parse(read(file)) as { state: string }).state === 'input') break
    await new Promise((done) => setTimeout(done, 50))
  }
  expect((JSON.parse(read(file)) as { state: string }).state).toBe('input')
  return read(join(m.state, 'processes', `${id}.events.jsonl`))
    .trimEnd()
    .split('\n')
    .map((l) => JSON.parse(l) as Record<string, unknown>)
}

const writes = (events: Record<string, unknown>[]) =>
  events.filter((e) => e.event === 'github').map((e) => Object.fromEntries(Object.entries(e).filter(([k]) => k !== 'at' && k !== 'event')))
const refusals = (events: Record<string, unknown>[]) => events.filter((e) => e.event === 'github-refused').map((e) => e.reason as string)
// calls are the requests the scripted gh was asked that write: every gh api with a method.
const calls = () => read(m.ghLog).split('\n').filter((l) => l.startsWith('api --method'))
const tool = (name: string, args: unknown) => `tool ${name} ${JSON.stringify(args)}`

// canIssue cans an issue as the REST API answers it.
function canIssue(n: number, labels: string[], more: Record<string, unknown> = {}) {
  canApi(m, `repos/owner/repo/issues/${n}`, { id: 1000 + n, number: n, state: 'open', labels: labels.map((name) => ({ name })), milestone: null, ...more })
}
const canLabels = (names: string[]) => canPages(m, 'repos/owner/repo/labels?per_page=100', [names.map((name) => ({ name }))])

test('the label vocabulary the tools create follows the contract fixture', () => {
  const fixture = JSON.parse(readFileSync(fileURLToPath(new URL('../../contract/fixture.json', import.meta.url)), 'utf8')) as {
    labels: { vocabulary: { name: string; color: string; description: string; planner?: boolean }[] }
    frontier: { routing_label: string }
  }
  const planned = fixture.labels.vocabulary.filter((l) => l.planner !== false).map(({ name, color, description }) => ({ name, color, description }))
  expect(vocabulary).toEqual(planned)
  expect(vocabulary.map((l) => l.name)).toContain(fixture.frontier.routing_label)
})

test('a ticket is created with its labels, its parent and its milestone, and the missing labels are created first', async () => {
  canLabels(['ready-for-agent'])
  canApi(m, 'repos/owner/repo/labels', {})
  canPages(m, 'repos/owner/repo/milestones?state=all&per_page=100', [[{ number: 3, title: 'v1.2.0', state: 'open', open_issues: 0, closed_issues: 0 }]])
  canApi(m, 'repos/owner/repo/issues', { id: 5040, number: 40, html_url: 'https://github.com/owner/repo/issues/40' })
  canApi(m, 'repos/owner/repo/issues/30/sub_issues', {})
  canIssue(30, ['spec'])
  const events = await planner(tool('create_issue', { title: 'Retry the upload', body: 'The body.', labels: ['ready-for-agent', 'factory'], parent: 30, milestone: 'v1.2.0' }))
  expect(refusals(events)).toEqual([])
  expect(calls()).toEqual([
    'api --method POST -f name=factory -f color=FFC799 -f description=Routed to the factory host; local claims leave it alone repos/owner/repo/labels',
    'api --method POST -f title=Retry the upload -f body=The body. -f labels[]=ready-for-agent -f labels[]=factory -F milestone=3 repos/owner/repo/issues',
    'api --method POST -F sub_issue_id=5040 repos/owner/repo/issues/30/sub_issues',
    'api --method PATCH -F milestone=3 repos/owner/repo/issues/30',
  ])
  expect(writes(events)).toEqual([
    { write: 'label-created', label: 'factory' },
    { write: 'issue-created', issue: 40, title: 'Retry the upload', labels: ['ready-for-agent', 'factory'], milestone: 'v1.2.0', url: 'https://github.com/owner/repo/issues/40' },
    { write: 'sub-issue', issue: 40, parent: 30 },
    { write: 'milestone-attached', issue: 30, milestone: 'v1.2.0' },
  ])
})

test('a planner session is started with the tools as its one server and allowed to call them', async () => {
  await planner('say nothing to write')
  const lines = read(m.claudeLog).split('\n')
  const init = JSON.parse(lines.find((l) => l.startsWith('< ') && l.includes('"subtype":"initialize"'))?.slice(2) ?? '{}') as { request?: { sdkMcpServers?: string[] } }
  expect(init.request?.sdkMcpServers).toEqual(['github'])
  expect(lines[lines.indexOf('--allowedTools') + 1]).toBe('mcp__github')
  expect(lines).toContain('--strict-mcp-config')
})

test('each refusal of the issue script is a refusal of the tools, and nothing is written', async () => {
  canLabels(vocabulary.map((l) => l.name))
  canPages(m, 'repos/owner/repo/milestones?state=all&per_page=100', [[{ number: 1, title: 'v1.0.0', state: 'closed', open_issues: 0, closed_issues: 4 }]])
  canIssue(30, ['spec'])
  canIssue(31, ['ready-for-agent', 'ready-for-human'])
  canApi(m, 'repos/owner/repo/issues/31/parent', { number: 30 })
  const body = { title: 'T', body: 'B' }
  const events = await planner(
    tool('create_issue', { ...body, labels: ['factory'] }),
    tool('create_issue', { ...body, labels: ['ready-for-agent', 'ready-for-human', 'factory'] }),
    tool('create_issue', { ...body, labels: ['spec', 'factory', 'factory:spec-run'] }),
    tool('create_issue', { ...body, labels: ['spec', 'ready-for-human', 'factory:spec-run'] }),
    tool('create_issue', { ...body, labels: ['ready-for-agent', 'factory:spec-run'] }),
    tool('create_issue', { ...body, labels: ['ready-for-agent', 'factory:spec-run'], parent: 30 }),
    tool('create_issue', { ...body, milestone: '1.0' }),
    tool('create_issue', { ...body, milestone: 'v2.0.0' }),
    tool('create_issue', { ...body, milestone: 'v1.0.0' }),
    tool('create_issue', { ...body, labels: ['nonsense'] }),
    tool('set_labels', { issue: 31, add: ['factory'] }),
    tool('set_labels', { issue: 31, remove: ['ready-for-agent'], add: ['factory:spec-run'] }),
    tool('set_labels', { issue: 99, add: ['factory'] }),
    tool('set_labels', { issue: 31 }),
    tool('create_milestone', { title: 'v1.0.0' }),
  )
  expect(refusals(events)).toEqual([
    'the new issue would carry factory without ready-for-agent: the factory takes only issues a worker can finish from the brief alone. Add ready-for-agent, or leave the label factory off.',
    'the new issue would carry factory and ready-for-human: the factory works unattended, so an issue a person has to implement is never routed to it. Drop one of the two labels; leave the label factory off.',
    'the new issue would carry factory and factory:spec-run: a spec run routes its tickets itself, so an issue carries one of the two. Drop one of them; leave the label factory:spec-run off, or drop factory.',
    'the new issue would carry factory:spec-run and ready-for-human: the factory skips a ticket a person works, so that ticket keeps ready-for-human alone. Drop one of the two labels; leave the label factory:spec-run off.',
    'the new issue would carry factory:spec-run but is no spec and has no parent: the label marks a spec and the tickets of its spec run. Label the spec, or make the issue a ticket of a spec that carries it; leave the label factory:spec-run off.',
    'the new issue would carry factory:spec-run but its spec #30 does not: a ticket joins a spec run only once its spec is one. Label #30 first with set_labels on 30 adding factory:spec-run, or leave the label factory:spec-run off.',
    "milestone must be named vX.Y.Z, got '1.0'",
    'milestone v2.0.0 does not exist; create it with create_milestone v2.0.0 and its goal',
    'milestone v1.0.0 is closed (released); pick a new version',
    'nonsense is neither a label of the workflow\'s vocabulary nor one of owner/repo; use a label of the vocabulary (ready-for-agent, needs-triage, needs-info, ready-for-human, wontfix, spec, factory, factory:spec-run, bug, enhancement), or create nonsense on GitHub first',
    '#31 would carry factory and ready-for-human: the factory works unattended, so an issue a person has to implement is never routed to it. Drop one of the two labels; leave factory out of add.',
    '#31 would carry factory:spec-run and ready-for-human: the factory skips a ticket a person works, so that ticket keeps ready-for-human alone. Drop one of the two labels; leave factory:spec-run out of add.',
    expect.stringMatching(/^could not read #99 of owner\/repo: .*; does the issue exist, and is gh authenticated for this repository\?$/) as unknown,
    'set_labels needs labels to add or to remove',
    'milestone v1.0.0 is closed (released); pick a new version',
  ])
  expect(calls()).toEqual([])
  expect(writes(events)).toEqual([])
})

test('labels are judged on the set the issue ends up with, and a ticket joins the spec run of its spec', async () => {
  canLabels(vocabulary.map((l) => l.name))
  canIssue(30, ['spec', 'factory:spec-run'])
  canIssue(31, ['ready-for-agent', 'needs-triage'])
  canApi(m, 'repos/owner/repo/issues/31/parent', { number: 30 })
  canApi(m, 'repos/owner/repo/issues/31/labels', [])
  canApi(m, 'repos/owner/repo/issues/31/labels/needs-triage', {})
  const events = await planner(tool('set_labels', { issue: 31, add: ['factory:spec-run'], remove: ['needs-triage', 'bug'] }))
  expect(refusals(events)).toEqual([])
  expect(calls()).toEqual(['api --method POST -f labels[]=factory:spec-run repos/owner/repo/issues/31/labels', 'api --method DELETE repos/owner/repo/issues/31/labels/needs-triage'])
  expect(writes(events)).toEqual([{ write: 'labels', issue: 31, added: ['factory:spec-run'], removed: ['needs-triage'] }])
})

test('a ticket of a spec run that cannot become a sub-issue loses the spec-run label and is refused', async () => {
  canLabels(vocabulary.map((l) => l.name))
  canIssue(30, ['spec', 'factory:spec-run'])
  canApi(m, 'repos/owner/repo/issues', { id: 5040, number: 40 })
  canApi(m, 'repos/owner/repo/issues/40/labels/factory%3Aspec-run', {})
  const events = await planner(tool('create_issue', { title: 'T', body: 'B', labels: ['ready-for-agent', 'factory:spec-run'], parent: 30 }))
  expect(refusals(events)).toEqual([
    '#40 could not become a sub-issue of #30, so it cannot join the spec run and lost factory:spec-run. Attach it to #30 on GitHub, then add factory:spec-run with set_labels on 40.',
  ])
  expect(writes(events)).toEqual([
    { write: 'issue-created', issue: 40, title: 'T', labels: ['ready-for-agent', 'factory:spec-run'], url: 'https://github.com/owner/repo/issues/40' },
    { write: 'labels', issue: 40, removed: ['factory:spec-run'] },
  ])
})

test('a spec closes as completed only with its closing comment and every ticket closed', async () => {
  canIssue(19, ['spec'])
  canPages(m, 'repos/owner/repo/issues/19/sub_issues?per_page=100', [[{ number: 20 }]])
  canIssue(20, ['ready-for-agent'], { state: 'closed' })
  canIssue(21, ['ready-for-agent'])
  canApi(m, 'repos/owner/repo/issues/19/comments', {})
  const events = await planner(
    tool('close', { issue: 19 }),
    tool('close', { issue: 19, comment: 'Accepted.', tickets: [21] }),
    tool('close', { issue: 19, comment: 'Accepted.' }),
  )
  expect(refusals(events)).toEqual([
    'closing the spec #19 needs its closing comment; the closing comment records what the acceptance checked',
    '#19 still has open sub-issues: #21; the acceptance runs again once they are closed',
  ])
  expect(calls()).toEqual(['api --method POST -f body=Accepted. repos/owner/repo/issues/19/comments', 'api --method PATCH -f state=closed -f state_reason=completed repos/owner/repo/issues/19'])
  expect(writes(events)).toEqual([
    { write: 'comment', issue: 19, body: 'Accepted.' },
    { write: 'closed', issue: 19, reason: 'completed' },
  ])
})

test('a spec does not close while a ticket cannot be read or it has no tickets', async () => {
  canIssue(19, ['spec'])
  canPages(m, 'repos/owner/repo/issues/19/sub_issues?per_page=100', [[{ number: 20 }]])
  canIssue(18, ['spec'])
  canPages(m, 'repos/owner/repo/issues/18/sub_issues?per_page=100', [[]])
  canIssue(17, ['spec'])
  canIssue(21, ['ready-for-agent'], { state: 'closed' })
  const events = await planner(
    tool('close', { issue: 19, comment: 'Accepted.' }),
    tool('close', { issue: 18, comment: 'Accepted.' }),
    tool('close', { issue: 17, comment: 'Accepted.', tickets: [22] }),
  )
  expect(refusals(events)).toEqual([
    expect.stringMatching(/^could not read #20 of owner\/repo: /) as unknown,
    '#18 has no native sub-issues; pass the ticket numbers in tickets',
    expect.stringMatching(/^could not read #22 of owner\/repo: /) as unknown,
  ])
  expect(calls()).toEqual([])
  expect(writes(events)).toEqual([])
})

test('blockers, comments, milestones and a close as not planned are written and logged', async () => {
  canIssue(5, [])
  canIssue(6, [])
  canIssue(7, [])
  canApi(m, 'repos/owner/repo/issues/5/dependencies/blocked_by', {})
  canApi(m, 'repos/owner/repo/issues/7/comments', {})
  canPages(m, 'repos/owner/repo/milestones?state=all&per_page=100', [[{ number: 2, title: 'v1.1.0', state: 'open', open_issues: 1, closed_issues: 2 }]])
  canApi(m, 'repos/owner/repo/milestones', {})
  const events = await planner(
    tool('block', { issue: 5, by: [6] }),
    tool('block', { issue: 7, by: [6] }),
    tool('create_milestone', { title: 'v1.1.0' }),
    tool('create_milestone', { title: 'v1.2.0', description: 'Offline mode' }),
    tool('attach_milestone', { issue: 5, milestone: 'v1.1.0' }),
    tool('close', { issue: 7, comment: 'Out of scope.', reason: 'not planned' }),
  )
  expect(refusals(events)).toEqual([])
  expect(calls()).toEqual([
    'api --method POST -F issue_id=1006 repos/owner/repo/issues/5/dependencies/blocked_by',
    'api --method POST -F issue_id=1006 repos/owner/repo/issues/7/dependencies/blocked_by',
    'api --method POST -f title=v1.2.0 -f description=Offline mode repos/owner/repo/milestones',
    'api --method PATCH -F milestone=2 repos/owner/repo/issues/5',
    'api --method POST -f body=Out of scope. repos/owner/repo/issues/7/comments',
    'api --method PATCH -f state=closed -f state_reason=not_planned repos/owner/repo/issues/7',
  ])
  // Where GitHub has no native dependencies, the link is not made and nothing is logged.
  expect(writes(events)).toEqual([
    { write: 'blocked', issue: 5, by: 6 },
    { write: 'milestone-created', milestone: 'v1.2.0', description: 'Offline mode' },
    { write: 'milestone-attached', issue: 5, milestone: 'v1.1.0' },
    { write: 'comment', issue: 7, body: 'Out of scope.' },
    { write: 'closed', issue: 7, reason: 'not planned' },
  ])
})
