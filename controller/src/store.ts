// The store of the processes: the records, event logs and command files in processes/ of the state
// directory, and the notices of their changes. It writes a new process whole, reads, updates and forgets
// a record, appends to its event log and its history, and tells every watcher of a process each record
// written, each event and the removal. It imports no module that drives a process.
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Refusal } from './project.js'
import type { Attempt, CreatedRecord, SessionRecord, StageRecord } from './records.js'

export const recordsDir = (stateDir: string) => join(stateDir, 'processes')

// writeAtomic replaces a file whole, through a rename, so a reader sees the old one or the new one.
export function writeAtomic(path: string, body: string) {
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, body)
  renameSync(tmp, path)
}

// writeProcess writes the record of a new process and the first line of its event log. A process that
// cannot be written is no process: it removes what it wrote, runs undo for what the action created
// elsewhere and refuses with the reason.
export async function writeProcess(stateDir: string, record: CreatedRecord, event: Record<string, unknown>, undo: () => Promise<void>, action: string): Promise<void> {
  const dir = recordsDir(stateDir)
  const file = join(dir, `${record.id}.json`)
  const events = join(dir, `${record.id}.events.jsonl`)
  try {
    mkdirSync(dir, { recursive: true })
    writeAtomic(file, JSON.stringify(record, null, 2) + '\n')
    appendFileSync(events, JSON.stringify({ at: record.created_at, ...event }) + '\n')
  } catch (err) {
    for (const f of [file, events, `${file}.${process.pid}.tmp`]) {
      try {
        rmSync(f, { force: true })
      } catch {
        // a path that is no file is left alone
      }
    }
    await undo()
    throw new Refusal(`could not write the process of ${record.issue === null ? record.branch : `#${record.issue}`}: ${(err as Error).message}; the ${action} is undone`, 500)
  }
}

// A change of a process that the process page follows: a line written to its event log, its record
// written anew, or its record gone.
export type Change = { event: Record<string, unknown> } | { record: SessionRecord } | { gone: true }

const watchers = new Map<string, Set<(c: Change) => void>>()

// watch calls back with every change of the process from now on, and answers the call that ends it.
export function watch(id: string, fn: (c: Change) => void): () => void {
  const set = watchers.get(id) ?? new Set()
  watchers.set(id, set)
  set.add(fn)
  return () => {
    set.delete(fn)
    if (set.size === 0) watchers.delete(id)
  }
}

function tell(id: string, c: Change) {
  for (const fn of watchers.get(id) ?? []) {
    try {
      fn(c)
    } catch (err) {
      warn(id, 'a watcher of the process failed', err)
    }
  }
}

export const recordFile = (stateDir: string, id: string) => join(stateDir, 'processes', `${id}.json`)
export const eventsFile = (stateDir: string, id: string) => join(stateDir, 'processes', `${id}.events.jsonl`)
export const commandFile = (stateDir: string, id: string) => join(stateDir, 'processes', `${id}.command`)

// processId checks that an id has the shape of a process id, so no id names a file outside the
// processes.
export function processId(id: unknown): string {
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-][A-Za-z0-9._-]*$/.test(id)) throw new Refusal('id is not the id of a process; send the id the board names')
  return id
}

// readRecord answers the record of a process, or undefined when it has none. Its id is the name of its
// file, as the board reads it.
export function readRecord(stateDir: string, id: string): SessionRecord | undefined {
  const file = recordFile(stateDir, processId(id))
  if (!existsSync(file)) return undefined
  return { ...(JSON.parse(readFileSync(file, 'utf8')) as SessionRecord), id }
}

// update writes a change to a process's record and answers the record, or undefined when the process
// is gone, as after an abandon.
export function update(stateDir: string, id: string, change: Partial<CreatedRecord>): SessionRecord | undefined {
  const file = recordFile(stateDir, id)
  if (!existsSync(file)) return undefined
  const record = { ...(JSON.parse(readFileSync(file, 'utf8')) as SessionRecord), ...change, updated_at: new Date().toISOString() } as SessionRecord
  writeAtomic(file, JSON.stringify(record, null, 2) + '\n')
  tell(id, { record })
  return record
}

// forget removes a process's record, its event log and its terminal script.
export function forget(stateDir: string, id: string) {
  rmSync(eventsFile(stateDir, id), { force: true })
  rmSync(commandFile(stateDir, id), { force: true })
  rmSync(recordFile(stateDir, id), { force: true })
  tell(id, { gone: true })
}

// seen marks a process as seen, once its page is opened, and answers whether it has a record. It leaves
// the time of the record's last change alone, since the process itself did not change.
export function seen(stateDir: string, id: string): boolean {
  const file = recordFile(stateDir, processId(id))
  if (!existsSync(file)) return false
  const record = JSON.parse(readFileSync(file, 'utf8')) as SessionRecord
  if (record.unseen) {
    const marked = { ...record, unseen: false }
    writeAtomic(file, JSON.stringify(marked, null, 2) + '\n')
    tell(id, { record: marked })
  }
  return true
}

// An end is written into the log before the record takes the state it ends in, and a record goes after
// its log: whoever reads a record's state, as the board does, then finds the log that led to it complete.
export function event(stateDir: string, id: string, e: Record<string, unknown>) {
  if (!existsSync(recordFile(stateDir, id))) return
  const line = { at: new Date().toISOString(), ...e }
  appendFileSync(eventsFile(stateDir, id), JSON.stringify(line) + '\n')
  tell(id, { event: line })
}

// attempt adds an attempt to a work or hunt process's history and answers the record, or undefined when
// the process is gone.
export function attempt(stateDir: string, id: string, a: Attempt, change: Partial<StageRecord> = {}): StageRecord | undefined {
  const now = readRecord(stateDir, id)
  if (!now || now.kind === 'plan' || now.kind === 'standardize') return undefined
  return update(stateDir, id, { ...change, history: [...(now.history ?? []), a] } as unknown as Partial<CreatedRecord>) as StageRecord | undefined
}

// warn tells the controller's own stderr what a process could not write, as the record cannot hold it.
const warn = (id: string, what: string, err: unknown) => process.stderr.write(`warning: ${id}: ${what}: ${(err as Error).message}\n`)
