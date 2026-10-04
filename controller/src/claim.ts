// Claim and abandon: a claim takes an agent-ready issue of a project into a work process, an abandon
// drops the process again. An adopt takes a worktree the controller did not start into a process. A
// claim creates the issue's branch and its worktree, assigns the issue, and writes the process record
// and its event log; the server then starts its implement session. An abandon removes the worktree
// and the process and leaves the branch and the issue as they are.
import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { basename, isAbsolute, join } from 'node:path'
import { run } from './exec.js'
import { addWorktree, exists, fetch, git } from './git.js'
import { ghApi, issueFromBranch, kindOf, labelNames, labels, recordFiles, worktrees, type GitHubIssue, type Worktree } from './board.js'
import { enter, type Opening } from './engine.js'
import { gateForm } from './gate.js'
import { graphOf } from './graphs.js'
import { claimRuntime } from './quota.js'
import { settingOf } from './settings.js'
import { type Project, Refusal } from './project.js'
import { stop } from './running.js'
import type { Announce, Runtime } from './session.js'
import { modes, type Mode, type WorkRecord } from './records.js'
import { event, forget, recordsDir, update, writeAtomic, writeProcess } from './store.js'

// The worker knobs a claim may set for its process, the ones the local claim accepts with --env. The
// claim itself sets the mode and the issue, and the base branch follows the base branch rule.
export const knobs = [
  'WF_REVIEWERS',
  'WF_REVIEW_ROUNDS',
  'WF_CI_REPAIR_ROUNDS',
  'WF_PR_BOT_REVIEWERS',
  'WF_PR_REVIEW_WAIT',
  'WF_DOCS_TIMEOUT',
  'WF_GATE',
  'WF_GATE_ROUNDS',
  'WF_GATE_TIMEOUT',
  'WF_CHECKS_GRACE',
  'WF_STAGE_TIMEOUT',
]

const envShape = 'an override is NAME=VALUE, such as WF_REVIEW_ROUNDS=5; an empty value (WF_PR_BOT_REVIEWERS=) is allowed'

// overrides reads the knob overrides of a claim, each NAME=VALUE, into the names and values they set.
// It refuses a malformed override, a name that is no knob and a name given twice, before anything is
// created.
export function overrides(env: unknown): Record<string, string> {
  if (env === undefined) return {}
  if (!Array.isArray(env)) throw new Refusal(`env is not a list; ${envShape}`)
  const out: Record<string, string> = {}
  for (const pair of env as unknown[]) {
    if (typeof pair !== 'string') throw new Refusal(`the override ${JSON.stringify(pair)} is not a string; ${envShape}`)
    const i = pair.indexOf('=')
    if (i < 0) throw new Refusal(`the override ${pair} has no '='; ${envShape}`)
    const name = pair.slice(0, i)
    if (name === '') throw new Refusal(`the override ${pair} has no name; ${envShape}`)
    if (!/^[A-Z0-9_]+$/.test(name)) throw new Refusal(`the override ${pair} has no usable name: a name is A-Z, 0-9 and _; ${envShape}`)
    if (!knobs.includes(name)) throw new Refusal(`${name} is not a worker knob a claim can set; the knobs are ${knobs.join(' ')}`)
    if (name in out) throw new Refusal(`${name} was given twice; give it once, with the value you mean`)
    out[name] = pair.slice(i + 1)
  }
  return out
}

// slug is the branch contract's slug of a title: URLs out, umlauts spelled out, lower case, every other
// run of characters a hyphen, cut to 40 characters without a hyphen at either end.
export function slug(title: string): string {
  const s = title
    .replace(/https?:\/\/[^ ]*/g, '')
    .replace(/[äÄ]/g, 'ae')
    .replace(/[öÖ]/g, 'oe')
    .replace(/[üÜ]/g, 'ue')
    .replace(/ß/g, 'ss')
    .replace(/[A-Z]/g, (c) => c.toLowerCase())
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return s.slice(0, 40).replace(/-+$/, '')
}

