// The ci stage of a work process, which the controller runs once the pr stage has opened the pull
// request. It pushes what the branch has, then waits on the pull request itself, with one wait at a time
// and no session polling: first for GitHub to say whether the branch merges into its base, then for the
// checks, then for a review of each bot of WF_PR_BOT_REVIEWERS within WF_PR_REVIEW_WAIT seconds of the
// checks' end, then it reads the standing requests for changes and the unresolved threads.
//
// A gate's draft the pr stage marked ready waits for the checks its ready starts, as the README's ci
// stage says. Bot reviewers skip drafts, so their review is waited for from the ready on.
//
// A conflict or failed checks start a fix session of the ci stage within WF_CI_REPAIR_ROUNDS; its complete
// comes back here, which pushes and waits again. Green ends the process ready, where the board offers
// the merge. A standing request for changes, an unresolved thread or a merge state other than clean is
// never green: the process is blocked until the maintainer answers it. A pull request merged meanwhile
// blocks it too, for the maintainer to abandon. A spent repair budget ends the process failed, and so does a
// pull request that is closed. Every verdict other than a wait is an attempt in the record's history.
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { type Attempt, type Check, fetch, git, push, type WorkRecord } from './claim.js'
import { run } from './exec.js'
import { defaultGrace, knob, setting } from './gate.js'
import type { Project } from './project.js'
import { attempt, begin, ciFixBrief, event, type Runtime, track, update } from './session.js'

// The ci stage's knobs, the worker's own defaults: the repair rounds of one pull request, the bots whose
// review is waited for, and how many seconds after the checks' end a bot's review is waited for.
const defaultRepairs = 3
const defaultBots = 'chatgpt-codex-connector'
const defaultReviewWait = 1200
// How many seconds after the stage started an empty rollup reads as checks GitHub has not registered
// yet, in a repository that has workflows.
const checksGrace = 600

// botsOf reads WF_PR_BOT_REVIEWERS of the process: a comma-separated list of logins, written with or
// without [bot]; empty means no bot is waited for, and unset means the worker's default.
export function botsOf(record: WorkRecord): string[] {
  const value = setting(record, 'WF_PR_BOT_REVIEWERS')
  if (value === undefined) return [defaultBots]
  if (typeof value !== 'string') throw new Error(`WF_PR_BOT_REVIEWERS=${String(value)} is not a list of logins; set it as such, such as ${defaultBots}, or empty for no bot`)
  return [...new Set(value.split(',').map((l) => l.trim().replace(/\[bot\]$/, '')).filter((l) => l !== ''))]
}

// A reading of the pull request as gh pr view answers it: the fields the verdict is made of.
export interface Reading {
  number: number
  url: string
  state: string
  headRefOid?: string
  mergeable: string
  mergeStateStatus?: string
  statusCheckRollup?: { name?: string; context?: string; conclusion?: string | null; state?: string | null; status?: string | null; completedAt?: string | null; detailsUrl?: string; targetUrl?: string }[]
  reviews?: { author?: { login?: string } | null; state: string; submittedAt?: string }[]
}

const readingFields = 'number,url,state,headRefOid,mergeable,mergeStateStatus,statusCheckRollup,reviews'

