// The repo-standards plugin's workspace.sh against the scripted gh, whose canned GitHub holds the repository's
// settings. Its dry run is what check.sh reads; applying is controller code, tested in
// controller/test/standard-workspace.test.ts.
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { type Sandbox, sandbox, standards } from './sandbox.js'

const box = sandbox()
const WORKSPACE = join(standards, 'workspace.sh')
const AUTOADD = 'turn on Workflows > Auto-add to project with the filter is:issue,pr is:open for o/r (the API cannot create or turn on project workflows)'
const STATUS = ['Triage', 'Ready', 'In progress', 'In review', 'Done']
const PRIORITY = ['P0', 'P1', 'P2', 'P3']

const milestone = (number: number, title: string, open_issues: number, closed_issues: number) => ({ number, title, state: 'open', open_issues, closed_issues })
const select = (name: string, options: string[]) => ({ name, dataType: 'SINGLE_SELECT', options: options.map((o) => ({ name: o })) })

// project is one projectsV2 node as the GraphQL query returns it, its fields as the standard wants them.
const project = (number: number) => ({
  id: `PVT_${number}`,
  number,
  title: 'r',
  url: `https://github.com/users/o/projects/${number}`,
  closed: false,
  workflows: { nodes: [{ name: 'Auto-add to project', enabled: false }] },
  fields: { nodes: [{ name: 'Title', dataType: 'TITLE' }, select('Status', STATUS), select('Priority', PRIORITY)] },
})

const REPO = {
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
}

// publicMain cans a public repository on main alone, clicked together by hand. Its classic protection of main
// stands; automated-security-fixes is not canned, as GitHub may answer 404 while Dependabot alerts are off.
function publicMain(s: Sandbox) {
  s.onGitHub()
  s.answer('repos/o/r', REPO)
  s.answer('repos/o/r/branches/main/protection', { required_pull_request_reviews: { required_approving_review_count: 1 } })
  s.answer('repos/o/r/rulesets?includes_parents=false&per_page=100', [])
  s.answer('repos/o/r/commits/main/check-runs?check_name=check&per_page=1', { total_count: 1 })
  // GitHub matches label names ignoring case, so Wontfix counts as wontfix.
  s.answer(
    'repos/o/r/labels?per_page=100',
    ['bug', 'enhancement', 'ready-for-agent', 'question', 'Wontfix'].map((name) => ({ name })),
  )
  s.answer('repos/o/r/actions/permissions/workflow', { default_workflow_permissions: 'write', can_approve_pull_request_reviews: true })
  s.answer('repos/o/r/private-vulnerability-reporting', { enabled: false })
  s.answer('repos/o/r/milestones?state=open&per_page=100', [
    milestone(1, 'v0.1.0', 0, 3),
    milestone(2, 'Backlog', 0, 2),
    milestone(3, 'v0.2.0', 0, 0),
    milestone(4, 'v0.3.0', 2, 0),
    milestone(5, 'Someday', 1, 0),
  ])
  s.projects('o/r', [])
}

