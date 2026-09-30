// The gate stage of a work process, which the controller runs itself once the implement session has
// reported complete (ADR 0058). It merges the base into the branch and runs the repository's gate
// command in the worktree. WF_GATE names the form of that command, and the form none runs no gate.
// The gate on CI pushes the branch and reads the checks of the gate's draft instead (cigate.ts).
// A merge that conflicts and a gate command that fails each start a fix session of the gate. That is
// a fresh session with the stage timeout, within the gate's budget, and the gate runs again on what it
// leaves. Every merge that conflicts, every run and every fix session is an attempt in the record's
// history. A pass starts the review stage (review.ts); a budget spent ends the process failed with the
// end of the last output. The gate runs again after every fix session of the review.
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { type Attempt, fetch, git, type WorkRecord } from './claim.js'
import type { Project } from './project.js'
import { ciGate } from './cigate.js'
import { review } from './review.js'
import { attempt, begin, event, fixBrief, runtimeEnv, type Runtime, track, update } from './session.js'

// The gate command of a repository that sets no WF_GATE, the single gate of a repository that follows
// the standard (ADR 0008).
export const defaultGate = 'make check'
const defaultArgv = defaultGate.split(' ') as [string, ...string[]]

// A gate form of WF_GATE is a command, none or the gate on CI. A command is an argument list the gate
// runs in the worktree without a shell. The form none runs no gate, so implement and every fix session
// of the review go straight to the review. The gate on CI, ci or ci:<checks>, reads the checks of the
// gate's draft instead (cigate.ts): every check, or the checks it names.
export type GateForm =
  | { form: 'command'; argv: [string, ...string[]]; name: string }
  | { form: 'none'; name: 'none' }
  | { form: 'ci'; checks: string[]; name: string }

const forms = `the forms are a command such as ${defaultGate}, which runs in the worktree without a shell; none, which runs no gate; ci or ci:<jobs> such as ci:check,browser, the gate on CI; or unset, for ${defaultGate}`

