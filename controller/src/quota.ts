// The quota: how much of each runtime's subscription is left, as the configured quota-axi reads it. The
// board shows each runtime named below with its reset, marked when it is below the configured minimum.
// The quota informs a claim and never holds one: a reading that cannot be had is unknown, and a claim
// with Claude below the minimum goes on with a warning.
import { type ChildProcess, spawn } from 'node:child_process'

// runtimes are the runtimes the quota reads, as quota-axi names its providers, in the order it answers
// them: Claude, which a work process spends, then Codex.
export const runtimes = ['claude', 'codex']

// claimRuntime is the runtime a claim reads and warns of. Every stage session of a work process runs on
// Claude Code, so a work process spends Claude alone.
export const claimRuntime = 'claude'

// schema is the version of quota-axi's JSON report this reading is written against, the factory's own.
const schema = 5

// timeout bounds one reading, so a quota-axi that hangs on its provider holds no answer for longer.
const timeout = 30000

// maxBuffer bounds the report quota-axi may print.
const maxBuffer = 4 * 1024 * 1024

// windowIds are the windows a reading shows in this order, as quota-axi names them: the five-hour session
// window, then the weekly window, which Claude names seven_day and Codex weekly.
const windowIds = ['five_hour', 'seven_day', 'weekly']

// fableScope is the scope of Claude's Fable model, which the provider limits apart from the others and
// quota-axi reports only where it does.
const fableScope = 'model:fable'

// A window of a runtime: its percentage left where quota-axi reports one, and its reset.
interface Window {
  id: string
  remaining: number | null
  reset: string | null
}

// A scope of one model: known with its percentage left and the latest reset of the windows that limit
// it, or unknown with the reason.
type Scope = { known: true; remaining: number; reset: string | null } | { known: false; reason: string }

// What a runtime's reading knows: the percentage left of its all-models scope and the latest reset of
// the windows that limit it, its session and weekly windows, and for Claude the Fable scope when
// quota-axi reports one.
interface Known {
  remaining: number
  reset: string | null
  windows: Window[]
  fable?: Scope
}

// A reading of one runtime: known, or unknown with the reason.
type Reading = ({ runtime: string; known: true; below: boolean } & Known) | { runtime: string; known: false; reason: string; below: false }

// A quota with the check switched off says so with off and reads no runtime.
export interface Quota {
  minimum: number
  off?: true
  runtimes: Reading[]
}

interface Availability {
  scope?: string
  status?: string
  effectivePercentRemaining?: number | null
  limitingWindowIds?: string[]
}

interface Report {
  schemaVersion?: number
  providers?: {
    provider?: string
    state?: { stale?: boolean; error?: string }
    windows?: { id?: string; percentRemaining?: number; resetsAt?: string }[]
    quotaSemantics?: { effectiveAvailability?: Availability[] }
  }[]
}

// percentOf is the percentage left of a scope quota-axi knows, or undefined where it does not.
const percentOf = (a: Availability) => (a.status === 'known' && typeof a.effectivePercentRemaining === 'number' ? a.effectivePercentRemaining : undefined)

// parse reads the all-models scope of one runtime out of quota-axi's report, with its windows and the
// Fable scope of Claude, or throws the reason.
function parse(raw: string, runtime: string): Known {
  let report: Report
  try {
    report = JSON.parse(raw) as Report
  } catch (err) {
    throw new Error(`quota-axi printed something that is not its JSON report: ${(err as Error).message}`, { cause: err })
  }
  if (report.schemaVersion !== schema) throw new Error(`quota-axi reports in schema version ${report.schemaVersion} and ameise reads version ${schema}`)
  const p = (report.providers ?? []).find((x) => x.provider === runtime)
  if (!p) throw new Error(`quota-axi reports no provider ${runtime}`)
  if (p.state?.stale) throw new Error(`quota-axi's reading of ${runtime} is stale`)
  const rows = p.quotaSemantics?.effectiveAvailability ?? []
  const row = rows.find((r) => r.scope === 'all_models')
  if (!row) throw new Error(`quota-axi reports no all_models scope for ${runtime}${p.state?.error ? `: ${p.state.error}` : ''}`)
  const remaining = percentOf(row)
  if (remaining === undefined) throw new Error(`quota-axi does not know how much of ${runtime} is left`)
  const windows = p.windows ?? []
  const resetOf = (ids: string[]) => {
    let reset: number | undefined
    for (const id of ids) {
      const at = Date.parse(windows.find((w) => w.id === id)?.resetsAt ?? '')
      if (!Number.isNaN(at) && (reset === undefined || at > reset)) reset = at
    }
    return reset === undefined ? null : new Date(reset).toISOString()
  }
  const read = {
    remaining,
    reset: resetOf(row.limitingWindowIds ?? []),
    windows: windowIds.flatMap((id) => {
      const w = windows.find((x) => x.id === id)
      return w ? [{ id, remaining: typeof w.percentRemaining === 'number' ? w.percentRemaining : null, reset: resetOf([id]) }] : []
    }),
  }
  const fable = runtime === 'claude' ? rows.find((r) => r.scope?.toLowerCase() === fableScope) : undefined
  if (!fable) return read
  const fableRemaining = percentOf(fable)
  if (fableRemaining === undefined) {
    return { ...read, fable: { known: false, reason: `quota-axi does not know how much of Fable is left (status ${fable.status ?? 'missing'})` } }
  }
  return { ...read, fable: { known: true, remaining: fableRemaining, reset: resetOf(fable.limitingWindowIds ?? []) } }
}

