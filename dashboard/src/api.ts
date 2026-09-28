import { createContext, useCallback, useEffect, useState } from "react"

// A project as GET /api/projects answers it: the facts derived from its checkout, or the reason its
// checkout no longer derives.
export type Project = { path: string; owner: string; name: string; base: string }
export type Broken = { path: string; error: string }
export type Listed = Project | Broken

export const broken = (p: Listed): p is Broken => "error" in p

// label is what the sidebar and the page call a project: its name on GitHub, or the last part of its
// path when the checkout does not say.
export const label = (p: Listed) => (broken(p) ? p.path.split("/").filter(Boolean).pop() ?? p.path : p.name)

export type Projects =
  | { state: "loading" }
  | { state: "failed"; error: string }
  | { state: "loaded"; projects: Listed[] }

// useProjects reads the projects when the page opens and again whenever the window comes back into
// focus, so a project added in the CLI or by hand shows without a reload.
export function useProjects(): [Projects, () => Promise<void>] {
  const [projects, setProjects] = useState<Projects>({ state: "loading" })
  const reload = useCallback(async () => {
    try {
      setProjects({ state: "loaded", projects: await call<Listed[]>("GET", "/api/projects") })
    } catch (err) {
      setProjects({ state: "failed", error: (err as Error).message })
    }
  }, [])
  useEffect(() => {
    // The first read is started from here, and its answer lands after this effect has returned.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void reload()
    addEventListener("focus", reload)
    return () => removeEventListener("focus", reload)
  }, [reload])
  return [projects, reload]
}

// A process as the board answers it: the worktree and the record of one process, joined with its pull
// request. needs says it waits for a person, action names what answers it. id names its record, which a
// worktree without one lacks. unseen says it turned blocked, ready or failed and its page is not opened yet.
export type Process = {
  id: string | null
  kind: "work" | "plan" | "hunt" | "standardize"
  state: "blocked" | "approval" | "ready" | "input" | "failed" | "running" | "waiting" | "created"
  stage: string
  issue: number | null
  branch: string
  worktree: string | null
  pr: { number: number; url: string; draft: boolean } | null
  checks: "none" | "pending" | "pass" | "fail" | null
  since: string | null
  note: string
  needs: boolean
  action: string
  unseen: boolean
}
export type Issue = { number: number; title: string; milestone: string | null }
export type ProjectBoard = Project & { processes: Process[]; frontier: Issue[]; acceptance: Issue[]; notes: string[] }
export type BoardEntry = ProjectBoard | Broken

export type Board =
  | { state: "loading" }
  | { state: "failed"; error: string }
  | { state: "loaded"; projects: BoardEntry[] }

// useBoard reads the board of every project when the page opens, on focus and every half minute.
// The controller derives it from git and GitHub on each request.
export function useBoard(): [Board, () => Promise<void>] {
  const [board, setBoard] = useState<Board>({ state: "loading" })
  const reload = useCallback(async () => {
    try {
      setBoard({ state: "loaded", projects: (await call<{ projects: BoardEntry[] }>("GET", "/api/board")).projects })
    } catch (err) {
      setBoard({ state: "failed", error: (err as Error).message })
    }
  }, [])
  useEffect(() => {
    // The first read is started from here, and its answer lands after this effect has returned.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void reload()
    addEventListener("focus", reload)
    const timer = setInterval(reload, 30_000)
    return () => {
      removeEventListener("focus", reload)
      clearInterval(timer)
    }
  }, [reload])
  return [board, reload]
}

// A reading of a runtime's quota as GET /api/quota answers it: the percentage left and when the windows
// that limit it reset, marked below when it is under the configured minimum, or unknown with the reason.
export type Reading =
  | { runtime: string; known: true; remaining: number; reset: string | null; below: boolean }
  | { runtime: string; known: false; reason: string; below: false }
export type Quota = { state: "loading" } | { state: "failed"; error: string } | { state: "loaded"; minimum: number; runtimes: Reading[] }

// useQuota reads the quota when the page opens, on focus and every minute. The controller runs the
// configured quota-axi on each request.
export function useQuota(): Quota {
  const [quota, setQuota] = useState<Quota>({ state: "loading" })
  const reload = useCallback(async () => {
    try {
      setQuota({ state: "loaded", ...(await call<{ minimum: number; runtimes: Reading[] }>("GET", "/api/quota")) })
    } catch (err) {
      setQuota({ state: "failed", error: (err as Error).message })
    }
  }, [])
  useEffect(() => {
    // The first read is started from here, and its answer lands after this effect has returned.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void reload()
    addEventListener("focus", reload)
    const timer = setInterval(reload, 60_000)
    return () => {
      removeEventListener("focus", reload)
      clearInterval(timer)
    }
  }, [reload])
  return quota
}

// QuotaContext carries the quota to the claim dialogs, deep in the rows of the board.
export const QuotaContext = createContext<Quota>({ state: "loading" })

// runtimeName is how the dashboard names a runtime quota-axi names as a provider.
export const runtimeName = (runtime: string) => (runtime === "claude" ? "Claude" : runtime)

// until is the time to an instant, in its largest whole unit, as age tells the time since one.
export const until = (at: string, now = Date.now()) => age(new Date(now).toISOString(), Date.parse(at))