// gateForm reads a value of WF_GATE into its gate form, or refuses it with the forms.
export function gateForm(value: unknown): GateForm {
  if (value === undefined || value === '') return { form: 'command', argv: defaultArgv, name: defaultGate }
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`WF_GATE=${JSON.stringify(value)} is no gate form; ${forms}`)
  const v = value.trim()
  if (v === 'none') return { form: 'none', name: 'none' }
  if (/^ci(:|$)/.test(v)) {
    if (/^ci(:[A-Za-z0-9_.-]+(,[A-Za-z0-9_.-]+)*)?$/.test(v)) return { form: 'ci', checks: v === 'ci' ? [] : [...new Set(v.slice(3).split(','))], name: v }
    throw new Error(`WF_GATE=${v} is no gate form: ci:<jobs> names jobs separated by commas; ${forms}`)
  }
  if (/[|&;<>()$`"'\\]/.test(v)) throw new Error(`WF_GATE=${v} holds shell syntax, but the gate runs its command without a shell; ${forms}`)
  const argv = v.split(/\s+/) as [string, ...string[]]
  return { form: 'command', argv, name: argv.join(' ') }
}

// The gate's knobs: how many fix sessions a failing gate may take, and how many seconds one run of the
// gate command may take before it is ended and counts as a failure. One run of the gate on CI is bounded
// the same way.
export const defaultRounds = 3
export const defaultTimeout = 2700

// The end of the gate command's output the record keeps and a fix session is briefed with.
const tailLines = 20
const tailChars = 4000

// setting reads a knob of the process: the claim's override, else the env block of the repository's
// .claude/settings.json, else undefined.
export const setting = (record: WorkRecord, name: string): unknown => settingOf(record.env, record.project, name)

// settingOf reads a knob from the overrides, else from the env block of the checkout's settings.
export function settingOf(env: Record<string, string>, checkout: string, name: string): unknown {
  const value: unknown = env[name]
  if (value !== undefined) return value
  try {
    return (JSON.parse(readFileSync(join(checkout, '.claude', 'settings.json'), 'utf8')) as { env?: Record<string, unknown> }).env?.[name]
  } catch {
    // a repository without settings sets no knob
    return undefined
  }
}

// knob reads a whole-number knob of the process, or the default where it is not set. A value that is no
// whole number of at least min is refused with the reason.
export function knob(record: WorkRecord, name: string, fallback: number, min = 0): number {
  const value = setting(record, name)
  if (value === undefined || value === '') return fallback
  const n = Number(value)
  if (typeof value === 'boolean' || !Number.isInteger(n) || n < min) throw new Error(`${name}=${String(value)} is not a whole number of at least ${min}; set it as such, or leave it out for ${fallback}`)
  return n
}

// gate starts the gate stage of a process once after has settled, as the runtime of the session before
// it has exited, and answers the record as it runs. A stop ends it and its gate command; the process's
// history counts the fix sessions it spent since the session before it that was no fix of the gate.
// before is the abort of that session, which a stop of the gate aborts too while its runtime exits.
export function gate(record: WorkRecord, project: Project, rt: Runtime, after: Promise<void> = Promise.resolve(), before?: AbortController): WorkRecord {
  const id = record.id
  const started = (update(rt.stateDir, id, { stage: 'gate', state: 'running', note: 'the gate starts', fixing: false } as Partial<WorkRecord>) as WorkRecord | undefined) ?? record
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
  own = track(id, abort, done).own
  return started
}

export const short = (commit: string | undefined) => (commit ?? '').slice(0, 7)

async function stage(record: WorkRecord, project: Project, rt: Runtime, signal: AbortSignal, own: () => boolean): Promise<void> {
  const id = record.id
  const wt = record.worktree
  const now = () => new Date().toISOString()
  // end ends the process failed with the note, unless a stop has taken it over.
  const end = (state: 'failed', note: string, a?: Attempt) => {
    if (!own()) return
    event(rt.stateDir, id, { event: 'gate-end', stage: 'gate', state, note })
    const change = { state, note, unseen: true }
    const ended = a ? attempt(rt.stateDir, id, a, change) : update(rt.stateDir, id, change)
    if (ended) rt.announce(ended)
  }
  let rounds: number
  let limit: number
  let form: GateForm
  try {
    form = gateForm(setting(record, 'WF_GATE'))
    rounds = knob(record, 'WF_GATE_ROUNDS', defaultRounds)
    limit = knob(record, 'WF_GATE_TIMEOUT', defaultTimeout, 1)
  } catch (err) {
    return end('failed', (err as Error).message)
  }
  const command = form.name
  if (!own()) return
  // The gate on CI reads the checks of the gate's draft instead of running a command here.
  if (form.form === 'ci') return ciGate(record, project, rt, signal, own, form, rounds, limit)
  update(rt.stateDir, id, { note: form.form === 'none' ? 'the gate form is none, so the review follows without a gate' : `the gate merges ${record.base} and runs ${command}` })

  // The form none runs no gate: its attempt names the form, and the review follows.
  if (form.form === 'none') {
    const a: Attempt = { stage: 'gate', kind: 'run', result: 'skipped', at: now(), commit: await git(wt, 'rev-parse', 'HEAD'), gate: command }
    if (!own()) return
    event(rt.stateDir, id, { event: 'gate', ...a })
    event(rt.stateDir, id, { event: 'gate-end', stage: 'gate', state: 'skipped', note: 'the gate form is none; no gate ran' })
    const next = attempt(rt.stateDir, id, a)
    if (next && own()) review(next, project, rt)
    return
  }

  let failure: Attempt | undefined
  try {
    const files = await mergeBase(record, rt)
    if (files.length > 0) failure = { stage: 'gate', kind: 'merge', result: 'conflict', at: now(), commit: await git(wt, 'rev-parse', 'HEAD'), files }
  } catch (err) {
    return end('failed', (err as Error).message)
  }
  if (!own()) return

  if (!failure) {
    const commit = await git(wt, 'rev-parse', 'HEAD')
    const ran = await runGate(wt, form.argv, limit, signal)
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
      gate: command,
      exit: ran.exit,
      tail: ran.tail,
      ...(ran.late ? { note: `${command} ran past the gate timeout of ${limit} s` } : {}),
    }
    event(rt.stateDir, id, { event: 'gate', ...a })
    if (a.result === 'pass') {
      const passed = `the gate passed at ${short(commit)}${dirty ? ', with changes not committed' : ''}`
      event(rt.stateDir, id, { event: 'gate-end', stage: 'gate', state: 'pass', note: passed })
      const next = attempt(rt.stateDir, id, a)
      if (next && own()) review(next, project, rt)
      return
    }
    failure = a
  } else {
    event(rt.stateDir, id, { event: 'gate', ...failure })
  }

  repair(record, project, rt, own, failure, command, rounds)
}

// mergeBase merges the base into the branch in the worktree and answers the files it left in conflict,
// none when it merged, after aborting a merge that conflicts. The base is fetched first, so the merge
// takes what origin has now; offline, it takes what the checkout has. A merge that fails otherwise
// throws with the reason.
export async function mergeBase(record: WorkRecord, rt: Runtime): Promise<string[]> {
  const wt = record.worktree
  if (record.base.startsWith('origin/') && !(await fetch(record.project, record.base.slice('origin/'.length), rt.fake))) {
    event(rt.stateDir, record.id, { event: 'gate-note', note: `could not fetch ${record.base}; merging what this checkout has of it` })
  }
  try {
    await git(wt, 'merge', '--no-edit', record.base)
    return []
  } catch (err) {
    const files = (await git(wt, 'diff', '--name-only', '--diff-filter=U').catch(() => '')).split('\n').filter((f) => f !== '')
    if (files.length === 0) throw new Error(`could not merge ${record.base} into ${record.branch}: ${(err as Error).message}`, { cause: err })
    await git(wt, 'merge', '--abort').catch(() => undefined)
    return files
  }
}

// repair starts a fix session of the gate on its failure, a merge of the base that conflicts or a run
// that failed, or ends the process failed once the gate has spent its rounds. The fix sessions this gate
// has spent are those since the last session of another stage, the implement session or a fix session
// of the review, whose work this gate checks.
export function repair(record: WorkRecord, project: Project, rt: Runtime, own: () => boolean, failure: Attempt, command: string, rounds: number): void {
  const id = record.id
  const history = record.history ?? []
  const since = history.map((h) => h.stage !== 'gate' && h.kind === 'session').lastIndexOf(true)
  // A fix session resumed after a block is the same session, counted once.
  const fixes = new Set(history.slice(since + 1).flatMap((h, i) => (h.stage === 'gate' && h.kind === 'session' ? [h.session_id ?? `#${i}`] : []))).size
  const failing = (failure.checks ?? []).filter((c) => c.state === 'fail').map((c) => c.name)
  const what =
    failure.kind === 'merge'
      ? `merging ${record.base} conflicts in ${(failure.files ?? []).join(', ')}`
      : failure.checks
        ? `${command} failed at ${short(failure.commit)} on PR #${failure.pr ?? '?'}: ${failing.join(', ')}`
        : `${command} failed at ${short(failure.commit)} with ${failure.note ?? `exit ${failure.exit ?? 'none'}`}`
  if (fixes >= rounds) {
    if (!own()) return
    const tail = failure.kind === 'run' && failure.tail ? `; the end of its output:\n${failure.tail}` : ''
    const note = `the gate spent its ${rounds} fix session(s): ${what}${tail}`
    event(rt.stateDir, id, { event: 'gate-end', stage: 'gate', state: 'failed', note })
    const ended = attempt(rt.stateDir, id, failure, { state: 'failed', note, wait: undefined, unseen: true } as Partial<WorkRecord>)
    if (ended) rt.announce(ended)
    return
  }
  // A fix session is a fresh session: the one before it is in the history, not in its resume.
  const fixing = attempt(rt.stateDir, id, failure, { session_id: undefined, fixing: true, wait: undefined, note: `${what}; fix session ${fixes + 1} of ${rounds}` } as Partial<WorkRecord>)
  if (!fixing || !own()) return
  begin(fixing, project, rt, fixBrief(fixing, `${project.owner}/${project.name}`, failure, command))
}

// runGate runs the gate command, an argument list without a shell, in the worktree in a process group of
// its own, which a stop or the timeout ends whole, and answers its exit status and the end of its output.
function runGate(cwd: string, argv: [string, ...string[]], seconds: number, signal: AbortSignal): Promise<{ exit: number | null; tail: string; late: boolean }> {
  return new Promise((resolve) => {
    let out = ''
    let late = false
    let settled = false
    // A stop that came before the command started ends the gate without starting it.
    if (signal.aborted) return resolve({ exit: null, tail: '', late: false })
    const [cmd, ...args] = argv
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
export function tailOf(out: string): string {
  const lines = out.replace(/\s+$/, '').split('\n').slice(-tailLines).join('\n')
  return lines.length > tailChars ? lines.slice(-tailChars) : lines
}