const failures = ['FAILURE', 'ERROR', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE']
const pendings = ['PENDING', 'EXPECTED', 'QUEUED', 'IN_PROGRESS', 'WAITING', 'REQUESTED']

// checksOf are the checks of a reading, each pass, fail or pending, with when it completed.
export function checksOf(r: Reading): (Check & { completed?: number })[] {
  return (r.statusCheckRollup ?? []).map((c) => {
    const s = c.conclusion || c.state || 'PENDING'
    const pending = pendings.includes(s) || (c.status != null && c.status !== 'COMPLETED')
    const state: Check['state'] = failures.includes(s) ? 'fail' : pending ? 'pending' : 'pass'
    const url = c.detailsUrl || c.targetUrl
    const completed = c.completedAt ? Date.parse(c.completedAt) : NaN
    return { name: c.name || c.context || 'check', ...(url ? { url } : {}), state, ...(Number.isFinite(completed) ? { completed } : {}) }
  })
}

// The verdict of one reading: a wait with what it waits for, or an end of the wait.
type Verdict =
  | { kind: 'waiting'; wait: string }
  | { kind: 'closed' | 'merged' | 'conflicts' | 'checks-failed' | 'green' }
  | { kind: 'review-comments'; reviews: string[] }
  | { kind: 'unmergeable'; status: string }

interface Knobs {
  bots: string[]
  reviewWait: number
  workflows: boolean
  started: number
  // readied is when the pr stage marked the gate's draft ready, onReady says a workflow runs on that,
  // and grace is WF_CHECKS_GRACE in seconds.
  readied?: number
  onReady: boolean
  grace: number
}

// judge makes the verdict of one reading, in the order of the waits. doneAt is when the checks were first
// seen done without GitHub saying when, which the review wait counts from; it is the caller's, across
// readings. unresolved counts the review threads nobody resolved, which is asked only once every wait
// before it has passed.
async function judge(r: Reading, unresolved: () => Promise<number>, k: Knobs, now: number, doneAt: { at?: number }): Promise<Verdict> {
  if (r.state === 'MERGED') return { kind: 'merged' }
  if (r.state !== 'OPEN') return { kind: 'closed' }
  if (r.mergeable === 'CONFLICTING') return { kind: 'conflicts' }
  if (r.mergeable !== 'MERGEABLE') return { kind: 'waiting', wait: 'GitHub to say whether the branch merges into its base' }
  const checks = checksOf(r)
  const pending = checks.filter((c) => c.state === 'pending').length
  if (pending > 0) return { kind: 'waiting', wait: `the checks: ${pending} of ${checks.length} pending` }
  if (checks.length === 0 && k.workflows && now - k.started < checksGrace * 1000) return { kind: 'waiting', wait: 'GitHub to register the checks of the workflows' }
  if (checks.some((c) => c.state === 'fail')) return { kind: 'checks-failed' }
  const last = Math.max(0, ...checks.map((c) => c.completed ?? 0))
  if (k.readied !== undefined && k.onReady && last <= k.readied && now - k.readied < k.grace * 1000) {
    return { kind: 'waiting', wait: `the checks of marking the draft ready for review, until ${new Date(k.readied + k.grace * 1000).toISOString()}` }
  }
  if (last > 0) doneAt.at = last
  else doneAt.at ??= now
  // A bot reviews no draft, so its wait starts at the ready at the earliest.
  if (k.readied !== undefined) doneAt.at = Math.max(doneAt.at, k.readied)
  const reviewed = (r.reviews ?? []).filter((v) => k.bots.includes((v.author?.login ?? '').replace(/\[bot\]$/, ''))).length
  if (k.bots.length > 0 && reviewed === 0 && now - doneAt.at < k.reviewWait * 1000) {
    return { kind: 'waiting', wait: `a review of ${k.bots.join(', ')}, until ${new Date(doneAt.at + k.reviewWait * 1000).toISOString()}` }
  }
  // What one writer says is their latest review that states anything; a request for changes stands until
  // they approve or it is dismissed.
  const latest = new Map<string, { state: string; at: string }>()
  for (const v of r.reviews ?? []) {
    if (v.state === 'COMMENTED' || v.state === 'PENDING') continue
    const login = v.author?.login ?? 'someone'
    const at = v.submittedAt ?? ''
    if ((latest.get(login)?.at ?? '') <= at) latest.set(login, { state: v.state, at })
  }
  const reviews = [...latest].filter(([, v]) => v.state === 'CHANGES_REQUESTED').map(([login]) => `${login} requested changes`)
  const open = await unresolved()
  if (open > 0) reviews.push(`${open} review thread(s) not resolved`)
  if (reviews.length > 0) return { kind: 'review-comments', reviews }
  // The merge takes only a clean pull request: one behind its base or blocked by a rule of it is not green.
  const status = r.mergeStateStatus ?? 'UNKNOWN'
  if (status === 'UNKNOWN') return { kind: 'waiting', wait: 'GitHub to say whether the base lets the branch merge' }
  if (status !== 'CLEAN') return { kind: 'unmergeable', status }
  return { kind: 'green' }
}

// unresolved counts the review threads of a pull request nobody resolved, by the first hundred threads.
async function unresolved(gh: string, owner: string, name: string, n: number): Promise<number> {
  const query = 'query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){reviewThreads(first:100){nodes{isResolved}}}}}'
  const out = JSON.parse(await run(gh, ['api', 'graphql', '-F', `owner=${owner}`, '-F', `name=${name}`, '-F', `number=${n}`, '-f', `query=${query}`])) as {
    data?: { repository?: { pullRequest?: { reviewThreads?: { nodes?: { isResolved: boolean }[] } } } }
  }
  const nodes = out.data?.repository?.pullRequest?.reviewThreads?.nodes
  if (!nodes) throw new Error(`GitHub named no review threads of PR #${n}`)
  return nodes.filter((t) => !t.isResolved).length
}

// workflowsIn says whether the worktree has workflows of GitHub Actions, so an empty rollup is checks
// GitHub has not registered yet and not green.
function workflowsIn(wt: string): boolean {
  try {
    return readdirSync(join(wt, '.github', 'workflows')).some((f) => f.endsWith('.yml') || f.endsWith('.yaml'))
  } catch {
    return false
  }
}

// readyIn says a workflow of the worktree names the ready_for_review event, so marking a draft ready
// starts checks of its own. It reads the text, not the YAML: a workflow that only mentions the event
// costs a wait of the checks grace, never a green on checks that were not there yet.
function readyIn(wt: string): boolean {
  try {
    const dir = join(wt, '.github', 'workflows')
    return readdirSync(dir)
      .filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))
      .some((f) => readFileSync(join(dir, f), 'utf8').includes('ready_for_review'))
  } catch {
    return false
  }
}

