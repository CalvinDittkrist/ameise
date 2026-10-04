// The budgets of a work or hunt process, counted from its history the one way the stages and the guards
// of its process graph (delivery.ts) both read them: the fix sessions of the gate, the rounds of the
// review and the repair rounds of the pull request. This module imports the record types and nothing
// that drives a process.
import type { Attempt } from '../records/records.js'

// gateFixesSpent are the fix sessions the gate has spent: those since the last session of another
// stage, the implement session or a fix session of the review, whose work the gate checks. A fix session
// resumed after a block is the same session, counted once.
export function gateFixesSpent(history: Attempt[]): number {
  const since = history.map((h) => h.stage !== 'gate' && h.kind === 'session').lastIndexOf(true)
  return new Set(history.slice(since + 1).flatMap((h, i) => (h.stage === 'gate' && h.kind === 'session' ? [h.session_id ?? `#${i}`] : []))).size
}

// reviewRounds are the rounds of the review since the implement or hunt session last ended, whose work
// it reviews.
export function reviewRounds(history: Attempt[]): Attempt[] {
  const since = history.map((h) => h.stage === 'implement' || h.stage === 'hunt').lastIndexOf(true)
  return history.slice(since + 1).filter((h) => h.stage === 'review' && h.kind === 'round')
}

// repairsSpent are the repair rounds of the pull request: the fix sessions of the ci stage and the
// address-reviews sessions of a bot's review since the pull request was opened or found, or since the
// last address-reviews session of a writer's request, which starts the count afresh.
export function repairsSpent(history: Attempt[]): number {
  const since = history.map((h) => (h.stage === 'pr' && h.kind === 'open') || (h.stage === 'address-reviews' && h.kind === 'session' && h.mandate === 'writer')).lastIndexOf(true)
  const counted = history.slice(since + 1).flatMap((h, i) => (h.kind === 'session' && (h.stage === 'ci' || (h.stage === 'address-reviews' && h.mandate === 'bot')) ? [h.session_id ?? `#${i}`] : []))
  return new Set(counted).size
}