// branchType is the type of an issue's branch by its labels.
export function branchType(names: string[]): string {
  const has = (...l: string[]) => l.some((x) => names.includes(x))
  if (has('bug', 'fix')) return 'fix'
  if (has('docs', 'documentation')) return 'docs'
  if (has('chore', 'maintenance')) return 'chore'
  return 'feat'
}

// branchName is the branch a claim of the issue creates: <type>/<number>-<slug>.
export const branchName = (number: number, title: string, names: string[]) => `${branchType(names)}/${number}-${slug(title)}`

export interface ClaimRequest {
  issue: number
  mode: Mode
  env: Record<string, string>
  force: boolean
}

// target reads the issue and force of a claim's or an abandon's body, or refuses them with the reason.
function target(body: Record<string, unknown>): { issue: number; force: boolean } {
  const issue = body.issue
  if (typeof issue !== 'number' || !Number.isInteger(issue) || issue < 1) throw new Refusal('issue is not an issue number; send it as a whole number, such as 42')
  if (body.force !== undefined && typeof body.force !== 'boolean') throw new Refusal('force is not true or false')
  return { issue, force: body.force === true }
}

// claimRequest reads the body of a claim, or refuses it with the reason before anything is created.
export function claimRequest(body: Record<string, unknown>): ClaimRequest {
  const { issue, force } = target(body)
  const mode = body.mode ?? 'manual'
  if (!modes.includes(mode as Mode)) throw new Refusal(`mode ${JSON.stringify(mode)} is neither manual nor yolo`)
  return { issue, mode: mode as Mode, env: overrides(body.env), force }
}

// abandonRequest reads the body of an abandon, or refuses it with the reason before anything is removed.
export const abandonRequest = (body: Record<string, unknown>): { issue: number; force: boolean } => target(body)

// adoptRequest reads the body of an adopt: the issue, and the branch of the worktree to adopt when the
// board names the row it was sent from.
export function adoptRequest(body: Record<string, unknown>): { issue: number; branch?: string } {
  const { issue } = target(body)
  const branch = body.branch
  if (branch !== undefined && (typeof branch !== 'string' || branch === '')) throw new Refusal('branch is not a branch name; send the branch of the worktree to adopt')
  return { issue, branch }
}

// recordsOf are the records of a project's issue, each with the path of its file, as the board reads them.
function recordsOf(stateDir: string, project: string, issue: number) {
  return recordFiles(stateDir, project).filter(({ record: r }) => (r.issue != null ? r.issue === issue : ofIssue(r.branch, issue)))
}

// ofIssue tells a branch of the issue by the contract's issue-from-branch rule, spec branches included
// and the number spelled as the branch spells it, so feat/0104-x is no branch of #104.
const ofIssue = (branch: string, issue: number) => issueFromBranch(branch) === String(issue)

// refOf is the ref of a base branch: origin's where the checkout has it, else the local branch.
async function refOf(top: string, base: string): Promise<string> {
  return (await exists(top, `origin/${base}`)) ? `origin/${base}` : (await exists(top, base)) ? base : `origin/${base}`
}

// processId is the id of the work process of an issue of a project, the name of its record.
const processId = (top: string, issue: number) => `work-${issue}-${createHash('sha256').update(top).digest('hex').slice(0, 8)}`

export interface Claimed {
  record: WorkRecord
  // warnings are the refusals force lifted and what the claim could not check.
  warnings: string[]
}

// openClaim is the open function of the delivery graph. It claims the issue and enters the implement node
// at once. It answers the claim's record as it runs, its warnings and the quota's.
// The quota is read beside the claim and never holds it. The session starts once the claim is done.
// After the claim, the answer waits for the reading no longer than the quota's share allows.
// Below the minimum the claim goes on, and its answer says so.
// It reads Claude alone, the one runtime it warns of. So a slow reading of another runtime takes no warning away.
export async function openClaim(project: Project, rt: Runtime, request: ClaimRequest, opening: Opening): Promise<Record<string, unknown>> {
  const reading = opening.quota([claimRuntime])
  const done = await claim(project, rt.stateDir, rt.gh, rt.fake, request)
  opening.log({ event: 'claimed', project: project.path, issue: request.issue, branch: done.record.branch, mode: request.mode, force: request.force })
  const record = enter(graphOf(done.record), 'implement', done.record, project, rt)
  return { ...done, record, quota: await reading() }
}