// pause lets ms pass, or less once the signal aborts.
export function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve()
    const done = () => {
      clearTimeout(timer)
      signal.removeEventListener('abort', done)
      resolve()
    }
    const timer = setTimeout(done, ms)
    signal.addEventListener('abort', done, { once: true })
  })
}

// ci starts the ci stage of a process once after has settled, as the runtime of a fix session before it
// has exited, and answers the record as it runs. A stop ends its wait; before is the abort of that
// session, which a stop of the stage aborts too while its runtime exits.
export function ci(record: WorkRecord, project: Project, rt: Runtime, after: Promise<void> = Promise.resolve(), before?: AbortController): WorkRecord {
  const id = record.id
  const n = record.pull?.number
  const started = (update(rt.stateDir, id, { stage: 'ci', state: 'waiting', note: `waiting on PR #${n ?? '?'}`, fixing: false } as Partial<WorkRecord>) as WorkRecord | undefined) ?? record
  event(rt.stateDir, id, { event: 'ci-start', stage: 'ci', pr: n })
  const abort = new AbortController()
  if (before) abort.signal.addEventListener('abort', () => before.abort(), { once: true })
  let own = () => true
  const done = after
    .then(() => (own() ? wait(started, project, rt, abort.signal, () => own()) : undefined))
    .catch((err: unknown) => {
      if (!own()) return
      const note = `the ci stage failed: ${(err as Error).message}`
      event(rt.stateDir, id, { event: 'ci-end', stage: 'ci', state: 'failed', note })
      const failed = update(rt.stateDir, id, { state: 'failed', note, wait: undefined, unseen: true } as Partial<WorkRecord>)
      if (failed) rt.announce(failed)
    })
    .catch((err: unknown) => {
      process.stderr.write(`warning: ${id}: its ci stage ended unexpectedly: ${(err as Error).message}\n`)
    })
  own = track(id, abort, done, `the ci stage waits on PR #${n ?? '?'}`).own
  return started
}

