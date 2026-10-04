// The plan graph through XState's pure functions: each route enters its own path, no edge joins the
// planner to the acceptance, every outcome of every node has an edge, and a restart maps a record of the
// previous release to its node.
import { expect, test } from 'vitest'
import { transition } from 'xstate'
import { graphOf } from '../src/graphs.js'
import { planAt, planEntry, planGraph, planResume } from '../src/planning.js'
import type { PlanRecord, StageRecord } from '../src/records.js'

// The outcomes and events of each node.
const table: Record<string, string[]> = {
  planner: ['input', 'failed', 'message'],
  gather: ['gathered', 'failed', 'check'],
  checker: ['items', 'failed', 'check'],
  decision: ['input', 'left', 'gaps', 'closed'],
}
const paths = { planner: ['planner'], acceptance: ['gather', 'checker', 'decision'] }

// step is where an event takes a node: the next node, or the park it keeps the process on.
function step(node: string, type: string): string {
  const snapshot = planGraph.resolveState({ value: node, context: {} })
  if (!snapshot.can({ type })) return 'no edge'
  const [next, actions] = transition(planGraph, snapshot, { type })
  const park = (actions as { type: string; params?: { state?: string } }[]).find((a) => a.type === 'park')
  return park ? `parked ${park.params?.state}` : String(next.value)
}

test('the plan graph has the planner and the acceptance nodes, and a plan process runs on it', () => {
  expect(planGraph.id).toBe('plan')
  expect(Object.keys(planGraph.config.states ?? {}).sort()).toEqual(Object.keys(table).sort())
  expect(graphOf({ kind: 'plan' }).machine).toBe(planGraph)
})

test('each route enters its own path', () => {
  for (const route of ['idea', 'issue', 'open'] as const) expect(planEntry(route)).toBe('planner')
  expect(planEntry('accept')).toBe('gather')
})

test('every outcome of every node has an edge', () => {
  for (const [node, outcomes] of Object.entries(table)) for (const outcome of outcomes) expect(step(node, outcome), `${node} ${outcome}`).not.toBe('no edge')
})

test('no edge joins the planner to the acceptance', () => {
  for (const path of Object.values(paths)) {
    for (const node of path) {
      for (const outcome of table[node] ?? []) {
        const to = step(node, outcome)
        if (!to.startsWith('parked')) expect(path, `${node} ${outcome}`).toContain(to)
      }
    }
  }
})

test('the acceptance runs gather, checker and decision, parks on input after every batch of answers and checks again from a failure', () => {
  expect(step('gather', 'gathered')).toBe('checker')
  expect(step('checker', 'items')).toBe('decision')
  for (const outcome of ['input', 'left', 'gaps', 'closed']) expect(step('decision', outcome)).toBe('parked input')
  expect(step('gather', 'check')).toBe('gather')
  expect(step('checker', 'check')).toBe('gather')
  expect(step('decision', 'check')).toBe('no edge')
  expect(step('planner', 'message')).toBe('planner')
  expect(step('planner', 'input')).toBe('parked input')
})

const plan = (change: Partial<PlanRecord>): PlanRecord => ({ id: 'plan-1', kind: 'plan', route: 'idea', project: '/x', branch: 'plan/x', issue: null, worktree: '/x', base: 'main', stage: 'plan', state: 'running', note: '', created_at: '', updated_at: '', ...change })
const resume = (change: Partial<PlanRecord>) => planResume(plan(change) as unknown as StageRecord)
const acceptance = { spec: { title: 't', milestone: null, labels: [] }, tickets: [], files: 0, deviations: [], notes: [], items: [], repeated: 0 }

test('a restart maps a plan record of the previous release to its node, or fails it', () => {
  expect(resume({ route: 'accept', stage: 'accept', state: 'running' })).toBeUndefined()
  expect(resume({ route: 'accept', stage: 'accept', state: 'input' })).toBeUndefined()
  expect(resume({ route: 'accept', stage: 'accept', state: 'input', acceptance })).toBe('decision')
  for (const state of ['running', 'approval']) {
    expect(resume({ state, session_id: 's' })).toBe('planner')
    expect(resume({ state })).toBeUndefined()
  }
})

test('an event to a plan record without a node is taken from the node its route, state and items name', () => {
  expect(planAt(plan({ state: 'input', session_id: 's' }))).toBe('planner')
  expect(planAt(plan({ route: 'accept', stage: 'accept', state: 'input', acceptance }))).toBe('decision')
  expect(planAt(plan({ route: 'accept', stage: 'accept', state: 'failed' }))).toBe('gather')
  expect(planAt(plan({ route: 'accept', stage: 'accept', state: 'failed', workflow: 'plan', node: 'checker' }))).toBe('checker')
})
