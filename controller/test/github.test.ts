// The GitHub tools of a planner session: the scripted claude calls them through the SDK as a planner
// session does, and the tests watch what the scripted gh was asked and what the event log holds.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { directWrite, skillCandidate, vocabulary } from '../src/github/github.js'
import { api, canApi, canPages, canPulls, checkout, cleanup, failApi, type Machine, machine, play, read, start } from './controller.js'

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
  // A standardisation creates the whole vocabulary, skill-candidate included, which the tools never create.
  expect([...vocabulary, skillCandidate]).toEqual(fixture.labels.vocabulary.map(({ name, color, description }) => ({ name, color, description })))
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
  const events = await planner(tool('set_labels', { issue: 31, add: ['factory:spec-run'], remove: ['needs-triage', 'bug'] }))
  expect(refusals(events)).toEqual([])
  // The set the rules judged replaces the labels in one call, so no set in between is left on a failure.
  expect(calls()).toEqual(['api --method PUT -f labels[]=ready-for-agent -f labels[]=factory:spec-run repos/owner/repo/issues/31/labels'])
  expect(writes(events)).toEqual([{ write: 'labels', issue: 31, added: ['factory:spec-run'], removed: ['needs-triage'] }])
})

test('labels are compared as GitHub names them, whatever their case', async () => {
  canLabels(vocabulary.map((l) => l.name))
  canIssue(31, ['ready-for-human'])
  canIssue(19, ['Spec'])
  canApi(m, 'repos/owner/repo/issues', { id: 5040, number: 40 })
  const events = await planner(
    tool('set_labels', { issue: 31, add: ['Factory', 'Ready-For-Agent'] }),
    tool('close', { issue: 19 }),
    tool('create_issue', { title: 'T', body: 'B', labels: ['Ready-For-Agent', 'FACTORY', 'factory'] }),
  )
  expect(refusals(events)).toEqual([
    '#31 would carry factory and ready-for-human: the factory works unattended, so an issue a person has to implement is never routed to it. Drop one of the two labels; leave factory out of add.',
    'closing the spec #19 needs its closing comment; the closing comment records what the acceptance checked',
  ])
  expect(calls()).toEqual(['api --method POST -f title=T -f body=B -f labels[]=ready-for-agent -f labels[]=factory repos/owner/repo/issues'])
})