async function wait(record: WorkRecord, project: Project, rt: Runtime, signal: AbortSignal, own: () => boolean): Promise<void> {
  const id = record.id
  const repo = `${project.owner}/${project.name}`
  const wt = record.worktree
  // end ends the process in the state with the note, unless a stop has taken it over.
  const end = (state: 'ready' | 'blocked' | 'failed', note: string, a?: Attempt) => {
    if (!own()) return
    event(rt.stateDir, id, { event: 'ci-end', stage: 'ci', state, note })
    const change = { state, note, wait: undefined, unseen: true } as Partial<WorkRecord>
    const ended = a ? attempt(rt.stateDir, id, a, change) : update(rt.stateDir, id, change)
    if (ended) rt.announce(ended)
  }
  const pull = record.pull
  if (!pull) return end('failed', 'the ci stage has no pull request to wait on; resume it to open one')
  const n = pull.number
  let repairs: number
  let k: Knobs
  try {
    repairs = knob(record, 'WF_CI_REPAIR_ROUNDS', defaultRepairs)
    const readied = record.readied ? Date.parse(record.readied) : NaN
    k = {
      bots: botsOf(record),
      reviewWait: knob(record, 'WF_PR_REVIEW_WAIT', defaultReviewWait),
      workflows: workflowsIn(wt),
      started: Date.now(),
      ...(Number.isFinite(readied) ? { readied } : {}),
      onReady: readyIn(wt),
      grace: knob(record, 'WF_CHECKS_GRACE', defaultGrace),
    }
  } catch (err) {
    return end('failed', (err as Error).message)
  }

  // What a fix session committed reaches the pull request first.
  try {
    await push(wt, record.branch, rt.fake)
  } catch (err) {
    return end('failed', `could not push ${record.branch} to origin: ${(err as Error).message}`)
  }
  if (!own()) return
  const head = await git(wt, 'rev-parse', 'HEAD')
  const now = () => new Date().toISOString()
  const doneAt: { at?: number } = {}
  let shown = ''
  let seen = ''
  for (;;) {
    if (!own()) return
    let verdict: Verdict
    let checks: Check[] = []
    try {
      const r = JSON.parse(await run(rt.gh, ['pr', 'view', String(n), '--repo', repo, '--json', readingFields])) as Reading
      checks = checksOf(r).map((c) => ({ name: c.name, ...(c.url ? { url: c.url } : {}), state: c.state }))
      // A reading of another head is GitHub's before the push has reached it.
      if (r.headRefOid && r.headRefOid !== head && r.state === 'OPEN') verdict = { kind: 'waiting', wait: `GitHub to show the push of ${head.slice(0, 7)}` }
      else verdict = await judge(r, () => unresolved(rt.gh, project.owner, project.name, n), k, Date.now(), doneAt)
    } catch (err) {
      verdict = { kind: 'waiting', wait: `GitHub to answer: ${(err as Error).message.split('\n')[0]}` }
    }
    if (!own()) return
    const said = JSON.stringify(checks)
    if (verdict.kind === 'waiting') {
      if (verdict.wait !== shown || said !== seen) {
        shown = verdict.wait
        seen = said
        event(rt.stateDir, id, { event: 'ci-wait', stage: 'ci', pr: n, wait: verdict.wait })
        update(rt.stateDir, id, { state: 'waiting', note: `PR #${n}: waiting for ${verdict.wait}`, wait: verdict.wait, checks } as Partial<WorkRecord>)
      }
      await pause(rt.poll, signal)
      continue
    }
    update(rt.stateDir, id, { checks } as Partial<WorkRecord>)
    const a: Attempt = { stage: 'ci', kind: 'wait', result: verdict.kind, at: now(), commit: head, pr: n, url: pull.url, checks }
    if (verdict.kind === 'green') return end('ready', `PR #${n} is green: it merges, its checks pass and no review asks for changes`, a)
    if (verdict.kind === 'merged') return end('blocked', `PR #${n} is merged already on GitHub; abandon the process to remove its worktree and branch`, a)
    if (verdict.kind === 'unmergeable') return end('blocked', `PR #${n} is not green: its merge state is ${verdict.status}, not CLEAN; meet the base's rules on GitHub, or write here to have the session bring the branch up to date`, a)
    if (verdict.kind === 'closed') return end('failed', `PR #${n} is closed, so there is nothing to wait on; open it again and resume, or abandon the process`, a)
    if (verdict.kind === 'review-comments') {
      a.reviews = verdict.reviews
      return end('blocked', `PR #${n} is not green: ${verdict.reviews.join('; ')}; answer the review, or write here to have the session take it on`, a)
    }
    const failing = checks.filter((c) => c.state === 'fail')
    const what = verdict.kind === 'conflicts' ? `PR #${n} conflicts with ${record.base}` : `checks failed on PR #${n}: ${failing.map((c) => c.name).join(', ')}`
    event(rt.stateDir, id, { event: 'ci', ...a })
    // The repair rounds of this pull request: the fix sessions of the ci stage since it was opened or found.
    const history = record.history ?? []
    const since = history.map((h) => h.stage === 'pr' && h.kind === 'open').lastIndexOf(true)
    const spent = new Set(history.slice(since + 1).flatMap((h, i) => (h.stage === 'ci' && h.kind === 'session' ? [h.session_id ?? `#${i}`] : []))).size
    if (spent >= repairs) return end('failed', `the ci stage spent its ${repairs} repair round(s): ${what}`, a)
    if (verdict.kind === 'conflicts' && record.base.startsWith('origin/') && !(await fetch(record.project, record.base.slice('origin/'.length), rt.fake))) {
      event(rt.stateDir, id, { event: 'ci-note', note: `could not fetch ${record.base}; the fix session merges what this checkout has of it` })
    }
    if (!own()) return
    // A fix session is a fresh session: the one before it is in the history, not in its resume.
    const fixing = attempt(rt.stateDir, id, a, { session_id: undefined, fixing: true, wait: undefined, note: `${what}; repair round ${spent + 1} of ${repairs}` } as Partial<WorkRecord>)
    if (!fixing || !own()) return
    begin(fixing, project, rt, ciFixBrief(fixing, repo, n, verdict.kind, failing))
    return
  }
}