// The actions under way, per project and what they act on, so two at once cannot both pass the checks.
const busy = new Set<string>()

// held runs f while no other action of the project holds the same key: an issue, a pull request or a
// milestone. Another action of that key meanwhile is refused.
export async function held<T>(project: Project, key: string, f: () => Promise<T>): Promise<T> {
  key = `${project.path}#${key}`
  if (busy.has(key)) throw new Refusal(`an action on ${key.slice(project.path.length + 1)} is under way; try again when it is done`, 409)
  busy.add(key)
  try {
    return await f()
  } finally {
    busy.delete(key)
  }
}

// claim takes the issue into a work process of the project. It refuses an issue that has a process
// already, whatever force says. Force lifts the refusals of an issue that is not agent-ready, routed to
// the factory, held in a spec run or claimed on origin; each of those it lifts is a warning.
// In fake mode it fetches nothing from origin and branches from what the checkout has.
export async function claim(project: Project, stateDir: string, gh: string, fake: boolean, req: ClaimRequest): Promise<Claimed> {
  // A gate form the gate would refuse is refused here, before anything is created.
  try {
    gateForm(settingOf(req.env, project.path, 'WF_GATE'))
  } catch (err) {
    throw new Refusal((err as Error).message)
  }
  return held(project, `#${req.issue}`, () => claimHeld(project, stateDir, gh, fake, req))
}

