// The standardize graph through XState's pure functions: every outcome of every node and every request of
// the routes has an edge from the park it is sent from. Through the engine with nodes of the test: answers
// the approval refuses park the audit failed, a refused finalize parks ready unannounced, a stop moves
// nothing, and a request goes on from a record of the release before the graph.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { transition } from 'xstate'
import { advance, enter, type NodeContext, type Outcome, type Registration } from '../src/engine/engine.js'
import { graphOf } from '../src/engine/graphs.js'
import type { StageRecord } from '../src/records/records.js'
import { runningOf, stop } from '../src/sessions/running.js'
import type { Runtime } from '../src/sessions/session.js'
import { standardizeContext, standardizeGraph, standardizeNode } from '../src/stages/standardize.js'

// The outcomes of each node, and the requests with the park each is sent from.
const outcomes: Record<string, string[]> = {
  audit: ['input', 'failed'],
  apply: ['ready', 'blocked', 'failed', 'refused'],
  finalize: ['done', 'failed', 'refused'],
}
const requests: [string, string, string][] = [
  ['audit', 'failed', 'audit'],
  ['audit', 'input', 'apply'],
  ['apply', 'blocked', 'apply'],
  ['apply', 'failed', 'apply'],
  ['apply', 'ready', 'finalize'],
  ['finalize', 'ready', 'finalize'],
  ['finalize', 'failed', 'finalize'],
]

// step is where an event takes a node: the next node, or the park it keeps the process on and where.
function step(node: string, state: string, type: string): string {
  const snapshot = standardizeGraph.resolveState({ value: node, context: { state } })
  if (!snapshot.can({ type })) return 'no edge'
  const [next, actions] = transition(standardizeGraph, snapshot, { type })
  const park = (actions as { type: string; params?: { state?: string; announce?: boolean } }[]).find((a) => a.type === 'park')
  if (!park) return String(next.value)
  return `parked ${park.params?.state} on ${String(next.value)}${park.params?.announce === false ? ' quietly' : ''}`
}

test('the standardize graph has the nodes audit, apply and finalize, and only done is final', () => {
  const states = standardizeGraph.toJSON().states as Record<string, { type?: string }>
  expect(standardizeGraph.id).toBe('standardize')
  expect(Object.keys(states).sort()).toEqual(['apply', 'audit', 'done', 'finalize'])
  expect(Object.entries(states).filter(([, s]) => s.type === 'final').map(([k]) => k)).toEqual(['done'])
  expect(graphOf({ kind: 'standardize' }).machine).toBe(standardizeGraph)
})

test('every outcome of every node and every request from its park has an edge', () => {
  for (const [node, list] of Object.entries(outcomes)) for (const o of list) expect(step(node, 'running', o), `${node} ${o}`).not.toBe('no edge')
  for (const [node, state, r] of requests) expect(step(node, state, r), `${node} ${state} ${r}`).toBe(r)
})

test('every park keeps the process on its node, but the refused answers, which park the audit failed', () => {
  expect(step('audit', 'running', 'input')).toBe('parked input on audit')
  expect(step('audit', 'running', 'failed')).toBe('parked failed on audit')
  expect(step('apply', 'running', 'ready')).toBe('parked ready on apply')
  expect(step('apply', 'running', 'blocked')).toBe('parked blocked on apply')
  expect(step('apply', 'running', 'failed')).toBe('parked failed on apply')
  expect(step('apply', 'running', 'refused')).toBe('parked failed on audit')
  expect(step('finalize', 'running', 'done')).toBe('done')
  expect(step('finalize', 'running', 'failed')).toBe('parked failed on finalize')
  expect(step('finalize', 'running', 'refused')).toBe('parked ready on finalize quietly')
})

test('a request from outside its parks and a message have no edge', () => {
  expect(step('audit', 'input', 'audit')).toBe('no edge')
  expect(step('audit', 'failed', 'apply')).toBe('no edge')
  expect(step('apply', 'ready', 'apply')).toBe('no edge')
  expect(step('apply', 'failed', 'finalize')).toBe('no edge')
  expect(step('finalize', 'blocked', 'finalize')).toBe('no edge')
  for (const node of Object.keys(outcomes)) expect(step(node, 'failed', 'message')).toBe('no edge')
})

