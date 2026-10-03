// The registry of the process graphs, by process kind: each registration carries the graph's machine,
// the context its guards read, its node implementations, and the request reader, the open function and
// the mapping of an old record its graph needs. The engine (engine.ts) is given a registration as data.
//
// The delivery graph (delivery.ts) is registered for a work process. Its pr node runs as a node; a state
// whose stage is not a node yet calls today's stage function through an adapter. Until the hunt has a
// graph of its own, a hunt that reaches the pr stage runs the nodes of the delivery graph.
import { ci } from './ci.js'
import { delivery, deliveryContext } from './delivery.js'
import type { Registration } from './engine.js'
import { prNode } from './pr.js'
import type { StageRecord } from './records.js'

const registry = new Map<string, Registration>([
  [
    'work',
    {
      machine: delivery,
      context: (record) => ({ ...deliveryContext(record) }),
      nodes: { pr: prNode, ci: { adapt: (record, project, rt) => ci(record, project, rt) } },
    },
  ],
])

// graphOf is the registration of the graph a process of the record's kind runs on.
export function graphOf(record: StageRecord): Registration {
  const g = registry.get(record.kind) ?? (record.kind === 'hunt' ? registry.get('work') : undefined)
  if (!g) throw new Error(`no process graph is registered for a ${record.kind} process`)
  return g
}
