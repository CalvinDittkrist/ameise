// The gate stage of a work process, which the controller runs itself once the implement session has
// reported complete (ADR 0058). It merges the base into the branch and runs the repository's gate
// command in the worktree. WF_GATE names the form of that command, and the form none runs no gate.
// The gate on CI pushes the branch and reads the checks of the gate's draft instead (cigate.ts).
//
// The gate and its fix are two nodes of the delivery graph (delivery.ts), which start no stage
// themselves. The gate node returns pass, skipped, fail or failed, and the engine (engine.ts) follows it:
// a pass or a skip goes on to the review node. A merge that conflicts and a gate command that fails are
// a fail, which goes to the gate fix node while the graph's guard gateRoundsRemain finds a round of
// WF_GATE_ROUNDS left, and otherwise parks the process failed with the end of the last output. Failed
// parks the process with the reason and spends no round. The gate fix node starts a fresh session with
// the stage timeout, whose complete runs the gate again on what it leaves. Every merge that conflicts,
// every run and every fix session is an attempt in the record's history. The gate runs again after every
// fix session of the review.
import { spawn } from 'node:child_process'
import { fetch, git } from './git.js'
import { ciGate } from './cigate.js'
import type { Node, NodeContext, Outcome } from './engine.js'
import { fixBrief } from './briefs.js'
import { gateFixesSpent } from './budgets.js'
import { begin, type Runtime } from './session.js'
import { knob, runtimeEnv, setting } from './settings.js'
import type { Attempt, StageRecord } from './records.js'
import { attempt, event, update } from './store.js'

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
const defaultRounds = 3
const defaultTimeout = 2700

// How many seconds after a push a named check may take to appear, and GitHub to register any check of
// the head, before the gate on CI ends the process naming what is missing. The ci stage waits as long
// for the checks a ready pull request starts.
export const defaultGrace = 600

// The end of the gate command's output the record keeps and a fix session is briefed with.
const tailLines = 20
const tailChars = 4000

// gateNode is the gate node of the delivery graph (delivery.ts). It runs the gate of the form WF_GATE
// names and returns pass, skipped, fail or failed. It starts no stage and no session itself; the engine
// (engine.ts) follows its outcome. A stop ends it and its gate command; a resume enters it again.
export const gateNode: Node = { run: (ctx) => stage(ctx) }

export const short = (commit: string | undefined) => (commit ?? '').slice(0, 7)

// stopped is what the node returns once a stop has taken the process over, which the engine discards.
export const stopped: Outcome = { outcome: 'stopped' }

async function stage(ctx: NodeContext): Promise<Outcome> {
  const { record, rt, signal, own } = ctx
  const id = record.id
  const wt = record.worktree
  const now = () => new Date().toISOString()
  ctx.running.busy = 'the gate runs'
  let rounds: number
  let limit: number
  let form: GateForm
  try {
    form = gateForm(setting(record, 'WF_GATE'))
    rounds = knob(record, 'WF_GATE_ROUNDS', defaultRounds)
    limit = knob(record, 'WF_GATE_TIMEOUT', defaultTimeout, 1)
  } catch (err) {
    return { outcome: 'failed', note: (err as Error).message }
  }
  const command = form.name
  if (!own()) return stopped
  // The gate on CI reads the checks of the gate's draft instead of running a command here.
  if (form.form === 'ci') return ciGate(ctx, form, rounds, limit)
  update(rt.stateDir, id, { note: form.form === 'none' ? 'the gate form is none, so the review follows without a gate' : `the gate merges ${record.base} and runs ${command}` })

  // The form none runs no gate: its attempt names the form, and the review follows.
  if (form.form === 'none') {
    const a: Attempt = { stage: 'gate', kind: 'run', result: 'skipped', at: now(), commit: await git(wt, 'rev-parse', 'HEAD'), gate: command }
    if (!own()) return stopped
    event(rt.stateDir, id, { event: 'gate', ...a })
    event(rt.stateDir, id, { event: 'gate-end', stage: 'gate', state: 'skipped', note: 'the gate form is none; no gate ran' })
    attempt(rt.stateDir, id, a)
    return { outcome: 'skipped' }
  }

  let failure: Attempt | undefined
  try {
    const files = await mergeBase(record, rt)
    if (files.length > 0) failure = { stage: 'gate', kind: 'merge', result: 'conflict', at: now(), commit: await git(wt, 'rev-parse', 'HEAD'), files }
  } catch (err) {
    return { outcome: 'failed', note: (err as Error).message }
  }
  if (!own()) return stopped

  if (!failure) {
    const commit = await git(wt, 'rev-parse', 'HEAD')
    const ran = await runGate(wt, form.argv, limit, signal)
    if (!own()) return stopped
    // The worktree is read after the run, so a gate command that formats or generates files counts as dirty.
    const dirty = (await git(wt, 'status', '--porcelain')) !== ''
    if (!own()) return stopped
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
      attempt(rt.stateDir, id, a)
      return { outcome: 'pass' }
    }
    failure = a
  } else {
    event(rt.stateDir, id, { event: 'gate', ...failure })
  }

  return fail(record, rt, own, failure, command, rounds)
}

