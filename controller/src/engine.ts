// The engine: the controller code that enters the nodes of a process graph, runs them and follows their
// edges. A graph reaches it as data, a registration of the registry (graphs.ts). It imports no graph and
// no node. It runs a graph's XState machine through its pure functions only. These are the resolved state
// of a stored node, the check whether an event has an edge, and the transition. No actor runs and no
// snapshot is kept. The process record is the source of truth: workflow holds the graph's id, node its node.
//
// Entering a node writes its entry fields, stage, workflow and node, and its start event. The engine
// tracks the run. A stop ends the run, and a throw parks it failed with the node's
// prefix. A stop takes the process over, so what the node returns after it starts nothing. The engine
// checks that the outcome has an edge before it transitions, since a transition without an edge answers
// the same state. An outcome without an edge parks the process failed, with a note naming the node and
// the outcome. A park writes the node's end event, the state and the note. A park in blocked, ready or
// failed is announced; one in input waits on the board alone. An edge's write action changes the record
// before the next node is entered. The next node is entered before the run settles, so the process is
// never untracked between two nodes. advance follows an event into a node from outside a run: a message
// to a parked process, or the follow-up of the ci stage. A session node runs the process's own session
// (session.ts), which takes messages while it runs. Its run is tracked until its runtime has exited, and
// the next node runs only then, so two sessions never work the worktree at once. Until then a stop of the
// next node stops that runtime too.
import type { AnyStateMachine } from 'xstate'
import { transition } from 'xstate'
import type { Project } from './project.js'
import type { Attempt, SessionRecord, StageRecord } from './records.js'
import { type Running, track } from './running.js'
import type { Runtime } from './session.js'
import { attempt, event, readRecord, update } from './store.js'

// The outcome a node returns, or an event to a parked process, with the note of a park and what an
// edge's guard reads of it: mandate on the comments of the ci stage, unmerged on a green pull request
// whose yolo merge did not happen, and ready on a message to a process parked ready. message is the text
// of a message, the first turn of the session the next node resumes.
export interface Outcome {
  outcome: string
  note?: string
  mandate?: 'writer' | 'bot'
  unmerged?: boolean
  ready?: boolean
  message?: string
}

// How a node is entered: fresh from an edge, by the resume route of an interrupted process (resume), or
// by a message to a parked process (message). A session node goes on with the record's session on a
// message, and on a resume when the record has a session id.
export interface Entry {
  resume?: boolean
  message?: string
}

// What a node runs with: the record as it entered, how it was entered, the project, the runtime and the
// abort signal of its run, with the entry of the run that the runner of the agent runs takes, own, which
// is false once a stop has taken the process over, and the calls that write its note, an attempt and an
// event. A node that runs a session tells exits of its runtime's exit: the run is tracked until then,
// and the next node runs once it has settled.
export interface NodeContext {
  record: StageRecord
  how: Entry
  project: Project
  rt: Runtime
  signal: AbortSignal
  running: Running
  own: () => boolean
  note: (text: string) => void
  attempt: (a: Attempt, change?: Partial<StageRecord>) => StageRecord | undefined
  event: (e: Record<string, unknown>) => void
  exits: (exited: Promise<void>) => void
}

// A node of a graph: a run that returns an outcome. entry adds the fields of its entry that depend on
// the record and on how it was entered, given the record with the entry fields of its meta. A node that
// talks runs a session that takes messages, so its run is tracked as nothing that refuses them.
export interface Node {
  run: (ctx: NodeContext) => Promise<Outcome>
  entry?: (record: StageRecord, how: Entry) => Partial<StageRecord>
  talks?: boolean
}