async function claimHeld(project: Project, stateDir: string, gh: string, fake: boolean, req: ClaimRequest): Promise<Claimed> {
  const top = project.path
  const repo = `${project.owner}/${project.name}`
  const n = req.issue
  const warnings: string[] = []
  const refuse = (message: string, lifted: string) => {
    if (!req.force) throw new Refusal(`${message}; ${lifted}, or claim it anyway with force`, 409)
    warnings.push(`${message}; claimed anyway because force was given`)
  }

  // One issue has one process: a claim that runs into one names it, and the answer carries it.
  const trees = await worktrees(top)
  const tree = trees.find((t) => ofIssue(t.branch, n))
  const recorded = recordsOf(stateDir, top, n)[0]
  if (recorded) {
    const id = basename(recorded.file, '.json')
    const r = recorded.record
    const process = { id, branch: r.branch, worktree: tree?.path ?? r.worktree ?? null, state: r.state ?? 'running' }
    throw new Refusal(`#${n} has a process already: ${id}, ${process.state} on ${r.branch}; open it on the board, or abandon it first`, 409, { process })
  }
  if (tree) {
    const process = { id: null, branch: tree.branch, worktree: tree.path, state: 'foreign' }
    throw new Refusal(`#${n} has a process already: the worktree ${tree.path} on ${tree.branch}, which this controller did not start; adopt it or abandon it first`, 409, { process })
  }

  const api = ghApi(gh, repo)
  let issue: { number: number; title: string; state: string; labels: { name: string }[] }
  try {
    issue = JSON.parse(await run(gh, ['issue', 'view', String(n), '--repo', repo, '--json', 'number,title,state,labels'])) as typeof issue
  } catch (err) {
    throw new Refusal(`could not read #${n} of ${repo}: ${(err as Error).message}`, 502)
  }
  if (issue.state !== 'OPEN') throw new Refusal(`#${n} of ${repo} is ${issue.state}, not open`, 409)
  const names = issue.labels.map((l) => l.name)
  const human = names.includes(labels.human)

  if (!names.includes(labels.ready)) {
    const what = names.includes(labels.spec) ? 'a spec' : 'not ready for an agent'
    refuse(`#${n} is ${what} (labels: ${names.join(', ') || 'none'})`, 'plan it first')
  }
  if (names.includes(labels.routing)) refuse(`#${n} is routed to the factory (label ${labels.routing})`, `remove the label ${labels.routing} to work on it here`)
  if (names.includes(labels.specRun) && !human) {
    refuse(`#${n} is a ticket of a spec run (label ${labels.specRun}), which the factory works on the spec branch`, `add ${labels.human} or remove ${labels.specRun} to work on it here`)
  }

  // The parent tells whether the issue is a ticket of a spec run, the rule the board and the factory
  // apply. A parent that cannot be read leaves the usual base, as the local claim does.
  // The parent's number names a spec branch on the origin of the parent's own repository alone.
  let spec: number | undefined
  try {
    const parent = await api<GitHubIssue>(`issues/${n}/parent`)
    if (parent.number > 0 && labelNames(parent).includes(labels.specRun)) {
      const own = `https://api.github.com/repos/${repo}`.toLowerCase()
      if ((parent.repository_url ?? '').toLowerCase() === own) spec = parent.number
      else warnings.push(`#${n} is a ticket of the spec run of #${parent.number} in another repository (${parent.repository_url ?? 'unknown'}), so its spec branch is not on this origin; branching from ${project.base}`)
    }
  } catch (err) {
    if (!/HTTP 404/.test((err as Error).message)) warnings.push(`could not read the parent of #${n}; branching from ${project.base}`)
  }
  if (spec !== undefined && !human && !names.includes(labels.specRun)) {
    refuse(`#${n} is a ticket of the spec run of #${spec}, which the factory works on the spec branch`, `add ${labels.human} to #${n} or remove ${labels.specRun} from #${spec} to work on it here`)
  }

  // A claim on origin is the creation of the issue's branch there, so a branch of the issue on origin
  // belongs to another claimer. Force adopts it: the worktree goes on from its work.
  let remote: string[] | undefined
  try {
    remote = (await api<{ name: string }[]>('branches?per_page=100', true)).map((b) => b.name)
  } catch {
    warnings.push(`could not read the branches of ${repo}; claimed #${n} without checking whether it is claimed on origin`)
  }
  const adopted = remote?.find((b) => ofIssue(b, n))
  if (adopted) refuse(`#${n} is claimed on origin already: the branch ${adopted} exists there`, `wait for its pull request, or delete it with git push origin --delete ${adopted}`)

  let branch = branchName(n, issue.title, names)
  let base = project.base
  const specBranch = spec !== undefined && human ? remote?.find((b) => b.startsWith(`spec/${spec}-`)) : undefined
  if (specBranch) base = specBranch
  // The base is what the branch merges into; the start is what its worktree starts from, which is the
  // base unless the claim adopts a branch on origin.
  const fetched = await fetch(top, base, fake)
  const baseRef = await refOf(top, base)
  let start: string
  if (adopted) {
    branch = adopted
    start = `origin/${adopted}`
    if (!(await fetch(top, adopted, fake)) || !(await exists(top, start))) throw new Refusal(`could not fetch ${adopted} from origin, so its work cannot go on here`, 502)
    const local = await git(top, 'rev-parse', '-q', '--verify', `refs/heads/${branch}`).catch(() => '')
    if (local && local !== (await git(top, 'rev-parse', start))) {
      throw new Refusal(`the local branch ${branch} is not what origin has; go on with it by hand, or remove it with git branch -D ${branch} and claim again`, 409)
    }
  } else {
    if (!fetched) warnings.push(`could not fetch ${base} from origin; branching from what this checkout has of it`)
    start = baseRef
    if (!(await exists(top, start))) throw new Refusal(`the base ${base} is neither on origin nor in ${top}; fetch it and claim again`, 409)
  }

  const { path, created } = await addWorktree(top, branch, start)

  // undo removes the worktree and the branch the claim created, so nothing of a failed claim stays.
  const undo = async () => {
    await git(top, 'worktree', 'remove', '--force', path).catch(() => undefined)
    if (created) await git(top, 'branch', '-D', branch).catch(() => undefined)
  }
  try {
    await run(gh, ['issue', 'edit', String(n), '--repo', repo, '--add-assignee', '@me'])
  } catch (err) {
    await undo()
    throw new Refusal(`could not assign #${n}: ${(err as Error).message}; the claim is undone`, 502)
  }

  const now = new Date().toISOString()
  const id = processId(top, n)
  const record: WorkRecord = {
    id,
    project: top,
    kind: 'work',
    branch,
    issue: n,
    worktree: path,
    base: baseRef,
    start,
    mode: req.mode,
    env: req.env,
    stage: 'implement',
    state: 'created',
    note: 'claimed; no session yet',
    created_at: now,
    updated_at: now,
  }
  await writeProcess(stateDir, record, { event: 'claimed', issue: n, branch, base: baseRef, start, mode: req.mode, env: req.env, warnings }, async () => {
    await run(gh, ['issue', 'edit', String(n), '--repo', repo, '--remove-assignee', '@me']).catch(() => undefined)
    await undo()
  }, 'claim')
  return { record, warnings }
}

