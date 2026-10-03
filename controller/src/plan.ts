// The plan process: a planning session in a worktree on a plan branch. A plan opens from an idea, an
// issue or nothing, an open session, and the server then starts its planner session. A capture moves
// the prototype code the session left in the worktree to a prototype branch of its own and pushes it,
// so the plan branch stays clean. A finish removes the worktree, the plan branch and the process. A
// plan branch never carries a commit.
import { createHash } from 'node:crypto'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { run } from './exec.js'
import { issueFromBranch, recordFiles, worktrees } from './board.js'
import { addWorktree, exists, fetch, git, held, slug } from './claim.js'
import { settingOf } from './gate.js'
import { type Project, Refusal } from './project.js'
import { stop } from './session.js'
import { resumed } from './terminal.js'
import type { PlanRecord } from './records.js'
import { event, forget, readRecord, update, writeProcess } from './store.js'

export type PlanRequest = { route: 'idea'; idea: string } | { route: 'issue'; issue: number } | { route: 'open' }

// planRequest reads the body of a plan: an idea, an issue, or neither for an open session. It refuses
// both at once and either in a shape it cannot use, before anything is created.
export function planRequest(body: Record<string, unknown>): PlanRequest {
  const { idea, issue } = body
  if (idea !== undefined && issue !== undefined) throw new Refusal('a plan starts from an idea or from an issue, not both; send one of them, or neither for an open session')
  if (issue !== undefined) {
    if (typeof issue !== 'number' || !Number.isInteger(issue) || issue < 1) throw new Refusal('issue is not an issue number; send it as a whole number, such as 42')
    return { route: 'issue', issue }
  }
  if (idea !== undefined) {
    if (typeof idea !== 'string') throw new Refusal('idea is not text; send the idea as a string')
    const text = idea.trim()
    // An empty idea is an open session, as a plan without a topic is.
    if (text !== '') return { route: 'idea', idea: text }
  }
  return { route: 'open' }
}

// captureRequest reads the name of a capture, which names its prototype branch.
export function captureRequest(body: Record<string, unknown>): string {
  const name = body.name
  if (typeof name !== 'string' || slug(name) === '') throw new Refusal('name is not a name for the prototype; send a few words, such as retry queue')
  return slug(name)
}

// The longest WF_PLANNER_LANGUAGE, in characters: a language name or a locale code, never a sentence.
const languageMax = 32

// plannerLanguage reads WF_PLANNER_LANGUAGE from the env block of the checkout's settings.
// It returns the language the planner talks in, or undefined when the setting is unset or empty.
// The value enters the session's system prompt verbatim.
// It refuses control, separator and format characters, and values longer than a language name.
export function plannerLanguage(checkout: string): string | undefined {
  const value = settingOf({}, checkout, 'WF_PLANNER_LANGUAGE')
  if (value === undefined || value === '') return undefined
  if (typeof value !== 'string') throw new Refusal(`WF_PLANNER_LANGUAGE=${JSON.stringify(value)} is not text; set a language name or a locale code, such as german or pt-br`)
  if (/[\p{Cc}\p{Zl}\p{Zp}\p{Cf}]/u.test(value)) throw new Refusal('WF_PLANNER_LANGUAGE contains a line break, a control character or a format character; set a plain language name or a locale code, such as german')
  const length = [...value].length
  if (length > languageMax) throw new Refusal(`WF_PLANNER_LANGUAGE is ${length} characters long, which is a sentence, not a language; set a name or a locale code of at most ${languageMax}, such as german or pt-br`)
  return value
}

const hash = (s: string) => createHash('sha256').update(s).digest('hex')

// stamp is the local time to the second, which names the branch of an open session.
function stamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

// plan opens a plan process: the branch plan/<slug> from the base, its worktree and a record in the
// state created. The slug is the idea's, the issue's title's, or open-<time> for an open session. The
// branch's description carries the topic, so the checkout tells what the plan is about. It refuses an
// issue that is not open, an issue with a process already, a plan branch that exists, and a
// WF_PLANNER_LANGUAGE that is no language.
// In fake mode it fetches nothing from origin and branches from what the checkout has.
export function plan(project: Project, stateDir: string, gh: string, fake: boolean, req: PlanRequest): Promise<PlanRecord> {
  // A language the session would refuse is refused here, before anything is created.
  const language = plannerLanguage(project.path)
  const key = req.route === 'issue' ? `#${req.issue}` : `plan ${req.route === 'idea' ? slug(req.idea) : 'open'}`
  return held(project, key, () => planHeld(project, stateDir, gh, fake, req, language))
}

