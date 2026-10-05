// The registry of the running processes: what runs for each process, a session, its gate, its
// reviewers or a wait of its ci stage, with the input of a session and the requests that wait for the
// maintainer. Only this module reads or writes that map; the session module registers, looks up and
// releases its runs through it. It stops one process or all of them as the controller stops, and marks
// each interrupted with a note that says how to go on, and it recovers the records the controller's last
// stop left running. It imports the record store and no module that drives a process.
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import type { Answer } from './conversation.js'
import type { SessionRecord, StageRecord, StandardizeRecord } from '../records/records.js'
import { event, eventsFile, recordFile, update, warn } from '../records/store.js'

// firstStage is the stage whose session a process of the record's kind starts with: implement for a
// work process, hunt for a hunt process.
export const firstStage = (record: { kind: string }): 'implement' | 'hunt' => (record.kind === 'hunt' ? 'hunt' : 'implement')

// Input is the stream of the session's user messages: the brief or the message that resumes it first,
// then every message the maintainer writes while it runs. Closing it ends the session's input.
export class Input implements AsyncIterable<SDKUserMessage> {
  private queue: SDKUserMessage[] = []
  private wake: (() => void) | undefined
  closed = false

  push(text: string) {
    this.queue.push({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null })
    this.wake?.()
  }

  // lead puts the text before every message that waits, as the first turn of a session that starts.
  lead(text: string) {
    this.queue.unshift({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null })
    this.wake?.()
  }

  close() {
    this.closed = true
    this.wake?.()
  }

  async *[Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    for (;;) {
      const next = this.queue.shift()
      if (next) yield next
      else if (this.closed) return
      else await new Promise<void>((wake) => (this.wake = wake))
    }
  }
}

// A request of the session that waits for the maintainer: a permission, answered by one of the answers,
// a question, answered by the text of a message, or a question round of the controller tool ask,
// answered by one reply per question or by the text of a message.
export interface Request {
  kind: 'permission' | 'question' | 'round'
  note: string
  // answer throws a Refusal for an answer the request does not take, and then leaves it waiting.
  answer: (a: Answer | { text: string } | { replies: unknown }) => void
  // close settles the request without an answer, as its session ends.
  close: () => void
}

// A session running: the abort that stops it, its end, its input and the requests that wait for an
// answer. Its end settles once the session has written its last and its runtime has exited. It is over
// once it has reported its end or been stopped, while its runtime may still be exiting.
export interface Running {
  abort: AbortController
  done: Promise<void>
  input: Input
  requests: Map<string, Request>
  over: boolean
  // busy says what runs in place of a session that takes messages, the gate command or the reviewers, so
  // nothing can be written to it.
  busy?: string
}

// The sessions running, by process id, so an abandon can stop its process's session and a message or an
// answer reaches it. A session stays here until its runtime has exited, so a resume waits for it and two
// runtimes never share a worktree.
const running = new Map<string, Running>()

// register keeps the session of a process as running, in place of what ran before.
export function register(id: string, s: Running) {
  running.set(id, s)
}

// runningOf answers what runs for a process: its session, its gate, its reviewers or a wait of its ci stage.
export const runningOf = (id: string): Running | undefined => running.get(id)

// release forgets what ran for a process once its runtime has exited, unless something new runs already.
export function release(id: string, s: Running) {
  if (running.get(id) === s) running.delete(id)
}

// track keeps the gate command or the reviewers of a process as running, so a stop ends them as it ends a
// session, and answers whether they are still the process's own: false once a stop has asked them to
// end. busy says what runs, as a refused message names it. The entry holds the reviewers' requests.
export function track(id: string, abort: AbortController, done: Promise<void>, busy = 'the gate runs'): { own: () => boolean; s: Running } {
  const s: Running = { abort, done, input: new Input(), requests: new Map(), over: false, busy }
  running.set(id, s)
  void done.finally(() => {
    if (running.get(id) === s) running.delete(id)
  })
  return { own: () => running.get(id) === s && !s.over, s }
}

// busy says the process runs a session, its gate, its reviewers or a wait of its ci stage.
export const busy = (id: string): boolean => running.has(id)

// stop ends the session of a process, if one runs, and settles once its runtime process has exited, so
// the session writes nothing more into the worktree or the record. It answers whether a session ran.
export async function stop(id: string): Promise<boolean> {
  const s = running.get(id)
  if (!s) return false
  s.over = true
  s.abort.abort()
  await s.done
  return true
}

// interruptedNote is the note of a work or hunt process whose session or stage the controller's stop cut off.
function interruptedNote(record: StageRecord): string {
  const first = `${firstStage(record)} session`
  const what =
    record.stage === 'gate'
      ? 'its gate'
      : record.stage === 'review'
        ? 'its review'
        : record.stage === 'pr'
          ? 'its pr stage'
          : record.stage === 'ci'
            ? 'its ci stage'
            : record.stage === 'address-reviews'
              ? 'its address-reviews stage'
              : `its ${first}`
  if (record.worktree && !existsSync(record.worktree)) return `the controller stopped while ${what} ran, and its worktree ${record.worktree} is gone; abandon it`
  if (record.stage !== firstStage(record) && record.fixing && record.session_id) return `the controller stopped while the fix session of ${what} ran; resume it to go on`
  if (record.stage === 'gate') return 'the controller stopped while its gate ran; resume it to run the gate again'
  if (record.stage === 'review' && record.fixing) return 'the controller stopped before the fix session of its review started; resume it to start the session'
  if (record.stage === 'review') return 'the controller stopped while its reviewers ran; resume it to run the round again'
  if (record.stage === 'pr') return 'the controller stopped while its pr stage ran; resume it to open the pull request'
  if (record.stage === 'ci') return 'the controller stopped while its ci stage waited on the pull request; resume it to wait again'
  if (record.stage === 'address-reviews') return 'the controller stopped before its address-reviews session started; resume it to read the review again'
  if (!record.session_id) return `the controller stopped before its ${first} started; resume it to start the session`
  return `the controller stopped while its ${first} ran; resume it to go on`
}