// mergeBase merges the base into the branch in the worktree and answers the files it left in conflict,
// none when it merged, after aborting a merge that conflicts. The base is fetched first, so the merge
// takes what origin has now; offline, it takes what the checkout has. A merge that fails otherwise
// throws with the reason.
export async function mergeBase(record: StageRecord, rt: Runtime): Promise<string[]> {
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

// whatOf names a failure of the gate: a merge of the base that conflicts, checks of the gate on CI that
// failed, or a run of the gate command that failed.
function whatOf(record: StageRecord, failure: Attempt, command: string): string {
  const failing = (failure.checks ?? []).filter((c) => c.state === 'fail').map((c) => c.name)
  return failure.kind === 'merge'
    ? `merging ${record.base} conflicts in ${(failure.files ?? []).join(', ')}`
    : failure.checks
      ? `${command} failed at ${short(failure.commit)} on PR #${failure.pr ?? '?'}: ${failing.join(', ')}`
      : `${command} failed at ${short(failure.commit)} with ${failure.note ?? `exit ${failure.exit ?? 'none'}`}`
}

// fail writes the failure of the gate, a merge of the base that conflicts or a run that failed, and
// returns the outcome fail. The fix sessions this gate has spent are those since the last session of
// another stage, the implement session or a fix session of the review, whose work this gate checks. The
// graph's guard gateRoundsRemain counts them the same way. While a round remains, the failure is written
// with the note of the fix session the gate fix node starts. Once the rounds are spent, its note is the
// one the process parks failed with, with the end of the last output.
export function fail(record: StageRecord, rt: Runtime, own: () => boolean, failure: Attempt, command: string, rounds: number): Outcome {
  if (!own()) return stopped
  const id = record.id
  const fixes = gateFixesSpent(record.history ?? [])
  const what = whatOf(record, failure, command)
  if (fixes >= rounds) {
    const tail = failure.kind === 'run' && failure.tail ? `; the end of its output:\n${failure.tail}` : ''
    attempt(rt.stateDir, id, failure, { wait: undefined } as Partial<StageRecord>)
    return { outcome: 'fail', note: `the gate spent its ${rounds} fix session(s): ${what}${tail}` }
  }
  // A fix session is a fresh session: the one before it is in the history, not in its resume.
  attempt(rt.stateDir, id, failure, { session_id: undefined, fixing: true, wait: undefined, note: `${what}; fix session ${fixes + 1} of ${rounds}` } as Partial<StageRecord>)
  return { outcome: 'fail' }
}

// gateFixNode is the fix-session node of the gate. A record that still has the id of its fix session, as
// on a resume, goes on with that session. Any other starts a fresh session briefed with the last failure
// of the gate in the history and the name of the gate form. Its complete goes to the gate through the
// engine.
export const gateFixNode: Node = {
  adapt: (record, project, rt) => {
    if (record.session_id !== undefined) return begin(record, project, rt)
    const failure = [...(record.history ?? [])].reverse().find((h) => h.stage === 'gate' && (h.kind === 'merge' || h.kind === 'run') && h.result !== 'pass' && h.result !== 'skipped')
    let command = defaultGate
    try {
      command = gateForm(setting(record, 'WF_GATE')).name
    } catch {
      // the gate node refused the form before it failed; the brief names the default
    }
    if (!failure) return begin(record, project, rt)
    return begin(record, project, rt, fixBrief(record, `${project.owner}/${project.name}`, failure, command))
  },
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
