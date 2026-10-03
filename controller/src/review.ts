// The review stage of a work process, which the controller runs once the gate has passed. A round runs
// the repository's reviewers in parallel, each a fresh read-only session briefed with the diff, the gate
// result and the issue, which reports a verdict and its findings through a schema. The first round runs
// every reviewer of WF_REVIEWERS, a later one those whose last verdict was fix. Every round is an attempt
// in the record's history with each reviewer's verdict and findings.
//
// The review and its fix are two nodes of the delivery graph (delivery.ts), which start no stage
// themselves. The review node returns pass, findings or failed, and the engine (engine.ts) follows it.
// A round with no reviewer left due passes at once. A pass writes the panel pass and goes on to the pr
// node, whose pr stage (pr.ts) opens the pull request. The graph's guard reviewRoundsRemain counts the
// rounds against WF_REVIEW_ROUNDS. Findings in a round below the limit go to the review fix node.
// Findings in the last round go to the pr node with the panel failed, which the pull request names.
// Failed parks the process failed with the reason. That is a reviewer with no verdict, a fix verdict
// without a finding, a wrong WF_REVIEWERS or WF_REVIEW_ROUNDS, or a throw.
//
// The review fix node starts one fresh fix session with every finding of the last round by its id. The
// complete of that session reaches the engine (session.ts), whose edge runs the gate again, and the
// gate's pass enters the next round.
import { type AgentRun, type Ended, reviewers } from './agents.js'
import { reviewRounds } from './budgets.js'
import { git } from './git.js'
import type { Node, NodeContext, Outcome } from './engine.js'
import { reviewBrief, reviewFixBrief } from './briefs.js'
import { agents, sessionEntry, talk } from './session.js'
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

// reviewNode is the review node of the delivery graph (delivery.ts). It runs a round of the reviewers side
// by side and returns pass, findings or failed. It starts no stage and no session itself; the engine
// (engine.ts) follows its outcome. A stop ends its reviewers; a resume enters the node again, which runs
// the round again.
export const reviewNode: Node = { run: (ctx) => round(ctx) }

// stopped is what the node returns once a stop has taken the process over, which the engine discards.
const stopped: Outcome = { outcome: 'stopped' }

async function round({ record, project, rt, running, own, signal }: NodeContext): Promise<Outcome> {
  const id = record.id
  const repo = `${project.owner}/${project.name}`
  // pass ends the review with the panel, which goes on to the pr node, unless a stop has taken it over.
  const pass = (panel: 'pass' | 'failed', note: string, a?: Attempt): Outcome => {
    if (!own()) return stopped
    event(rt.stateDir, id, { event: 'review-end', stage: 'review', state: panel, note })
    const change = { panel, note } as Partial<StageRecord>
    if (a) attempt(rt.stateDir, id, a, change)
    else update(rt.stateDir, id, change)
    return { outcome: panel === 'pass' ? 'pass' : 'findings' }
  }
  let names: string[]
  let rounds: number
  try {
    names = reviewersOf(record)
    rounds = knob(record, 'WF_REVIEW_ROUNDS', defaultRounds, 1)
  } catch (err) {
    return { outcome: 'failed', note: (err as Error).message }
  }

  // The rounds of this review: those since the implement session last ended, whose work it reviews.
  const history = record.history ?? []
  const past = reviewRounds(history)
  const n = past.length + 1
  const last = new Map<string, string>()
  for (const r of past) for (const v of r.verdicts ?? []) last.set(v.reviewer, v.verdict)
  const due = names.filter((name) => !last.has(name) || last.get(name) !== 'pass')
  if (due.length === 0) return pass('pass', `the review passed in round ${n - 1}`)

  update(rt.stateDir, id, { note: `review round ${n} of ${rounds}: ${due.join(', ')}` })
  event(rt.stateDir, id, { event: 'review-start', stage: 'review', round: n, reviewers: due })
  const gated = [...history].reverse().find((h) => h.stage === 'gate' && h.kind === 'run')
  const commit = await git(record.worktree, 'rev-parse', 'HEAD')
  // A stop while git ran has taken the process over; no reviewer starts after it.
  if (!own() || signal.aborted) return stopped
  const brief = reviewBrief(record, repo, gated)
  const ended = await agents(record, rt, running, own, due.map((name) => ({ run: reviewers[name] as AgentRun, brief })))
  const ends = due.map((reviewer, i) => ({ reviewer, ended: ended[i] as Ended }))
  if (!own()) return stopped

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
  if (broken.length > 0) {
    const note = `review round ${n}: ${broken.map((v) => v.note).join('; ')}`
    attempt(rt.stateDir, id, a)
    return { outcome: 'failed', note }
  }
  if (fixing.length === 0) return pass('pass', `the review passed in round ${n}`, a)
  // The guard reviewRoundsRemain of the graph reads the same budget: findings in the last round go to the
  // pr node with the panel failed, any other round's to the review fix node.
  if (n >= rounds) {
    const who = fixing.map((v) => v.reviewer).join(', ')
    return pass('failed', `the review spent its ${rounds} round(s) with ${who} at fix; the panel failed, which the pull request names`, a)
  }
  attempt(rt.stateDir, id, a)
  return { outcome: 'findings' }
}

// reviewFixNode is the review fix node: a fresh fix session with every finding of the last round, which
// it reads from that round's attempt, unless it goes on with the record's session on a resume or a
// message. Its complete goes to the gate through the engine.
export const reviewFixNode: Node = {
  talks: true,
  entry: (record, how) => sessionEntry(record, how, { session_id: undefined }),
  run: (ctx) =>
    talk(ctx, () => {
      const { n, findings } = lastRound(ctx.record)
      return reviewFixBrief(ctx.record, `${ctx.project.owner}/${ctx.project.name}`, n, findings)
    }),
}

// lastRound is the last round of the review: its number and the findings of the reviewers at fix.
function lastRound(record: StageRecord) {
  const last = [...(record.history ?? [])].reverse().find((h) => h.stage === 'review' && h.kind === 'round')
  const fixing = (last?.verdicts ?? []).filter((v) => v.verdict === 'fix')
  return { n: last?.round ?? 1, findings: fixing.flatMap((v) => v.findings) }
}
