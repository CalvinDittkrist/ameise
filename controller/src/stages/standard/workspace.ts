// Bring the GitHub workspace of a repository to the standard (docs/repo-standard.md, ADR 0011).
// Without apply nothing changes: it derives the profile, reads the current state and reports one `diff:` line
// per difference. The apply first writes the previous state to the snapshot file (default: a new temporary
// file, reported as `snapshot:`), then makes exactly those changes. Run it again to verify.
// The template of the context (WF_PROJECT_TEMPLATE=<owner>/<number>) is the project copied when the repository
// has none linked.
import { randomBytes } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { pages } from '../../github/board.js'
import { type Ctx, gh, last, say, standardLabels, Stop, tagRuleset } from './lib.js'

// The snapshot goes to the file given, and only an apply writes one.
export type WorkspaceOptions = { apply: false } | { apply: true; snapshot?: string }

type Json = Record<string, unknown>

// show is a JSON value as jq -r prints it inside a string.
const show = (v: unknown) => (v === undefined || v === null ? 'null' : typeof v === 'string' ? v : JSON.stringify(v))
// some is a jq alternative: null and false count as missing.
const some = (v: unknown) => (v === null || v === undefined || v === false ? undefined : v)
const obj = (v: unknown): Json => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Json) : {})
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])

// ruleset is the ruleset of the standard for a branch, named "standard: <branch>" so the next run recognises it.
function ruleset(branch: string, linear: boolean, methods: string[]) {
  return {
    name: `standard: ${branch}`,
    target: 'branch',
    enforcement: 'active',
    bypass_actors: [],
    conditions: { ref_name: { include: [`refs/heads/${branch}`], exclude: [] } },
    rules: [
      { type: 'deletion' },
      { type: 'non_fast_forward' },
      {
        type: 'pull_request',
        parameters: {
          required_approving_review_count: 0,
          dismiss_stale_reviews_on_push: false,
          require_code_owner_review: false,
          require_last_push_approval: false,
          required_review_thread_resolution: true,
          allowed_merge_methods: methods,
        },
      },
      { type: 'required_status_checks', parameters: { strict_required_status_checks_policy: false, required_status_checks: [{ context: 'check' }] } },
      ...(linear ? [{ type: 'required_linear_history' }] : []),
    ],
  }
}

// canon is a ruleset without what GitHub adds and the standard leaves open. Only the pull request rule and the
// required checks carry parameters.
function canon(r: Json) {
  const at = (o: Json, k: string) => (o[k] === undefined ? null : o[k])
  const refs = obj(obj(r.conditions).ref_name)
  const rules = arr(r.rules).map((x) => {
    const rule = obj(x)
    const p = obj(rule.parameters)
    if (rule.type === 'pull_request')
      return {
        type: at(rule, 'type'),
        p: {
          required_approving_review_count: at(p, 'required_approving_review_count'),
          dismiss_stale_reviews_on_push: at(p, 'dismiss_stale_reviews_on_push'),
          require_code_owner_review: at(p, 'require_code_owner_review'),
          require_last_push_approval: at(p, 'require_last_push_approval'),
          required_review_thread_resolution: at(p, 'required_review_thread_resolution'),
          m: [...((some(p.allowed_merge_methods) as string[] | undefined) ?? ['merge', 'rebase', 'squash'])].sort(),
        },
      }
    if (rule.type === 'required_status_checks')
      return {
        type: at(rule, 'type'),
        p: { s: at(p, 'strict_required_status_checks_policy'), c: arr(p.required_status_checks).map((c) => show(obj(c).context)).sort() },
      }
    return { type: at(rule, 'type') }
  })
  return {
    target: at(r, 'target'),
    enforcement: at(r, 'enforcement'),
    bypass_actors: some(r.bypass_actors) ?? [],
    include: [...arr(some(refs.include))].map(String).sort(),
    exclude: [...arr(some(refs.exclude))].map(String).sort(),
    rules: rules.sort((a, b) => (String(a.type) < String(b.type) ? -1 : String(a.type) > String(b.type) ? 1 : 0)),
  }
}