// privateDevMain cans a private repository on dev plus main that is close to the standard: dev conforms, main has
// a bypass, and its rulesets come as GitHub returns them, with ids, defaults the standard leaves open and rules in
// another order.
function privateDevMain(s: Sandbox) {
  s.onGitHub()
  s.answer('repos/o/r', {
    ...REPO,
    visibility: 'private',
    default_branch: 'dev',
    allow_merge_commit: false,
    allow_rebase_merge: false,
    delete_branch_on_merge: true,
    squash_merge_commit_title: 'PR_TITLE',
    has_wiki: false,
    security_and_analysis: null,
  })
  s.answer(
    'repos/o/r/labels?per_page=100',
    ['ready-for-agent', 'needs-triage', 'needs-info', 'ready-for-human', 'wontfix', 'spec', 'factory', 'factory:spec-run', 'bug', 'enhancement', 'skill-candidate'].map((name) => ({ name })),
  )
  s.answer('repos/o/r/vulnerability-alerts', '')
  s.answer('repos/o/r/automated-security-fixes', { enabled: true, paused: false })
  s.answer('repos/o/r/actions/permissions/workflow', { default_workflow_permissions: 'read' })
  s.answer('repos/o/r/commits/dev/check-runs?check_name=check&per_page=1', { total_count: 1 })
  s.answer('repos/o/r/milestones?state=open&per_page=100', [milestone(1, 'v1.0.0', 1, 4)])
  s.projects('o/r', [project(3)])
  const rules = (methods: string[], linear: boolean) => [
    ...(linear ? [{ type: 'required_linear_history' }] : []),
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
        allowed_merge_methods: methods,
        automatic_copilot_code_review_enabled: false,
      },
    },
  ]
  const ruleset = (id: number, branch: string, bypass: unknown[], methods: string[], linear: boolean) => ({
    id,
    name: `standard: ${branch}`,
    target: 'branch',
    enforcement: 'active',
    source_type: 'Repository',
    bypass_actors: bypass,
    current_user_can_bypass: 'never',
    conditions: { ref_name: { exclude: [], include: [`refs/heads/${branch}`] } },
    rules: rules(methods, linear),
  })
  const sets = [
    ruleset(7, 'dev', [], ['squash'], true),
    ruleset(8, 'main', [{ actor_id: 5, actor_type: 'RepositoryRole', bypass_mode: 'always' }], ['squash', 'merge'], false),
    {
      id: 9,
      name: 'Copilot review for default branch',
      target: 'branch',
      enforcement: 'active',
      source_type: 'Repository',
      bypass_actors: [],
      conditions: { ref_name: { exclude: [], include: ['~DEFAULT_BRANCH'] } },
      rules: [{ type: 'copilot_code_review', parameters: { review_on_push: false } }],
    },
  ]
  s.answer(
    'repos/o/r/rulesets?includes_parents=false&per_page=100',
    sets.map(({ id, name, target, source_type }) => ({ id, name, target, source_type })),
  )
  for (const r of sets) s.answer(`repos/o/r/rulesets/${r.id}`, r)
}

test('the dry run prints every difference and never applies', () => {
  const s = box()
  publicMain(s)
  let r = s.run(WORKSPACE, [], { env: { WF_PROJECT_TEMPLATE: 'tpl-owner/1' } })
  expect(r.code, r.stderr).toBe(0)
  expect(r.stdout).toBe(
    [
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
      'next: the standardize process of the controller makes these changes',
      '',
    ].join('\n'),
  )
  r = s.run(WORKSPACE, ['--apply'])
  expect(r.code).toBe(1)
  expect(r.stderr).toContain('error: unknown argument --apply')
  expect(s.ghCalls().length).toBeGreaterThan(0)
  expect(s.ghCalls().filter((c) => c.includes('--method ') || c.startsWith('project'))).toEqual([])
})

test('the check reports workspace drift, and skips it when GitHub does not answer', () => {
  const s = box()
  expect(s.run(join(standards, 'scaffold.sh')).code).toBe(0)
  s.onGitHub()
  let r = s.run(join(standards, 'check.sh'))
  expect(r.code, r.stdout).toBe(0)
  expect(r.stdout).toContain('skip: GitHub workspace not checked (cannot read repos/o/r:')
  s.git('remote', 'remove', 'origin')
  privateDevMain(s)
  r = s.run(join(standards, 'check.sh'))
  expect(r.code, r.stdout).toBe(0)
  expect(r.stdout.split('\n').filter((l) => l.includes('GitHub workspace'))).toEqual([
    'warn: GitHub workspace: repo allow_merge_commit: false -> true',
    'warn: GitHub workspace: ruleset standard: main: differs -> replace',
    'warn: GitHub workspace: ruleset standard: pre-standard: missing -> create',
    'warn: GitHub workspace differs from the standard; plugins/repo-standards/scripts/workspace.sh shows why, the standardize process of the controller fixes it',
  ])
  // That the check passes once the controller applied the workspace is tested beside the apply, in
  // controller/test/standard-workspace.test.ts.
})