// readOne runs quota-axi for one runtime and answers its reading. It never throws: whatever keeps the
// number from being read is the reason of an unknown reading. The check runs in a process group of its
// own, and at the deadline the whole group is killed and the reading answered at once, so neither a
// quota-axi that ignores its signal nor a child of it that holds its output keeps the answer waiting.
function readOne(command: string, runtime: string, minimum: number): Promise<Reading> {
  return new Promise((resolve) => {
    let settled = false
    const done = (r: Reading) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(r)
    }
    const unknown = (reason: string) => done({ runtime, known: false, reason, below: false })
    const group = process.platform !== 'win32'
    let child: ChildProcess
    try {
      child = spawn(command, ['--provider', runtime, '--json'], { detached: group, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (err) {
      return resolve({ runtime, known: false, reason: `${command} failed: ${(err as Error).message}`, below: false })
    }
    const kill = () => {
      try {
        if (group && child.pid !== undefined) process.kill(-child.pid, 'SIGKILL')
        else child.kill('SIGKILL')
      } catch {
        // The group is gone already.
      }
    }
    const timer = setTimeout(() => {
      kill()
      unknown(`${command} gave no reading within ${timeout / 1000} seconds`)
    }, timeout)
    let stdout = ''
    let stderr = ''
    child.stdout?.setEncoding('utf8').on('data', (d: string) => {
      stdout += d
      if (stdout.length > maxBuffer) {
        kill()
        unknown(`${command} printed more than ${maxBuffer} bytes`)
      }
    })
    child.stderr?.setEncoding('utf8').on('data', (d: string) => {
      if (stderr.length < maxBuffer) stderr += d
    })
    child.on('error', (err: NodeJS.ErrnoException) => unknown(err.code === 'ENOENT' ? `${command} is not installed` : `${command} failed: ${err.message}`))
    child.on('close', (code, signal) => {
      if (code !== 0) return unknown(`${command} failed: ${(stderr || `it exited with ${signal ?? code}`).trim()}`)
      try {
        const r = parse(stdout, runtime)
        done({ runtime, known: true, ...r, below: r.remaining < minimum })
      } catch (e) {
        unknown((e as Error).message)
      }
    })
  })
}

// readQuota reads the runtimes named with the configured command, all of them at once. An empty command is the quota check switched off, which reads nothing.
export async function readQuota(command: string, minimum: number, read: string[]): Promise<Quota> {
  if (command === '') return { minimum, off: true, runtimes: [] }
  return { minimum, runtimes: await Promise.all(read.map((r) => readOne(command, r, minimum))) }
}

// warnings are what a claim says of a quota below the minimum: a line when Claude is below it. A runtime
// the work process does not spend warns no claim, however low it is.
export function warnings(q: Quota): string[] {
  return q.runtimes
    .filter((r): r is Extract<Reading, { known: true }> => r.runtime === claimRuntime && r.known && r.below)
    .map((r) => `${r.runtime} has ${Math.round(r.remaining)}% of its quota left, below the minimum of ${q.minimum}%${r.reset ? `; it resets at ${r.reset}` : ''}`)
}