// The meta of a state the engine reads: its stage, its entry fields and note, its start and end events,
// and the prefix of a throw's note. what names the node in the warning of a run that ends unexpectedly.
// A graph declares the meta of its states with this type.
export interface StateMeta {
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
function metaOf(g: Registration, node: string, record: StageRecord): StateMeta {
  const state = g.machine.resolveState({ value: node, context: g.context(record) })
  const meta = (state.getMeta() as Record<string, StateMeta | undefined>)[`${g.machine.id}.${node}`]
  if (!meta) throw new Error(`the ${g.machine.id} graph has no node ${node}`)
  return meta
}

// enter enters a node of the graph for the process, the way how says, and answers the record as it runs.
// A node without a note of its own keeps the record's note until it writes one. Its run starts once after
// has settled, the exit of the runtime of the node before, and a stop of the run aborts before, that
// node's run, too.
export function enter(g: Registration, node: string, record: StageRecord, project: Project, rt: Runtime, how: Entry = {}, after: Promise<void> = Promise.resolve(), before?: AbortController): SessionRecord {
  const id = record.id
  const impl = g.nodes[node]
  const meta = metaOf(g, node, record)
  const at = { workflow: g.machine.id, node }
  if (!impl) throw new Error(`the ${g.machine.id} graph has no implementation of its node ${node}`)
  const note = meta.note !== undefined ? { note: meta.note } : {}
  const fields = { stage: meta.stage, ...meta.entry, ...note } as Partial<StageRecord>
  const own = impl.entry ? impl.entry({ ...record, ...fields } as StageRecord, how) : {}
  const started = (update(rt.stateDir, id, { ...fields, ...own, ...at } as Partial<StageRecord>) as StageRecord | undefined) ?? record
  if (meta.start) event(rt.stateDir, id, { event: meta.start, stage: meta.stage })
  const abort = new AbortController()
  if (before) abort.signal.addEventListener('abort', () => before.abort(), { once: true })
  // The node runs on the next turn, once it is tracked, so a stop meanwhile ends it.
  const tracked: { own: () => boolean; s?: Running } = { own: () => false }
  const owns = () => tracked.own()
  let exit: Promise<void> = Promise.resolve()
  const done = after
    .then(async () => {
      const s = tracked.s
      if (!s) return
      const ctx: NodeContext = {
        record: started,
        how,
        project,
        rt,
        signal: abort.signal,
        running: s,
        own: owns,
        note: (text) => void update(rt.stateDir, id, { note: text }),
        attempt: (a, change) => attempt(rt.stateDir, id, a, change),
        event: (e) => event(rt.stateDir, id, e),
        exits: (exited) => (exit = exited),
      }
      const outcome = await impl.run(ctx)
      if (owns()) follow(g, id, node, meta, outcome, project, rt, exit, abort)
    })
    .catch((err: unknown) => {
      if (!owns()) return
      park(rt, id, meta, 'failed', `${meta.failure ?? `the ${node} node failed`}: ${(err as Error).message}`)
    })
    .catch((err: unknown) => {
      process.stderr.write(`warning: ${id}: ${meta.what ?? `its ${node} node`} ended unexpectedly: ${(err as Error).message}\n`)
    })
    .then(() => exit)
  Object.assign(tracked, track(id, abort, done, meta.note ?? `${meta.what ?? `its ${node} node`} runs`))
  if (impl.talks && tracked.s) tracked.s.busy = undefined
  return started
}

// advance follows the edge of an event from a node of the graph for the process, as its record stands.
export function advance(g: Registration, node: string, o: Outcome, record: StageRecord, project: Project, rt: Runtime) {
  follow(g, record.id, node, metaOf(g, node, record), o, project, rt)
}

// follow takes the edge of the node's outcome from the record as it stands: a park keeps the process on
// the node, a final state ends the graph, any other state is entered, after the edge's write action has
// changed the record. A message enters the next node with its text.
function follow(g: Registration, id: string, node: string, meta: StateMeta, o: Outcome, project: Project, rt: Runtime, after?: Promise<void>, before?: AbortController) {
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
  const writes = (actions as { type: string; params?: unknown }[]).filter((a) => a.type === 'write')
  let now = record
  for (const w of writes) now = (update(rt.stateDir, id, w.params as Partial<StageRecord>) as StageRecord | undefined) ?? now
  enter(g, String(next.value), now, project, rt, o.message !== undefined ? { message: o.message } : {}, after, before)
}

// park ends the run of a node with the process waiting on it: its end event, then its state and note,
// and the announce, unless it waits for input.
function park(rt: Runtime, id: string, meta: StateMeta, state: string, note: string) {
  if (meta.end) event(rt.stateDir, id, { event: meta.end, stage: meta.stage, state, note })
  const parked = update(rt.stateDir, id, { state, note, unseen: true })
  if (parked && state !== 'input') rt.announce(parked)
}
