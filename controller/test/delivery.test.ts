// The delivery graph through XState's pure functions: every outcome of every node of the delivery table
// has an edge, every guard is named, and every budget ends in a park once it is spent.
import { expect, test } from 'vitest'
import { transition } from 'xstate'
import { delivery, type DeliveryContext } from '../src/delivery.js'

// The outcomes and events of each node, as the delivery table names them.
const table: Record<string, string[]> = {
  implement: ['complete', 'input', 'blocked', 'failed', 'message'],
  gate: ['pass', 'skipped', 'fail', 'failed'],
  'gate-fix': ['complete', 'input', 'blocked', 'failed'],
  review: ['pass', 'findings', 'failed'],
  'review-fix': ['complete', 'input', 'blocked', 'failed'],
  pr: ['opened', 'found', 'finished', 'failed'],
  ci: ['green', 'merged', 'unmergeable', 'answered', 'closed', 'failed', 'checks-failed', 'conflicts', 'comments', 'follow-up'],
  'ci-fix': ['complete', 'failed'],
  'address-reviews': ['complete', 'failed'],
}

const remain: DeliveryContext = { gateFixes: 0, gateRounds: 3, reviewRound: 1, reviewRounds: 3, repairs: 0, repairRounds: 3, yolo: false, panelPassed: false }
const spent: DeliveryContext = { ...remain, gateFixes: 3, reviewRound: 3, repairs: 3 }

// step is where an event takes a node: the next node, or the park it keeps the process on.
function step(node: string, context: DeliveryContext, type: string, mandate?: 'writer' | 'bot'): string {
  const snapshot = delivery.resolveState({ value: node, context })
  const e = { type, ...(mandate ? { mandate } : {}) }
  if (!snapshot.can(e)) return 'no edge'
  const [next, actions] = transition(delivery, snapshot, e)
  const park = (actions as { type: string; params?: { state?: string } }[]).find((a) => a.type === 'park')
  return park ? `parked ${park.params?.state}` : String(next.value)
}

test('the delivery graph has the nodes of the delivery table, and only done is final', () => {
  const states = delivery.toJSON().states as Record<string, { type?: string }>
  expect(delivery.id).toBe('delivery')
  expect(Object.keys(states).sort()).toEqual([...Object.keys(table), 'done'].sort())
  expect(Object.entries(states).filter(([, s]) => s.type === 'final').map(([k]) => k)).toEqual(['done'])
})

test('every outcome of every node has an edge, with its budgets left and spent', () => {
  for (const [node, outcomes] of Object.entries(table)) {
    for (const outcome of outcomes) {
      for (const context of [remain, spent]) expect(step(node, context, outcome), `${node} ${outcome}`).not.toBe('no edge')
    }
  }
})

test('every guard of the graph is named', () => {
  const states = delivery.toJSON().states as Record<string, { on?: Record<string, { guard?: unknown }[]> }>
  const guards = Object.values(states).flatMap((s) => Object.values(s.on ?? {}).flatMap((ts) => ts.flatMap((t) => (t.guard === undefined ? [] : [t.guard]))))
  expect(guards.length).toBeGreaterThan(0)
  for (const g of guards) expect(typeof g).toBe('string')
})

test('every budget takes its fix while it remains and ends in a park once it is spent', () => {
  expect(step('gate', remain, 'fail')).toBe('gate-fix')
  expect(step('gate', spent, 'fail')).toBe('parked failed')
  expect(step('review', remain, 'findings')).toBe('review-fix')
  expect(step('review', spent, 'findings')).toBe('pr')
  expect(step('ci', remain, 'checks-failed')).toBe('ci-fix')
  expect(step('ci', spent, 'checks-failed')).toBe('parked failed')
  expect(step('ci', spent, 'conflicts')).toBe('parked failed')
  expect(step('ci', remain, 'comments', 'bot')).toBe('address-reviews')
  expect(step('ci', spent, 'comments', 'bot')).toBe('parked failed')
  expect(step('ci', spent, 'comments', 'writer')).toBe('address-reviews')
})

test('the pr node goes to ci on opened, found and finished, and parks failed', () => {
  for (const outcome of ['opened', 'found', 'finished']) expect(step('pr', remain, outcome)).toBe('ci')
  expect(step('pr', remain, 'failed')).toBe('parked failed')
  expect(step('pr', remain, 'merged')).toBe('no edge')
})

test('a green pull request parks ready, and a yolo process whose panel passed is done', () => {
  expect(step('ci', remain, 'green')).toBe('parked ready')
  expect(step('ci', { ...remain, yolo: true }, 'green')).toBe('parked ready')
  expect(step('ci', { ...remain, yolo: true, panelPassed: true }, 'green')).toBe('done')
})

test("a state's meta carries its stage and its start and end events", () => {
  const meta = delivery.resolveState({ value: 'pr', context: remain }).getMeta()['delivery.pr'] as { stage: string; start: string; end: string; note: string }
  expect(meta).toMatchObject({ stage: 'pr', start: 'pr-start', end: 'pr-end', note: 'the author session writes the pull request' })
})
