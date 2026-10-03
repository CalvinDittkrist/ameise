// The registry of the process graphs, by process kind. Each registration carries the graph's machine,
// the context its guards read and its node implementations. It carries the request reader, the open
// function and the mapping of an old record where its graph needs them. The engine (engine.ts) is given
// a registration as data.
//
// The delivery graph (delivery.ts) is registered for a work process. Each of its stages is a node: the
// implement session, the gate, the review, the pr and the ci stage, and the fix sessions of the gate, the
// review and the ci stage, and the address-reviews session. The session nodes run the process's own
// session through the session runner (session.ts). Its mapping of an old record names the node a resume
// of an interrupted process enters (deliveryResume). Until the hunt has a graph of its own, a hunt that
// reaches the gate runs the delivery graph's nodes.
//
// The plan graph (planning.ts) is registered for a plan process: the planner node runs the planner
// session, and the gather, checker and decision nodes run the acceptance of a spec. Its request reader
// and open function start a plan or, with a spec, an acceptance (plan.ts), and its mapping names the node
// a plan process goes on at after a restart (planResume).
import { checkerNode, decisionNode, gatherNode } from './acceptance.js'
import { addressNode, ciFixNode, ciNode } from './ci.js'
import { delivery, deliveryContext, deliveryResume } from './delivery.js'
import type { Registration } from './engine.js'
import { gateFixNode, gateNode } from './gate.js'
import { openPlan, plannerNode, planStart } from './plan.js'
import { planContext, planGraph, planResume } from './planning.js'
import { prNode } from './pr.js'
import { reviewFixNode, reviewNode } from './review.js'
import { implementNode } from './session.js'

// registrations builds the registry on its first read. The graphs' modules import this one through a
// cycle, so a registry built as this module loads could hold a machine or a node not loaded yet.
let registry: Map<string, Registration> | undefined
const registrations = (): Map<string, Registration> =>
  (registry ??= new Map<string, Registration>([
    [
      'work',
      {
        machine: delivery,
        context: deliveryContext,
        old: deliveryResume,
        nodes: {
          implement: implementNode,
          gate: gateNode,
          'gate-fix': gateFixNode,
          review: reviewNode,
          'review-fix': reviewFixNode,
          pr: prNode,
          ci: ciNode,
          'ci-fix': ciFixNode,
          'address-reviews': addressNode,
        },
      },
    ],
    [
      'plan',
      {
        machine: planGraph,
        context: planContext,
        old: planResume,
        request: planStart,
        open: openPlan,
        nodes: { planner: plannerNode, gather: gatherNode, checker: checkerNode, decision: decisionNode },
      },
    ],
  ]))

// graphOf is the registration of the graph a process of the record's kind runs on.
export function graphOf(record: { kind: string }): Registration {
  const g = registrations().get(record.kind) ?? (record.kind === 'hunt' ? registrations().get('work') : undefined)
  if (!g) throw new Error(`no process graph is registered for a ${record.kind} process`)
  return g
}
