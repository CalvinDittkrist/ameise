// The registry of the process graphs, by process kind. Each registration carries the graph's machine,
// the context its guards read and its node implementations. It carries the request reader, the open
// function and the mapping of an old record where its graph needs them. The engine (engine.ts) is given
// a registration as data.
//
// The delivery graph (delivery.ts) is registered for a work process. Its pr node runs as a node; a state
// whose stage is not a node yet calls today's stage function through an adapter. Until the hunt has a
// graph of its own, a hunt that reaches the pr stage runs the nodes of the delivery graph.
import { ci } from './ci.js'
import { delivery, deliveryContext } from './delivery.js'
import type { Registration } from './engine.js'
import { prNode } from './pr.js'
import type { StageRecord } from './records.js'

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
        nodes: { pr: prNode, ci: { adapt: (record, project, rt) => ci(record, project, rt) } },
      },
    ],
  ]))

// graphOf is the registration of the graph a process of the record's kind runs on.
export function graphOf(record: StageRecord): Registration {
  const g = registrations().get(record.kind) ?? (record.kind === 'hunt' ? registrations().get('work') : undefined)
  if (!g) throw new Error(`no process graph is registered for a ${record.kind} process`)
  return g
}