// age is the time since an instant, in its largest whole unit, as the CLI prints it.
export function age(since: string | null, now = Date.now()): string {
  const t = since === null ? NaN : Date.parse(since)
  if (Number.isNaN(t)) return "-"
  const s = Math.max(0, Math.floor((now - t) / 1000))
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m`
  if (s < 86400) return `${Math.floor(s / 3600)}h`
  return `${Math.floor(s / 86400)}d`
}

// addProject adds the checkout at an absolute path and answers the project, or throws the controller's
// reason for refusing it.
export const addProject = (path: string) => call<Listed>("POST", "/api/projects", { path })

// claim takes an issue of the project at path into a work process, in manual or yolo mode with the
// worker knobs it overrides, each NAME=VALUE. It answers the warnings of what force lifted and the
// runtimes below the quota's minimum, or throws the controller's reason for refusing it.
export const claim = (path: string, issue: number, mode: "manual" | "yolo", env: string[], force: boolean) =>
  call<{ warnings: string[]; quota: string[] }>("POST", "/api/processes", { project: path, issue, mode, env, force })

// seen marks the process with that id as seen, which clears its badge.
export const seen = (id: string) => call<{ id: string }>("POST", "/api/processes/seen", { id })

// abandon removes the worktree and the process of the issue, or throws the controller's reason.
export const abandon = (path: string, issue: number, force: boolean) =>
  call<{ branch: string }>("DELETE", "/api/processes", { project: path, issue, force })

// A question of the session with the options it offers, and an entry of a process's conversation as the
// controller derives it from the event log: seq is the line of the log it comes from.
export type Question = { question: string; header: string; options: { label: string; description: string }[]; multiSelect: boolean }
export type Answer = "once" | "process" | "deny"
export type Entry = { seq: number } & (
  | { kind: "text"; text: string }
  | { kind: "tool"; name: string; detail: string }
  | { kind: "you"; text: string }
  | { kind: "permission"; request: string; tool: string; detail: string; title: string; reason: string }
  | { kind: "question"; request: string; questions: Question[] }
  | { kind: "answer"; request: string; answer?: Answer; text?: string }
  | { kind: "allowed"; tool: string; detail: string }
  | { kind: "closed"; request: string }
  | { kind: "start"; resumed: boolean }
  | { kind: "end"; state: string; note: string }
)

// A process record as the controller keeps it, with the context size at which its session compacts.
export type ProcessRecord = {
  id: string
  project: string
  branch: string
  issue: number
  mode: "manual" | "yolo"
  stage: string
  state: Process["state"]
  note: string
  session_id?: string
  context?: number
  compact_at: number
  unseen?: boolean
  updated_at: string
}

// Followed is a process page's view of its process: the record and the conversation, live while the
// connection holds and kept as they were while it reconnects.
export type Followed =
  | { state: "loading" }
  | { state: "gone" }
  | { state: "failed"; error: string }
  | { state: "live" | "reconnecting"; record: ProcessRecord; entries: Entry[] }

// useProcess follows a process over the controller's stream of its events: the record and the
// conversation so far when it connects, then every change. The browser reconnects a stream that breaks,
// and each connection starts with the whole conversation again.
export function useProcess(id: string): Followed {
  const [followed, setFollowed] = useState<Followed>({ state: "loading" })
  useEffect(() => {
    const source = new EventSource(`/api/processes/events?${new URLSearchParams({ id }).toString()}`)
    let record: ProcessRecord | undefined
    let entries: Entry[] = []
    let fresh = true
    const show = () => record && setFollowed({ state: "live", record, entries })
    source.addEventListener("open", () => (fresh = true))
    source.addEventListener("record", (e) => {
      record = JSON.parse(e.data) as ProcessRecord
      show()
    })
    source.addEventListener("entries", (e) => {
      const more = JSON.parse(e.data) as Entry[]
      entries = fresh ? more : [...entries, ...more]
      fresh = false
      show()
    })
    source.addEventListener("gone", () => {
      source.close()
      setFollowed({ state: "gone" })
    })
    source.addEventListener("error", () => {
      // A stream the controller refused, as for a process it does not know, is closed for good.
      if (source.readyState === EventSource.CLOSED) setFollowed({ state: "failed", error: `${id} is not a process of this machine, or the controller does not answer` })
      else if (record) setFollowed({ state: "reconnecting", record, entries })
    })
    return () => source.close()
  }, [id])
  return followed
}

// say writes a message to the process's session: the answer to its question, its next turn, or the turn
// that resumes it.
export const say = (id: string, text: string) => call<{ delivered: "answered" | "sent" | "resumed" }>("POST", "/api/processes/message", { id, text })

// answer answers a permission request of the process's session.
export const answer = (id: string, request: string, a: Answer) => call<{ answer: Answer }>("POST", "/api/processes/answer", { id, request, answer: a })

// openTerminal opens the process's session in a terminal window of this machine.
export const openTerminal = (id: string) => call<{ script: string }>("POST", "/api/processes/terminal", { id })

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response
  try {
    res = await fetch(path, {
      method,
      headers: body === undefined ? {} : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  } catch {
    throw new Error("the controller does not answer; start it with workflows")
  }
  const answer = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(answer.error ?? `${method} ${path} answered ${res.status}`)
  return answer as T
}
