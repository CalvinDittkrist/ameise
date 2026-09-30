import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { api, canApi, canIssue, canPages, canPulls, checkout, cleanup, cli, type Machine, machine, read, record, start, worktree } from './controller.js'

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
  branches([])
  expect((await api(m, 'POST', '/api/projects', { path: dir })).status).toBe(201)
})

const issue = (number: number, title: string, labels: string[]) => ({ number, title, state: 'open', labels: labels.map((name) => ({ name })) })

// parent is a parent issue as GitHub answers it, of this repository unless another is named.
const parent = (number: number, title: string, labels: string[], repo = 'owner/repo') => ({ ...issue(number, title, labels), repository_url: `https://api.github.com/repos/${repo}` })

// can cans an issue as GitHub answers it.
const can = (number: number, title: string, labels: string[], state?: string) => canIssue(m, 'owner/repo', number, title, labels, state)

const branches = (names: string[]) => canPages(m, 'repos/owner/repo/branches?per_page=100', [names.map((name) => ({ name }))])

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: 'pipe' }).trim()

const claim = (body: Record<string, unknown>) => api(m, 'POST', '/api/processes', { project: dir, ...body })
const abandon = (body: Record<string, unknown>) => api(m, 'DELETE', '/api/processes', { project: dir, ...body })

const processes = () => (existsSync(join(m.state, 'processes')) ? readdirSync(join(m.state, 'processes')) : [])
const worktrees = () => git(dir, 'worktree', 'list', '--porcelain').split('\n').filter((l) => l.startsWith('worktree ')).length - 1
const assigned = () => read(m.ghLog).split('\n').filter((l) => l.startsWith('issue edit'))

interface Claimed {
  record: Record<string, unknown> & { id: string; branch: string; worktree: string; env: Record<string, string> }
  warnings: string[]
}

// nothing says a refused claim left no trace: no worktree, no branch, no assignment and no process.
function nothing() {
  expect(worktrees()).toBe(0)
  expect(git(dir, 'branch', '--list')).toBe('* main')
  expect(assigned()).toEqual([])
  expect(processes()).toEqual([])
}

