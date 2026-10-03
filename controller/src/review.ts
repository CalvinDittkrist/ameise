// The review stage of a work process, which the controller runs once the gate has passed. A round runs
// the repository's reviewers in parallel, each a fresh read-only session briefed with the diff, the gate
// result and the issue, which reports a verdict and its findings through a schema. The first round runs
// every reviewer of WF_REVIEWERS, a later one those whose last verdict was fix. Every round is an attempt
// in the record's history with each reviewer's verdict and findings.
//
// A fix verdict starts one fix session of the review with every finding of the round by its id; its
// complete runs the gate again, whose pass starts the next round. Once every reviewer passes, the panel
// passes and the pr stage (pr.ts) opens the pull request. Once WF_REVIEW_ROUNDS rounds ran with a fix
// verdict still standing, the panel fails: the pull request is opened all the same, and names the failed
// panel. A reviewer that reports no verdict ends the process failed with the reason.
import { type AgentRun, type Ended, reviewers } from './agents.js'
import { git } from './git.js'
import { pr } from './pr.js'
import type { Project } from './project.js'
import { reviewBrief, reviewFixBrief } from './briefs.js'
import { type Running, track } from './running.js'
import { agents, begin, type Runtime } from './session.js'
import { knob, setting } from './settings.js'
import type { Attempt, StageRecord, Verdict } from './records.js'
import { attempt, event, update } from './store.js'

const defaultReviewers = ['code', 'security', 'docs', 'tests', 'senior']
const defaultRounds = 3

// reviewersOf reads WF_REVIEWERS of the process: a comma-separated list of the reviewers (agents.ts), the five
// where it is not set. A name that is no reviewer is refused with the reason.
export function reviewersOf(record: StageRecord): string[] {
  const value = setting(record, 'WF_REVIEWERS')
  if (value === undefined || value === '') return defaultReviewers
  if (typeof value !== 'string') throw new Error(`WF_REVIEWERS=${String(value)} is not a list of reviewers; set it as such, such as code,security, or leave it out for ${defaultReviewers.join(',')}`)
  const names = [...new Set(value.split(',').map((n) => n.trim()).filter((n) => n !== ''))]
  const unknown = names.find((n) => !Object.hasOwn(reviewers, n))
  if (unknown !== undefined) throw new Error(`WF_REVIEWERS names ${unknown}, which is no reviewer; the reviewers are ${Object.keys(reviewers).join(', ')}`)
  return names.length > 0 ? names : defaultReviewers
}

// review starts a round of the review stage of a process and answers the record as it runs. A stop ends
// its reviewers; a resume runs the round again.
export function review(record: StageRecord, project: Project, rt: Runtime): StageRecord {
  const id = record.id
  const started = (update(rt.stateDir, id, { stage: 'review', state: 'running', note: 'the reviewers run', fixing: false } as Partial<StageRecord>) as StageRecord | undefined) ?? record
  const abort = new AbortController()
  // The round starts on the next turn, once the stage is tracked, so a stop meanwhile ends it.
  const tracked: { own: () => boolean; s?: Running } = { own: () => false }
  const own = () => tracked.own()
  const done = Promise.resolve()
    .then(() => (tracked.s ? round(started, project, rt, tracked.s, own) : undefined))
    .catch((err: unknown) => {
      if (!own()) return
      const note = `the review failed: ${(err as Error).message}`
      event(rt.stateDir, id, { event: 'review-end', stage: 'review', state: 'failed', note })
      const failed = update(rt.stateDir, id, { state: 'failed', note, unseen: true })
      if (failed) rt.announce(failed)
    })
    .catch((err: unknown) => {
      process.stderr.write(`warning: ${id}: its review ended unexpectedly: ${(err as Error).message}\n`)
    })
  Object.assign(tracked, track(id, abort, done, 'the reviewers run'))
  return started
}

