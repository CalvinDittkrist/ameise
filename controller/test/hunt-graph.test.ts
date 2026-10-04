// The hunt graph through XState's pure functions: every outcome and event of every node has an edge,
// every guard parks failed once it is spent, and from the gate on it runs the delivery graph's nodes.
import { expect, test } from 'vitest'
import { type AnyStateMachine, transition } from 'xstate'
import { delivery, type DeliveryContext, huntGraph } from '../src/graphs/delivery.js'
import { graphOf } from '../src/engine/graphs.js'
import type { StageRecord } from '../src/records/records.js'

// The outcomes and events of each node of the hunt graph.
const table: Record<string, string[]> = {
  hunt: ['complete', 'input', 'blocked', 'failed', 'message'],
  'hunt-record': ['removed', 'unended', 'nothing', 'failed', 'message'],
  gate: ['pass', 'skipped', 'fail', 'failed', 'message'],
  'gate-fix': ['complete', 'input', 'blocked', 'failed', 'message'],
  review: ['pass', 'findings', 'failed', 'message'],
  'review-fix': ['complete', 'input', 'blocked', 'failed', 'message'],
  pr: ['opened', 'found', 'finished', 'failed', 'message'],
  ci: ['green', 'merged', 'unmergeable', 'answered', 'closed', 'failed', 'checks-failed', 'conflicts', 'comments', 'follow-up', 'message'],
  'ci-fix': ['complete', 'input', 'blocked', 'failed', 'message'],
  'address-reviews': ['complete', 'input', 'blocked', 'failed', 'message'],
}

const remain: DeliveryContext = { gateFixes: 0, gateRounds: 3, reviewRound: 1, reviewRounds: 3, repairs: 0, repairRounds: 3, yolo: false, panelPassed: false }
const spent: DeliveryContext = { ...remain, gateFixes: 3, reviewRound: 3, repairs: 3 }

// step is where an event takes a node: the next node, or the park it keeps the process on.
function step(node: string, context: DeliveryContext, e: { type: string; mandate?: 'writer' | 'bot'; ready?: boolean }): string {
  const snapshot = huntGraph.resolveState({ value: node, context })
  if (!snapshot.can(e)) return 'no edge'
  const [next, actions] = transition(huntGraph, snapshot, e)
  const park = (actions as { type: string; params?: { state?: string } }[]).find((a) => a.type === 'park')
  return park ? `parked ${park.params?.state}` : String(next.value)
}

test('the hunt graph has the hunt nodes and the delivery nodes from the gate on, and only done is final', () => {
  const states = huntGraph.toJSON().states as Record<string, { type?: string }>
  expect(huntGraph.id).toBe('hunt')
  expect(huntGraph.config.initial).toBe('hunt')
  expect(Object.keys(states).sort()).toEqual([...Object.keys(table), 'done'].sort())
  expect(Object.entries(states).filter(([, s]) => s.type === 'final').map(([k]) => k)).toEqual(['done'])
})

test('every outcome and event of every node has an edge, with its budgets left and spent', () => {
  for (const [node, outcomes] of Object.entries(table)) {
    for (const type of outcomes) {
      for (const context of [remain, spent]) expect(step(node, context, { type }), `${node} ${type}`).not.toBe('no edge')
    }
  }
})

test('the hunt session goes to the hunt record, which goes to the gate, waits on input, ends done or parks failed', () => {
  expect(step('hunt', remain, { type: 'complete' })).toBe('hunt-record')
  for (const state of ['input', 'blocked', 'failed']) expect(step('hunt', remain, { type: state })).toBe(`parked ${state}`)
  expect(step('hunt-record', remain, { type: 'removed' })).toBe('gate')
  expect(step('hunt-record', remain, { type: 'unended' })).toBe('parked input')
  expect(step('hunt-record', remain, { type: 'nothing' })).toBe('done')
  expect(step('hunt-record', remain, { type: 'failed' })).toBe('parked failed')
})

test('a message resumes the hunt session from the hunt nodes and the pr stage, and from any node of a hunt parked ready', () => {
  for (const node of ['hunt', 'hunt-record', 'pr']) expect(step(node, remain, { type: 'message' })).toBe('hunt')
  for (const node of ['gate', 'review', 'ci', 'ci-fix']) expect(step(node, remain, { type: 'message', ready: true })).toBe('hunt')
  expect(step('ci', remain, { type: 'message' })).toBe('ci-fix')
})

test('every guard parks failed once it is spent', () => {
  expect(step('gate', remain, { type: 'fail' })).toBe('gate-fix')
  expect(step('gate', spent, { type: 'fail' })).toBe('parked failed')
  for (const type of ['checks-failed', 'conflicts']) {
    expect(step('ci', remain, { type })).toBe('ci-fix')
    expect(step('ci', spent, { type })).toBe('parked failed')
  }
  expect(step('ci', remain, { type: 'comments', mandate: 'bot' })).toBe('address-reviews')
  expect(step('ci', spent, { type: 'comments', mandate: 'bot' })).toBe('parked failed')
  // The review's guard ends in the pr stage, not in a park, once its rounds are spent.
  expect(step('review', spent, { type: 'findings' })).toBe('pr')
})

test('from the gate on the hunt graph keeps the meta of the delivery graph and references its nodes', () => {
  const hunt = graphOf({ id: 'hunt-1', kind: 'hunt', project: '/nonexistent', stage: 'hunt', state: 'running', note: '' } as unknown as StageRecord)
  const work = graphOf({ id: 'owner-repo-1', kind: 'work', project: '/nonexistent', stage: 'implement', state: 'running', note: '' } as unknown as StageRecord)
  expect(hunt.machine).toBe(huntGraph)
  for (const node of ['gate', 'gate-fix', 'review', 'review-fix', 'pr', 'ci', 'ci-fix', 'address-reviews']) {
    expect(hunt.nodes[node], node).toBe(work.nodes[node])
    const meta = (g: AnyStateMachine) => (g.resolveState({ value: node, context: remain }).getMeta() as Record<string, unknown>)[`${g.id}.${node}`]
    expect(meta(huntGraph), node).toEqual(meta(delivery))
  }
})