let dir: string
let rt: Runtime
let announced: string[]
const id = 'standardize-0123456789ab'
const project = { owner: 'owner', name: 'repo', path: '/p' } as never

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'standardize-graph-'))
  mkdirSync(join(dir, 'processes'))
  announced = []
  rt = { claude: '', plugins: '', stateDir: dir, fake: true, gh: '', poll: 0, announce: (r) => announced.push(`${r.state} ${r.note}`) }
  writeFileSync(join(dir, 'processes', `${id}.json`), JSON.stringify({ id, kind: 'standardize', project: '/p', branch: 'chore/standardize', issue: null, stage: 'audit', state: 'input', note: '' }))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const recordOf = () => JSON.parse(readFileSync(join(dir, 'processes', `${id}.json`), 'utf8')) as StageRecord
const events = () =>
  readFileSync(join(dir, 'processes', `${id}.events.jsonl`), 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l) as { event: string; stage?: string; state?: string })

async function settle(): Promise<StageRecord> {
  for (let s = runningOf(id); s; s = runningOf(id)) await s.done
  return recordOf()
}

// graph is the standardize graph with the nodes of the test.
const graph = (nodes: Record<string, (ctx: NodeContext) => Promise<Outcome>>): Registration => ({
  machine: standardizeGraph,
  context: standardizeContext,
  nodes: Object.fromEntries(Object.entries(nodes).map(([k, run]) => [k, { run }])),
})

test('answers the approval refuses move the process back to the audit, parked failed and announced', async () => {
  const g = graph({ apply: async () => ({ outcome: 'refused', note: 'approve.sh refused the answers' }) })
  const entered = advance(g, 'audit', { outcome: 'apply' }, recordOf(), project, rt)
  expect(entered).toMatchObject({ stage: 'apply', state: 'running', workflow: 'standardize', node: 'apply' })
  const done = await settle()
  expect(done).toMatchObject({ stage: 'audit', node: 'audit', state: 'failed', note: 'approve.sh refused the answers' })
  expect(events().map((e) => `${e.event} ${e.stage} ${e.state ?? ''}`.trim())).toEqual(['audit-end audit failed'])
  expect(announced).toEqual(['failed approve.sh refused the answers'])
})

test('a refused finalize parks ready without an announce, and a failed one finalizes again on request', async () => {
  let outcome: Outcome = { outcome: 'refused', note: 'finalize.sh refused: not merged' }
  const g = graph({ finalize: async () => outcome })
  writeFileSync(join(dir, 'processes', `${id}.json`), JSON.stringify({ ...recordOf(), stage: 'apply', state: 'ready', workflow: 'standardize', node: 'apply' }))
  advance(g, 'apply', { outcome: 'finalize' }, recordOf(), project, rt)
  expect(await settle()).toMatchObject({ stage: 'finalize', state: 'ready', note: 'finalize.sh refused: not merged' })
  expect(announced).toEqual([])
  outcome = { outcome: 'failed', note: 'the standard check fails' }
  advance(g, 'finalize', { outcome: 'finalize' }, recordOf(), project, rt)
  expect(await settle()).toMatchObject({ stage: 'finalize', state: 'failed', note: 'the standard check fails' })
  expect(announced).toEqual(['failed the standard check fails'])
  advance(g, 'finalize', { outcome: 'finalize' }, recordOf(), project, rt)
  expect(await settle()).toMatchObject({ stage: 'finalize', state: 'failed' })
  expect(events().filter((e) => e.event === 'finalize-start')).toHaveLength(3)
})

test('a stop during any node ends it, and its outcome moves nothing', async () => {
  for (const node of ['audit', 'apply', 'finalize']) {
    const g = graph({
      [node]: ({ signal }) =>
        new Promise<Outcome>((resolve) => {
          const end = () => resolve({ outcome: node === 'apply' ? 'refused' : 'failed' })
          // The stop may come before the node runs, which is on the next turn.
          if (signal.aborted) end()
          else signal.addEventListener('abort', end)
        }),
    })
    enter(g, node, recordOf(), project, rt)
    expect(await stop(id)).toBe(true)
    expect(await settle()).toMatchObject({ stage: node, node, state: 'running' })
  }
  expect(announced).toEqual([])
})

test('a record of the release before the graph, without its workflow, is on the node its stage names', async () => {
  writeFileSync(join(dir, 'processes', `${id}.json`), JSON.stringify({ ...recordOf(), stage: 'apply', state: 'blocked' }))
  const old = recordOf()
  expect(old.workflow).toBeUndefined()
  expect(standardizeNode(old as never)).toBe('apply')
  let entered = 0
  const g = graph({ apply: async () => (entered++, { outcome: 'ready', note: 'the base needed no cleanup' }) })
  advance(g, standardizeNode(old as never), { outcome: 'apply' }, old, project, rt)
  expect(await settle()).toMatchObject({ stage: 'apply', workflow: 'standardize', node: 'apply', state: 'ready' })
  expect(entered).toBe(1)
})