test('a parent that cannot be read refuses the ticket before it is created', async () => {
  canLabels(vocabulary.map((l) => l.name))
  canApi(m, 'repos/owner/repo/issues', { id: 5040, number: 40 })
  const events = await planner(tool('create_issue', { title: 'T', body: 'B', labels: ['ready-for-agent'], parent: 99 }))
  expect(refusals(events)).toEqual([expect.stringMatching(/^could not read #99 of owner\/repo: /) as unknown])
  expect(calls()).toEqual([])
  expect(writes(events)).toEqual([])
})

test('a planner session cannot write GitHub with gh in Bash, and reads the issue its brief names without a card', async () => {
  const events = await planner(
    'bash gh issue create --title T --body B',
    'bash gh issue view 3 --comments && gh api -X PATCH repos/owner/repo/issues/3 -f state=closed',
    'bash gh api repos/owner/repo/issues/3 -f title=T',
    'bash gh issue view 3 --comments',
    "bash gh api 'repos/owner/repo/milestones?state=open&per_page=100' --jq '.[].title'",
    'bash grep -rn "gh issue view\\|git diff origin" plugins controller/src',
  )
  expect(events.filter((e) => e.event === 'github-refused').map((e) => [e.tool, (e.reason as string).split(';')[0]])).toEqual([
    ['Bash', 'gh issue create writes GitHub'],
    ['Bash', 'gh api --method PATCH writes GitHub'],
    ['Bash', 'gh api with fields sends a POST, which writes GitHub'],
  ])
  // The read its brief names runs without a card; a read in another form goes to the permission layer.
  expect(read(m.claudeLog).split('\n').filter((l) => l.startsWith('! ') && !l.includes('denied'))).toEqual([
    '! The hook allowed gh issue view 3 --comments.',
    "! The hook let gh api 'repos/owner/repo/milestones?state=open&per_page=100' --jq '.[].title' through.",
  ])
})

test('a gh call is a word gh of a command, and quoted text never names one', () => {
  for (const command of [
    'grep -rn "gh issue view\\|git diff origin" src',
    'git commit -m "gh issue close is refused"',
    "echo 'gh pr merge 1'",
    "gh issue view 3 --jq '.body | length'",
    'gh -R owner/repo pr list && echo "done; gh pr merge 1"',
    'gh issue view 3 \\\n  --comments',
    `bash -c 'grep "gh issue view" x'`,
    'sh -c "echo \'gh pr merge 1\'"',
    'eval "gh issue view 3"',
    'git commit -m "bash -c gh issue close 1"',
  ])
    expect(directWrite(command), command).toBeUndefined()
  const named: [string, string][] = [
    ['echo x | gh issue close 1', 'gh issue close writes GitHub'],
    ['gh issue close 1 --body "a | b"', 'gh issue close writes GitHub'],
    ['(gh pr merge 1)', 'gh pr merge writes GitHub'],
    ['x=$(gh issue edit 1 --add-label bug)', 'gh issue edit writes GitHub'],
    ['echo "$(gh issue close 1)"', 'gh issue close writes GitHub'],
    ['echo "`gh pr merge 1`"', 'gh pr merge writes GitHub'],
    ['"gh" issue \'close\' 1', 'gh issue close writes GitHub'],
    ['gh issue \\\nclose 1', 'gh issue close writes GitHub'],
    ['gh --repo owner/repo label create x', 'gh label create writes GitHub'],
    ['gh api -X PATCH repos/owner/repo/issues/3', 'gh api --method PATCH writes GitHub'],
    ["gh api graphql -f query='mutation { x }'", 'a graphql mutation writes GitHub'],
    ['gh api repos/owner/repo/issues -f "title=a; b"', 'gh api with fields sends a POST, which writes GitHub'],
    ["bash -c 'gh issue close 1'", 'gh issue close writes GitHub'],
    ['sh -c "gh pr merge 1"', 'gh pr merge writes GitHub'],
    ["sudo /bin/bash -lc 'cd x && gh issue edit 1 --add-label bug'", 'gh issue edit writes GitHub'],
    ['eval "gh pr merge 1"', 'gh pr merge writes GitHub'],
    ["echo 1 | xargs -I{} sh -c 'gh issue close {}'", 'gh issue close writes GitHub'],
    [`bash -c "sh -c 'gh issue close 1'"`, 'gh issue close writes GitHub'],
    ["ssh host 'gh release delete v1'", 'gh release delete writes GitHub'],
  ]
  for (const [command, why] of named) expect(directWrite(command), command).toBe(why)
  expect(directWrite("gh api graphql -f query='query { viewer { login } }'")).toBeUndefined()
})

test('a here-document body is text, and neither it nor an unclosed quote hides a later gh call', () => {
  for (const command of [
    "git commit -m \"$(cat <<'EOF'\nfix: gh issue close 1 no longer fails\nEOF\n)\"",
    "cat <<'EOF'\n$(gh issue close 1)\nEOF",
    "cat <<<'gh pr merge 1'",
  ])
    expect(directWrite(command), command).toBeUndefined()
  const named: [string, string][] = [
    ["cat <<EOF > f\nit's\nEOF\ngh issue close 1", 'gh issue close writes GitHub'],
    ["git commit -m \"$(cat <<'EOF'\nfix don't\nEOF\n)\" && gh pr create --fill", 'gh pr create writes GitHub'],
    ["cat <<-EOF\n\tit's\n\tEOF\ngh pr merge 1", 'gh pr merge writes GitHub'],
    ["cat <<A <<B\na'\nA\nb\"\nB\ngh pr merge 1", 'gh pr merge writes GitHub'],
    ['cat <<EOF\n$(gh issue close 1)\nEOF', 'gh issue close writes GitHub'],
    ["bash <<'EOF'\ngh issue close 1\nEOF", 'gh issue close writes GitHub'],
    ["cat <<'EOF' | ssh host\ngh issue close 1\nEOF", 'gh issue close writes GitHub'],
    ['x=$((1<<2))\ngh pr merge 1', 'gh pr merge writes GitHub'],
    ["echo it's && gh pr merge 1", 'gh pr merge writes GitHub'],
    ['echo "it && gh pr merge 1', 'gh pr merge writes GitHub'],
    ['x=$((1<<2))\ngh issue close 1\n2', 'gh issue close writes GitHub'],
    ['echo "$((1<<2))"\ngh issue close 1\n2', 'gh issue close writes GitHub'],
    ['(( x = 1<<2 ))\ngh pr merge 1\n2', 'gh pr merge writes GitHub'],
    ['x=$[1<<2]\ngh pr merge 1\n2]', 'gh pr merge writes GitHub'],
    ["bash <<< 'gh issue close 1'", 'gh issue close writes GitHub'],
  ]
  for (const [command, why] of named) expect(directWrite(command), command).toBe(why)
})

test('a comment is nothing, and every gh of a command is read', () => {
  for (const command of ['gh issue view 1 # then gh issue close 1', "gh pr list # don't merge", 'echo a#b && gh pr view 1'])
    expect(directWrite(command), command).toBeUndefined()
  const named: [string, string][] = [
    ['true # "\ngh issue close 1\ntrue # "', 'gh issue close writes GitHub'],
    ["true # it's\ngh pr merge 1\necho '", 'gh pr merge writes GitHub'],
    ['echo `true # `; gh pr merge 1', 'gh pr merge writes GitHub'],
    ['find . -maxdepth 0 -exec gh issue view 1 \\; -exec gh issue close 1 \\;', 'gh issue close writes GitHub'],
    ["env -S 'gh issue close 1'", 'gh issue close writes GitHub'],
    ["env -S'gh pr' merge 1", 'gh pr merge writes GitHub'],
    ["env --split-string='gh issue close 1'", 'gh issue close writes GitHub'],
  ]
  for (const [command, why] of named) expect(directWrite(command), command).toBe(why)
})

test('a gh call built at run time is refused when its group or verb may write', () => {
  for (const command of [
    'gh issue view "$n" --comments',
    'cd "$dir" && gh pr list --repo "$repo"',
    '"$(command -v gh)" issue view 1',
    'gh api "repos/$repo/pulls/$n/comments"',
    "IFS=$'\\n' read -r x",
  ])
    expect(directWrite(command), command).toBeUndefined()
  const named: [string, string][] = [
    ['gh pr "$(printf re)view" 1 --approve', 'gh pr with a verb built at run time may write GitHub'],
    ['gh pr $(printf re)view 1 --approve', 'gh pr with a verb built at run time may write GitHub'],
    ['g=issue; gh $g close 1', 'gh with a group built at run time may write GitHub'],
    ['$(command -v gh) issue close 1', 'gh issue close writes GitHub'],
    ["$'\\x67h' issue close 1", 'gh issue close writes GitHub'],
    ["echo $'it\\'s' && gh pr merge 1", 'gh pr merge writes GitHub'],
  ]
  for (const [command, why] of named) expect(directWrite(command), command).toBe(why)
})

test('repeated runners, shells and unclosed quotes are read without blowing up', () => {
  expect(directWrite(`${'eval '.repeat(200)}gh issue view 1`)).toBeUndefined()
  expect(directWrite(`${'eval '.repeat(200)}gh issue close 1`)).toBe('gh issue close writes GitHub')
  expect(directWrite(`${'bash '.repeat(200)}-c 'gh pr view 1'`)).toBeUndefined()
  expect(directWrite(`${'"$('.repeat(200)}gh pr merge 1`)).toBe('gh pr merge writes GitHub')
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

// answers are the texts the tools answered the session, in the order of its calls.
const answers = () =>
  read(m.claudeLog)
    .split('\n')
    .filter((l) => l.startsWith('< ') && l.includes('"mcp_response"') && l.includes('"content"'))
    .map((l) => {
      const found = /"content":\[\{"type":"text","text":("(?:[^"\\]|\\.)*")/.exec(l)
      return found?.[1] ? (JSON.parse(found[1]) as string) : ''
    })

test('a ticket that cannot become a sub-issue is created with a warning, and its spec keeps its own milestone', async () => {
  canLabels(vocabulary.map((l) => l.name))
  canPages(m, 'repos/owner/repo/milestones?state=all&per_page=100', [[{ number: 3, title: 'v1.2.0', state: 'open', open_issues: 0, closed_issues: 0 }]])
  canApi(m, 'repos/owner/repo/issues', { id: 5040, number: 40 })
  canIssue(30, ['spec'], { milestone: { title: 'v1.2.0' } })
  canIssue(32, ['spec'], { milestone: { title: 'v1.1.0' } })
  failApi(m, 'repos/owner/repo/issues/32/sub_issues', 'gh: Server Error (HTTP 500)')
  const ticket = { title: 'T', body: 'B', labels: ['ready-for-agent'], milestone: 'v1.2.0' }
  const events = await planner(tool('create_issue', { ...ticket, parent: 30 }), tool('create_issue', { ...ticket, parent: 32 }))
  expect(refusals(events)).toEqual([])
  expect(answers()).toEqual([
    [
      'issue: #40',
      'url: https://github.com/owner/repo/issues/40',
      'milestone: v1.2.0',
      'warning: #40 is not linked to #30 (sub-issues unavailable here); name #30 in its body',
      'parent-milestone: #30 already on v1.2.0',
    ].join('\n'),
    [
      'issue: #40',
      'url: https://github.com/owner/repo/issues/40',
      'milestone: v1.2.0',
      'warning: linking #40 as a sub-issue of #32 failed: gh: Server Error (HTTP 500); attach it to #32 on GitHub',
      'warning: #32 stays on milestone v1.1.0 while its sub-issues go to v1.2.0; move it if v1.2.0 releases this work',
    ].join('\n'),
  ])
  // Neither ticket carries the spec-run label, so no label is taken off and no spec is moved.
  expect(calls()).toEqual([
    'api --method POST -f title=T -f body=B -f labels[]=ready-for-agent -F milestone=3 repos/owner/repo/issues',
    'api --method POST -F sub_issue_id=5040 repos/owner/repo/issues/30/sub_issues',
    'api --method POST -f title=T -f body=B -f labels[]=ready-for-agent -F milestone=3 repos/owner/repo/issues',
    'api --method POST -F sub_issue_id=5040 repos/owner/repo/issues/32/sub_issues',
  ])
  expect(writes(events).map((w) => w.write)).toEqual(['issue-created', 'issue-created'])
})

test('a blocker link that fails other than for want of dependencies is refused', async () => {
  canIssue(5, [])
  canIssue(6, [])
  canIssue(8, [])
  failApi(m, 'repos/owner/repo/issues/5/dependencies/blocked_by', 'gh: Forbidden (HTTP 403)')
  const events = await planner(tool('block', { issue: 5, by: [6, 8] }))
  expect(refusals(events)).toEqual(['linking #5 as blocked by #6 failed: gh: Forbidden (HTTP 403)'])
  expect(writes(events)).toEqual([])
})
