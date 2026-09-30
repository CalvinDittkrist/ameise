// The gate stage of a work process, which the controller runs itself once the implement session has
// reported complete (ADR 0058). It merges the base into the branch and runs the repository's gate
// command in the worktree. A merge that conflicts and a gate command that fails each start a fix session
// of the gate, a fresh session with the stage timeout, within the gate's budget; the gate runs again on
// what the session leaves. Every merge that conflicts, every run and every fix session is an attempt in
// the record's history. A pass ends the process ready; a budget spent ends it failed with the end of the
// last output.
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { type Attempt, fetch, git, type WorkRecord } from './claim.js'
import type { Project } from './project.js'
import { attempt, begin, event, fixBrief, runtimeEnv, type Runtime, track, update } from './session.js'

// The gate command, the single gate of a repository that follows the standard (ADR 0008).
export const gateCommand = ['make', 'check']
const command = gateCommand.join(' ')

// The gate's knobs: how many fix sessions a failing gate may take, and how many seconds one run of the
// gate command may take before it is ended and counts as a failure.
const defaultRounds = 3
const defaultTimeout = 2700

// The end of the gate command's output the record keeps and a fix session is briefed with.
const tailLines = 20
const tailChars = 4000

// knob reads a whole-number knob of the process: the claim's override, else the env block of the
// repository's .claude/settings.json, else the default. A value that is no whole number of at least min
// is refused with the reason.
export function knob(record: WorkRecord, name: string, fallback: number, min = 0): number {
  let value: unknown = record.env[name]
  if (value === undefined) {
    try {
      value = (JSON.parse(readFileSync(join(record.project, '.claude', 'settings.json'), 'utf8')) as { env?: Record<string, unknown> }).env?.[name]
    } catch {
      // a repository without settings sets no knob
    }
  }
  if (value === undefined || value === '') return fallback
  const n = Number(value)
  if (typeof value === 'boolean' || !Number.isInteger(n) || n < min) throw new Error(`${name}=${String(value)} is not a whole number of at least ${min}; set it as such, or leave it out for ${fallback}`)
  return n
}

// gate starts the gate stage of a process once after has settled, as the runtime of the session before
// it has exited, and answers the record as it runs. A stop ends it and its gate command; the process's
// history counts the fix sessions it spent since the last implement session.
// before is the abort of that session, which a stop of the gate aborts too while its runtime exits.
export function gate(record: WorkRecord, project: Project, rt: Runtime, after: Promise<void> = Promise.resolve(), before?: AbortController): WorkRecord {
  const id = record.id
  const started = (update(rt.stateDir, id, { stage: 'gate', state: 'running', note: `the gate merges ${record.base} and runs ${command}`, fixing: false } as Partial<WorkRecord>) as WorkRecord | undefined) ?? record
  event(rt.stateDir, id, { event: 'gate-start', stage: 'gate' })
  const abort = new AbortController()
  if (before) abort.signal.addEventListener('abort', () => before.abort(), { once: true })
  let own = () => true
  const done = after
    .then(() => (own() ? stage(started, project, rt, abort.signal, () => own()) : undefined))
    .catch((err: unknown) => {
      if (!own()) return
      const note = `the gate failed: ${(err as Error).message}`
      event(rt.stateDir, id, { event: 'gate-end', stage: 'gate', state: 'failed', note })
      const failed = update(rt.stateDir, id, { state: 'failed', note, unseen: true })
      if (failed) rt.announce(failed)
    })
    .catch((err: unknown) => {
      process.stderr.write(`warning: ${id}: its gate ended unexpectedly: ${(err as Error).message}\n`)
    })
  own = track(id, abort, done)
  return started
}

const short = (commit: string | undefined) => (commit ?? '').slice(0, 7)