// The fields every project has (docs/repo-standard.md, Projects). A field is matched by name ignoring case and its
// options are compared by name alone, ignoring case and order; colour and description are what a missing field is
// created with, never a reason to report a difference.
const wantFields = [
  {
    name: 'Status',
    options: [
      { name: 'Triage', color: 'GRAY', description: 'Not planned yet' },
      { name: 'Ready', color: 'BLUE', description: 'Ready to be picked up' },
      { name: 'In progress', color: 'YELLOW', description: 'Being worked on' },
      { name: 'In review', color: 'ORANGE', description: 'Waiting for review' },
      { name: 'Done', color: 'GREEN', description: 'Merged or closed' },
    ],
  },
  {
    name: 'Priority',
    options: [
      { name: 'P0', color: 'RED', description: 'Now' },
      { name: 'P1', color: 'ORANGE', description: 'Next' },
      { name: 'P2', color: 'YELLOW', description: 'Soon' },
      { name: 'P3', color: 'GRAY', description: 'Someday' },
    ],
  },
]

// The projects of the repository. The fields of a project are a union; the interface ProjectV2FieldCommon gives
// the name and the type of every member, so a field type GitHub adds later is read too instead of looking like a
// missing field. GitHub caps a project at 50 fields, so the one page of 100 the query asks for is always all of them.
const projectsQuery = `query($o: String!, $n: String!) { repository(owner: $o, name: $n) { projectsV2(first: 20) { nodes {
  id number title url closed workflows(first: 50) { nodes { name enabled } }
  fields(first: 100) { nodes { ... on ProjectV2FieldCommon { name dataType }
    ... on ProjectV2SingleSelectField { options { name } } } } } } } }`
const fieldMutation = `mutation($p: ID!, $n: String!, $o: [ProjectV2SingleSelectFieldOptionInput!]!) {
  createProjectV2Field(input: {projectId: $p, dataType: SINGLE_SELECT, name: $n, singleSelectOptions: $o}) {
    projectV2Field { ... on ProjectV2SingleSelectField { id } } } }`

interface Project {
  id: string
  number: number
  title: string
  url: string
  closed: boolean
  workflows?: { nodes?: { name?: string; enabled?: boolean }[] }
  fields?: { nodes?: { name?: string; dataType?: string; options?: { name: string }[] }[] }
}

// on is whether a setting GitHub reads as {enabled} is on.
const on = (v: string) => {
  try {
    return obj(JSON.parse(v === '' ? 'null' : v)).enabled === true
  } catch {
    return false
  }
}