async function planHeld(project: Project, stateDir: string, gh: string, fake: boolean, req: PlanRequest, language: string | undefined): Promise<PlanRecord> {
  const top = project.path
  const repo = `${project.owner}/${project.name}`
  let topic: string | undefined
  let issue: number | null = null
  let name: string
  if (req.route === 'issue') {
    issue = req.issue
    const recorded = recordFiles(stateDir, top).find((r) => r.record.issue === issue)
    if (recorded) throw new Refusal(`#${issue} has a process already on ${recorded.record.branch}; open it on the board, or finish it first`, 409)
    // A worktree of the issue that no record knows is a foreign process, as the board shows it.
    const foreign = (await worktrees(top)).find((t) => issueFromBranch(t.branch) === String(issue))
    if (foreign) throw new Refusal(`#${issue} has a process already on ${foreign.branch} at ${foreign.path}; adopt it on the board, or remove it first`, 409)
    let found: { number: number; title: string; state: string }
    try {
      found = JSON.parse(await run(gh, ['issue', 'view', String(issue), '--repo', repo, '--json', 'number,title,state,labels'])) as typeof found
    } catch (err) {
      throw new Refusal(`could not read #${issue} of ${repo}: ${(err as Error).message}`, 502)
    }
    if (found.state !== 'OPEN') throw new Refusal(`#${issue} of ${repo} is ${found.state}, not open`, 409)
    topic = found.title
    name = slug(found.title) || `issue-${issue}`
  } else if (req.route === 'idea') {
    topic = req.idea
    name = slug(req.idea)
    if (name === '') throw new Refusal(`the idea ${JSON.stringify(req.idea)} gives no branch name; write it in a few words of letters or digits`)
  } else {
    name = `open-${stamp()}`
  }
  const branch = `plan/${name}`

  const tree = (await worktrees(top)).find((t) => t.branch === branch)
  if (tree) throw new Refusal(`${branch} is open already at ${tree.path}; open it on the board, or finish it first`, 409)
  const other = recordFiles(stateDir, top).find((r) => r.record.branch === branch)
  if (other) throw new Refusal(`${branch} has a process already; open it on the board, or finish it first`, 409)
  if (await exists(top, `refs/heads/${branch}`)) throw new Refusal(`the branch ${branch} exists already; remove it with git branch -D ${branch} and plan again`, 409)
  const base = project.base
  await fetch(top, base, fake)
  const start = (await exists(top, `origin/${base}`)) ? `origin/${base}` : base
  if (!(await exists(top, start))) throw new Refusal(`the base ${base} is neither on origin nor in ${top}; fetch it and plan again`, 409)
  const { path } = await addWorktree(top, branch, start)
  const undo = async () => {
    await git(top, 'worktree', 'remove', '--force', path).catch(() => undefined)
    await git(top, 'branch', '-D', branch).catch(() => undefined)
  }
  // The description names the topic, the issue or an open session in the branch's git config.
  const description = req.route === 'issue' ? `issue: #${req.issue}` : req.route === 'idea' ? `topic: ${req.idea.replace(/\s+/g, ' ')}` : `open: ${name.slice('open-'.length)}`
  try {
    await git(top, 'config', `branch.${branch}.description`, description)
  } catch (err) {
    await undo()
    throw new Refusal(`could not describe ${branch}: ${(err as Error).message}; the plan is undone`, 500)
  }

  const now = new Date().toISOString()
  const record: PlanRecord = {
    id: `plan-${hash(`${top}\n${branch}`).slice(0, 12)}`,
    project: top,
    kind: 'plan',
    route: req.route,
    ...(topic !== undefined ? { topic } : {}),
    ...(language !== undefined ? { language } : {}),
    branch,
    issue,
    worktree: path,
    base: start,
    stage: 'plan',
    state: 'created',
    note: 'planned; no session yet',
    created_at: now,
    updated_at: now,
  }
  await writeProcess(stateDir, record, { event: 'planned', route: req.route, ...(topic !== undefined ? { topic } : {}), issue, branch, base: start }, undo, 'plan')
  return record
}

// planOf is the record of a plan process by its id, or the refusal that says why there is none.
function planOf(stateDir: string, id: string): PlanRecord {
  const r = readRecord(stateDir, id) as PlanRecord | undefined
  if (!r) throw new Refusal(`${id} is not a process of this machine`, 404)
  if (r.kind !== 'plan') throw new Refusal(`${id} is a ${r.kind} process, not a plan; only a plan captures a prototype or finishes`, 409)
  return r
}

export interface Captured {
  branch: string
  url: string
}

// The states in which a plan's session works in its worktree, so a capture would take half a change.
const working = ['created', 'running', 'approval']

// capture moves what the plan's worktree holds beyond its branch, the prototype, to the branch
// prototype/<plan>-<name> and pushes it. The worktree is clean afterwards and the plan branch carries
// no commit. It refuses a worktree with nothing to capture, a session at work in it and a prototype
// branch that exists. A push that fails keeps the commit on the local branch and the worktree as it was.
// In fake mode it pushes nothing.
export function capture(project: Project, stateDir: string, fake: boolean, id: string, name: string): Promise<Captured> {
  const r = planOf(stateDir, id)
  return held(project, `plan ${r.branch}`, () => captureHeld(project, stateDir, fake, id, name))
}

