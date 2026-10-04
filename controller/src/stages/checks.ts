// The checks of a pull request as the gate on CI (cigate.ts) and the ci stage (ci.ts) both read them:
// a reading as gh pr view answers it, its checks each pass, fail or pending, and the pause between two
// readings. This module imports the record types and nothing that drives a process.
import type { Check } from '../records/records.js'

// A reading of the pull request as gh pr view answers it: the fields the verdict is made of.
export interface Reading {
  number: number
  url: string
  state: string
  headRefOid?: string
  mergeable: string
  mergeStateStatus?: string
  statusCheckRollup?: { name?: string; context?: string; conclusion?: string | null; state?: string | null; status?: string | null; completedAt?: string | null; detailsUrl?: string; targetUrl?: string }[]
  reviews?: { id?: string; author?: { login?: string } | null; authorAssociation?: string; body?: string; url?: string; state: string; submittedAt?: string }[]
}

const failures = ['FAILURE', 'ERROR', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE']
const pendings = ['PENDING', 'EXPECTED', 'QUEUED', 'IN_PROGRESS', 'WAITING', 'REQUESTED']

// checksOf are the checks of a reading, each pass, fail or pending, with when it completed.
export function checksOf(r: Reading): (Check & { completed?: number })[] {
  return (r.statusCheckRollup ?? []).map((c) => {
    const s = c.conclusion || c.state || 'PENDING'
    const pending = pendings.includes(s) || (c.status != null && c.status !== 'COMPLETED')
    const state: Check['state'] = failures.includes(s) ? 'fail' : pending ? 'pending' : 'pass'
    const url = c.detailsUrl || c.targetUrl
    const completed = c.completedAt ? Date.parse(c.completedAt) : NaN
    return { name: c.name || c.context || 'check', ...(url ? { url } : {}), state, ...(Number.isFinite(completed) ? { completed } : {}) }
  })
}

// pause lets ms pass, or less once the signal aborts.
export function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve()
    const done = () => {
      clearTimeout(timer)
      signal.removeEventListener('abort', done)
      resolve()
    }
    const timer = setTimeout(done, ms)
    signal.addEventListener('abort', done, { once: true })
  })
}