export async function workspace(c: Ctx, opts: WorkspaceOptions) {
  const tpl = c.template ?? ''
  if (tpl !== '' && !/^[A-Za-z0-9-]+\/[0-9]+$/.test(tpl)) throw new Stop(`WF_PROJECT_TEMPLATE must look like <owner>/<number>, got '${tpl}'`)

  // get is a GitHub API GET; any failure stops the step.
  const get = async (path: string): Promise<unknown> => {
    const r = await gh(c, ['api', path])
    if (r.code !== 0) throw new Stop(`cannot read ${path}: ${last(r.stderr)}`)
    return JSON.parse(r.stdout) as unknown
  }
  // getAll is every page of a list, merged into one array.
  const getAll = async (path: string): Promise<Json[]> => {
    const r = await gh(c, ['api', '--paginate', path])
    if (r.code !== 0) throw new Stop(`cannot read ${path}: ${last(r.stderr)}`)
    return pages<Json>(r.stdout)
  }
  // getOpt is like get, but a 404 answers '' (an empty 2xx answers true). With plan, a 403 because the account's
  // plan lacks the feature answers 'plan' instead of failing.
  const getOpt = async (path: string, plan = false): Promise<string> => {
    const r = await gh(c, ['api', path])
    if (r.code === 0) return r.stdout.trim() === '' ? 'true' : r.stdout
    if (r.stderr.includes('HTTP 404')) return ''
    if (plan && r.stderr.includes('HTTP 403') && /upgrade/i.test(r.stderr)) return 'plan'
    throw new Stop(`cannot read ${path}: ${last(r.stderr)}`)
  }
  // send makes one change; the body goes to gh on stdin.
  const send = async (method: string, path: string, body?: unknown) => {
    const r = body === undefined ? await gh(c, ['api', '--method', method, path]) : await gh(c, ['api', '--method', method, path, '--input', '-'], body)
    if (r.code !== 0) throw new Stop(`${method} ${path} failed: ${last(r.stderr)}; the snapshot has the state before this run`)
  }

  const view = await gh(c, ['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner'])
  if (view.code !== 0) throw new Stop(`cannot read the GitHub repository: ${last(view.stderr)}; run gh auth status`)
  const nwo = view.stdout.trim()
  const owner = nwo.slice(0, nwo.indexOf('/'))
  const name = nwo.slice(nwo.indexOf('/') + 1)
  const repo = obj(await get(`repos/${nwo}`))
  if (obj(repo.permissions).admin !== true) throw new Stop(`admin rights on ${nwo} are needed to read and change its settings`)
  const visibility = show(repo.visibility)
  const defaultBranch = show(repo.default_branch)
  // The profile (ADR 0009): dev plus main when the default branch is dev, otherwise main alone.
  const model = defaultBranch === 'dev' ? 'dev+main' : 'main'
  const branches = defaultBranch === 'dev' ? ['main', 'dev'] : ['main']

  const diffs: string[] = [] // one difference to the standard each
  const manual: string[] = [] // what only a person can change
  const blocked: string[] = [] // the reasons the apply refuses
  if (defaultBranch !== 'main' && defaultBranch !== 'dev')
    blocked.push(
      `the default branch is ${defaultBranch}, but the standard knows main alone or dev plus main; rename it to main (Settings > Branches, or gh api --method POST repos/${nwo}/branches/${defaultBranch}/rename -f new_name=main), then run workspace.sh again`,
    )

  // Merge settings, wiki and discussions. With dev plus main the promotion needs merge commits.
  const wantRepo: Json = {
    allow_squash_merge: true,
    allow_merge_commit: model !== 'main',
    allow_rebase_merge: false,
    delete_branch_on_merge: true,
    squash_merge_commit_title: 'PR_TITLE',
    has_wiki: false,
    has_discussions: false,
  }
  const repoPatch: Json = {}
  for (const [k, v] of Object.entries(wantRepo)) {
    if (isDeepStrictEqual(repo[k] ?? null, v)) continue
    repoPatch[k] = v
    diffs.push(`repo ${k}: ${show(repo[k])} -> ${show(v)}`)
  }

  // Rulesets. Classic branch protection is replaced by the ruleset; it is removed after the ruleset is in place.
  // GitHub answers 403 when the plan has neither (a private repository on GitHub Free).
  let wantRulesets: Json[] = branches.map((b) => (model === 'dev+main' && b === 'main' ? ruleset('main', false, ['merge', 'squash']) : ruleset(b, true, ['squash'])))
  wantRulesets.push(tagRuleset())
  const oldProtection: Json = {}
  const protectionPlan: string[] = []
  const oldRulesets: unknown[] = []
  const rulesetPlan: [string, string, Json][] = []
  let branchRules = false
  let rules = true
  for (const b of branches) {
    const p = await getOpt(`repos/${nwo}/branches/${b}/protection`, true)
    if (p === 'plan') {
      rules = false
      break
    }
    if (p === '') continue
    oldProtection[b] = JSON.parse(p) as unknown
    diffs.push(`branch-protection ${b}: classic -> removed (the ruleset replaces it)`)
    protectionPlan.push(b)
  }
  let existing: Json[] = []
  if (!rules) {
    manual.push('rulesets: not offered for this private repository on its account\'s plan; upgrade the account to GitHub Pro or make the repository public, then run workspace.sh again')
    wantRulesets = []
  } else existing = await getAll(`repos/${nwo}/rulesets?includes_parents=false&per_page=100`)
  for (const want of wantRulesets) {
    const id = some(existing.find((r) => r.name === want.name)?.id)
    if (id === undefined) {
      diffs.push(`ruleset ${show(want.name)}: missing -> create`)
      rulesetPlan.push(['POST', `repos/${nwo}/rulesets`, want])
    } else {
      const cur = obj(await get(`repos/${nwo}/rulesets/${show(id)}`))
      oldRulesets.push(cur)
      if (isDeepStrictEqual(canon(cur), canon(want))) continue
      diffs.push(`ruleset ${show(want.name)}: differs -> replace`)
      rulesetPlan.push(['PUT', `repos/${nwo}/rulesets/${show(id)}`, want])
    }
    if (want.target !== 'tag') branchRules = true
  }

  // The required check must exist before a ruleset requires it, or nothing could merge.
  if (branchRules) {
    const runs = some(obj(await get(`repos/${nwo}/commits/${defaultBranch}/check-runs?check_name=check&per_page=1`)).total_count) ?? 0
    if (runs === 0)
      blocked.push(
        `the default branch ${defaultBranch} has no CI job named check; add a CI job named check that runs make check on every push to ${defaultBranch}, merge it so it runs on the head of ${defaultBranch}, then run workspace.sh --apply again`,
      )
  }

  // Labels: the workflow vocabulary plus skill-candidate; GitHub matches label names ignoring case.
  const labels = await getAll(`repos/${nwo}/labels?per_page=100`)
  const labelPlan = standardLabels().filter((l) => !labels.some((x) => show(x.name).toLowerCase() === l.name))
  for (const l of labelPlan) diffs.push(`label ${l.name}: missing -> create`)

  // Dependabot alerts (204 when on, 404 when off) and security updates; read-only Actions token.
  const alerts = (await getOpt(`repos/${nwo}/vulnerability-alerts`)) !== '' ? 'on' : 'off'
  if (alerts !== 'on') diffs.push('dependabot alerts: off -> on')
  const fixes = on(await getOpt(`repos/${nwo}/automated-security-fixes`)) ? 'on' : 'off'
  if (fixes !== 'on') diffs.push('dependabot security-updates: off -> on')
  const actions = obj(await get(`repos/${nwo}/actions/permissions/workflow`))
  const token = show(actions.default_workflow_permissions)
  if (token !== 'read') diffs.push(`actions default-token: ${token} -> read`)
  const approves = some(actions.can_approve_pull_request_reviews) ?? false
  if (approves !== false) diffs.push('actions token-approves-pull-requests: true -> false')

  // Public repositories: secret scanning, push protection, private vulnerability reporting.
  const sa = obj(repo.security_and_analysis)
  const saPatch: Json = {}
  let pvr = ''
  if (visibility === 'public') {
    for (const k of ['secret_scanning', 'secret_scanning_push_protection']) {
      if (obj(sa[k]).status === 'enabled') continue
      saPatch[k] = { status: 'enabled' }
      diffs.push(`${k.replace(/_/g, '-')}: ${show(some(obj(sa[k]).status) ?? 'disabled')} -> enabled`)
    }
    pvr = on(await getOpt(`repos/${nwo}/private-vulnerability-reporting`)) ? 'on' : 'off'
    if (pvr !== 'on') diffs.push('private-vulnerability-reporting: off -> on')
  } else if ((some(obj(sa.secret_scanning).status) ?? 'unavailable') === 'unavailable') {
    manual.push(
      'secret scanning and push protection: not offered for this private repository (GitHub Secret Protection needs an organisation on GitHub Team or Enterprise); make the repository public or move it to such an organisation to get them',
    )
  }

  // Milestones: close open ones that are empty, or orphaned (not named vX.Y.Z, so never released, and nothing
  // open). Never creates one.
  const close = (await getAll(`repos/${nwo}/milestones?state=open&per_page=100`))
    .filter((m) => m.open_issues === 0 && (m.closed_issues === 0 || !/^v[0-9]+\.[0-9]+\.[0-9]+$/.test(show(m.title))))
    .map((m) => ({ number: m.number as number, title: m.title, open_issues: m.open_issues, closed_issues: m.closed_issues, why: m.closed_issues === 0 ? 'empty' : 'orphaned' }))
    .sort((a, b) => a.number - b.number)
  for (const m of close) diffs.push(`milestone ${show(m.title)}: open, ${m.why} -> closed`)

  // Project: one per repository, copied from the template when none is linked, and carrying the standard's Status
  // and Priority fields. The API cannot create or turn on project workflows.
  const autoadd = `turn on Workflows > Auto-add to project with the filter is:issue,pr is:open for ${nwo} (the API cannot create or turn on project workflows)`
  let projects: Project[] = []
  let projectsRead = true
  let copyProject = false
  const fieldPlan: [string, string, string][] = []
  const read = await gh(c, ['api', 'graphql', '-f', `query=${projectsQuery}`, '-f', `o=${owner}`, '-f', `n=${name}`])
  if (read.code !== 0) {
    if (!read.stderr.includes('read:project')) throw new Stop(`cannot read the projects of ${nwo}: ${last(read.stderr)}`)
    projectsRead = false
    manual.push('project: not checked, the gh token cannot read projects; run gh auth refresh -s project, then run workspace.sh again')
  } else {
    const data = JSON.parse(read.stdout) as { data?: { repository?: { projectsV2?: { nodes?: Project[] } } } }
    projects = (data.data?.repository?.projectsV2?.nodes ?? []).filter((p) => !p.closed)
  }
  if (!projectsRead) {
    // nothing to compare
  } else if (projects.length === 0) {
    if (tpl !== '') {
      diffs.push(`project: none linked -> copy of ${tpl}`)
      copyProject = true
      manual.push(`project (the copy): ${autoadd}`)
    } else manual.push('project: none linked; set WF_PROJECT_TEMPLATE=<owner>/<number> and run again to copy the template project, or create one by hand')
  } else {
    if (projects.length !== 1)
      manual.push(`projects: ${projects.length} open ones are linked (${projects.map((p) => p.url).join(', ')}); the standard wants one; unlink or close the others by hand`)
    for (const p of projects) if (!(p.workflows?.nodes ?? []).some((w) => w.name === 'Auto-add to project' && w.enabled)) manual.push(`project ${p.url}: ${autoadd}`)
    // A field that is there but differs is never rewritten: replacing an option list clears that field on every
    // item. A missing one is created only while a single project is linked, so no write lands in a project the run
    // just asked the maintainer to unlink.
    const single = projects.length === 1
    const names = (xs: { name: string }[]) => xs.map((x) => x.name.toLowerCase()).sort()
    const list = (xs: { name: string }[]) => xs.map((x) => x.name).join(', ')
    for (const p of projects) {
      for (const w of wantFields) {
        const f = (p.fields?.nodes ?? []).find((x) => (x.name ?? '').toLowerCase() === w.name.toLowerCase())
        const where = `project ${p.url} field ${w.name}`
        const wants = list(w.options)
        if (!f) {
          if (single) {
            diffs.push(`${where}: missing -> create single-select with ${wants}`)
            fieldPlan.push([p.id, w.name, p.url])
          } else manual.push(`${where}: missing; the run creates it only while one project is linked, so unlink the others and run again, or create the single-select with ${wants} by hand`)
        } else if (f.dataType !== 'SINGLE_SELECT')
          manual.push(`${where}: a ${(f.dataType ?? 'unknown').toLowerCase().replace(/_/g, ' ')} field, but the standard wants a single-select with ${wants}; change it by hand`)
        else if (!isDeepStrictEqual(names(f.options ?? []), names(w.options)))
          manual.push(`${where}: options ${list(f.options ?? [])}, but the standard wants ${wants}; change them by hand (replacing an option list clears the field on every item)`)
      }
    }
  }

  say(c, `repository: ${nwo}`, `profile: ${visibility}, ${model}`)
  say(c, ...diffs.map((l) => `diff: ${l}`), ...manual.map((l) => `manual: ${l}`), ...blocked.map((l) => `blocked: ${l}`))
  say(c, `differences: ${diffs.length}`)
  if (!opts.apply) {
    if (diffs.length > 0 && blocked.length === 0) say(c, 'next: run workspace.sh --apply to make these changes')
    return
  }
  if (diffs.length === 0) {
    say(c, 'applied: 0')
    return
  }
  if (blocked.length > 0) throw new Stop(`refusing to apply: ${blocked[0]}`)

  // The snapshot holds everything this run replaces, written before the first change.
  const snap = opts.snapshot ?? join(tmpdir(), `workspace-snapshot.${randomBytes(4).toString('hex')}`)
  const pick = (o: Json, keys: string[]) => Object.fromEntries(keys.map((k) => [k, o[k] ?? null]))
  const snapshot = {
    repository: nwo,
    taken_at: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
    repo: pick(repo, [
      'visibility',
      'default_branch',
      'allow_squash_merge',
      'allow_merge_commit',
      'allow_rebase_merge',
      'delete_branch_on_merge',
      'squash_merge_commit_title',
      'squash_merge_commit_message',
      'has_wiki',
      'has_discussions',
      'security_and_analysis',
    ]),
    rulesets: oldRulesets,
    branch_protection: oldProtection,
    labels: labels.map((l) => l.name ?? null),
    dependabot: { alerts, security_updates: fixes },
    actions_default_token: token,
    actions_token_approves_pull_requests: approves,
    private_vulnerability_reporting: pvr === '' ? null : pvr,
    milestones_closed: close,
    projects: projects.map((p) => ({
      number: p.number ?? null,
      title: p.title ?? null,
      url: p.url ?? null,
      fields: (p.fields?.nodes ?? []).map((f) => ({ name: f.name ?? null, dataType: f.dataType ?? null, options: (f.options ?? []).map((o) => o.name ?? null) })),
    })),
  }
  try {
    writeFileSync(snap, JSON.stringify(snapshot, null, 2) + '\n')
  } catch {
    throw new Stop(`cannot write the snapshot to ${snap}; nothing changed`)
  }
  say(c, `snapshot: ${snap}`)

  // GitHub validates the squash title together with the message, so the current message goes along.
  if (Object.keys(repoPatch).length > 0)
    await send('PATCH', `repos/${nwo}`, 'squash_merge_commit_title' in repoPatch ? { ...repoPatch, squash_merge_commit_message: repo.squash_merge_commit_message ?? null } : repoPatch)
  for (const [method, path, body] of rulesetPlan) await send(method, path, body)
  for (const b of protectionPlan) await send('DELETE', `repos/${nwo}/branches/${b}/protection`)
  for (const l of labelPlan) await send('POST', `repos/${nwo}/labels`, { name: l.name, color: l.color, description: l.description })
  if (alerts !== 'on') await send('PUT', `repos/${nwo}/vulnerability-alerts`)
  if (fixes !== 'on') await send('PUT', `repos/${nwo}/automated-security-fixes`)
  if (token !== 'read' || approves !== false) await send('PUT', `repos/${nwo}/actions/permissions/workflow`, '{"default_workflow_permissions":"read","can_approve_pull_request_reviews":false}')
  if (Object.keys(saPatch).length > 0) await send('PATCH', `repos/${nwo}`, { security_and_analysis: saPatch })
  if (pvr !== '' && pvr !== 'on') await send('PUT', `repos/${nwo}/private-vulnerability-reporting`)
  for (const m of close) await send('PATCH', `repos/${nwo}/milestones/${m.number}`, '{"state":"closed"}')
  // A missing project field is created with its options; an existing one is never touched.
  for (const [pid, field, url] of fieldPlan) {
    const r = await gh(c, ['api', 'graphql', '--input', '-'], { query: fieldMutation, variables: { p: pid, n: field, o: wantFields.find((w) => w.name === field)?.options ?? [] } })
    if (r.code !== 0) throw new Stop(`creating the field ${field} on ${url} failed: ${last(r.stderr)}; the snapshot has the state before this run`)
  }
  if (copyProject) {
    const [source, number] = [tpl.slice(0, tpl.indexOf('/')), tpl.slice(tpl.indexOf('/') + 1)]
    const copied = await gh(c, ['project', 'copy', number, '--source-owner', source, '--target-owner', owner, '--title', name, '--format', 'json'])
    if (copied.code !== 0) throw new Stop(`copying project ${tpl} failed: ${last(copied.stderr)}`)
    const copy = JSON.parse(copied.stdout) as { number: number; url: string }
    const linked = await gh(c, ['project', 'link', String(copy.number), '--owner', owner, '--repo', nwo])
    if (linked.code !== 0)
      throw new Stop(`project ${copy.url} was copied but linking it to ${nwo} failed: ${last(linked.stderr)}; link it with gh project link ${copy.number} --owner ${owner} --repo ${nwo}`)
    say(c, `project: ${copy.url}`)
  }
  say(c, `applied: ${diffs.length}`)
}
