// The engine: the controller code that enters the nodes of a process graph, runs them and follows their
// edges. A graph reaches it as data, a registration of the registry (graphs.ts); it imports no graph and
// no node. It runs a graph's XState machine through its pure functions only: the resolved state of a
// stored node, the check whether an event has an edge, and the transition. No actor runs and no snapshot
// is kept: the process record is the source of truth and holds the graph's id in workflow and its node
// in node.
//
// Entering a node writes its entry fields, stage, workflow and node, and its start event. The engine
// tracks the run, so a stop ends it, chains its abort, and turns a throw into failed with the node's
// prefix. A stop takes the process over: what the node returns after it starts nothing. The outcome
// takes its edge, which the engine checks before it transitions, since a transition without an edge
// answers the same state: an outcome without one parks the process failed with a note naming the node
// and the outcome. A park writes the node's end event, the state and the note, and is announced. The
// next node is entered before the run settles, so the process is never untracked between two nodes. A
// state whose stage is not a node yet calls today's stage function through an adapter.
import type { AnyStateMachine } from 'xstate'
import { transition } from 'xstate'
import type { Project } from './project.js'
import type { Attempt, SessionRecord, StageRecord } from './records.js'
import { type Running, track } from './running.js'
import type { Runtime } from './session.js'
import { attempt, event, readRecord, update } from './store.js'

// The outcome a node returns, with the note of a park and what an edge's guard reads of it.
export interface Outcome {
  outcome: string
  note?: string
  mandate?: 'writer' | 'bot'
}

// What a node runs with: the record as it entered, the project, the runtime and the abort signal of its
// run, with the entry of the run that the runner of the agent runs takes, own, which is false once a stop
// has taken the process over, and the calls that write its note, an attempt and an event.
export interface NodeContext {
  record: StageRecord
  project: Project
  rt: Runtime
  signal: AbortSignal
  running: Running
  own: () => boolean
  note: (text: string) => void
  attempt: (a: Attempt, change?: Partial<StageRecord>) => StageRecord | undefined
  event: (e: Record<string, unknown>) => void
}

// A node of a graph: a run that returns an outcome, or the adapter of a stage that is not a node yet,
// which starts today's stage function and answers the record as it runs.
export type Node = { run: (ctx: NodeContext) => Promise<Outcome> } | { adapt: (record: StageRecord, project: Project, rt: Runtime) => SessionRecord }

// The meta of a state the engine reads: its stage, its entry fields and note, its start and end events,
// and the prefix of a throw's note and the name of the warning of a run that ends unexpectedly.
interface Meta {
  stage: string
  entry?: Record<string, unknown>
  note?: string
  start?: string
  end?: string
  failure?: string
  what?: string
}

// A registration of a process graph: its machine, the context its guards read, built from the record,
// and its node implementations. The request reader, the open function and the mapping of an old record
// to a node are filled by the graphs that need them.
export interface Registration {
  machine: AnyStateMachine
  context: (record: StageRecord) => Record<string, unknown>
  nodes: Record<string, Node>
  request?: (body: Record<string, unknown>) => unknown
  open?: (...args: never[]) => unknown
  old?: (record: SessionRecord) => string
}

// metaOf is the meta of a node of the graph, from its resolved state.
function metaOf(g: Registration, node: string, record: StageRecord): Meta {
  const state = g.machine.resolveState({ value: node, context: g.context(record) })
  const meta = (state.getMeta() as Record<string, Meta | undefined>)[`${g.machine.id}.${node}`]
  if (!meta) throw new Error(`the ${g.machine.id} graph has no node ${node}`)
  return meta
}

// enter enters a node of the graph for the process and answers the record as it runs.
export function enter(g: Registration, node: string, record: StageRecord, project: Project, rt: Runtime): SessionRecord {
  const id = record.id
  const impl = g.nodes[node]
  const meta = metaOf(g, node, record)
  const at = { workflow: g.machine.id, node }
  if (!impl) throw new Error(`the ${g.machine.id} graph has no implementation of its node ${node}`)
  if ('adapt' in impl) {
    const adapted = (update(rt.stateDir, id, at) as StageRecord | undefined) ?? record
    return impl.adapt(adapted, project, rt)
  }
  const note = meta.note ?? ''
  const started = (update(rt.stateDir, id, { stage: meta.stage, ...meta.entry, note, ...at } as Partial<StageRecord>) as StageRecord | undefined) ?? record
  if (meta.start) event(rt.stateDir, id, { event: meta.start, stage: meta.stage })
  const abort = new AbortController()
  // The node runs on the next turn, once it is tracked, so a stop meanwhile ends it.
  const tracked: { own: () => boolean; s?: Running } = { own: () => false }
  const own = () => tracked.own()
  const done = Promise.resolve()
    .then(async () => {
      const s = tracked.s
      if (!s) return
      const ctx: NodeContext = {
        record: started,
        project,
        rt,
        signal: abort.signal,
        running: s,
        own,
        note: (text) => void update(rt.stateDir, id, { note: text }),
        attempt: (a, change) => attempt(rt.stateDir, id, a, change),
        event: (e) => event(rt.stateDir, id, e),
      }
      const outcome = await impl.run(ctx)
      if (own()) follow(g, id, node, meta, outcome, project, rt)
    })
    .catch((err: unknown) => {
      if (!own()) return
      park(rt, id, meta, 'failed', `${meta.failure ?? `the ${node} node failed`}: ${(err as Error).message}`)
    })
    .catch((err: unknown) => {
      process.stderr.write(`warning: ${id}: ${meta.what ?? `its ${node} node`} ended unexpectedly: ${(err as Error).message}\n`)
    })
  Object.assign(tracked, track(id, abort, done, note))
  return started
}

// follow takes the edge of the node's outcome from the record as it stands: a park keeps the process on
// the node, a final state ends the graph, any other state is entered.
function follow(g: Registration, id: string, node: string, meta: Meta, o: Outcome, project: Project, rt: Runtime) {
  const record = readRecord(rt.stateDir, id) as StageRecord | undefined
  if (!record) return
  const { outcome, note, ...fields } = o
  const snapshot = g.machine.resolveState({ value: node, context: g.context(record) })
  const e = { type: outcome, ...fields }
  if (!snapshot.can(e)) return park(rt, id, meta, 'failed', `the ${node} node of the ${g.machine.id} graph returned the outcome ${outcome}, which has no edge`)
  const [next, actions] = transition(g.machine, snapshot, e)
  const parked = (actions as { type: string; params?: unknown }[]).find((a) => a.type === 'park')
  if (parked) return park(rt, id, meta, (parked.params as { state: string }).state, note ?? record.note)
  if (next.status === 'done') return
  enter(g, String(next.value), record, project, rt)
}

// park ends the run of a node with the process waiting on it: its end event, then its state and note,
// and the announce.
function park(rt: Runtime, id: string, meta: Meta, state: string, note: string) {
  if (meta.end) event(rt.stateDir, id, { event: meta.end, stage: meta.stage, state, note })
  const parked = update(rt.stateDir, id, { state, note, unseen: true })
  if (parked) rt.announce(parked)
}
