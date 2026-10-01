// The GitHub workspace step against the stateful gh shim: its files hold the GitHub state and every write changes it.
import { existsSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { plugin } from '../src/standard/lib.js'
import { workspace } from '../src/standard/workspace.js'
import { type Fixture, fixture } from './standard.js'

const repo = fixture()

const AUTOADD =
  'turn on Workflows > Auto-add to project with the filter is:issue,pr is:open for o/r (the API cannot create or turn on project workflows)'
const STATUS = ['Triage', 'Ready', 'In progress', 'In review', 'Done']
const PRIORITY = ['P0', 'P1', 'P2', 'P3']

type Json = Record<string, unknown>

const milestone = (number: number, title: string, open_issues: number, closed_issues: number, state = 'open') => ({ number, title, state, open_issues, closed_issues })
const select = (name: string, options: string[]) => ({ name, dataType: 'SINGLE_SELECT', options: options.map((o) => ({ name: o })) })

// project is one projectsV2 node as the GraphQL query returns it; by default its fields match the standard.
function project(number: number, opts: { fields?: Json[]; autoadd?: boolean; closed?: boolean } = {}) {
  const fields = opts.fields ?? [select('Status', STATUS), select('Priority', PRIORITY)]
  return {
    id: `PVT_${number}`,
    number,
    title: 'r',
    url: `https://github.com/users/o/projects/${number}`,
    closed: opts.closed ?? false,
    workflows: { nodes: [{ name: 'Auto-add to project', enabled: opts.autoadd ?? false }] },
    fields: { nodes: [{ name: 'Title', dataType: 'TITLE' }, ...fields] },
  }
}

// publicMain is a public repository on main alone, clicked together by hand.
function publicMain(f: Fixture) {
  f.put('repo.json', {
    visibility: 'public',
    default_branch: 'main',
    permissions: { admin: true },
    allow_squash_merge: true,
    allow_merge_commit: true,
    allow_rebase_merge: true,
    delete_branch_on_merge: false,
    squash_merge_commit_title: 'COMMIT_OR_PR_TITLE',
    squash_merge_commit_message: 'COMMIT_MESSAGES',
    has_wiki: true,
    has_discussions: false,
    security_and_analysis: { secret_scanning: { status: 'disabled' }, secret_scanning_push_protection: { status: 'disabled' } },
  })
  // GitHub matches label names ignoring case, so Wontfix counts as wontfix.
  f.put(
    'labels.json',
    ['bug', 'enhancement', 'ready-for-agent', 'question', 'Wontfix'].map((name) => ({ name })),
  )
  // automated-security-fixes.json is absent: GitHub may answer 404 while Dependabot alerts are off.
  f.put('actions-workflow.json', { default_workflow_permissions: 'write', can_approve_pull_request_reviews: true })
  f.put('private-vulnerability-reporting.json', { enabled: false })
  f.put('protection-main.json', { required_pull_request_reviews: { required_approving_review_count: 1 } })
  f.put('milestones.json', [
    milestone(1, 'v0.1.0', 0, 3),
    milestone(2, 'Backlog', 0, 2),
    milestone(3, 'v0.2.0', 0, 0),
    milestone(4, 'v0.3.0', 2, 0),
    milestone(5, 'Someday', 1, 0),
    milestone(6, 'old', 0, 0, 'closed'),
  ])
  f.put('projects.json', [])
}

// privateDevMain is a private repository on dev plus main that is close to the standard: dev conforms, main has a
// bypass.
function privateDevMain(f: Fixture) {
  publicMain(f)
  f.put('repo.json', {
    ...f.github<Json>('repo.json'),
    visibility: 'private',
    default_branch: 'dev',
    allow_merge_commit: false,
    allow_rebase_merge: false,
    delete_branch_on_merge: true,
    squash_merge_commit_title: 'PR_TITLE',
    has_wiki: false,
    security_and_analysis: null,
  })
  f.put(
    'labels.json',
    ['ready-for-agent', 'needs-triage', 'needs-info', 'ready-for-human', 'wontfix', 'spec', 'factory', 'factory:spec-run', 'bug', 'enhancement', 'skill-candidate'].map((name) => ({ name })),
  )
  f.put('vulnerability-alerts', '')
  f.put('automated-security-fixes.json', { enabled: true, paused: false })
  f.put('actions-workflow.json', { default_workflow_permissions: 'read' })
  unlinkSync(join(f.ws, 'private-vulnerability-reporting.json'))
  unlinkSync(join(f.ws, 'protection-main.json'))
  f.put('milestones.json', [milestone(1, 'v1.0.0', 1, 4)])
  f.put('projects.json', [project(3)])
  // As GitHub returns them: ids, defaults the standard leaves open, rules in another order.
  const dev = {
    id: 7,
    name: 'standard: dev',
    target: 'branch',
    enforcement: 'active',
    source_type: 'Repository',
    bypass_actors: [] as Json[],
    current_user_can_bypass: 'never',
    conditions: { ref_name: { exclude: [], include: ['refs/heads/dev'] } },
    rules: [
      { type: 'required_linear_history' },
      { type: 'deletion' },
      { type: 'non_fast_forward' },
      {
        type: 'required_status_checks',
        parameters: { strict_required_status_checks_policy: false, do_not_enforce_on_create: false, required_status_checks: [{ context: 'check', integration_id: 15368 }] },
      },
      {
        type: 'pull_request',
        parameters: {
          required_approving_review_count: 0,
          dismiss_stale_reviews_on_push: false,
          require_code_owner_review: false,
          require_last_push_approval: false,
          required_review_thread_resolution: true,
          allowed_merge_methods: ['squash'],
          automatic_copilot_code_review_enabled: false,
        },
      },
    ] as Json[],
  }
  const main = structuredClone(dev)
  Object.assign(main, {
    id: 8,
    name: 'standard: main',
    bypass_actors: [{ actor_id: 5, actor_type: 'RepositoryRole', bypass_mode: 'always' }],
    conditions: { ref_name: { exclude: [], include: ['refs/heads/main'] } },
  })
  main.rules = main.rules.filter((r) => r.type !== 'required_linear_history')
  ;(main.rules.at(-1)?.parameters as Json).allowed_merge_methods = ['squash', 'merge']
  const copilot = {
    id: 9,
    name: 'Copilot review for default branch',
    target: 'branch',
    enforcement: 'active',
    bypass_actors: [],
    conditions: { ref_name: { exclude: [], include: ['~DEFAULT_BRANCH'] } },
    rules: [{ type: 'copilot_code_review', parameters: { review_on_push: false } }],
  }
  for (const r of [dev, main, copilot]) f.put(`ruleset-${r.id}.json`, r)
}

const dry = (f: Fixture, opts: { template?: string; env?: Record<string, string> } = {}) => f.run((c) => workspace(c, { apply: false }), opts)
const apply = (f: Fixture, snapshot?: string, opts: { template?: string; env?: Record<string, string> } = {}) =>
  f.run((c) => workspace(c, snapshot === undefined ? { apply: true } : { apply: true, snapshot }), opts)

const writes = (f: Fixture) =>
  f.calls().filter((c) => c.includes(' --method ') || c.startsWith('gh project copy') || c.startsWith('gh project link') || c.startsWith('gh api graphql --input -'))
const input = (call: string) => JSON.parse(call.split(' --input - ', 2)[1] ?? '') as Json

// body is the payload of the one logged write that starts with prefix.
function body(f: Fixture, prefix: string): Json {
  const hits = writes(f).filter((c) => c.startsWith(prefix))
  expect(hits).toHaveLength(1)
  return input(hits[0] as string)
}

async function cleanSecondRun(f: Fixture) {
  f.resetCalls()
  let r = await dry(f)
  expect(r.code, r.out).toBe(0)
  expect(r.out).not.toContain('diff:')
  expect(r.out).toContain('differences: 0')
  r = await apply(f)
  expect(r.code, r.out).toBe(0)
  expect(r.out).toContain('applied: 0')
  expect(r.out).not.toContain('snapshot:')
  expect(writes(f)).toEqual([])
  return r
}

const PUBLIC_MAIN_DRY_RUN = [
  'repository: o/r',
  'profile: public, main',
  'diff: repo allow_merge_commit: true -> false',
  'diff: repo allow_rebase_merge: true -> false',
  'diff: repo delete_branch_on_merge: false -> true',
  'diff: repo squash_merge_commit_title: COMMIT_OR_PR_TITLE -> PR_TITLE',
  'diff: repo has_wiki: true -> false',
  'diff: branch-protection main: classic -> removed (the ruleset replaces it)',
  'diff: ruleset standard: main: missing -> create',
  'diff: ruleset standard: pre-standard: missing -> create',
  'diff: label needs-triage: missing -> create',
  'diff: label needs-info: missing -> create',
  'diff: label ready-for-human: missing -> create',
  'diff: label spec: missing -> create',
  'diff: label factory: missing -> create',
  'diff: label factory:spec-run: missing -> create',
  'diff: label skill-candidate: missing -> create',
  'diff: dependabot alerts: off -> on',
  'diff: dependabot security-updates: off -> on',
  'diff: actions default-token: write -> read',
  'diff: actions token-approves-pull-requests: true -> false',
  'diff: secret-scanning: disabled -> enabled',
  'diff: secret-scanning-push-protection: disabled -> enabled',
  'diff: private-vulnerability-reporting: off -> on',
  'diff: milestone Backlog: open, orphaned -> closed',
  'diff: milestone v0.2.0: open, empty -> closed',
  'diff: project: none linked -> copy of tpl-owner/1',
  `manual: project (the copy): ${AUTOADD}`,
  'differences: 25',
]

describe('workspace', { timeout: 60_000 }, () => {
  test('a public repository on main: the dry run says every difference and changes nothing', async () => {
    const f = repo()
    publicMain(f)
    const r = await dry(f, { template: 'tpl-owner/1' })
    expect(r.code, r.out).toBe(0)
    expect(r.lines).toEqual([...PUBLIC_MAIN_DRY_RUN, 'next: run workspace.sh --apply to make these changes'])
    expect(writes(f)).toEqual([])
    expect((await dry(f, { template: 'tpl-owner/1' })).lines, 'the output is stable').toEqual(r.lines)
  })

  test('the plugin copy says the same dry run and never applies', async () => {
    // The plugin keeps the dry run for check.sh; applying is the controller's standardize process.
    const f = repo()
    publicMain(f)
    const want = (await dry(f, { template: 'tpl-owner/1' })).lines.slice(0, -1)
    const r = await f.run(async (c) => {
      const p = await plugin(c, 'workspace.sh', [], c.root, { env: { WF_PROJECT_TEMPLATE: 'tpl-owner/1' } })
      c.lines.push(...p.stdout.split('\n').filter((l) => l !== ''))
      return p.code
    })
    expect(r.code, r.out).toBe(0)
    expect(r.lines).toEqual([...want, 'next: the standardize process of the controller makes these changes'])
  })

  test('a public repository on main: the apply snapshots first, changes exactly the differences and is idempotent', async () => {
    const f = repo()
    publicMain(f)
    const before = {
      repo: f.github<Json>('repo.json'),
      protection: f.github<Json>('protection-main.json'),
    }
    const snap = join(f.base, 'snapshot.json')
    const r = await apply(f, snap, { template: 'tpl-owner/1' })
    expect(r.code, r.out).toBe(0)
    expect(r.out).toContain(`snapshot: ${snap}`)
    expect(r.out).toContain('project: https://github.com/users/o/projects/12')
    expect(r.out.endsWith('applied: 25\n'), r.out).toBe(true)

    const s = JSON.parse(readFileSync(snap, 'utf8')) as Json & { repo: Json; milestones_closed: { title: string }[] }
    expect(s.repository).toBe('o/r')
    expect(s.repo.allow_rebase_merge).toBe(true)
    expect(s.repo.security_and_analysis).toEqual(before.repo.security_and_analysis)
    expect(s.branch_protection).toEqual({ main: before.protection })
    expect(s.labels).toEqual(['bug', 'enhancement', 'ready-for-agent', 'question', 'Wontfix'])
    expect(s.dependabot).toEqual({ alerts: 'off', security_updates: 'off' })
    expect(s.actions_default_token).toBe('write')
    expect(s.actions_token_approves_pull_requests).toBe(true)
    expect(s.private_vulnerability_reporting).toBe('off')
    expect(s.milestones_closed.map((m) => m.title)).toEqual(['Backlog', 'v0.2.0'])

    expect(writes(f).map((c) => c.split(' --input - ')[0])).toEqual([
      'gh api --method PATCH repos/o/r',
      'gh api --method POST repos/o/r/rulesets',
      'gh api --method POST repos/o/r/rulesets',
      'gh api --method DELETE repos/o/r/branches/main/protection',
      ...Array<string>(7).fill('gh api --method POST repos/o/r/labels'),
      'gh api --method PUT repos/o/r/vulnerability-alerts',
      'gh api --method PUT repos/o/r/automated-security-fixes',
      'gh api --method PUT repos/o/r/actions/permissions/workflow',
      'gh api --method PATCH repos/o/r',
      'gh api --method PUT repos/o/r/private-vulnerability-reporting',
      'gh api --method PATCH repos/o/r/milestones/2',
      'gh api --method PATCH repos/o/r/milestones/3',
      'gh project copy 1 --source-owner tpl-owner --target-owner o --title r --format json',
      'gh project link 12 --owner o --repo o/r',
    ])
    expect(body(f, 'gh api --method PATCH repos/o/r --input - {"allow')).toEqual({
      allow_merge_commit: false,
      allow_rebase_merge: false,
      delete_branch_on_merge: true,
      squash_merge_commit_title: 'PR_TITLE',
      squash_merge_commit_message: 'COMMIT_MESSAGES',
      has_wiki: false,
    })
    type Ruleset = { name: string; target: string; bypass_actors: unknown[]; conditions: { ref_name: { include: string[] } }; rules: { type: string; parameters?: Json }[] }
    const [main, tag] = writes(f)
      .filter((c) => c.includes('rulesets'))
      .map((c) => input(c) as unknown as Ruleset)
    expect(main?.name).toBe('standard: main')
    expect(main?.bypass_actors).toEqual([])
    expect(main?.conditions.ref_name.include).toEqual(['refs/heads/main'])
    const rules = Object.fromEntries((main?.rules ?? []).map((x) => [x.type, x.parameters]))
    expect(new Set(Object.keys(rules))).toEqual(new Set(['deletion', 'non_fast_forward', 'pull_request', 'required_status_checks', 'required_linear_history']))
    expect(rules.pull_request?.required_approving_review_count).toBe(0)
    expect(rules.pull_request?.required_review_thread_resolution).toBe(true)
    expect(rules.pull_request?.allowed_merge_methods).toEqual(['squash'])
    expect(rules.required_status_checks?.required_status_checks).toEqual([{ context: 'check' }])
    expect(tag?.target).toBe('tag')
    expect(tag?.conditions.ref_name.include).toEqual(['refs/tags/pre-standard'])
    expect(new Set(tag?.rules.map((x) => x.type))).toEqual(new Set(['deletion', 'update']))
    const labels = writes(f)
      .filter((c) => c.includes('/labels'))
      .map(input)
    expect(labels.at(-1)).toEqual({ name: 'skill-candidate', color: 'C5DEF5', description: 'A removed skill that could move into the marketplace' })
    expect(body(f, 'gh api --method PUT repos/o/r/actions/permissions/workflow')).toEqual({ default_workflow_permissions: 'read', can_approve_pull_request_reviews: false })
    expect(body(f, 'gh api --method PATCH repos/o/r --input - {"security')).toEqual({
      security_and_analysis: { secret_scanning: { status: 'enabled' }, secret_scanning_push_protection: { status: 'enabled' } },
    })
    expect(body(f, 'gh api --method PATCH repos/o/r/milestones/2')).toEqual({ state: 'closed' })
    expect(f.calls().some((c) => c.includes('milestones') && c.includes('POST')), 'no milestone is created').toBe(false)

    // The copied project has auto-add off, which only a person can turn on.
    expect((await cleanSecondRun(f)).out).toContain(`manual: project https://github.com/users/o/projects/12: ${AUTOADD}`)
  })

  test('a private repository on dev plus main replaces only the drifted ruleset and keeps the others', async () => {
    const f = repo()
    privateDevMain(f)
    let r = await dry(f)
    expect(r.code, r.out).toBe(0)
    expect(r.lines).toEqual([
      'repository: o/r',
      'profile: private, dev+main',
      'diff: repo allow_merge_commit: false -> true',
      'diff: ruleset standard: main: differs -> replace',
      'diff: ruleset standard: pre-standard: missing -> create',
      'manual: secret scanning and push protection: not offered for this private repository (GitHub Secret Protection needs an organisation on GitHub Team or Enterprise); make the repository public or move it to such an organisation to get them',
      `manual: project https://github.com/users/o/projects/3: ${AUTOADD}`,
      'differences: 3',
      'next: run workspace.sh --apply to make these changes',
    ])
    expect(f.calls().some((c) => c.includes('private-vulnerability-reporting'))).toBe(false)

    r = await apply(f)
    expect(r.code, r.out).toBe(0)
    const snap = r.lines.find((l) => l.startsWith('snapshot: '))?.slice('snapshot: '.length) ?? ''
    try {
      expect(snap.startsWith(join(tmpdir(), 'workspace-snapshot.')), snap).toBe(true)
      expect((JSON.parse(readFileSync(snap, 'utf8')) as { rulesets: { name: string }[] }).rulesets.map((x) => x.name)).toEqual(['standard: main', 'standard: dev'])
    } finally {
      rmSync(snap, { force: true })
    }
    expect(writes(f).map((c) => c.split(' --input - ')[0])).toEqual(['gh api --method PATCH repos/o/r', 'gh api --method PUT repos/o/r/rulesets/8', 'gh api --method POST repos/o/r/rulesets'])
    expect(body(f, 'gh api --method PATCH repos/o/r')).toEqual({ allow_merge_commit: true })
    const main = body(f, 'gh api --method PUT repos/o/r/rulesets/8') as { bypass_actors: unknown[]; rules: { type: string; parameters?: Json }[] }
    expect(main.bypass_actors).toEqual([])
    const rules = Object.fromEntries(main.rules.map((x) => [x.type, x.parameters]))
    expect(rules, 'the promotion lands on main as a merge commit').not.toHaveProperty('required_linear_history')
    expect(rules.pull_request?.allowed_merge_methods).toEqual(['merge', 'squash'])
    expect(readFileSync(join(f.ws, 'ruleset-9.json'), 'utf8')).toContain('Copilot review')
    await cleanSecondRun(f)
  })

  test('the apply refuses the branch ruleset until the default branch has a check job', async () => {
    const f = repo()
    publicMain(f)
    writeFileSync(join(f.ws, 'check-runs'), '0')
    let r = await dry(f)
    expect(r.code, r.out).toBe(0)
    expect(r.out).toContain(
      'blocked: the default branch main has no CI job named check; add a CI job named check that runs make check on every push to main, merge it so it runs on the head of main, then run workspace.sh --apply again',
    )
    const snap = join(f.base, 'snapshot.json')
    r = await apply(f, snap)
    expect(r.code).toBe(1)
    expect(r.out).toContain('error: refusing to apply: the default branch main has no CI job named check')
    expect(writes(f)).toEqual([])
    expect(existsSync(snap)).toBe(false)
  })

  test('without a template a missing project is a manual step, not a difference', async () => {
    const f = repo()
    publicMain(f)
    let r = await dry(f)
    expect(r.out).toContain('manual: project: none linked; set WF_PROJECT_TEMPLATE=<owner>/<number> and run again to copy the template project, or create one by hand')
    expect(r.out).toContain('differences: 24')
    expect(r.out).not.toContain('diff: project')
    r = await dry(f, { template: 'not a project' })
    expect(r.code).toBe(1)
    expect(r.out).toContain('error: WF_PROJECT_TEMPLATE must look like <owner>/<number>')
  })

  test('a failed write stops the run and leaves the snapshot of the state before', async () => {
    const f = repo()
    publicMain(f)
    const snap = join(f.base, 'snapshot.json')
    let r = await apply(f, snap, { env: { SHIM_WS_FAIL: 'api --method POST repos/o/r/labels' } })
    expect(r.code).toBe(1)
    expect(r.out).toContain('error: POST repos/o/r/labels failed: gh: Validation Failed (HTTP 422); the snapshot has the state before this run')
    expect((JSON.parse(readFileSync(snap, 'utf8')) as { repo: Json }).repo.allow_rebase_merge).toBe(true)
    expect(
      writes(f).some((c) => c.includes('vulnerability-alerts')),
      'nothing after the failure ran',
    ).toBe(false)
    r = await apply(f, snap)
    expect(r.code, r.out).toBe(0)
    expect(r.out, 'a second run continues where the first stopped').not.toContain('diff: repo')
    await cleanSecondRun(f)
  })

  test('a private repository without rulesets on its plan gets a manual step', async () => {
    const f = repo()
    privateDevMain(f)
    f.put('plan-free', '')
    const r = await dry(f)
    expect(r.code, r.out).toBe(0)
    expect(r.out).toContain(
      "manual: rulesets: not offered for this private repository on its account's plan; upgrade the account to GitHub Pro or make the repository public, then run workspace.sh again",
    )
    expect(r.out).not.toContain('diff: ruleset')
    expect(r.out).toContain('differences: 1')
    const a = await apply(f)
    expect(a.code, a.out).toBe(0)
    expect(writes(f).some((c) => c.includes('rulesets') || c.includes('protection'))).toBe(false)
    const snap = a.lines.find((l) => l.startsWith('snapshot: '))
    if (snap) rmSync(snap.slice('snapshot: '.length), { force: true })
  })

  test('a token without the project scope skips only the project', async () => {
    const f = repo()
    publicMain(f)
    f.put('no-project-scope', '')
    const r = await dry(f, { template: 'tpl-owner/1' })
    expect(r.code, r.out).toBe(0)
    expect(r.out).toContain('manual: project: not checked, the gh token cannot read projects; run gh auth refresh -s project, then run workspace.sh again')
    expect(r.out).not.toContain('diff: project')
    expect(r.out, 'no field is checked without the scope').not.toContain(' field ')
    expect(r.out).toContain('differences: 24')
  })

  test('a default branch outside the two models blocks the apply', async () => {
    const f = repo()
    publicMain(f)
    f.put('repo.json', { ...f.github<Json>('repo.json'), default_branch: 'master' })
    let r = await dry(f)
    expect(r.out).toContain('blocked: the default branch is master, but the standard knows main alone or dev plus main; rename it to main')
    expect(r.out).not.toContain('next:')
    r = await apply(f)
    expect(r.code).toBe(1)
    expect(r.out).toContain('error: refusing to apply: the default branch is master')
    expect(writes(f)).toEqual([])
  })

  test('refuses without admin rights', async () => {
    const f = repo()
    publicMain(f)
    f.put('repo.json', { ...f.github<Json>('repo.json'), permissions: { admin: false, push: true } })
    const r = await dry(f)
    expect(r.code).toBe(1)
    expect(r.out).toContain('error: admin rights on o/r are needed')
  })

  test('a project field that is missing is created and one that differs is left to a person', async () => {
    const f = repo()
    publicMain(f)
    // What GitHub gives a new project: Status with its own options, no Priority.
    f.put('projects.json', [project(3, { fields: [select('Status', ['Todo', 'In progress', 'Done'])], autoadd: true })])
    const url = 'https://github.com/users/o/projects/3'
    let r = await dry(f)
    expect(r.code, r.out).toBe(0)
    expect(r.out).toContain(`diff: project ${url} field Priority: missing -> create single-select with P0, P1, P2, P3`)
    const status = `manual: project ${url} field Status: options Todo, In progress, Done, but the standard wants Triage, Ready, In progress, In review, Done; change them by hand (replacing an option list clears the field on every item)`
    expect(r.out).toContain(status)
    expect(r.out).toContain('differences: 25')
    expect(writes(f)).toEqual([])

    const snap = join(f.base, 'snapshot.json')
    r = await apply(f, snap)
    expect(r.code, r.out).toBe(0)
    expect((JSON.parse(readFileSync(snap, 'utf8')) as { projects: unknown }).projects, 'the snapshot holds the fields as they were before the run').toEqual([
      {
        number: 3,
        title: 'r',
        url,
        fields: [
          { name: 'Title', dataType: 'TITLE', options: [] },
          { name: 'Status', dataType: 'SINGLE_SELECT', options: ['Todo', 'In progress', 'Done'] },
        ],
      },
    ])
    const created = writes(f).filter((c) => c.startsWith('gh api graphql --input -'))
    expect(created).toHaveLength(1)
    const b = input(created[0] as string) as { query: string; variables: { p: string; n: string; o: { name: string; color: string; description: string }[] } }
    expect(b.query).toContain('createProjectV2Field')
    expect(b.variables.p).toBe('PVT_3')
    expect(b.variables.n).toBe('Priority')
    expect(b.variables.o.map((o) => o.name)).toEqual(PRIORITY)
    expect(b.variables.o.every((o) => o.color && o.description)).toBe(true)

    f.resetCalls()
    r = await dry(f)
    expect(r.code, r.out).toBe(0)
    expect(r.out).not.toContain('diff:')
    expect(r.out).toContain(status)
    expect(r.out, 'the created field matches the standard').not.toContain('field Priority')
    expect(r.out).toContain('differences: 0')
  })

  test('project field options match in any order and casing', async () => {
    const f = repo()
    privateDevMain(f)
    f.put('projects.json', [project(3, { fields: [select('status', ['done', 'IN REVIEW', 'In progress', 'ready', 'TRIAGE']), select('Priority', ['P3', 'P2', 'P1', 'P0'])] })])
    const r = await dry(f)
    expect(r.code, r.out).toBe(0)
    expect(r.out).not.toContain(' field ')
    expect(r.out).toContain('differences: 3')
  })

  test('an extra option or a field of another type is a manual step and nothing is written', async () => {
    const f = repo()
    privateDevMain(f)
    const url = 'https://github.com/users/o/projects/3'
    f.put('projects.json', [project(3, { fields: [select('Status', [...STATUS, 'Blocked']), { name: 'Priority', dataType: 'TEXT' }] })])
    const r = await dry(f)
    expect(r.code, r.out).toBe(0)
    expect(r.out).toContain(
      `manual: project ${url} field Status: options Triage, Ready, In progress, In review, Done, Blocked, but the standard wants Triage, Ready, In progress, In review, Done; change them by hand (replacing an option list clears the field on every item)`,
    )
    expect(r.out).toContain(`manual: project ${url} field Priority: a text field, but the standard wants a single-select with P0, P1, P2, P3; change it by hand`)
    expect(r.out).not.toContain('diff: project')
    expect(r.out).toContain('differences: 3')
    const a = await apply(f, join(f.base, 'snapshot.json'))
    expect(a.code, a.out).toBe(0)
    expect(
      writes(f).filter((c) => c.includes('graphql')),
      'an existing field is never rewritten',
    ).toEqual([])
  })

  test('more than one open project is a manual step and every one is checked but none is written', async () => {
    const f = repo()
    privateDevMain(f)
    f.put('projects.json', [project(3), project(4, { fields: [select('Status', STATUS)], autoadd: true }), project(5, { closed: true, fields: [] })])
    const r = await dry(f)
    expect(r.code, r.out).toBe(0)
    expect(r.out).toContain(
      'manual: projects: 2 open ones are linked (https://github.com/users/o/projects/3, https://github.com/users/o/projects/4); the standard wants one; unlink or close the others by hand',
    )
    expect(r.out, 'a closed project is not checked').not.toContain('projects/5')
    // The missing field is reported, but creating it would write into a project the run just asked to unlink.
    expect(r.out).toContain(
      'manual: project https://github.com/users/o/projects/4 field Priority: missing; the run creates it only while one project is linked, so unlink the others and run again, or create the single-select with P0, P1, P2, P3 by hand',
    )
    expect(r.out).not.toContain('projects/3 field')
    expect(r.out).not.toContain('diff: project')
    expect(r.out).toContain('differences: 3')
    const a = await apply(f, join(f.base, 'snapshot.json'))
    expect(a.code, a.out).toBe(0)
    expect(
      writes(f).filter((c) => c.includes('graphql')),
      'no field is created',
    ).toEqual([])
  })

  test('a field type the query cannot read does not hide the other fields', async () => {
    const f = repo()
    privateDevMain(f)
    // A field type that implements none of the query's fragments comes back as an empty node.
    f.put('projects.json', [project(3, { fields: [{}, select('Status', STATUS)] })])
    const r = await dry(f)
    expect(r.code, r.out).toBe(0)
    expect(r.out).toContain('diff: project https://github.com/users/o/projects/3 field Priority: missing -> create single-select with P0, P1, P2, P3')
    expect(r.out).toContain('differences: 4')
  })

  test('a failed field creation stops the run and names the project', async () => {
    const f = repo()
    privateDevMain(f)
    f.put('projects.json', [project(3, { fields: [select('Status', STATUS)] })])
    const snap = join(f.base, 'snapshot.json')
    const r = await apply(f, snap, { env: { SHIM_WS_FAIL: 'api graphql --input -' } })
    expect(r.code).toBe(1)
    expect(r.out).toContain(
      'error: creating the field Priority on https://github.com/users/o/projects/3 failed: gh: Validation Failed (HTTP 422); the snapshot has the state before this run',
    )
    const projects = (JSON.parse(readFileSync(snap, 'utf8')) as { projects: { fields: { name: string }[] }[] }).projects
    expect(projects[0]?.fields.at(-1)?.name).toBe('Status')
  })

  test("after the apply the plugin's check finds the workspace at the standard", async () => {
    const f = repo()
    privateDevMain(f)
    const check = async () => {
      const r = await f.run(async (c) => {
        const p = await plugin(c, 'check.sh', [], c.root)
        c.lines.push(...p.stdout.split('\n').filter((l) => l.includes('GitHub workspace')))
      })
      return r.lines
    }
    expect(await check()).toContain('warn: GitHub workspace: repo allow_merge_commit: false -> true')
    const a = await apply(f, join(f.base, 'snapshot.json'))
    expect(a.code, a.out).toBe(0)
    const after = await check()
    expect(after).toContain('ok: GitHub workspace matches the standard')
    expect(after.filter((l) => l.startsWith('warn: GitHub workspace'))).toEqual([])
  })
})
