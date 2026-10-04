// The hunt process: a test hunt of a project on a hunt branch, which works no issue. A hunt creates the
// branch hunt/tests-<date> from the base and its worktree, and the server then starts its hunt session:
// the worker on its hunt skill, whose hunters propose tests that prove nothing and whose worker removes
// them. The hunt record the worker's hunt.sh keeps in the worktree is read into the process record as
// the session works. A hunt runs on the hunt graph (delivery.ts): its hunt node runs the hunt session,
// and its hunt-record node reads the hunt record once the session reported complete. The graph, not this
// module, starts the gate after a hunt that removed a test, which then runs the gate, the review, the pr
// and the ci stages of a work process with the hunt record in place of the issue. One that removed
// nothing ends done with no pull request, and a finish removes its worktree, branch and process.
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { run } from './exec.js'
import { ghApi, kindOf, recordFiles, worktrees } from './board.js'
import { held } from './claim.js'
import { addWorktree, exists, fetch, git } from './git.js'
import { enter, type Node, type Opening, type Outcome } from './engine.js'
import { graphOf } from './graphs.js'
import { resumed } from './terminal.js'
import { type Project, Refusal } from './project.js'
import { huntScript } from './bundle.js'
import { stop } from './running.js'
import { type Runtime, sessionEntry, talk } from './session.js'
import type { CreatedRecord, HuntLog, HuntRecord, StageRecord } from './records.js'
import { forget, readRecord, update, writeProcess } from './store.js'

// The rule a test file of a hunt follows, the worker's own (wf_test_paths in its lib.sh), which names it.
export const testFileRule =
  'test_*.py, *_test.py, *_test.go, *.test.* and *.spec.* (JavaScript and TypeScript), and code files in a tests or spec directory; fixtures, testdata, __snapshots__, node_modules and vendor directories are skipped'

// testPaths are the paths of a listing that are test files by the hunt's rule.
export function testPaths(paths: string[]): string[] {
  return paths.filter((p) => {
    const part = p.split('/')
    const name = part[part.length - 1] ?? ''
    const dirs = part.slice(0, -1)
    if (dirs.some((d) => /^(fixtures|testdata|__snapshots__|node_modules|vendor)$/.test(d))) return false
    if (/^test_.*\.py$/.test(name) || /_test\.py$/.test(name) || /_test\.go$/.test(name) || /\.(test|spec)\.(js|jsx|ts|tsx|mjs|cjs|mts|cts)$/.test(name)) return true
    return dirs.some((d) => d === 'tests' || d === 'spec') && /\.(py|go|js|jsx|ts|tsx|mjs|cjs|mts|cts|rb|sh|bash|java|kt|rs|php|cs|swift|ex|exs)$/.test(name)
  })
}