async function stage(record: WorkRecord, project: Project, rt: Runtime, signal: AbortSignal, own: () => boolean): Promise<void> {
  const id = record.id
  const wt = record.worktree
  const now = () => new Date().toISOString()
  // end ends the process in the state with the note, unless a stop has taken it over.
  const end = (state: 'ready' | 'failed', note: string, a?: Attempt) => {
    if (!own()) return
    event(rt.stateDir, id, { event: 'gate-end', stage: 'gate', state, note })
    const change = { state, note, unseen: true }
    const ended = a ? attempt(rt.stateDir, id, a, change) : update(rt.stateDir, id, change)
    if (ended) rt.announce(ended)
  }
  let rounds: number
  let limit: number
  try {
    rounds = knob(record, 'WF_GATE_ROUNDS', defaultRounds)
    limit = knob(record, 'WF_GATE_TIMEOUT', defaultTimeout, 1)
  } catch (err) {
    return end('failed', (err as Error).message)
  }

  // The base is fetched first, so the merge takes what origin has now; offline, it takes what the
  // checkout has.
  if (record.base.startsWith('origin/') && !(await fetch(record.project, record.base.slice('origin/'.length), rt.fake))) {
    event(rt.stateDir, id, { event: 'gate-note', note: `could not fetch ${record.base}; merging what this checkout has of it` })
  }
  if (!own()) return
  let failure: Attempt | undefined
  try {
    await git(wt, 'merge', '--no-edit', record.base)
  } catch (err) {
    const files = (await git(wt, 'diff', '--name-only', '--diff-filter=U').catch(() => '')).split('\n').filter((f) => f !== '')
    if (files.length === 0) return end('failed', `could not merge ${record.base} into ${record.branch}: ${(err as Error).message}`)
    await git(wt, 'merge', '--abort').catch(() => undefined)
    failure = { stage: 'gate', kind: 'merge', result: 'conflict', at: now(), commit: await git(wt, 'rev-parse', 'HEAD'), files }
  }
  if (!own()) return

  if (!failure) {
    const commit = await git(wt, 'rev-parse', 'HEAD')
    const ran = await runGate(wt, limit, signal)
    if (!own()) return
    // The worktree is read after the run, so a gate command that formats or generates files counts as dirty.
    const dirty = (await git(wt, 'status', '--porcelain')) !== ''
    if (!own()) return
    const a: Attempt = {
      stage: 'gate',
      kind: 'run',
      result: ran.exit === 0 && !ran.late ? 'pass' : 'fail',
      at: now(),
      commit,
      dirty,
      exit: ran.exit,
      tail: ran.tail,
      ...(ran.late ? { note: `${command} ran past the gate timeout of ${limit} s` } : {}),
    }
    event(rt.stateDir, id, { event: 'gate', ...a })
    if (a.result === 'pass') return end('ready', `the gate passed at ${short(commit)}${dirty ? ', with changes not committed' : ''}`, a)
    failure = a
  } else {
    event(rt.stateDir, id, { event: 'gate', ...failure })
  }

  // The fix sessions this gate has spent: those since the implement session last completed.
  const history = record.history ?? []
  const since = history.map((h) => h.stage === 'implement').lastIndexOf(true)
  // A fix session resumed after a block is the same session, counted once.
  const fixes = new Set(history.slice(since + 1).flatMap((h, i) => (h.stage === 'gate' && h.kind === 'session' ? [h.session_id ?? `#${i}`] : []))).size
  const what =
    failure.kind === 'merge'
      ? `merging ${record.base} conflicts in ${(failure.files ?? []).join(', ')}`
      : `${command} failed at ${short(failure.commit)} with ${failure.note ?? `exit ${failure.exit ?? 'none'}`}`
  if (fixes >= rounds) {
    const tail = failure.kind === 'run' && failure.tail ? `; the end of its output:\n${failure.tail}` : ''
    return end('failed', `the gate spent its ${rounds} fix session(s): ${what}${tail}`, failure)
  }
  // A fix session is a fresh session: the one before it is in the history, not in its resume.
  const fixing = attempt(rt.stateDir, id, failure, { session_id: undefined, fixing: true, note: `${what}; fix session ${fixes + 1} of ${rounds}` })
  if (!fixing || !own()) return
  begin(fixing, project, rt, fixBrief(fixing, `${project.owner}/${project.name}`, failure, command))
}

// runGate runs the gate command in the worktree in a process group of its own, which a stop or the
// timeout ends whole, and answers its exit status and the end of its output.
function runGate(cwd: string, seconds: number, signal: AbortSignal): Promise<{ exit: number | null; tail: string; late: boolean }> {
  return new Promise((resolve) => {
    let out = ''
    let late = false
    let settled = false
    // A stop that came before the command started ends the gate without starting it.
    if (signal.aborted) return resolve({ exit: null, tail: '', late: false })
    const [cmd, ...args] = gateCommand as [string, ...string[]]
    const child = spawn(cmd, args, { cwd, env: runtimeEnv(), detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
    const keep = (d: Buffer) => (out = (out + d.toString()).slice(-65536))
    child.stdout.on('data', keep)
    child.stderr.on('data', keep)
    const signalGroup = (sig: NodeJS.Signals) => {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, sig)
      } catch {
        // the group is gone already
      }
    }
    // The escalation is cancelled once the command has settled, so it never signals a group whose id
    // another process has taken since.
    let escalate: NodeJS.Timeout | undefined
    const kill = () => {
      signalGroup('SIGTERM')
      escalate ??= setTimeout(() => signalGroup('SIGKILL'), 5000)
      escalate.unref()
    }
    const timer = setTimeout(() => {
      late = true
      kill()
    }, seconds * 1000)
    timer.unref()
    signal.addEventListener('abort', kill, { once: true })
    const settle = (exit: number | null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      clearTimeout(escalate)
      signal.removeEventListener('abort', kill)
      resolve({ exit, tail: tailOf(out), late })
    }
    child.on('error', (err) => {
      out += `${err.message}\n`
      settle(null)
    })
    child.on('close', (code) => settle(code))
  })
}

// tailOf is the end of an output: its last lines, and no more than the characters a brief carries.
function tailOf(out: string): string {
  const lines = out.replace(/\s+$/, '').split('\n').slice(-tailLines).join('\n')
  return lines.length > tailChars ? lines.slice(-tailChars) : lines
}
