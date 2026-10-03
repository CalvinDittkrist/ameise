// The plan graph: the process graph of a plan process, an XState machine of its nodes and the edges their
// outcomes take. It has two entries, and the record's route picks one (planEntry). No edge joins the two
// paths.
//
// The idea, issue and open routes enter the planner node, which runs the planner session. Each turn it
// ends parks the process on input, and a message is an event on the node that enters it again, resuming
// the session by its id.
//
// The accept route enters the acceptance: gather fetches the base and reads the facts, checker runs the
// spec checker, and decision parks the process on input for the maintainer's answers. Each batch of
// answers is an event on decision, which parks it on input again. A failed acceptance checks again on the
// event check, which enters gather.
//
// A park is the action park on an edge, as in the delivery graph (delivery.ts). Its param seen marks the
// process seen, as the maintainer's own answer does. The engine (engine.ts) runs the machine through its
// pure functions only, and the registry (graphs.ts) pairs it with its nodes. This module imports no node.
import { setup } from 'xstate'
import type { StateMeta } from './engine.js'
import type { PlanRecord, Route, StageRecord } from './records.js'

// An event of the plan graph: the outcome of a node, or a message, a check or a batch of answers to a
// parked process.
export type PlanEvent = { type: string; message?: string }

const park = (state: 'input' | 'failed', seen = false) => ({ type: 'park', params: { state, ...(seen ? { seen } : {}) } }) as const

// The parks of an acceptance node: a throw or a failure parks it failed, and a check enters gather again.
const acceptanceParks = { failed: { actions: park('failed') }, check: 'gather' }

// The meta of the acceptance's nodes: what a message to it is refused with while it runs.
const accept = { stage: 'accept', failure: 'the acceptance failed', what: 'its acceptance', busy: 'the spec checker runs' }

export const planGraph = setup({
  types: { context: {} as Record<string, never>, events: {} as PlanEvent },
  actions: {
    // park is read from the transition by the engine, which writes it; it runs nothing itself.
    park: () => {},
  },
}).createMachine({
  id: 'plan',
  initial: 'planner',
  context: {},
  states: {
    planner: {
      // The planner session writes its own start and end events.
      meta: { stage: 'plan', what: 'its planner session' } satisfies StateMeta,
      on: { input: { actions: park('input') }, failed: { actions: park('failed') }, message: 'planner' },
    },
    gather: {
      meta: {
        ...accept,
        entry: { state: 'running', acceptance: undefined },
        note: 'the acceptance gathers the facts',
        start: 'acceptance-start',
        end: 'acceptance-end',
      } satisfies StateMeta,
      on: { gathered: 'checker', ...acceptanceParks },
    },
    checker: {
      // The checker node writes the end event of an acceptance that reported its items.
      meta: { ...accept, note: 'the spec checker runs', end: 'acceptance-end' } satisfies StateMeta,
      on: { items: 'decision', ...acceptanceParks },
    },
    decision: {
      // The answers write their own event, and every batch leaves the process parked on input.
      meta: { stage: 'accept', what: 'its acceptance' } satisfies StateMeta,
      on: { input: { actions: park('input') }, left: { actions: park('input', true) }, gaps: { actions: park('input', true) }, closed: { actions: park('input', true) } },
    },
  },
})

// planContext is the context of the plan graph, whose edges read no guard.
export const planContext = (): Record<string, never> => ({})

// planEntry is the node a plan process of the route enters as it opens.
export const planEntry = (route: Route): 'planner' | 'gather' => (route === 'accept' ? 'gather' : 'planner')

// planResume is the node a plan process goes on at after a restart, or undefined where the restart fails
// it. It reads the process's route, state, items and session id. An acceptance that ran, or whose
// checker asked a question before it reported items, fails; one with items waits for its answers on
// decision. A planner session that ran or waited for a permission waits for a message on planner when it
// has a session id, and fails without one.
export function planResume(stage: StageRecord): string | undefined {
  const record = stage as unknown as PlanRecord
  if (record.route === 'accept') return record.state === 'input' && record.acceptance ? 'decision' : undefined
  if (['running', 'approval', 'input'].includes(record.state)) return record.session_id ? 'planner' : undefined
  return undefined
}

// planAt is the node a plan process stands on, which an event to it is taken from: its node, or for a
// record of an older release without one, the node of the restart's mapping, else the entry of its route.
export function planAt(record: PlanRecord): string {
  const states = planGraph.config.states ?? {}
  if (record.workflow === 'plan' && record.node !== undefined && record.node in states) return record.node
  return planResume(record as unknown as StageRecord) ?? planEntry(record.route)
}