// today is the local date a hunt branch is named by, YYYY-MM-DD.
function today(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

export interface Hunted {
  record: HuntRecord
  // warnings are what the hunt could not check.
  warnings: string[]
}

// hunt opens a hunt process: the branch hunt/tests-<date> from the base, its worktree and a record in
// the state created. It refuses while a hunt branch exists here or on origin, or a hunt process does,
// and while the base has no test file, which leaves nothing to hunt.
// In fake mode it fetches nothing from origin and branches from what the checkout has.
export function hunt(project: Project, stateDir: string, gh: string, fake: boolean): Promise<Hunted> {
  return held(project, 'hunt', () => huntHeld(project, stateDir, gh, fake))
}

async function huntHeld(project: Project, stateDir: string, gh: string, fake: boolean): Promise<Hunted> {
  const top = project.path
  const repo = `${project.owner}/${project.name}`
  const warnings: string[] = []
  const recorded = recordFiles(stateDir, top).find((r) => kindOf(r.record.branch) === 'hunt')
  if (recorded) throw new Refusal(`a test hunt runs already on ${recorded.record.branch}; open it on the board, or finish it first`, 409)
  const tree = (await worktrees(top)).find((t) => kindOf(t.branch) === 'hunt')
  if (tree) throw new Refusal(`a test hunt runs already on ${tree.branch} at ${tree.path}; finish it or remove its worktree first`, 409)
  const local = await git(top, 'for-each-ref', '--format=%(refname:short)', 'refs/heads/hunt/').catch(() => '')
  if (local !== '') {
    const branch = local.split('\n')[0]
    throw new Refusal(`the hunt branch ${branch} exists already; merge or delete it with git branch -D ${branch} before the next hunt`, 409)
  }
  try {
    const remote = (await ghApi(gh, repo)<{ name: string }[]>('branches?per_page=100', true)).map((b) => b.name).find((b) => b.startsWith('hunt/'))
    if (remote) throw new Refusal(`the hunt branch ${remote} exists on origin; merge its pull request or delete it with git push origin --delete ${remote} before the next hunt`, 409)
  } catch (err) {
    if (err instanceof Refusal) throw err
    warnings.push(`could not read the branches of ${repo}; hunted without checking for a hunt branch on origin`)
  }

  const base = project.base
  if (!(await fetch(top, base, fake))) warnings.push(`could not fetch ${base} from origin; branching from what this checkout has of it`)
  const start = (await exists(top, `origin/${base}`)) ? `origin/${base}` : base
  if (!(await exists(top, start))) throw new Refusal(`the base ${base} is neither on origin nor in ${top}; fetch it and hunt again`, 409)
  const files = (await git(top, '-c', 'core.quotePath=false', 'ls-tree', '-r', '--name-only', start)).split('\n')
  if (testPaths(files).length === 0) {
    throw new Refusal(`no test file on ${start} matches the conventions of a test hunt: ${testFileRule}. There is nothing to hunt here.`, 409)
  }

  const branch = `hunt/tests-${today()}`
  const { path } = await addWorktree(top, branch, start)
  const undo = async () => {
    await git(top, 'worktree', 'remove', '--force', path).catch(() => undefined)
    await git(top, 'branch', '-D', branch).catch(() => undefined)
  }
  const now = new Date().toISOString()
  const record: HuntRecord = {
    id: `hunt-${createHash('sha256').update(`${top}\n${branch}`).digest('hex').slice(0, 12)}`,
    project: top,
    kind: 'hunt',
    branch,
    issue: null,
    worktree: path,
    base: start,
    mode: 'manual',
    env: {},
    stage: 'hunt',
    state: 'created',
    note: 'hunted; no session yet',
    created_at: now,
    updated_at: now,
  }
  await writeProcess(stateDir, record, { event: 'hunted', branch, base: start, warnings }, undo, 'hunt')
  return { record, warnings }
}

// huntLog reads the hunt record of a worktree through the worker's hunt.sh.
export async function huntLog(worktree: string): Promise<HuntLog> {
  const out = JSON.parse(await run(huntScript, ['json'], {}, worktree)) as HuntLog
  return { rounds: out.rounds, max_rounds: out.max_rounds, ended: out.ended, removed: out.removed, kept: out.kept, stale: out.stale }
}

// The processes whose hunt record is being read, so a session's many tool results read it once at a time.
const reading = new Set<string>()

// refresh reads the hunt record of a hunt process into its record while its hunt session runs, so the
// process page shows the rounds, removals and kept candidates as they come. A reading that fails is
// left to the next.
export function refresh(record: HuntRecord, rt: Runtime): void {
  if (reading.has(record.id)) return
  reading.add(record.id)
  void huntLog(record.worktree)
    .then((hunt) => {
      const now = readRecord(rt.stateDir, record.id)
      if (now?.kind === 'hunt' && now.stage === 'hunt' && JSON.stringify(now.hunt) !== JSON.stringify(hunt)) update(rt.stateDir, record.id, { hunt } as Partial<HuntRecord>)
    })
    .catch(() => undefined)
    .finally(() => reading.delete(record.id))
}

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`

// huntRequest reads the request of a hunt, which names nothing but its project.
export const huntRequest = (): Record<string, never> => ({})

// openHunt is the open function of the hunt graph: it opens a hunt process on a hunt branch and enters
// the hunt node at once, which runs its hunt session, and answers its record as it runs and what the
// hunt could not check.
export async function openHunt(project: Project, rt: Runtime, _request: Record<string, never>, opening: Opening): Promise<Record<string, unknown>> {
  const done = await hunt(project, rt.stateDir, rt.gh, rt.fake)
  opening.log({ event: 'hunted', project: project.path, branch: done.record.branch })
  const record = enter(graphOf(done.record), 'hunt', done.record, project, rt)
  return { record, warnings: done.warnings }
}

// huntNode is the hunt node of the hunt graph: the hunt session, which a hunt enters fresh, the resume
// route goes on with by its id, and a message resumes. The process page follows its hunt record, which
// changes with the session's tool results, so each user message of the session refreshes it.
export const huntNode: Node = {
  talks: true,
  entry: (record, how) => sessionEntry(record, how),
  run: (ctx) => talk(ctx, undefined, () => refresh(ctx.record as HuntRecord, ctx.rt)),
}

// huntRecordNode is the hunt-record node of the hunt graph: it reads the hunt record into the process
// record once the hunt session reported complete. It answers removed when the hunt removed a test,
// unended when the session reported complete before hunt.sh ended the hunt, nothing when it removed
// nothing, which ends the process done with no pull request, and failed when the record cannot be read.
export const huntRecordNode: Node = {
  run: async (ctx): Promise<Outcome> => {
    const { record, rt } = ctx
    const id = record.id
    let hunt: HuntLog
    try {
      hunt = await huntLog(record.worktree)
    } catch (err) {
      const note = `could not read the hunt record: ${(err as Error).message}`
      if (ctx.own()) ctx.event({ event: 'hunt-end', stage: 'hunt', state: 'failed', note })
      return { outcome: 'failed', note }
    }
    if (!ctx.own()) return { outcome: 'stopped' }
    update(rt.stateDir, id, { hunt } as Partial<StageRecord>)
    // hunt.sh ends the hunt, never the session's report: a complete before it waits for the session.
    if (hunt.ended === null) {
      const note = `the hunt session reported complete after ${plural(hunt.rounds, 'round')}, before hunt.sh ended the hunt; write to it to run its rounds until hunt.sh round answers none`
      ctx.event({ event: 'hunt-unended', stage: 'hunt', state: 'input', note, rounds: hunt.rounds })
      return { outcome: 'unended', note }
    }
    // hunt.sh lists only the removals that still stand, and counts the stale ones apart.
    if (hunt.removed.length > 0) return { outcome: 'removed' }
    // done is final, so the engine writes nothing on it: the node writes the end itself.
    const note = `the hunt removed nothing in ${plural(hunt.rounds, 'round')}, so no pull request opens; ${plural(hunt.kept.length, 'candidate')} were checked and kept. Finish it to remove its worktree and branch`
    ctx.event({ event: 'hunt-end', stage: 'hunt', state: 'done', note, rounds: hunt.rounds, kept: hunt.kept.length })
    const ended = update(rt.stateDir, id, { state: 'done', note, unseen: true })
    if (ended) rt.announce(ended)
    return { outcome: 'nothing', note }
  },
}

// huntOf is the record of a hunt process by its id, or the refusal that says why there is none.
function huntOf(stateDir: string, id: string): HuntRecord {
  const r = readRecord(stateDir, id)
  if (!r) throw new Refusal(`${id} is not a process of this machine`, 404)
  if (r.kind !== 'hunt') throw new Refusal(`${id} is a ${r.kind} process, not a hunt`, 409)
  return r
}

// finishHunt ends a hunt process: it stops its session, then removes its worktree, its hunt branch and
// its record. It refuses while its session runs in a terminal the maintainer opened, which the controller
// cannot stop, and commits that are on no branch of origin and changes not committed, which would be
// lost, unless force is given.
export function finishHunt(project: Project, stateDir: string, id: string, force: boolean): Promise<{ branch: string; worktree: string | null }> {
  huntOf(stateDir, id)
  return held(project, 'hunt', () => removal(project, stateDir, huntOf(stateDir, id), force))
}

// removal stops the process of a branch of its own, a hunt or a standardize process, then removes its
// worktree, its branch and its record, with the refusals of a finish of a hunt.
export async function removal(project: Project, stateDir: string, r: CreatedRecord, force: boolean): Promise<{ branch: string; worktree: string | null }> {
  const top = project.path
  const id = r.id
  if (r.session_id && (await resumed(r.session_id))) {
    throw new Refusal(`the session of ${r.branch} runs in a terminal; quit it there, then finish again`, 409)
  }
  const tree = (await worktrees(top)).find((t) => t.branch === r.branch)
  const clean = async () => {
    if (force) return
    if (tree && (await git(tree.path, 'status', '--porcelain')) !== '') {
      throw new Refusal(`${tree.path} has changes not committed; commit them, or finish with force to lose them`, 409)
    }
    if (!(await exists(top, `refs/heads/${r.branch}`))) return
    const n = Number(await git(top, 'rev-list', '--count', r.branch, '--not', r.base, '--remotes=origin'))
    if (n > 0) throw new Refusal(`${r.branch} has ${n} commit(s) on no branch of origin; push them, or finish with force to lose them`, 409)
  }
  await clean()
  await stop(id)
  await clean()
  if (tree) {
    await git(top, 'worktree', 'remove', '--force', tree.path)
    await git(top, 'worktree', 'prune')
  }
  await git(top, 'branch', '-D', r.branch).catch(() => undefined)
  forget(stateDir, id)
  return { branch: r.branch, worktree: tree?.path ?? null }
}

// resumableHunt is the record of an interrupted hunt process, whose session or stage a resume goes on
// with, or the refusal that says why it cannot.
export async function resumableHunt(project: Project, stateDir: string, id: string): Promise<HuntRecord> {
  const check = () => {
    const r = huntOf(stateDir, id)
    if (r.state !== 'interrupted') throw new Refusal(`${id} is ${r.state}, not interrupted; only an interrupted session resumes`, 409)
    if (!existsSync(r.worktree)) throw new Refusal(`the worktree ${r.worktree} of ${id} is gone, so its session cannot go on there; finish it`, 409)
    return r
  }
  const r = check()
  const tree = (await worktrees(project.path)).find((t) => t.path === r.worktree)
  if (tree?.branch !== r.branch) throw new Refusal(`the worktree ${r.worktree} of ${id} is not on ${r.branch}, so its session cannot go on there; finish it`, 409)
  return check()
}