async function captureHeld(project: Project, stateDir: string, fake: boolean, id: string, name: string): Promise<Captured> {
  const r = planOf(stateDir, id)
  if (working.includes(r.state)) throw new Refusal(`the session of ${r.branch} is at work in its worktree; capture the prototype once it waits for you`, 409)
  await outside(r)
  const wt = r.worktree
  // The prototype is one commit on the plan's start, so commits on the plan branch would ride along.
  const ahead = Number(await git(wt, 'rev-list', '--count', 'HEAD', '--not', r.base))
  if (ahead > 0) throw new Refusal(`${r.branch} has ${ahead} commit(s) not on ${r.base}, and a plan branch carries none; move them to a branch of their own, then capture`, 409)
  if ((await git(wt, 'status', '--porcelain')) === '') throw new Refusal(`nothing to capture: the worktree ${wt} is clean`, 409)
  const branch = `prototype/${r.branch.slice('plan/'.length)}-${name}`
  if (await exists(project.path, `refs/heads/${branch}`)) throw new Refusal(`the branch ${branch} exists already; pick another name`, 409)
  // The prototype is committed through an index of its own, so the worktree's HEAD and index stay on
  // the plan branch while it is written.
  const index = join(await git(wt, 'rev-parse', '--path-format=absolute', '--git-dir'), `prototype-${process.pid}.index`)
  const env = { GIT_INDEX_FILE: index }
  let commit: string
  try {
    await run('git', ['-C', wt, 'read-tree', 'HEAD'], env)
    await run('git', ['-C', wt, 'add', '-A'], env)
    const tree = await run('git', ['-C', wt, 'write-tree'], env)
    const message = `prototype: ${name}\n\nThrowaway code from planning session ${r.branch.slice('plan/'.length)}. Not for merging.`
    commit = await git(wt, 'commit-tree', tree, '-p', 'HEAD', '-m', message)
  } catch (err) {
    throw new Refusal(`could not commit the prototype: ${(err as Error).message}`, 500)
  } finally {
    rmSync(index, { force: true })
  }
  await git(project.path, 'update-ref', `refs/heads/${branch}`, commit, '')
  if (!fake) {
    try {
      await git(wt, 'push', '-q', 'origin', `${branch}:refs/heads/${branch}`)
    } catch (err) {
      throw new Refusal(`could not push ${branch}: ${(err as Error).message}; the commit is on the local branch ${branch} and the worktree is as it was`, 502)
    }
  }
  // Pushed, the prototype leaves the worktree, which is the plan branch again and nothing else.
  await git(wt, 'reset', '-q', '--hard', 'HEAD')
  await git(wt, 'clean', '-q', '-fd')
  return { branch, url: `https://github.com/${project.owner}/${project.name}/tree/${branch}` }
}

export interface Finished {
  branch: string
  worktree: string | null
}

// outside refuses while the plan's session runs in a terminal the maintainer opened, which the
// controller cannot stop and whose writes a capture or a finish would take half of or lose.
async function outside(r: PlanRecord): Promise<void> {
  if (r.session_id && (await resumed(r.session_id))) {
    throw new Refusal(`the session of ${r.branch} runs in a terminal; quit it there, then try again`, 409)
  }
}

// finish ends a plan process: it stops its session, then removes its worktree, its plan branch and its
// record. It refuses changes not captured and commits on the plan branch, which would be lost, unless
// force is given.
export function finish(project: Project, stateDir: string, id: string, force: boolean): Promise<Finished> {
  const r = planOf(stateDir, id)
  return held(project, `plan ${r.branch}`, () => finishHeld(project, stateDir, id, force))
}

async function finishHeld(project: Project, stateDir: string, id: string, force: boolean): Promise<Finished> {
  const top = project.path
  const r = planOf(stateDir, id)
  const tree = (await worktrees(top)).find((t) => t.branch === r.branch)
  const clean = async () => {
    if (force) return
    // A worktree removed outside the controller leaves the branch, whose commits are still checked.
    if (tree && (await git(tree.path, 'status', '--porcelain')) !== '') {
      throw new Refusal(`${tree.path} has changes not captured; capture them as a prototype, or finish with force to lose them`, 409)
    }
    if (!(await exists(top, `refs/heads/${r.branch}`))) return
    const n = Number(await git(top, 'rev-list', '--count', r.branch, '--not', r.base))
    if (n > 0) throw new Refusal(`${r.branch} has ${n} commit(s) not on ${r.base}, and a plan branch carries none; move them to a branch of their own, or finish with force to lose them`, 409)
  }
  await outside(r)
  await clean()
  const stopped = await stop(id)
  // The session may have written until it stopped, so the worktree is checked again. A session stopped
  // for a finish that is then refused waits for the maintainer, whose message resumes it.
  try {
    await clean()
  } catch (err) {
    if (stopped) {
      const note = `the planner session was stopped by a finish that was refused: ${(err as Error).message}`
      event(stateDir, id, { event: 'session-end', stage: r.stage, state: 'input', note })
      update(stateDir, id, { state: 'input', note, unseen: true })
    }
    throw err
  }
  if (tree) {
    await git(top, 'worktree', 'remove', '--force', tree.path)
    await git(top, 'worktree', 'prune')
  }
  await git(top, 'branch', '-D', r.branch).catch(() => undefined)
  forget(stateDir, id)
  return { branch: r.branch, worktree: tree?.path ?? null }
}
