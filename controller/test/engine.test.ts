// The engine on a graph of its own, with a record in a state directory of its own: it enters a node,
// follows the edge of its outcome into the next node, and parks the process failed on an outcome without
// an edge and on a throw, and a stop during a node starts nothing of what the node returns.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { setup } from 'xstate'
import { enter, type NodeContext, type Outcome, type Registration } from '../src/engine.js'
import type { StageRecord } from '../src/records.js'
import { runningOf, stop } from '../src/running.js'
import type { Runtime } from '../src/session.js'

let dir: string
let rt: Runtime
let announced: string[]
const id = 'owner-repo-1'

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'engine-'))
  mkdirSync(join(dir, 'processes'))
  announced = []
  rt = { claude: '', plugins: '', stateDir: dir, fake: true, gh: '', poll: 0, announce: (r) => announced.push(`${r.state} ${r.note}`) }
  writeFileSync(join(dir, 'processes', `${id}.json`), JSON.stringify({ id, kind: 'work', project: '/p', stage: 'review', state: 'running', note: '', history: [] }))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const meta = (stage: string) => ({ stage, entry: { state: 'running' }, note: `the ${stage} runs`, start: `${stage}-start`, end: `${stage}-end`, failure: `the ${stage} failed` })
const machine = setup({ actions: { park: () => {} } }).createMachine({
  id: 'test',
  initial: 'first',
  states: {
    first: { meta: meta('first'), on: { next: 'second', failed: { actions: { type: 'park', params: { state: 'failed' } } } } },
    second: { meta: meta('second'), on: { failed: { actions: { type: 'park', params: { state: 'failed' } } } } },
  },
})

const graph = (first: (ctx: NodeContext) => Promise<Outcome>, second: (ctx: NodeContext) => Promise<Outcome>): Registration => ({
  machine,
  context: () => ({}),
  nodes: { first: { run: first }, second: { run: second } },
})

const recordOf = () => JSON.parse(readFileSync(join(dir, 'processes', `${id}.json`), 'utf8')) as StageRecord
const events = () =>
  readFileSync(join(dir, 'processes', `${id}.events.jsonl`), 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l) as { event: string; state?: string; note?: string })

// settle waits until no run of the process is tracked: each node's run settles once the next is entered.
async function settle(): Promise<StageRecord> {
  for (let s = runningOf(id); s; s = runningOf(id)) await s.done
  return recordOf()
}

// aborted is an outcome, or a throw, once the node's run is aborted.
const aborted = (signal: AbortSignal, then: () => Outcome) =>
  new Promise<Outcome>((resolve, reject) => {
    const end = () => {
      try {
        resolve(then())
      } catch (err) {
        reject(err as Error)
      }
    }
    if (signal.aborted) end()
    else signal.addEventListener('abort', end)
  })

const project = { owner: 'owner', name: 'repo', path: '/p' } as never

test('an outcome without an edge parks the process failed with a note naming the node and the outcome', async () => {
  const entered = enter(graph(async () => ({ outcome: 'next' }), async () => ({ outcome: 'nonsense' })), 'first', recordOf(), project, rt)
  expect(entered).toMatchObject({ stage: 'first', state: 'running', workflow: 'test', node: 'first' })
  const done = await settle()
  expect(done).toMatchObject({ stage: 'second', workflow: 'test', node: 'second', unseen: true })
  expect(done.note).toContain('second')
  expect(done.note).toContain('nonsense')
  expect(events().map((e) => `${e.event} ${e.state ?? ''}`.trim())).toEqual(['first-start', 'second-start', 'second-end failed'])
  expect(announced).toEqual([`failed ${done.note}`])
})

test("a throw in a node parks the process failed with the node's failure prefix", async () => {
  enter(
    graph(async () => {
      throw new Error('it broke')
    }, async () => ({ outcome: 'failed' })),
    'first',
    recordOf(),
    project,
    rt,
  )
  const done = await settle()
  expect(done.note).toBe('the first failed: it broke')
  expect(events().at(-1)).toMatchObject({ event: 'first-end', state: 'failed', note: 'the first failed: it broke' })
})

test('a failed outcome parks the process on its node with the note it returns', async () => {
  enter(graph(async () => ({ outcome: 'failed', note: 'could not push' }), async () => ({ outcome: 'failed' })), 'first', recordOf(), project, rt)
  const done = await settle()
  expect(done).toMatchObject({ stage: 'first', node: 'first', note: 'could not push' })
})

test('a stop during a node starts nothing of the outcome it returns', async () => {
  let second = false
  const g = graph(
    ({ signal }) => aborted(signal, () => ({ outcome: 'next' })),
    async () => {
      second = true
      return { outcome: 'failed' }
    },
  )
  enter(g, 'first', recordOf(), project, rt)
  expect(await stop(id)).toBe(true)
  const done = await settle()
  expect(second).toBe(false)
  expect(done).toMatchObject({ stage: 'first', node: 'first', state: 'running', note: 'the first runs' })
  expect(events().map((e) => e.event)).toEqual(['first-start'])
  expect(announced).toEqual([])
})

test('a throw in a stopped node parks nothing', async () => {
  const g = graph(
    ({ signal }) =>
      aborted(signal, () => {
        throw new Error('aborted')
      }),
    async () => ({ outcome: 'failed' }),
  )
  enter(g, 'first', recordOf(), project, rt)
  expect(await stop(id)).toBe(true)
  const done = await settle()
  expect(done).toMatchObject({ stage: 'first', node: 'first', state: 'running', note: 'the first runs' })
  expect(events().map((e) => e.event)).toEqual(['first-start'])
  expect(announced).toEqual([])
})
