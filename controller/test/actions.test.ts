import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { api, canApi, canIssue, canPages, canPulls, canRepo, checkout, cleanup, cli, type Machine, machine, read, record, start, worktree } from './controller.js'

afterEach(cleanup)

let m: Machine
let dir: string
beforeEach(async () => {
  m = await machine()
  const s = await start(m)
  expect(s.running, s.stderr).toBe(true)
  dir = checkout(m, 'repo', { origin: 'https://github.com/owner/repo.git', originHead: 'main' })
  canRepo(m, 'owner/repo', 'main')
  canPulls(m, 'owner/repo', [])
  canApi(m, 'repos/owner/repo/issues?labels=ready-for-agent&state=open&per_page=100', [])
  canApi(m, 'repos/owner/repo/issues?labels=spec&state=open&per_page=100', [])
  expect((await api(m, 'POST', '/api/projects', { path: dir })).status).toBe(201)
})

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: 'pipe' }).trim()
const calls = (prefix: string) => (existsSync(m.ghLog) ? read(m.ghLog) : '').split('\n').filter((l) => l.startsWith(prefix))
const processes = () => (existsSync(join(m.state, 'processes')) ? readdirSync(join(m.state, 'processes')) : [])
const error = (r: { body: unknown }) => (r.body as { error: string }).error

// canPull cans a pull request as gh pr view answers it, green and ready unless told otherwise, and what
// it answers once merged with its merge commit. A merge commit of null cans a base with a merge queue,
// where the pull request stays open after gh pr merge.
function canPull(n: number, head: string, base: string, over: Record<string, unknown> = {}, mergeCommit: string | null = 'm3rged') {
  const pr = {
    number: n,
    title: `PR ${n}`,
    state: 'OPEN',
    isDraft: false,
    mergeable: 'MERGEABLE',
    mergeStateStatus: 'CLEAN',
    headRefName: head,
    headRefOid: 'c0ffee',
    baseRefName: base,
    isCrossRepository: false,
    reviewDecision: null,
    statusCheckRollup: [{ conclusion: 'SUCCESS', status: 'COMPLETED' }],
    mergeCommit: null,
    ...over,
  }
  const pulls = join(m.github, 'repos', 'owner', 'repo', 'pulls')
  mkdirSync(pulls, { recursive: true })
  writeFileSync(join(pulls, `${n}.json`), JSON.stringify(pr))
  const merged = join(pulls, `${n}.merged.json`)
  if (mergeCommit) writeFileSync(merged, JSON.stringify({ ...pr, state: 'MERGED', mergeCommit: { oid: mergeCommit } }))
  else rmSync(merged, { force: true })
}

// process makes a work process of a branch as a claim leaves it, its commits on origin.
function process(branch: string, issue: number): string {
  const path = worktree(dir, branch)
  git(dir, 'update-ref', `refs/remotes/origin/${branch}`, branch)
  record(m, `work-${issue}`, { project: dir, kind: 'work', branch, issue, worktree: path, mode: 'manual', stage: 'ci', state: 'ready' })
  return path
}

const merge = (pr: number) => api(m, 'POST', '/api/merges', { project: dir, pr })
const release = (milestone: string) => api(m, 'POST', '/api/releases', { project: dir, milestone })
const accept = (spec: number) => api(m, 'POST', '/api/acceptances', { project: dir, spec })

test('a merge of a ready process squash-merges it and removes its branch, worktree and process, and leaves the issue to GitHub', async () => {
  const branch = 'feat/144-board-lists-every-project'
  const path = process(branch, 144)
  canPull(12, branch, 'main')
  const r = await merge(12)
  expect(r.status, JSON.stringify(r.body)).toBe(200)
  expect(r.body).toMatchObject({ pr: 12, method: 'squash', base: 'main', branch, kept: '', worktree: path, closed: null, warnings: [] })
  expect(calls('pr merge')).toEqual(['pr merge 12 --repo owner/repo --squash --match-head-commit c0ffee --delete-branch'])
  expect(calls('issue close')).toEqual([])
  expect(existsSync(path)).toBe(false)
  expect(git(dir, 'branch', '--list', branch)).toBe('')
  expect(processes()).toEqual([])
})

