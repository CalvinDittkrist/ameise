// The registry of the process graphs, by process kind. Each registration carries the graph's machine,
// the context its guards read and its node implementations. It carries the request reader, the open
// function and the mapping of an old record where its graph needs them. The engine (engine.ts) is given
// a registration as data.
//
// The delivery graph (delivery.ts) is registered for a work process. Each of its stages is a node: the
// implement session, the gate, the review, the pr and the ci stage, and the fix sessions of the gate, the
// review and the ci stage, and the address-reviews session. The session nodes run the process's own
// session through the session runner (session.ts). Its mapping of an old record names the node a resume
// of an interrupted process enters (deliveryResume).
//
// The hunt graph (delivery.ts) is registered for a hunt process. Its hunt node runs the hunt session and
// its hunt-record node reads the hunt record (hunt.ts). From the gate on it references the delivery
// graph's node implementations, and copies none. It carries the hunt's request and opening, and its
// mapping of an old record (huntResume) reads a record without workflow, or one with the delivery
// workflow, by its stage.
//
// The plan graph (planning.ts) is registered for a plan process: the planner node runs the planner
// session, and the gather, checker and decision nodes run the acceptance of a spec. Its request reader
// and open function start a plan or, with a spec, an acceptance (plan.ts), and its mapping names the node
// a plan process goes on at after a restart (planResume).
//
// The standardize graph (standardize.ts) is registered for a standardize process: its nodes audit, apply
// and finalize run the standardize steps and the auditor and apply sessions. A record of a release before
// the graph is on the node its stage names (standardizeNode). A restart fails the node that ran, by the
// interrupt rules of the registry of running processes (running.ts), so no resume enters this graph.
//
// Each graph names its request reader and its open function. The start route (POST /api/processes/start)
// and the start route of each kind start a process through them (startOf).
// So a graph added here is started with no change to the server.
// Delivery opens a claim, hunt a hunt, standardize a standardize, and plan a plan or, with a spec, an acceptance.
//
// The graph read (GET /api/graphs) answers every graph of the registry in its order, each mapped by the
// engine (describe) into nodes and edges.
import { claimRequest, openClaim } from './claim.js'
import { checkerNode, decisionNode, gatherNode } from './acceptance.js'
import { addressNode, ciFixNode, ciNode } from './ci.js'
import { delivery, deliveryContext, deliveryResume, huntGraph, huntResume } from './delivery.js'
import { describe, type Graph, type Registration } from './engine.js'
import { gateFixNode, gateNode } from './gate.js'
import { huntNode, huntRecordNode, huntRequest, openHunt } from './hunt.js'
import { plannerNode, planStart, startPlan } from './plan.js'
import { planContext, planGraph, planResume } from './planning.js'
import { prNode } from './pr.js'
import { reviewFixNode, reviewNode } from './review.js'
import { implementNode } from './session.js'
import { Refusal } from './project.js'
import { applyNode, auditNode, finalizeNode, openStandardize, standardizeContext, standardizeGraph, standardizeRequest } from './standardize.js'

// registrations builds the registry on its first read. The graphs' modules import this one through a
// cycle, so a registry built as this module loads could hold a machine or a node not loaded yet.
let registry: Map<string, Registration> | undefined
const registrations = (): Map<string, Registration> => {
  if (registry) return registry
  // The nodes from the gate on, which the delivery and the hunt graph share.
  const tail = {
    gate: gateNode,
    'gate-fix': gateFixNode,
    review: reviewNode,
    'review-fix': reviewFixNode,
    pr: prNode,
    ci: ciNode,
    'ci-fix': ciFixNode,
    'address-reviews': addressNode,
  }
  registry = new Map<string, Registration>([
    [
      'work',
      {
        machine: delivery,
        context: deliveryContext,
        request: claimRequest,
        open: openClaim,
        old: deliveryResume,
        nodes: { implement: implementNode, ...tail },
      },
    ],
    [
      'hunt',
      {
        machine: huntGraph,
        context: deliveryContext,
        request: huntRequest,
        open: openHunt,
        old: huntResume,
        nodes: { hunt: huntNode, 'hunt-record': huntRecordNode, ...tail },
      },
    ],
    [
      'standardize',
      {
        machine: standardizeGraph,
        context: standardizeContext,
        request: standardizeRequest,
        open: openStandardize,
        nodes: { audit: auditNode, apply: applyNode, finalize: finalizeNode },
      },
    ],
    [
      'plan',
      {
        machine: planGraph,
        context: planContext,
        old: planResume,
        request: planStart,
        open: startPlan,
        nodes: { planner: plannerNode, gather: gatherNode, checker: checkerNode, decision: decisionNode },
      },
    ],
  ])
  return registry
}

// graphOf is the registration of the graph a process of the record's kind runs on.
export function graphOf(record: { kind: string }): Registration {
  const g = registrations().get(record.kind)
  if (!g) throw new Error(`no process graph is registered for a ${record.kind} process`)
  return g
}

// A start is a registration that a process is started on: its request reader and its open function.
export type Start = Required<Pick<Registration, 'request' | 'open'>>

// startOf is the start of the graph a start route names by its id (POST /api/processes/start and the
// start route of each kind). An unknown or missing graph is refused with the graphs a process starts on.
export function startOf(graph: unknown): Start {
  const all = [...registrations().values()].filter((g): g is Registration & Start => g.request !== undefined && g.open !== undefined)
  const g = all.find((r) => r.machine.id === graph)
  if (!g) {
    const ids = all.map((r) => r.machine.id).join(', ')
    const named = typeof graph === 'string' ? `graph ${JSON.stringify(graph)} is not a process graph` : 'graph is missing'
    throw new Refusal(`${named}; send one of ${ids}`)
  }
  return g
}

// graphs is every process graph of the registry, in its order, in the shape of the graph read
// (GET /api/graphs). It names no graph itself, so a graph added to the registry is read with the others.
export function graphs(): Graph[] {
  return [...registrations().values()].map(describe)
}