async function round(record: StageRecord, project: Project, rt: Runtime, s: Running, own: () => boolean): Promise<void> {
  const id = record.id
  const repo = `${project.owner}/${project.name}`
  // end ends the review with the note, unless a stop has taken it over: a panel that passed or failed
  // goes on to the pr stage, a review that failed ends the process failed.
  const end = (state: 'ready' | 'failed', note: string, a?: Attempt, change: Partial<StageRecord> = {}) => {
    if (!own()) return
    event(rt.stateDir, id, { event: 'review-end', stage: 'review', state: state === 'ready' ? (change.panel ?? 'pass') : state, note })
    if (state === 'ready') {
      const full = { ...change, note }
      const next = a ? attempt(rt.stateDir, id, a, full) : update(rt.stateDir, id, full)
      if (next && own()) pr(next as StageRecord, project, rt)
      return
    }
    const full = { ...change, state, note, unseen: true }
    const ended = a ? attempt(rt.stateDir, id, a, full) : update(rt.stateDir, id, full)
    if (ended) rt.announce(ended)
  }
  let names: string[]
  let rounds: number
  try {
    names = reviewersOf(record)
    rounds = knob(record, 'WF_REVIEW_ROUNDS', defaultRounds, 1)
  } catch (err) {
    return end('failed', (err as Error).message)
  }

  // The rounds of this review: those since the implement session last ended, whose work it reviews.
  const history = record.history ?? []
  const since = history.map((h) => h.stage === 'implement' || h.stage === 'hunt').lastIndexOf(true)
  const past = history.slice(since + 1).filter((h) => h.stage === 'review' && h.kind === 'round')
  const n = past.length + 1
  const last = new Map<string, string>()
  for (const r of past) for (const v of r.verdicts ?? []) last.set(v.reviewer, v.verdict)
  const due = names.filter((name) => !last.has(name) || last.get(name) !== 'pass')
  if (due.length === 0) return end('ready', `the review passed in round ${n - 1}`, undefined, { panel: 'pass' })

  update(rt.stateDir, id, { note: `review round ${n} of ${rounds}: ${due.join(', ')}` })
  event(rt.stateDir, id, { event: 'review-start', stage: 'review', round: n, reviewers: due })
  const gated = [...history].reverse().find((h) => h.stage === 'gate' && h.kind === 'run')
  const commit = await git(record.worktree, 'rev-parse', 'HEAD')
  // A stop while git ran has taken the process over; no reviewer starts after it.
  if (!own() || s.abort.signal.aborted) return
  const brief = reviewBrief(record, repo, gated)
  const ended = await agents(record, rt, s, own, due.map((name) => ({ run: reviewers[name] as AgentRun, brief })))
  const ends = due.map((reviewer, i) => ({ reviewer, ended: ended[i] as Ended }))
  if (!own()) return

  const verdicts: Verdict[] = ends.map(({ reviewer, ended }) => {
    const at = ended.session_id ? { session_id: ended.session_id } : {}
    if (!ended.verdict) return { reviewer, verdict: 'failed', ...at, findings: [], note: ended.note }
    const findings = ended.verdict.findings.map((f, i) => ({ id: `${reviewer}-${n}-${i + 1}`, ...f }))
    return { reviewer, verdict: ended.verdict.verdict, ...at, findings }
  })
  const broken = verdicts.filter((v) => v.verdict === 'failed')
  const fixing = verdicts.filter((v) => v.verdict === 'fix')
  const result = broken.length > 0 ? 'failed' : fixing.length > 0 ? 'fix' : 'pass'
  const a: Attempt = { stage: 'review', kind: 'round', result, at: new Date().toISOString(), commit, round: n, verdicts }
  event(rt.stateDir, id, { event: 'review', ...a })
  if (broken.length > 0) return end('failed', `review round ${n}: ${broken.map((v) => v.note).join('; ')}`, a)
  if (fixing.length === 0) return end('ready', `the review passed in round ${n}`, a, { panel: 'pass' })
  const who = fixing.map((v) => v.reviewer).join(', ')
  if (n >= rounds) {
    return end('ready', `the review spent its ${rounds} round(s) with ${who} at fix; the panel failed, which the pull request names`, a, { panel: 'failed' })
  }
  // A fix session is a fresh session with every finding of the round; its complete runs the gate again.
  const findings = verdicts.flatMap((v) => v.findings)
  const next = attempt(rt.stateDir, id, a, { session_id: undefined, fixing: true, note: `review round ${n}: ${who} at fix; a fix session takes ${findings.length} finding(s)` })
  if (!next || !own()) return
  begin(next, project, rt, reviewFixBrief(next, repo, n, findings))
}

// resumeFix starts the fix session of the review afresh for a process the controller stopped before that
// session reported its id: with every finding of the last round, as the round had started it.
export function resumeFix(record: StageRecord, project: Project, rt: Runtime): StageRecord {
  const last = [...(record.history ?? [])].reverse().find((h) => h.stage === 'review' && h.kind === 'round')
  if (!last || last.result !== 'fix') return review(record, project, rt)
  const findings = (last.verdicts ?? []).flatMap((v) => v.findings)
  return begin(record, project, rt, reviewFixBrief(record, `${project.owner}/${project.name}`, last.round ?? 1, findings)) as StageRecord
}
