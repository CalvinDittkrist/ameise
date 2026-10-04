import { request } from 'node:http'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { api, cleanup, type Machine, machine, start } from './controller.js'

afterEach(cleanup)

let m: Machine
beforeEach(async () => {
  m = await machine()
  const s = await start(m)
  expect(s.running, s.stderr).toBe(true)
})

interface Edge {
  on: string
  next: string
  guard?: string
  otherwise?: string | null
}
interface Graph {
  id: string
  start: string
  nodes: { id: string; stage: string | null; final: boolean; edges: Edge[] }[]
}

async function graphs(): Promise<Graph[]> {
  const r = await api(m, 'GET', '/api/graphs')
  expect(r.status).toBe(200)
  return (r.body as { graphs: Graph[] }).graphs
}

// The parks every session node has, and the edge of a message to a process parked on a node of the
// delivery graph: implement when it is parked ready, the node's own session otherwise.
const parks: Edge[] = [
  { on: 'input', next: 'parked input' },
  { on: 'blocked', next: 'parked blocked' },
  { on: 'failed', next: 'parked failed' },
]
const message = (otherwise: string): Edge => ({ on: 'message', guard: 'ready', next: 'implement', otherwise })

test('the graph read answers every process graph of the registry with its start node', async () => {
  const all = await graphs()
  expect(all.map((g) => [g.id, g.start])).toEqual([
    ['delivery', 'implement'],
    ['hunt', 'hunt'],
    ['standardize', 'audit'],
    ['plan', 'planner'],
  ])
  for (const g of all) expect(g.nodes.filter((n) => n.final).map((n) => n.id)).toEqual(g.id === 'plan' ? [] : ['done'])
  expect(JSON.stringify(all)).not.toContain('#')
})

test('the delivery graph of the read is the state table of the delivery stages, parks and messages included', async () => {
  const delivery = (await graphs()).find((g) => g.id === 'delivery')
  expect(delivery).toEqual({
    id: 'delivery',
    start: 'implement',
    nodes: [
      { id: 'implement', stage: 'implement', final: false, edges: [{ on: 'complete', next: 'gate' }, ...parks, message('implement')] },
      {
        id: 'gate',
        stage: 'gate',
        final: false,
        edges: [
          { on: 'pass', next: 'review' },
          { on: 'skipped', next: 'review' },
          { on: 'fail', guard: 'gateRoundsRemain', next: 'gate-fix', otherwise: 'parked failed' },
          { on: 'failed', next: 'parked failed' },
          message('gate-fix'),
        ],
      },
      { id: 'gate-fix', stage: 'gate', final: false, edges: [{ on: 'complete', next: 'gate' }, ...parks, message('gate-fix')] },
      {
        id: 'review',
        stage: 'review',
        final: false,
        edges: [
          { on: 'pass', next: 'pr' },
          { on: 'findings', guard: 'reviewRoundsRemain', next: 'review-fix', otherwise: 'pr' },
          { on: 'failed', next: 'parked failed' },
          message('review-fix'),
        ],
      },
      { id: 'review-fix', stage: 'review', final: false, edges: [{ on: 'complete', next: 'gate' }, ...parks, message('review-fix')] },
      {
        id: 'pr',
        stage: 'pr',
        final: false,
        edges: [
          { on: 'opened', next: 'ci' },
          { on: 'found', next: 'ci' },
          { on: 'finished', next: 'ci' },
          { on: 'failed', next: 'parked failed' },
          message('implement'),
        ],
      },
      {
        id: 'ci',
        stage: 'ci',
        final: false,
        edges: [
          { on: 'green', guard: 'yoloPanelPassed', next: 'done', otherwise: 'parked ready' },
          { on: 'merged', next: 'parked blocked' },
          { on: 'unmergeable', next: 'parked blocked' },
          { on: 'answered', next: 'parked blocked' },
          { on: 'closed', next: 'parked failed' },
          { on: 'failed', next: 'parked failed' },
          { on: 'checks-failed', guard: 'repairRoundsRemain', next: 'ci-fix', otherwise: 'parked failed' },
          { on: 'conflicts', guard: 'repairRoundsRemain', next: 'ci-fix', otherwise: 'parked failed' },
          { on: 'comments', guard: 'writerOrRepairRoundsRemain', next: 'address-reviews', otherwise: 'parked failed' },
          { on: 'follow-up', next: 'ci' },
          message('ci-fix'),
        ],
      },
      { id: 'ci-fix', stage: 'ci', final: false, edges: [{ on: 'complete', next: 'ci' }, ...parks, message('ci-fix')] },
      { id: 'address-reviews', stage: 'address-reviews', final: false, edges: [{ on: 'complete', next: 'ci' }, ...parks, message('address-reviews')] },
      { id: 'done', stage: null, final: true, edges: [] },
    ],
  })
})

test('a park on another node names that node, and a guard with no edge after it has none otherwise', async () => {
  const standardize = (await graphs()).find((g) => g.id === 'standardize')
  const apply = standardize?.nodes.find((n) => n.id === 'apply')
  expect(apply?.edges).toContainEqual({ on: 'refused', next: 'parked failed on audit' })
  expect(apply?.edges).toContainEqual({ on: 'finalize', guard: 'ready', next: 'finalize', otherwise: null })
})

test('a graph read whose Host does not name the server is turned away', async () => {
  // fetch sets Host itself, so the rebound name goes through node's own client.
  const status = await new Promise<number>((resolve, reject) => {
    const req = request(m.url + '/api/graphs', { headers: { host: 'evil.example' } }, (res) => {
      res.resume()
      resolve(res.statusCode ?? 0)
    })
    req.on('error', reject)
    req.end()
  })
  expect(status).toBe(403)
})