export interface Abandoned {
  issue: number
  branch: string
  worktree: string | null
}

// abandon removes the worktree and the process of the issue and leaves its branch and the issue. It
// refuses a worktree with commits that are on no branch of origin, or with changes not committed,
// unless force is given.
// A session it stopped for an abandon that is then refused ends failed, which announce is told of.
export function abandon(project: Project, stateDir: string, issue: number, force: boolean, announce: Announce): Promise<Abandoned> {
  return held(project, `#${issue}`, () => abandonHeld(project, stateDir, issue, force, announce))
}

async function abandonHeld(project: Project, stateDir: string, n: number, force: boolean, announce: Announce): Promise<Abandoned> {
  const top = project.path
  const records = recordsOf(stateDir, top, n)
  // A plan branch names no issue, so its worktree is found through the branch its record holds.
  const tree = (await worktrees(top)).find((t) => ofIssue(t.branch, n) || records.some(({ record: r }) => r.branch === t.branch))
  if (!tree && records.length === 0) throw new Refusal(`#${n} has no process in ${top}`, 404)
  const branch = tree?.branch ?? records[0]?.record.branch ?? ''
  // clean refuses a worktree with work that is on no branch of origin, unless force is given.
  const clean = async () => {
    if (!tree || force) return
    const unpushed = Number(await git(top, 'rev-list', '--count', branch, '--not', '--remotes=origin'))
    if (unpushed > 0) throw new Refusal(`${branch} has ${unpushed} commit(s) not on origin; push them, or abandon with force to lose them`, 409)
    if ((await git(tree.path, 'status', '--porcelain')) !== '') {
      throw new Refusal(`${tree.path} has changes not committed; commit and push them, or abandon with force to lose them`, 409)
    }
  }
  await clean()
  // A session still running in the worktree is stopped, and its runtime has exited, before the worktree
  // is checked again and removed: what it wrote until then is refused like any other work.
  const stopped: string[] = []
  for (const { file } of records) {
    const id = basename(file, '.json')
    if (await stop(id)) stopped.push(id)
  }
  try {
    await clean()
  } catch (err) {
    const note = `the implement session was stopped by an abandon that was refused: ${(err as Error).message}`
    for (const id of stopped) {
      event(stateDir, id, { event: 'session-end', stage: 'implement', state: 'failed', note })
      const failed = update(stateDir, id, { state: 'failed', note, unseen: true })
      if (failed) announce(failed)
    }
    throw err
  }
  if (tree) {
    await git(top, 'worktree', 'remove', '--force', tree.path)
    await git(top, 'worktree', 'prune')
  }
  for (const { file } of records) forget(stateDir, basename(file, '.json'))
  return { issue: n, branch, worktree: tree?.path ?? null }
}

// adopt makes a foreign worktree of the issue, one this controller did not start, a work process of the
// project. The process is interrupted on the implement node of the delivery graph with no session yet,
// so a resume starts its implement session in the worktree. It refuses an issue without a worktree and one that has a process already. A branch
// names the worktree to adopt; without one, an issue with more than one worktree is refused.
export function adopt(project: Project, stateDir: string, issue: number, branch?: string): Promise<WorkRecord> {
  return held(project, `#${issue}`, () => adoptHeld(project, stateDir, issue, branch))
}