test('a merge into a branch other than the default closes the issue of the head branch', async () => {
  const branch = 'feat/150-loose-idea'
  process(branch, 150)
  canPull(13, branch, 'spec/100-offline-mode')
  const r = await merge(13)
  expect(r.status, JSON.stringify(r.body)).toBe(200)
  expect(r.body).toMatchObject({ base: 'spec/100-offline-mode', closed: 150 })
  expect(calls('issue close')).toHaveLength(1)
  expect(calls('issue close')[0]).toMatch(/^issue close 150 --repo owner\/repo --comment Merged in #13 into spec\/100-offline-mode\./)
})

test('a merge of a promotion gives it a merge commit and keeps dev', async () => {
  canPull(14, 'dev', 'main')
  const r = await merge(14)
  expect(r.status, JSON.stringify(r.body)).toBe(200)
  expect(r.body).toMatchObject({ method: 'merge', branch: 'dev', kept: 'long-lived', worktree: null, closed: null })
  expect(calls('pr merge')).toEqual(['pr merge 14 --repo owner/repo --merge --match-head-commit c0ffee'])
})

const notGreen: { name: string; over: Record<string, unknown>; reason: RegExp }[] = [
  { name: 'a failed check', over: { statusCheckRollup: [{ conclusion: 'FAILURE' }] }, reason: /PR #15 has failed checks/ },
  { name: 'a pending check', over: { statusCheckRollup: [{ status: 'IN_PROGRESS' }] }, reason: /PR #15 has checks still pending/ },
  { name: 'a draft', over: { isDraft: true }, reason: /PR #15 is a draft/ },
  { name: 'a conflict', over: { mergeable: 'CONFLICTING' }, reason: /PR #15 is CONFLICTING/ },
  { name: 'changes requested', over: { reviewDecision: 'CHANGES_REQUESTED' }, reason: /PR #15 has changes requested/ },
  { name: 'a merged one', over: { state: 'MERGED' }, reason: /PR #15 is MERGED, not open/ },
]

for (const c of notGreen) {
  test(`a merge refuses a pull request with ${c.name} and changes nothing`, async () => {
    const branch = 'feat/144-board-lists-every-project'
    const path = process(branch, 144)
    canPull(15, branch, 'main', c.over)
    const r = await merge(15)
    expect(r.status).toBe(409)
    expect(error(r)).toMatch(c.reason)
    expect(calls('pr merge')).toEqual([])
    expect(existsSync(path)).toBe(true)
    expect(processes()).toEqual(['work-144.json'])
  })
}

test('a merge refuses a pull request with an unresolved review thread and changes nothing', async () => {
  const branch = 'feat/144-board-lists-every-project'
  const path = process(branch, 144)
  canPull(15, branch, 'main')
  writeFileSync(join(m.github, 'repos', 'owner', 'repo', 'pulls', '15.threads.json'), JSON.stringify([{ isResolved: true }, { isResolved: false }]))
  const r = await merge(15)
  expect(r.status).toBe(409)
  expect(error(r)).toMatch(/PR #15 has 1 unresolved review thread\(s\)/)
  expect(calls('pr merge')).toEqual([])
  expect(existsSync(path)).toBe(true)
  expect(processes()).toEqual(['work-144.json'])
})

test('a merge refuses a branch the checkout itself stands on and changes nothing', async () => {
  const branch = 'feat/144-board-lists-every-project'
  git(dir, 'switch', '-q', '-c', branch)
  git(dir, 'update-ref', `refs/remotes/origin/${branch}`, branch)
  canPull(15, branch, 'main')
  const r = await merge(15)
  expect(r.status).toBe(409)
  expect(error(r)).toMatch(/stands on feat\/144-board-lists-every-project; switch it to main and merge again/)
  expect(calls('pr merge')).toEqual([])
  expect(git(dir, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(branch)
})

test('a merge that a merge queue takes keeps the branch, worktree and process until GitHub merges it', async () => {
  const branch = 'feat/150-loose-idea'
  const path = process(branch, 150)
  canPull(18, branch, 'spec/100-offline-mode', {}, null)
  const r = await merge(18)
  expect(r.status, JSON.stringify(r.body)).toBe(200)
  expect(r.body).toMatchObject({ pr: 18, queued: true, worktree: null, closed: null, warnings: [expect.stringMatching(/PR #18 is in the merge queue of spec\/100-offline-mode/)] })
  expect(calls('pr merge')).toHaveLength(1)
  expect(calls('issue close')).toEqual([])
  expect(existsSync(path)).toBe(true)
  expect(git(dir, 'branch', '--list', branch)).not.toBe('')
  expect(processes()).toEqual(['work-150.json'])
})

test('a merge whose process record cannot be removed warns and still answers merged', async () => {
  const branch = 'feat/144-board-lists-every-project'
  process(branch, 144)
  mkdirSync(join(m.state, 'processes', 'work-144.events.jsonl', 'stuck'), { recursive: true })
  canPull(12, branch, 'main')
  const r = await merge(12)
  expect(r.status, JSON.stringify(r.body)).toBe(200)
  expect(r.body).toMatchObject({ queued: false, warnings: [expect.stringMatching(/PR #12 is merged, but .*work-144\.events\.jsonl could not be removed/)] })
  expect(processes()).toEqual(['work-144.events.jsonl'])
})

test('a merge refuses a worktree with commits not on origin', async () => {
  const branch = 'feat/144-board-lists-every-project'
  const path = process(branch, 144)
  git(path, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'local work')
  canPull(16, branch, 'main')
  const r = await merge(16)
  expect(r.status).toBe(409)
  expect(error(r)).toMatch(/has 1 commit\(s\) not on origin/)
  expect(calls('pr merge')).toEqual([])
  expect(existsSync(path)).toBe(true)
})

test('a merge refuses a local branch without a worktree that has commits not on origin', async () => {
  const branch = 'feat/144-board-lists-every-project'
  const path = process(branch, 144)
  git(path, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'local work')
  git(dir, 'worktree', 'remove', '--force', path)
  canPull(17, branch, 'main')
  const r = await merge(17)
  expect(r.status).toBe(409)
  expect(error(r)).toMatch(/has 1 commit\(s\) not on origin/)
  expect(calls('pr merge')).toEqual([])
  expect(git(dir, 'branch', '--list', branch)).not.toBe('')
})

// canRelease cans a finished milestone v1.0.0 and the head of main.
function canRelease(over: Record<string, unknown> = {}) {
  canPages(m, 'repos/owner/repo/milestones?state=all&per_page=100', [[{ number: 3, title: 'v1.0.0', state: 'open', open_issues: 0, closed_issues: 5, ...over }]])
  canApi(m, 'repos/owner/repo/branches/main', { name: 'main', commit: { sha: 'abc123' } })
}

test('a release with main alone tags the head of main, publishes the release and closes the milestone', async () => {
  canRelease()
  const r = await release('v1.0.0')
  expect(r.status, JSON.stringify(r.body)).toBe(201)
  expect(r.body).toEqual({ status: 'released', milestone: 'v1.0.0', model: 'main', target: 'abc123', release: 'https://github.com/owner/repo/releases/tag/v1.0.0', promotion: null })
  expect(calls('release create')).toEqual(['release create v1.0.0 --repo owner/repo --target abc123 --title v1.0.0 --generate-notes'])
  expect(calls('api --method PATCH')).toEqual(['api --method PATCH repos/owner/repo/milestones/3 -f state=closed'])
})

const refusedReleases: { name: string; arrange: () => void; reason: RegExp }[] = [
  { name: 'a missing milestone', arrange: () => canPages(m, 'repos/owner/repo/milestones?state=all&per_page=100', [[]]), reason: /milestone v1\.0\.0 does not exist/ },
  { name: 'open issues', arrange: () => canRelease({ open_issues: 2 }), reason: /milestone v1\.0\.0 has 2 open issue\(s\)/ },
  { name: 'a closed milestone', arrange: () => canRelease({ state: 'closed' }), reason: /milestone v1\.0\.0 is closed already/ },
  {
    name: 'an existing tag',
    arrange: () => {
      canRelease()
      canApi(m, 'repos/owner/repo/git/ref/tags/v1.0.0', { ref: 'refs/tags/v1.0.0' })
    },
    reason: /the tag v1\.0\.0 exists already/,
  },
]

for (const c of refusedReleases) {
  test(`a release refuses ${c.name} and publishes nothing`, async () => {
    c.arrange()
    const r = await release('v1.0.0')
    expect(r.status).toBe(409)
    expect(error(r)).toMatch(c.reason)
    expect(calls('release create')).toEqual([])
    expect(calls('pr create')).toEqual([])
  })
}

test('a release refuses a milestone that is no version before it reads GitHub', async () => {
  const r = await release('next')
  expect(r.status).toBe(400)
  expect(calls('api')).toEqual([])
})

test('a release with dev and main opens the promotion, merges it and tags its merge commit', async () => {
  canRepo(m, 'owner/repo', 'dev')
  canRelease()
  writeFileSync(join(m.github, 'repos', 'owner', 'repo', 'promotions.json'), '[]')
  writeFileSync(join(m.github, 'repos', 'owner', 'repo', 'next-pull'), '21\n')
  canPull(21, 'dev', 'main', {}, 'def456')
  const r = await release('v1.0.0')
  expect(r.status, JSON.stringify(r.body)).toBe(201)
  expect(r.body).toMatchObject({ status: 'released', model: 'dev+main', target: 'def456', promotion: 'https://github.com/owner/repo/pull/21' })
  expect(calls('pr create')).toHaveLength(1)
  expect(calls('pr create')[0]).toMatch(/^pr create --repo owner\/repo --base main --head dev --title chore\(release\): v1\.0\.0 /)
  expect(calls('pr merge')).toEqual(['pr merge 21 --repo owner/repo --merge --match-head-commit c0ffee'])
  expect(calls('release create')).toEqual(['release create v1.0.0 --repo owner/repo --target def456 --title v1.0.0 --generate-notes'])
})

test('a release with dev and main waits for a promotion that is not green, and goes on from it once it is', async () => {
  canRepo(m, 'owner/repo', 'dev')
  canRelease()
  const promotion = { number: 21, title: 'chore(release): v1.0.0', state: 'OPEN', url: 'https://github.com/owner/repo/pull/21', mergeCommit: null, isCrossRepository: false }
  writeFileSync(join(m.github, 'repos', 'owner', 'repo', 'promotions.json'), JSON.stringify([promotion]))
  canPull(21, 'dev', 'main', { statusCheckRollup: [{ status: 'IN_PROGRESS' }] })
  const waiting = await release('v1.0.0')
  expect(waiting.status, JSON.stringify(waiting.body)).toBe(202)
  expect(waiting.body).toMatchObject({ status: 'waiting', promotion: promotion.url, reason: expect.stringMatching(/PR #21 has checks still pending/) as unknown })
  expect(calls('pr merge')).toEqual([])
  expect(calls('release create')).toEqual([])

  canPull(21, 'dev', 'main', {}, 'def456')
  const done = await release('v1.0.0')
  expect(done.status, JSON.stringify(done.body)).toBe(201)
  expect(calls('pr create')).toEqual([])
  expect(done.body).toMatchObject({ status: 'released', target: 'def456' })
})

test('a release with dev and main waits for a promotion in the merge queue of main', async () => {
  canRepo(m, 'owner/repo', 'dev')
  canRelease()
  const promotion = { number: 21, title: 'chore(release): v1.0.0', state: 'OPEN', url: 'https://github.com/owner/repo/pull/21', mergeCommit: null, isCrossRepository: false }
  writeFileSync(join(m.github, 'repos', 'owner', 'repo', 'promotions.json'), JSON.stringify([promotion]))
  canPull(21, 'dev', 'main', {}, null)
  const r = await release('v1.0.0')
  expect(r.status, JSON.stringify(r.body)).toBe(202)
  expect(r.body).toMatchObject({ status: 'waiting', reason: expect.stringMatching(/PR #21 is in the merge queue of main/) as unknown })
  expect(calls('release create')).toEqual([])
})

// canSpec cans a spec with tickets of the given states.
function canSpec(n: number, states: string[], labels = ['spec']) {
  canIssue(m, 'owner/repo', n, 'Offline mode', labels)
  canPages(m, `repos/owner/repo/issues/${n}/sub_issues?per_page=100`, [states.map((state, i) => ({ number: n + 1 + i, title: `t${i}`, state }))])
}

test('an acceptance start opens a plan process on the spec with the acceptance route, starts its acceptance, and the spec leaves ready for acceptance', async () => {
  canSpec(100, ['closed', 'closed'])
  canApi(m, 'repos/owner/repo/issues?labels=spec&state=open&per_page=100', [{ number: 100, title: 'Offline mode', state: 'open', labels: [{ name: 'spec' }] }])
  const before = (await api(m, 'GET', '/api/board?' + new URLSearchParams({ project: dir }).toString())).body as { acceptance: unknown[] }
  expect(before.acceptance).toHaveLength(1)

  const r = await accept(100)
  expect(r.status, JSON.stringify(r.body)).toBe(201)
  const path = join(dir, '.claude', 'worktrees', 'plan-offline-mode')
  const rec = (r.body as { record: Record<string, unknown> & { id: string } }).record
  expect(rec).toMatchObject({ kind: 'plan', route: 'accept', branch: 'plan/offline-mode', issue: 100, worktree: path, base: 'origin/main', state: 'running', note: 'the acceptance gathers the facts' })
  expect(git(path, 'rev-parse', 'HEAD')).toBe(git(dir, 'rev-parse', 'origin/main'))
  expect(JSON.parse(read(join(m.state, 'processes', `${rec.id}.json`)))).toMatchObject({ id: rec.id, route: 'accept', issue: 100 })

  const board = (await api(m, 'GET', '/api/board?' + new URLSearchParams({ project: dir }).toString())).body as { processes: unknown[]; acceptance: unknown[] }
  expect(board.processes).toMatchObject([{ kind: 'plan', issue: 100, branch: 'plan/offline-mode', stage: 'accept' }])
  expect(board.acceptance).toEqual([])

  const again = await accept(100)
  expect(again.status).toBe(409)
  expect(error(again)).toMatch(/#100 has a process already on plan\/offline-mode/)
})

test('an abandon of an acceptance removes its worktree and process and leaves its branch, which a new start asks to remove', async () => {
  canSpec(100, ['closed'])
  expect((await accept(100)).status).toBe(201)
  const path = join(dir, '.claude', 'worktrees', 'plan-offline-mode')

  const r = await api(m, 'DELETE', '/api/processes', { project: dir, issue: 100 })
  expect(r.status, JSON.stringify(r.body)).toBe(200)
  expect(r.body).toMatchObject({ issue: 100, branch: 'plan/offline-mode', worktree: path })
  expect(existsSync(path)).toBe(false)
  expect(processes()).toEqual([])

  const again = await accept(100)
  expect(again.status).toBe(409)
  expect(error(again)).toMatch(/the branch plan\/offline-mode exists already; remove it with git branch -D plan\/offline-mode/)
  git(dir, 'branch', '-D', 'plan/offline-mode')
  expect((await accept(100)).status).toBe(201)
})

test('an acceptance start refuses a spec whose process is a worktree without a record', async () => {
  canSpec(100, ['closed'])
  worktree(dir, 'feat/100-offline-mode')
  const r = await accept(100)
  expect(r.status).toBe(409)
  expect(error(r)).toMatch(/#100 has a process already on feat\/100-offline-mode/)
  expect(processes()).toEqual([])
  expect(git(dir, 'branch', '--list', 'plan/*')).toBe('')
})

const refusedAcceptances: { name: string; arrange: () => void; reason: RegExp }[] = [

  { name: 'an issue that is no spec', arrange: () => canSpec(100, ['closed'], ['enhancement']), reason: /#100 is not a spec/ },
  { name: 'a spec with a ticket open', arrange: () => canSpec(100, ['closed', 'open']), reason: /#100 has 1 ticket\(s\) open \(#102\)/ },
  { name: 'a spec without tickets', arrange: () => canSpec(100, []), reason: /#100 has no tickets/ },
]

for (const c of refusedAcceptances) {
  test(`an acceptance start refuses ${c.name} and creates nothing`, async () => {
    c.arrange()
    const r = await accept(100)
    expect(r.status).toBe(409)
    expect(error(r)).toMatch(c.reason)
    expect(processes()).toEqual([])
    expect(git(dir, 'branch', '--list')).toBe('* main')
  })
}

test('the CLI merges, releases and starts an acceptance, and prints the refusal of each', () => {
  canPull(14, 'dev', 'main')
  const merged = cli(m, ['merge', '14', '--project', dir])
  expect(merged.code, merged.stderr).toBe(0)
  expect(merged.stdout).toBe('merged PR #14 (merge) into main  dev kept (long-lived)  worktree none removed\n')

  canRelease()
  const released = cli(m, ['release', 'v1.0.0'], dir)
  expect(released.code, released.stderr).toBe(0)
  expect(released.stdout).toBe('released v1.0.0  main  target abc123  https://github.com/owner/repo/releases/tag/v1.0.0  milestone closed\n')

  canSpec(100, ['closed'])
  const accepted = cli(m, ['accept', '#100'], dir)
  expect(accepted.code, accepted.stderr).toBe(0)
  expect(accepted.stdout).toBe(`accept #100  plan/offline-mode  from origin/main  running\n  ${join(dir, '.claude', 'worktrees', 'plan-offline-mode')}\n`)

  canPull(15, 'dev', 'main', { isDraft: true })
  const refused = cli(m, ['merge', '15'], dir)
  expect(refused.code).toBe(1)
  expect(refused.stderr).toMatch(/^error: PR #15 is a draft/)
  expect(cli(m, ['release', '1.0'], dir).stderr).toMatch(/^error: unexpected argument 1\.0/)
})