// interrupt marks a work process interrupted and keeps its session id, so a resume goes on with it. A
// plan process whose session had started waits for the maintainer instead, whose message resumes it by
// its id; one whose session never started has failed, and so has an acceptance, which checks again.
function interrupt(stateDir: string, id: string) {
  const file = recordFile(stateDir, id)
  if (!existsSync(file)) return
  const record = JSON.parse(readFileSync(file, 'utf8')) as SessionRecord
  // A standardize process runs scripts that are safe to run again: its stage fails, and runs again on request.
  if (record.kind === 'standardize') {
    const again = record.stage === 'audit' ? 'audit again' : record.stage === 'apply' ? 'apply again' : 'finalize again'
    const note = `the controller stopped while its ${record.stage} ran; ${again} in the process view`
    event(stateDir, id, { event: `${record.stage}-end`, stage: record.stage, state: 'failed', note })
    update(stateDir, id, { state: 'failed', note, unseen: true })
    return
  }
  if (record.kind === 'plan' && record.route === 'accept') {
    const note = 'the controller stopped while the acceptance ran; check again in the process view'
    event(stateDir, id, { event: 'acceptance-end', stage: record.stage, state: 'failed', note })
    update(stateDir, id, { state: 'failed', note, unseen: true })
    return
  }
  if (record.kind === 'plan') {
    const state = record.session_id ? 'input' : 'failed'
    const note = record.session_id
      ? 'the controller stopped while the planner session ran; write to it to go on'
      : 'the controller stopped before the planner session started; finish it and plan again'
    event(stateDir, id, { event: 'session-end', stage: record.stage, state, note })
    update(stateDir, id, { state, note, unseen: true })
    return
  }
  const note = interruptedNote(record)
  event(stateDir, id, { event: 'session-end', stage: record.stage, state: 'interrupted', note })
  update(stateDir, id, { state: 'interrupted', note })
}

// stopAll stops every session the controller runs, as it stops, and marks each process interrupted.
export async function stopAll(stateDir: string) {
  const ids = [...running.keys()]
  await Promise.all(ids.map((id) => stop(id)))
  for (const id of ids) {
    try {
      interrupt(stateDir, id)
    } catch (err) {
      warn(id, 'could not mark it interrupted', err)
    }
  }
}

// The events of a request that waits for the maintainer, and those that settle one.
const asks = ['permission', 'question', 'round']
const settles = ['answer', 'closed']

// closeOpen closes the requests of a process's event log that its session left waiting. A stop closes
// them as the session ends; a kill leaves them open, and none can be answered once its session is gone.
function closeOpen(stateDir: string, id: string) {
  const file = eventsFile(stateDir, id)
  if (!existsSync(file)) return
  const open = new Set<string>()
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (line.trim() === '') continue
    let e: { event?: unknown; request?: unknown }
    try {
      e = JSON.parse(line) as typeof e
    } catch {
      continue
    }
    if (typeof e.request !== 'string' || typeof e.event !== 'string') continue
    if (asks.includes(e.event)) open.add(e.request)
    else if (settles.includes(e.event)) open.delete(e.request)
  }
  for (const request of open) event(stateDir, id, { event: 'closed', request })
}

// recover reads the records as the controller starts, when no session of its own runs yet. A work
// process whose record says its session runs, is about to, or waits for an answer or on its pull request, lost it when the
// controller last stopped without stopping it. Such a process is marked interrupted. One held open after
// its implement session completed runs no session and waits for the maintainer's message as it was. A plan process
// whose session ran or waited for a permission lost it the same way, and is marked as interrupt does.
// A running acceptance fails, and so does one whose checker asked a question; it checks again on request.
// A standardize process whose audit, apply or finalize ran fails, and runs that stage again on request.
// A plan that waits for input waits for a message or for its answers either way. Every other record
// stays as it was. A request any session left waiting is closed first, since no session runs yet.
export function recover(stateDir: string) {
  let names: string[]
  try {
    names = readdirSync(join(stateDir, 'processes')).filter((n) => n.endsWith('.json'))
  } catch {
    return
  }
  for (const name of names) {
    const id = name.slice(0, -'.json'.length)
    try {
      const r = JSON.parse(readFileSync(recordFile(stateDir, id), 'utf8')) as SessionRecord
      closeOpen(stateDir, id)
      if ((r.kind === 'work' || r.kind === 'hunt') && ['running', 'waiting', 'created', 'approval', 'input'].includes(r.state) && !(r.state === 'input' && r.held)) interrupt(stateDir, id)
      // A checker that asked a question waits in input with no items yet, and it is gone as well.
      const asking = r.kind === 'plan' && r.route === 'accept' && r.state === 'input' && !r.acceptance
      if ((r.kind === 'plan' && ['running', 'approval'].includes(r.state)) || asking) interrupt(stateDir, id)
      // A standardize process waits for its answers or its finalize with nothing running, and lost its stage otherwise.
      // It waits in input for its answers once its audit reported; in input before, a session of it asked a question.
      const answering = r.kind === 'standardize' && r.state === 'input' && r.stage === 'audit' && (r as StandardizeRecord).standardize !== undefined
      if (r.kind === 'standardize' && ['running', 'created', 'approval', 'input'].includes(r.state) && !answering) interrupt(stateDir, id)
    } catch (err) {
      warn(id, 'could not read its record as the controller started', err)
    }
  }
}