test('a claim of an agent-ready issue creates branch, worktree, assignment, record and event log, starts its session, and the board shows the process', async () => {
  can(144, 'Board lists every project', ['ready-for-agent'])
  const r = await claim({ issue: 144 })
  expect(r.status, JSON.stringify(r.body)).toBe(201)
  const c = r.body as Claimed
  const branch = 'feat/144-board-lists-every-project'
  const path = join(dir, '.claude', 'worktrees', 'feat-144-board-lists-every-project')
  expect(c.record).toMatchObject({ project: dir, kind: 'work', branch, issue: 144, worktree: path, base: 'origin/main', mode: 'manual', env: {}, state: 'running', stage: 'implement' })
  expect(c.warnings).toEqual([])

  expect(git(path, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(branch)
  expect(git(path, 'rev-parse', 'HEAD')).toBe(git(dir, 'rev-parse', 'origin/main'))
  expect(git(dir, 'status', '--porcelain')).toBe('')
  expect(assigned()).toEqual(['issue edit 144 --repo owner/repo --add-assignee @me'])
  const kept: Partial<Claimed["record"]> = { ...c.record }
  delete kept.updated_at
  expect(JSON.parse(read(join(m.state, 'processes', `${c.record.id}.json`)))).toMatchObject(kept)
  const events = read(join(m.state, 'processes', `${c.record.id}.events.jsonl`)).trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>)
  expect(events.slice(0, 2)).toMatchObject([{ event: 'claimed', issue: 144, branch, mode: 'manual' }, { event: 'session-start', stage: 'implement' }])

  const board = (await api(m, 'GET', '/api/board?' + new URLSearchParams({ project: dir }).toString())).body as { processes: Record<string, unknown>[] }
  expect(board.processes).toMatchObject([{ kind: 'work', issue: 144, branch, worktree: path, state: 'running', stage: 'implement', needs: false, action: 'Open' }])
})

// Each refusal the story names, with the issue as GitHub answers it and what force says of it.
const refusals: { name: string; arrange: () => void; reason: RegExp }[] = [
  { name: 'not agent-ready', arrange: () => can(150, 'Loose idea', ['enhancement']), reason: /#150 is not ready for an agent \(labels: enhancement\)/ },
  { name: 'a spec', arrange: () => can(150, 'Loose idea', ['spec']), reason: /#150 is a spec/ },
  { name: 'routed', arrange: () => can(150, 'Loose idea', ['ready-for-agent', 'factory']), reason: /#150 is routed to the factory/ },
  {
    name: 'a spec run without the human label',
    arrange: () => can(150, 'Loose idea', ['ready-for-agent', 'factory:spec-run']),
    reason: /#150 is a ticket of a spec run/,
  },
  {
    name: 'a ticket whose parent is in a spec run',
    arrange: () => {
      can(150, 'Loose idea', ['ready-for-agent'])
      canApi(m, 'repos/owner/repo/issues/150/parent', parent(100, 'Offline mode', ['spec', 'factory:spec-run']))
    },
    reason: /#150 is a ticket of the spec run of #100/,
  },
  {
    name: 'the branch on origin',
    arrange: () => {
      can(150, 'Loose idea', ['ready-for-agent'])
      branches(['main', 'fix/150-loose-idea-seen-elsewhere'])
      // What this checkout fetched of that branch: one commit past main.
      const tip = git(dir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit-tree', 'HEAD^{tree}', '-p', 'HEAD', '-m', 'remote work')
      git(dir, 'update-ref', 'refs/remotes/origin/fix/150-loose-idea-seen-elsewhere', tip)
    },
    reason: /#150 is claimed on origin already: the branch fix\/150-loose-idea-seen-elsewhere exists there/,
  },
]

for (const r of refusals) {
  test(`a claim refuses an issue that is ${r.name}, and force lifts it`, async () => {
    r.arrange()
    const refused = await claim({ issue: 150 })
    expect(refused.status).toBe(409)
    expect((refused.body as { error: string }).error).toMatch(r.reason)
    nothing()

    const forced = await claim({ issue: 150, force: true })
    expect(forced.status, JSON.stringify(forced.body)).toBe(201)
    const c = forced.body as Claimed
    expect(c.warnings.join('\n')).toMatch(r.reason)
    expect(existsSync(c.record.worktree)).toBe(true)
    if (r.name === 'the branch on origin') {
      // Force adopts the branch on origin: the worktree goes on from its work.
      expect(c.record.branch).toBe('fix/150-loose-idea-seen-elsewhere')
      expect(git(c.record.worktree, 'log', '-1', '--format=%s')).toBe('remote work')
      // The adopted branch is where the worktree starts; it still merges into the project's base.
      expect(c.record).toMatchObject({ base: 'origin/main', start: 'origin/fix/150-loose-idea-seen-elsewhere' })
    }
  })
}

test('a claim refuses a closed issue and one GitHub does not know, force or not', async () => {
  can(160, 'Done already', ['ready-for-agent'], 'CLOSED')
  for (const force of [false, true]) {
    const closed = await claim({ issue: 160, force })
    expect(closed.status).toBe(409)
    expect((closed.body as { error: string }).error).toBe('#160 of owner/repo is CLOSED, not open')
  }
  expect((await claim({ issue: 161 })).status).toBe(502)
  const unknown = await claim({ issue: 161, force: true })
  expect(unknown.status).toBe(502)
  expect((unknown.body as { error: string }).error).toMatch(/^could not read #161 of owner\/repo: /)
  nothing()
})

for (const labelled of [false, true]) {
  test(`a claim of a ready-for-human ticket of a spec run branches from the spec branch, the ticket labelled ${labelled ? 'too' : 'or not'}`, async () => {
    can(150, 'Loose idea', ['ready-for-agent', 'ready-for-human', ...(labelled ? ['factory:spec-run'] : [])])
    canApi(m, 'repos/owner/repo/issues/150/parent', parent(100, 'Offline mode', ['spec', 'factory:spec-run']))
    branches(['main', 'spec/99-other-spec', 'spec/100-offline-mode'])
    // What this checkout fetched of the spec branch: one commit past main.
    const tip = git(dir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit-tree', 'HEAD^{tree}', '-p', 'HEAD', '-m', 'spec work')
    git(dir, 'update-ref', 'refs/remotes/origin/spec/100-offline-mode', tip)

    const r = await claim({ issue: 150 })
    expect(r.status, JSON.stringify(r.body)).toBe(201)
    const c = r.body as Claimed
    expect(c.warnings).toEqual([])
    expect(c.record.base).toBe('origin/spec/100-offline-mode')
    expect(git(c.record.worktree, 'rev-parse', 'HEAD')).toBe(tip)
  })
}

test('a claim of a ticket whose spec run is in another repository neither refuses it nor branches from a spec branch here', async () => {
  for (const [n, labels] of [
    [150, ['ready-for-agent']],
    [151, ['ready-for-agent', 'ready-for-human']],
  ] as const) {
    can(n, 'Loose idea', [...labels])
    canApi(m, `repos/owner/repo/issues/${n}/parent`, parent(100, 'Offline mode', ['spec', 'factory:spec-run'], 'other/specs'))
  }
  branches(['main', 'spec/100-offline-mode'])
  const tip = git(dir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit-tree', 'HEAD^{tree}', '-p', 'HEAD', '-m', 'unrelated spec work')
  git(dir, 'update-ref', 'refs/remotes/origin/spec/100-offline-mode', tip)
  for (const n of [150, 151]) {
    const r = await claim({ issue: n })
    expect(r.status, JSON.stringify(r.body)).toBe(201)
    const c = r.body as Claimed
    expect(c.record.base).toBe('origin/main')
    expect(c.warnings.join('\n')).toMatch(/in another repository \(https:\/\/api.github.com\/repos\/other\/specs\)/)
  }
})

test('a forced claim of a spec adopts its spec branch on origin, and a branch that spells the number otherwise is no branch of the issue', async () => {
  can(104, 'Offline mode', ['spec'])
  branches(['main', 'feat/0104-other-work', 'spec/104-offline-mode'])
  const tip = git(dir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit-tree', 'HEAD^{tree}', '-p', 'HEAD', '-m', 'spec work')
  git(dir, 'update-ref', 'refs/remotes/origin/spec/104-offline-mode', tip)
  const r = await claim({ issue: 104, force: true })
  expect(r.status, JSON.stringify(r.body)).toBe(201)
  const c = r.body as Claimed
  expect(c.warnings.join('\n')).toMatch(/#104 is claimed on origin already: the branch spec\/104-offline-mode exists there/)
  expect(c.record.branch).toBe('spec/104-offline-mode')
  expect(git(c.record.worktree, 'rev-parse', 'HEAD')).toBe(tip)
})

test('a claim refuses an issue that has a process, with or without force', async () => {
  can(144, 'Board lists every project', ['ready-for-agent'])
  expect((await claim({ issue: 144 })).status).toBe(201)
  for (const force of [false, true]) {
    const again = await claim({ issue: 144, force })
    expect(again.status).toBe(409)
    expect((again.body as { error: string }).error).toMatch(/#144 has a process already/)
  }
  expect(worktrees()).toBe(1)
  expect(assigned()).toHaveLength(1)

  // A process known by its record alone counts as well, as does a worktree without a record.
  record(m, 'p7', { project: dir, kind: 'work', branch: 'feat/7-held', issue: 7, stage: 'implement', state: 'running' })
  can(7, 'Held', ['ready-for-agent'])
  expect((await claim({ issue: 7, force: true })).status).toBe(409)
  worktree(dir, 'fix/8-by-hand')
  can(8, 'By hand', ['ready-for-agent'])
  expect((await claim({ issue: 8, force: true })).status).toBe(409)
})

interface BranchCase {
  case: string
  number: number
  title: string
  labels: string[]
  branch: string
}
const fixture = (JSON.parse(read(fileURLToPath(new URL('../../contract/fixture.json', import.meta.url)))) as { branch: { cases: BranchCase[] } }).branch.cases

test('the branch a claim creates agrees with the contract fixture for every case', async () => {
  const got: Record<string, string> = {}
  for (const c of fixture) {
    can(c.number, c.title, [...new Set(['ready-for-agent', ...c.labels])])
    const r = await claim({ issue: c.number })
    expect(r.status, `${c.case}: ${JSON.stringify(r.body)}`).toBe(201)
    got[c.case] = (r.body as Claimed).record.branch
  }
  expect(got).toEqual(Object.fromEntries(fixture.map((c) => [c.case, c.branch])))
})

test('a claim refuses a wrong knob, a malformed override, a repeated name and a wrong mode before anything is created', async () => {
  can(144, 'Board lists every project', ['ready-for-agent'])
  const cases: [Record<string, unknown>, RegExp][] = [
    [{ env: ['WF_NOPE=1'] }, /WF_NOPE is not a worker knob a claim can set; the knobs are WF_REVIEWERS /],
    [{ env: ['WF_REVIEWERS'] }, /the override WF_REVIEWERS has no '='/],
    [{ env: ['=2'] }, /the override =2 has no name/],
    [{ env: ['wf_reviewers=2'] }, /has no usable name/],
    [{ env: ['WF_REVIEWERS=2', 'WF_REVIEWERS=3'] }, /WF_REVIEWERS was given twice/],
    [{ env: 'WF_REVIEWERS=2' }, /env is not a list/],
    [{ env: [2] }, /is not a string/],
    [{ mode: 'auto' }, /mode "auto" is neither manual nor yolo/],
    [{ issue: 'x' }, /issue is not an issue number/],
  ]
  for (const [body, reason] of cases) {
    const r = await claim({ issue: 144, ...body })
    expect(r.status, JSON.stringify(body)).toBe(400)
    expect((r.body as { error: string }).error).toMatch(reason)
  }
  nothing()
  expect(read(m.ghLog)).not.toContain('144')
})

test('a claim refuses a WF_GATE that is no gate form, as an override or in the settings, before anything is created', async () => {
  can(144, 'Board lists every project', ['ready-for-agent'])
  const forms = /the forms are a command such as make check, .* none, .* ci or ci:<jobs> such as ci:check,browser, .* or unset, for make check/
  const cases: [string[], RegExp][] = [
    [['WF_GATE=ci:check,,browser'], /WF_GATE=ci:check,,browser is no gate form: ci:<jobs> names jobs separated by commas; /],
    [['WF_GATE=ci:'], forms],
    [['WF_GATE=make check | tee out'], /holds shell syntax, but the gate runs its command without a shell; /],
    [['WF_GATE= '], forms],
  ]
  for (const [env, reason] of cases) {
    const r = await claim({ issue: 144, env })
    expect(r.status, JSON.stringify(env)).toBe(400)
    expect((r.body as { error: string }).error).toMatch(reason)
  }
  mkdirSync(join(dir, '.claude'), { recursive: true })
  writeFileSync(join(dir, '.claude', 'settings.json'), JSON.stringify({ env: { WF_GATE: 'make && rm -rf x' } }))
  const r = await claim({ issue: 144 })
  expect(r.status).toBe(400)
  expect((r.body as { error: string }).error).toMatch(/^WF_GATE=make && rm -rf x holds shell syntax/)
  nothing()
  expect(read(m.ghLog)).not.toContain('144')
})

test('a claim records the mode and the accepted overrides on the process', async () => {
  can(144, 'Board lists every project', ['ready-for-agent'])
  const r = await claim({ issue: 144, mode: 'yolo', env: ['WF_REVIEWERS=2', 'WF_PR_BOT_REVIEWERS=', 'WF_HANDOFF_TOKENS=a=b'] })
  expect(r.status).toBe(201)
  const c = r.body as Claimed
  const env = { WF_REVIEWERS: '2', WF_PR_BOT_REVIEWERS: '', WF_HANDOFF_TOKENS: 'a=b' }
  expect(c.record).toMatchObject({ mode: 'yolo', env })
  expect(JSON.parse(read(join(m.state, 'processes', `${c.record.id}.json`)))).toMatchObject({ mode: 'yolo', env })
})

test('a claim that GitHub will not assign is undone', async () => {
  can(144, 'Board lists every project', ['ready-for-agent'])
  writeFileSync(join(m.github, 'repos', 'owner', 'repo', 'unassignable'), '')
  const r = await claim({ issue: 144 })
  expect(r.status).toBe(502)
  expect((r.body as { error: string }).error).toMatch(/could not assign #144: .*the claim is undone/)
  expect(worktrees()).toBe(0)
  expect(git(dir, 'branch', '--list')).toBe('* main')
  expect(processes()).toEqual([])
})

test('a claim whose process cannot be written is undone', async () => {
  can(144, 'Board lists every project', ['ready-for-agent'])
  // The processes directory is a file, so no record can be written under it.
  writeFileSync(join(m.state, 'processes'), '')
  const r = await claim({ issue: 144 })
  expect(r.status).toBe(500)
  expect((r.body as { error: string }).error).toMatch(/could not write the process of #144: .*the claim is undone/)
  expect(worktrees()).toBe(0)
  expect(git(dir, 'branch', '--list')).toBe('* main')
  expect(assigned()).toEqual(['issue edit 144 --repo owner/repo --add-assignee @me', 'issue edit 144 --repo owner/repo --remove-assignee @me'])
})

test('abandon removes worktree and process, leaves branch and issue, and refuses work not on origin unless forced', async () => {
  can(144, 'Board lists every project', ['ready-for-agent'])
  const c = (await claim({ issue: 144 })).body as Claimed
  const path = c.record.worktree
  git(path, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'work')
  const refused = await abandon({ issue: 144 })
  expect(refused.status).toBe(409)
  expect((refused.body as { error: string }).error).toMatch(/feat\/144-board-lists-every-project has 1 commit\(s\) not on origin/)
  git(dir, 'update-ref', `refs/remotes/origin/${c.record.branch}`, c.record.branch)
  writeFileSync(join(path, 'draft.txt'), 'draft')
  const dirty = await abandon({ issue: 144 })
  expect(dirty.status).toBe(409)
  expect((dirty.body as { error: string }).error).toMatch(/has changes not committed/)
  expect(existsSync(path)).toBe(true)
  expect(processes()).toHaveLength(2)

  const r = await abandon({ issue: 144, force: true })
  expect(r.status, JSON.stringify(r.body)).toBe(200)
  expect(r.body).toEqual({ issue: 144, branch: c.record.branch, worktree: path })
  expect(existsSync(path)).toBe(false)
  expect(worktrees()).toBe(0)
  expect(processes()).toEqual([])
  expect(git(dir, 'branch', '--list', c.record.branch)).toBe(c.record.branch)
  expect(assigned()).toEqual(['issue edit 144 --repo owner/repo --add-assignee @me'])
  expect((await abandon({ issue: 144 })).status).toBe(404)

  // The issue can be claimed again, and the branch left behind carries on.
  const again = await claim({ issue: 144 })
  expect(again.status, JSON.stringify(again.body)).toBe(201)
  expect(git((again.body as Claimed).record.worktree, 'log', '-1', '--format=%s')).toBe('work')
  expect((await abandon({ issue: 144 })).status).toBe(200)
})

test('the CLI claims and abandons', async () => {
  can(144, 'Board lists every project', ['ready-for-agent'])
  const c = cli(m, ['claim', '144', '--yolo', '--env', 'WF_REVIEWERS=2'], dir)
  expect(c.stderr).toBe('')
  expect(c.code).toBe(0)
  expect(c.stdout).toMatch(/^claimed #144 {2}feat\/144-board-lists-every-project {2}from origin\/main {2}yolo {2}WF_REVIEWERS=2 {2}running\n/)
  const b = cli(m, ['board', dir])
  expect(b.stdout).toMatch(/running +work {2}#144 {2}feat\/144-board-lists-every-project {2}implement {2}running/)

  const refused = cli(m, ['claim', '#144', '--env', 'WF_NOPE=1', '--project', dir])
  expect(refused.code).toBe(1)
  expect(refused.stderr).toMatch(/^error: WF_NOPE is not a worker knob/)

  const a = cli(m, ['abandon', '144', '--project', dir])
  expect(a.code, a.stderr).toBe(0)
  expect(a.stdout).toMatch(/^abandoned #144 {2}feat\/144-board-lists-every-project/)
  expect(processes()).toEqual([])
})