async function adoptHeld(project: Project, stateDir: string, n: number, branch?: string): Promise<WorkRecord> {
  const top = project.path
  const recorded = recordsOf(stateDir, top, n)[0]
  if (recorded) throw new Refusal(`#${n} has a process already: ${basename(recorded.file, '.json')} on ${recorded.record.branch}; there is nothing to adopt`, 409)
  const trees = (await worktrees(top)).filter((t) => ofIssue(t.branch, n) && kindOf(t.branch) === 'work' && (branch === undefined || t.branch === branch))
  if (trees.length === 0) {
    throw new Refusal(branch === undefined ? `#${n} has no worktree in ${top} to adopt; claim it instead` : `#${n} has no worktree on ${branch} in ${top} to adopt`, 404)
  }
  if (trees.length > 1) throw new Refusal(`#${n} has more than one worktree: ${trees.map((t) => t.branch).join(', ')}; name the branch to adopt`, 409)
  const [tree] = trees as [Worktree]
  const now = new Date().toISOString()
  const id = processId(top, n)
  const base = await refOf(top, project.base)
  const record: WorkRecord = {
    id,
    project: top,
    kind: 'work',
    branch: tree.branch,
    issue: n,
    worktree: tree.path,
    base,
    mode: 'manual',
    env: {},
    stage: 'implement',
    workflow: 'delivery',
    node: 'implement',
    state: 'interrupted',
    note: 'adopted; resume it to start its implement session in the worktree',
    created_at: now,
    updated_at: now,
  }
  const file = join(recordsDir(stateDir), `${id}.json`)
  const events = join(recordsDir(stateDir), `${id}.events.jsonl`)
  try {
    mkdirSync(recordsDir(stateDir), { recursive: true })
    // The events are written before the record, so a record never stands without its adopted event.
    appendFileSync(events, JSON.stringify({ at: now, event: 'adopted', issue: n, branch: tree.branch, base }) + '\n')
    writeAtomic(file, JSON.stringify(record, null, 2) + '\n')
  } catch (err) {
    // A failed adopt leaves nothing behind, so the worktree stays foreign and the adopt can be tried again.
    rmSync(file, { force: true })
    rmSync(events, { force: true })
    throw new Refusal(`could not write the process of #${n}: ${(err as Error).message}`, 500)
  }
  return record
}

// resumable is the record of the issue's interrupted process, whose session a resume goes on with, or
// the refusal that says why it cannot. It refuses a worktree that git no longer has on the process's
// branch, such as a path reused for other work. It reads the state again after asking git, so the
// last check and the start of the session run in one go when the caller starts it at once.
export async function resumable(project: Project, stateDir: string, n: number): Promise<WorkRecord> {
  const r = interrupted(project, stateDir, n)
  const tree = (await worktrees(project.path)).find((t) => t.path === r.worktree)
  if (tree?.branch !== r.branch) {
    const now = tree ? `on ${tree.branch}` : 'no worktree of git'
    throw new Refusal(`the worktree ${r.worktree} of #${n} is ${now}, not on ${r.branch}, so its session cannot go on there; abandon #${n}`, 409)
  }
  return interrupted(project, stateDir, n)
}

function interrupted(project: Project, stateDir: string, n: number): WorkRecord {
  const top = project.path
  if (busy.has(`${top}#${n}`)) throw new Refusal(`a claim or abandon of #${n} is under way; try again when it is done`, 409)
  const recorded = recordsOf(stateDir, top, n)[0]
  if (!recorded) throw new Refusal(`#${n} has no process in ${top}`, 404)
  const r = recorded.record as WorkRecord
  if (r.kind !== 'work' || r.state !== 'interrupted') throw new Refusal(`#${n} is ${r.state ?? 'running'}, not interrupted; only an interrupted session resumes`, 409)
  if (!r.worktree || !existsSync(r.worktree)) throw new Refusal(`the worktree ${r.worktree ?? '(none)'} of #${n} is gone, so its session cannot go on there; abandon #${n}`, 409)
  return r
}

// projectPath is the absolute path a body names as its project, or a Refusal.
export function projectPath(body: Record<string, unknown>): string {
  const p = body.project
  if (typeof p !== 'string' || !isAbsolute(p)) throw new Refusal('project is not an absolute path; name the checkout of the project as an absolute path')
  return p
}
