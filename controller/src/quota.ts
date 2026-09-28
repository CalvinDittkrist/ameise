// The quota: how much of each runtime's subscription is left, as the configured quota-axi reads it. A
// work process spends the runtimes named below, and the board shows each with its reset, marked when it
// is below the configured minimum. The quota informs a claim and never holds one: a reading that cannot
// be had is unknown, and a claim below the minimum goes on with a warning.
import { execFile } from 'node:child_process'

// runtimes are the runtimes a work process spends, as quota-axi names its providers. The implement
// session runs on Claude Code, and the worker's pipeline runs inside that session.
export const runtimes = ['claude']

// schema is the version of quota-axi's JSON report this reading is written against, the factory's own.
const schema = 5

// timeout bounds one reading, so a quota-axi that hangs on its provider holds no answer for longer.
const timeout = 30000

// A reading of one runtime: known with the percentage left of its all-models scope and the latest
// reset of the windows that limit it, or unknown with the reason.
export type Reading =
  | { runtime: string; known: true; remaining: number; reset: string | null; below: boolean }
  | { runtime: string; known: false; reason: string; below: false }

export interface Quota {
  minimum: number
  runtimes: Reading[]
}

interface Report {
  schemaVersion?: number
  providers?: {
    provider?: string
    state?: { stale?: boolean; error?: string }
    windows?: { id?: string; resetsAt?: string }[]
    quotaSemantics?: {
      effectiveAvailability?: { scope?: string; status?: string; effectivePercentRemaining?: number | null; limitingWindowIds?: string[] }[]
    }
  }[]
}

// parse reads the all-models scope of one runtime out of quota-axi's report, or throws the reason.
export function parse(raw: string, runtime: string): { remaining: number; reset: string | null } {
  let report: Report
  try {
    report = JSON.parse(raw) as Report
  } catch (err) {
    throw new Error(`quota-axi printed something that is not its JSON report: ${(err as Error).message}`, { cause: err })
  }
  if (report.schemaVersion !== schema) throw new Error(`quota-axi reports in schema version ${report.schemaVersion} and workflows reads version ${schema}`)
  const p = (report.providers ?? []).find((x) => x.provider === runtime)
  if (!p) throw new Error(`quota-axi reports no provider ${runtime}`)
  if (p.state?.stale) throw new Error(`quota-axi's reading of ${runtime} is stale`)
  const row = (p.quotaSemantics?.effectiveAvailability ?? []).find((r) => r.scope === 'all_models')
  if (!row) throw new Error(`quota-axi reports no all_models scope for ${runtime}${p.state?.error ? `: ${p.state.error}` : ''}`)
  if (row.status !== 'known' || typeof row.effectivePercentRemaining !== 'number') throw new Error(`quota-axi does not know how much of ${runtime} is left`)
  let reset: number | undefined
  for (const id of row.limitingWindowIds ?? []) {
    const at = Date.parse((p.windows ?? []).find((w) => w.id === id)?.resetsAt ?? '')
    if (!Number.isNaN(at) && (reset === undefined || at > reset)) reset = at
  }
  return { remaining: row.effectivePercentRemaining, reset: reset === undefined ? null : new Date(reset).toISOString() }
}

// readOne runs quota-axi for one runtime and answers its reading. It never throws: whatever keeps the
// number from being read is the reason of an unknown reading.
function readOne(command: string, runtime: string, minimum: number): Promise<Reading> {
  return new Promise((resolve) => {
    execFile(command, ['--provider', runtime, '--json'], { encoding: 'utf8', timeout, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const why = (err as NodeJS.ErrnoException).code === 'ENOENT' ? `${command} is not installed` : `${command} failed: ${(stderr || err.message).trim()}`
        return resolve({ runtime, known: false, reason: why, below: false })
      }
      try {
        const r = parse(stdout, runtime)
        resolve({ runtime, known: true, ...r, below: r.remaining < minimum })
      } catch (e) {
        resolve({ runtime, known: false, reason: (e as Error).message, below: false })
      }
    })
  })
}

// readQuota reads every runtime a process spends with the configured command. An empty command is the
// quota check switched off, and every runtime reads as unknown.
export async function readQuota(command: string, minimum: number): Promise<Quota> {
  if (command === '') {
    return { minimum, runtimes: runtimes.map((runtime) => ({ runtime, known: false, reason: 'no quota_axi is configured', below: false })) }
  }
  return { minimum, runtimes: await Promise.all(runtimes.map((r) => readOne(command, r, minimum))) }
}

// warnings are what a claim says of a quota below the minimum: one line per runtime below it.
export function warnings(q: Quota): string[] {
  return q.runtimes
    .filter((r): r is Extract<Reading, { known: true }> => r.known && r.below)
    .map((r) => `${r.runtime} has ${Math.round(r.remaining)}% of its quota left, below the minimum of ${q.minimum}%${r.reset ? `; it resets at ${r.reset}` : ''}`)
}
