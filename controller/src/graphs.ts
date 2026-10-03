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
// The standardize graph (standardize.ts) is registered for a standardize process: its nodes audit, apply
// and finalize run the standardize steps and the auditor and apply sessions. A record of a release before
// the graph is on the node its stage names (standardizeNode). A restart fails the node that ran, by the
// interrupt rules of the registry of running processes (running.ts), so no resume enters this graph.
import { addressNode, ciFixNode, ciNode } from './ci.js'
import { delivery, deliveryContext, deliveryResume } from './delivery.js'
import type { Registration } from './engine.js'
import { gateFixNode, gateNode } from './gate.js'
import { prNode } from './pr.js'
import { reviewFixNode, reviewNode } from './review.js'
import { implementNode } from './session.js'
import { applyNode, auditNode, finalizeNode, standardizeContext, standardizeGraph } from './standardize.js'

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
      'standardize',
      {
        machine: standardizeGraph,
        context: standardizeContext,
        nodes: { audit: auditNode, apply: applyNode, finalize: finalizeNode },
      },
    ],
  ]))

// graphOf is the registration of the graph a process of the record's kind runs on.
export function graphOf(record: { kind: string }): Registration {
  const g = registrations().get(record.kind) ?? (record.kind === 'hunt' ? registrations().get('work') : undefined)
  if (!g) throw new Error(`no process graph is registered for a ${record.kind} process`)
  return g
}
