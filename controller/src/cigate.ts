// The gate on CI of a work process: the gate of a repository whose WF_GATE is ci, every check, or
// ci:<checks>, the checks it names. GitHub runs its workflows on a pull request and not on a pushed
// branch, so the first gate on CI of a process pushes the branch and opens the gate's draft: a draft pull
// request against the base, titled with the first line of the issue's title, whose body is Closes #N
// alone (the contract fixture's draft rule). The record keeps its number and a draft flag, which is the
// controller's own and never GitHub's draft state: a person who marks the draft ready changes nothing.
//
// Before a gate on CI reads the checks it reads the branch's open pull requests. The one the record
// names, of the branch and opened by the login gh is logged in as, is taken over; any other ends the
// process failed with a note naming it, and nothing is written on the issue (the fixture's takeover).
//
// It then reads the checks of the pushed head every poll until they pass, fail or go missing. The
// "Gate on CI" section of controller/README.md states the rules and the knobs of this reading.
// A draft that conflicts with the base gets the base merged in and pushed. The whole poll runs inside
// the gate node (gate.ts), which a stop ends. A pass returns the outcome pass. A merge that conflicts in
// files and a failed check return fail, which the engine takes to the gate fix node within the budget.
// Every other end returns failed, which parks the process with the reason.
import { rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { git, push } from './git.js'
import { checksOf, pause, type Reading } from './checks.js'
import { run } from './exec.js'
import { defaultGrace, fail, type GateForm, mergeBase, short, stopped, tailOf } from './gate.js'
import type { NodeContext, Outcome } from './engine.js'
import { type Runtime } from './session.js'
import { knob } from './settings.js'
import type { Attempt, Check, Pull, StageRecord } from './records.js'
import { attempt, event, update } from './store.js'

// The failed logs a fix session is briefed with: those of at most this many runs of GitHub Actions.
const maxLogRuns = 4

const readingFields = 'number,url,state,headRefOid,mergeable,statusCheckRollup'

type CiForm = Extract<GateForm, { form: 'ci' }>

// draftOf is the gate's draft of an issue, as the contract fixture's draft rule states it: the first line
// of the issue's title, and the body Closes #N alone.
export function draftOf(issue: number, title: string): { title: string; body: string } {
  const first = (title.split('\n')[0] ?? '').trim()
  return { title: first === '' ? `Issue #${issue}` : first, body: `Closes #${issue}` }
}

// An open pull request of the process's branch: its number, where it is and who opened it.
export interface BranchPull {
  number: number
  url: string
  author: string
}

// takeoverOf is what a gate on CI does with the pull requests open on its branch, by the contract
// fixture's takeover rule: it takes over the one the record names and its own login opened, any other
// ends the process, and none opens the draft.
export function takeoverOf(open: BranchPull[], recorded: number, login: string): { outcome: 'take over'; pull: BranchPull } | { outcome: 'open' } | { outcome: 'end'; foreign: BranchPull[] } {
  const ours = open.find((p) => recorded > 0 && p.number === recorded && p.author.toLowerCase() === login.toLowerCase())
  const foreign = open.filter((p) => p !== ours)
  if (foreign.length > 0) return { outcome: 'end', foreign }
  if (ours) return { outcome: 'take over', pull: ours }
  return { outcome: 'open' }
}

// openPulls are the pull requests open on the branch in the repository itself; a fork's of the same name
// is another branch.
async function openPulls(gh: string, repo: string, branch: string): Promise<BranchPull[]> {
  const list = JSON.parse(await run(gh, ['pr', 'list', '--repo', repo, '--state', 'open', '--limit', '100', '--json', 'number,headRefName,isCrossRepository,url,author', '--head', branch])) as {
    number: number
    headRefName: string
    isCrossRepository?: boolean
    url: string
    author?: { login?: string } | null
  }[]
  return list.filter((p) => p.headRefName === branch && !p.isCrossRepository).map((p) => ({ number: p.number, url: p.url, author: p.author?.login ?? 'someone' }))
}

// A verdict of one reading of the checks the gate on CI reads.
type Judged = { verdict: 'wait'; wait: string } | { verdict: 'missing'; missing: string[] } | { verdict: 'fail' } | { verdict: 'pass' }

// judge reads the checks of a head: every check, or the named ones. A check that runs under one name in
// several workflows is read in each.
function judge(all: Check[], names: string[], graceOver: boolean): { judged: Judged; read: Check[] } {
  const read = names.length > 0 ? all.filter((c) => names.includes(c.name)) : all
  const missing = names.length > 0 ? names.filter((n) => !all.some((c) => c.name === n)) : all.length === 0 ? ['any check'] : []
  const pending = read.filter((c) => c.state === 'pending').length
  if (pending > 0) return { judged: { verdict: 'wait', wait: `the checks: ${pending} of ${read.length} pending` }, read }
  if (missing.length > 0 && graceOver) return { judged: { verdict: 'missing', missing }, read }
  if (missing.length > 0) return { judged: { verdict: 'wait', wait: names.length > 0 ? `the checks ${missing.join(', ')} to appear` : 'GitHub to register the checks of the head' }, read }
  if (read.some((c) => c.state === 'fail')) return { judged: { verdict: 'fail' }, read }
  return { judged: { verdict: 'pass' }, read }
}

// listed is the checks read, one line each with its state.
const listed = (checks: Check[]) => checks.map((c) => `${c.name} ${c.state}${c.url ? ` ${c.url}` : ''}`).join('\n')

// failedLogs is the end of the failed logs of the checks that failed, from GitHub Actions; a check of
// another system has none to give, and its URL in the brief is where to look.
async function failedLogs(gh: string, repo: string, failing: Check[]): Promise<string> {
  const runs = [...new Set(failing.flatMap((c) => /\/actions\/runs\/([0-9]+)/.exec(c.url ?? '')?.[1] ?? []))].slice(0, maxLogRuns)
  const out: string[] = []
  for (const id of runs) {
    try {
      out.push(`run ${id}:\n${tailOf(await run(gh, ['run', 'view', id, '--repo', repo, '--log-failed']))}`)
    } catch (err) {
      out.push(`run ${id}: its failed log could not be read: ${(err as Error).message.split('\n')[0]}`)
    }
  }
  return out.length > 0 ? out.join('\n\n') : "no failed log could be read; the checks' pages are named above"
}

// ciGate runs the gate on CI of a process within the gate node until its pass, its failure or its end,
// unless a stop takes it over, and returns the outcome of the node: pass, fail or failed. Its waits are
// polls inside the node, which a stop ends.
export async function ciGate({ record, project, rt, signal, own }: NodeContext, form: CiForm, rounds: number, limit: number): Promise<Outcome> {
  const id = record.id
  const repo = `${project.owner}/${project.name}`
  const wt = record.worktree
  const now = () => new Date().toISOString()
  // end is the outcome failed with the note, which parks the process, unless a stop has taken it over.
  const end = (note: string, a?: Attempt): Outcome => {
    if (!own()) return stopped
    const change = { wait: undefined } as Partial<StageRecord>
    if (a) attempt(rt.stateDir, id, a, change)
    else update(rt.stateDir, id, change)
    return { outcome: 'failed', note }
  }
  let grace: number
  try {
    grace = knob(record, 'WF_CHECKS_GRACE', defaultGrace)
  } catch (err) {
    return end((err as Error).message)
  }
  const began = Date.now()
  update(rt.stateDir, id, { note: `the gate on CI pushes ${record.branch} and reads the checks of its draft` })

  const pushed = async (): Promise<string> => {
    await push(wt, record.branch, rt.fake)
    return git(wt, 'rev-parse', 'HEAD')
  }
  let head: string
  try {
    head = await pushed()
  } catch (err) {
    return end(`could not push ${record.branch} to origin: ${(err as Error).message}`)
  }
  if (!own()) return stopped

  let pull: Pull
  try {
    const settled = await draft(record, repo, rt, own)
    if (!settled || !own()) return stopped
    if ('foreign' in settled) {
      const named = settled.foreign.map((p) => `#${p.number} of ${p.author} (${p.url})`).join(', ')
      return end(
        `the branch ${record.branch} has a pull request open that is not this process's: ${named}. A pull request is the process's only when the controller recorded it and the login of gh opened it; close that pull request or delete the branch, and claim again`,
      )
    }
    pull = settled
  } catch (err) {
    return end(`the gate on CI could not settle the draft of ${record.branch}: ${(err as Error).message}`)
  }
  const n = pull.number

  let pushedAt = Date.now()
  let seen = ''
  let shown = ''
  let said = ''
  for (;;) {
    if (!own()) return stopped
    if (Date.now() - began >= limit * 1000) {
      return end(`the gate on CI ran past the gate timeout of ${limit} s (WF_GATE_TIMEOUT) on PR #${n} at ${short(head)}${shown ? `, waiting for ${shown}` : ''}`)
    }
    let wait = 'GitHub to answer'
    let checks: Check[] = []
    let r: Reading | undefined
    try {
      r = JSON.parse(await run(rt.gh, ['pr', 'view', String(n), '--repo', repo, '--json', readingFields])) as Reading
    } catch (err) {
      wait = `GitHub to answer: ${(err as Error).message.split('\n')[0]}`
    }
    if (!own()) return stopped
    if (!r) {
      // wait says what GitHub did not answer
    } else if (r.state !== 'OPEN') {
      return end(`the gate's draft PR #${n} is ${r.state.toLowerCase()}, so its checks cannot gate the branch; open it again and resume, or abandon the process`)
    } else if (r.mergeable === 'CONFLICTING' && (!r.headRefOid || r.headRefOid === head)) {
      // GitHub runs no workflow on a branch that does not merge, so the base is merged in and pushed.
      event(rt.stateDir, id, { event: 'gate-note', note: `PR #${n} conflicts with ${record.base}; merging it in` })
      let files: string[]
      try {
        files = await mergeBase(record, rt)
      } catch (err) {
        return end((err as Error).message)
      }
      if (!own()) return stopped
      if (files.length > 0) {
        const failure: Attempt = { stage: 'gate', kind: 'merge', result: 'conflict', at: now(), commit: await git(wt, 'rev-parse', 'HEAD'), files, pr: n, url: pull.url }
        if (!own()) return stopped
        event(rt.stateDir, id, { event: 'gate', ...failure })
        return fail(record, rt, own, failure, form.name, rounds)
      }
      try {
        head = await pushed()
      } catch (err) {
        return end(`could not push the merge of ${record.base} to origin: ${(err as Error).message}`)
      }
      if (!own()) return stopped
      pushedAt = Date.now()
      seen = ''
      wait = `the checks of ${short(head)}, which merged ${record.base}`
    } else if (r.headRefOid && r.headRefOid !== head) {
      wait = `GitHub to show the push of ${short(head)}`
    } else if (r.mergeable !== 'MERGEABLE') {
      wait = 'GitHub to say whether the branch merges into its base'
    } else {
      const all = checksOf(r).map((c) => ({ name: c.name, ...(c.url ? { url: c.url } : {}), state: c.state }))
      const { judged, read } = judge(all, form.checks, Date.now() - pushedAt >= grace * 1000)
      checks = read
      const base: Attempt = { stage: 'gate', kind: 'run', result: 'pass', at: now(), commit: head, gate: form.name, pr: n, url: pull.url, checks }
      if (judged.verdict === 'missing') {
        const note =
          form.checks.length === 0
            ? `the gate on CI read no check on ${short(head)} of PR #${n} within the checks grace of ${grace} s (WF_CHECKS_GRACE) after the push, so nothing passed: a gate on CI needs a workflow that runs on pull requests, or set WF_GATE to a command`
            : `the gate ${form.name} names the check(s) ${judged.missing.join(', ')}, which PR #${n} did not show on ${short(head)} within the checks grace of ${grace} s (WF_CHECKS_GRACE) after the push: name the checks in WF_GATE as the pull request shows them`
        return end(note, { ...base, result: 'missing', note })
      }
      if (judged.verdict === 'fail') {
        const failing = checks.filter((c) => c.state === 'fail')
        const tail = `The checks that failed:\n${listed(failing)}\n\nThe end of their failed logs:\n${await failedLogs(rt.gh, repo, failing)}`
        if (!own()) return stopped
        const failure: Attempt = { ...base, result: 'fail', tail }
        update(rt.stateDir, id, { checks } as Partial<StageRecord>)
        event(rt.stateDir, id, { event: 'gate', ...failure })
        return fail(record, rt, own, failure, form.name, rounds)
      }
      if (judged.verdict === 'pass') {
        const key = `${head} ${JSON.stringify(checks)}`
        // With every check read, a pass stands on a second reading a poll later that shows the same checks.
        if (form.checks.length > 0 || seen === key) {
          const a: Attempt = { ...base, tail: listed(checks) }
          event(rt.stateDir, id, { event: 'gate', ...a })
          event(rt.stateDir, id, { event: 'gate-end', stage: 'gate', state: 'pass', note: `the gate on CI passed at ${short(head)} on PR #${n}: ${checks.map((c) => c.name).join(', ')}` })
          attempt(rt.stateDir, id, a, { state: 'running', wait: undefined, checks } as Partial<StageRecord>)
          return { outcome: 'pass' }
        }
        seen = key
        wait = 'a second reading a poll later that shows the same checks'
      } else {
        seen = ''
        wait = judged.wait
      }
    }
    const saw = JSON.stringify(checks)
    if (wait !== shown || saw !== said) {
      shown = wait
      said = saw
      event(rt.stateDir, id, { event: 'gate-wait', stage: 'gate', pr: n, wait })
      update(rt.stateDir, id, { state: 'waiting', note: `the gate on CI, PR #${n}: waiting for ${wait}`, wait, checks } as Partial<StageRecord>)
    }
    await pause(rt.poll, signal)
  }
}

// draft settles the pull request the gate on CI reads: the draft the record names, taken over, or a new
// draft it opens when the branch has none open. It answers the pull requests of somebody else that end
// the process, or undefined once a stop has taken the process over.
async function draft(record: StageRecord, repo: string, rt: Runtime, own: () => boolean): Promise<Pull | { foreign: BranchPull[] } | undefined> {
  const id = record.id
  const open = await openPulls(rt.gh, repo, record.branch)
  // The login is asked only of a branch that has a pull request open.
  const login = open.length > 0 ? (await run(rt.gh, ['api', 'user', '--jq', '.login'])).trim() : ''
  if (!own()) return undefined
  const recorded = record.pull?.number ?? 0
  const t = takeoverOf(open, recorded, login)
  if (t.outcome === 'end') return { foreign: t.foreign }
  if (t.outcome === 'take over') {
    event(rt.stateDir, id, { event: 'gate-note', note: `going on with the gate's draft PR #${t.pull.number}` })
    return { number: t.pull.number, url: t.pull.url }
  }
  if (recorded > 0) event(rt.stateDir, id, { event: 'gate-note', note: `PR #${recorded}, which the process recorded, is not open on ${record.branch} any more; opening a new draft` })
  // A hunt has no issue to read: its draft names the date of its branch and closes nothing.
  let d: { title: string; body: string }
  if (record.issue === null) {
    d = { title: `Test hunt ${record.branch.replace(/^hunt\/tests-/, '')}`, body: 'A test hunt: it removes tests that prove nothing and closes no issue.' }
  } else {
    const issue = JSON.parse(await run(rt.gh, ['issue', 'view', String(record.issue), '--repo', repo, '--json', 'number,title,state,labels'])) as { title?: string }
    d = draftOf(record.issue, issue.title ?? '')
  }
  if (!own()) return undefined
  const file = join(rt.stateDir, 'processes', `${id}.draft.md`)
  let url: string
  try {
    writeFileSync(file, d.body)
    url = await run(rt.gh, ['pr', 'create', '--repo', repo, '--base', record.base.replace(/^origin\//, ''), '--head', record.branch, '--title', d.title, '--body-file', file, '--draft'])
  } finally {
    rmSync(file, { force: true })
  }
  const number = Number(/\/pull\/([0-9]+)\s*$/.exec(url)?.[1] ?? NaN)
  if (!Number.isInteger(number)) throw new Error(`gh pr create answered ${JSON.stringify(url)}, which names no pull request`)
  const pull: Pull = { number, url: url.trim() }
  event(rt.stateDir, id, { event: 'gate-note', note: `opened the gate's draft PR #${number}; the pr stage finishes it` })
  update(rt.stateDir, id, { pull, draft: true } as Partial<StageRecord>)
  return pull
}
