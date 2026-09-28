import { useCallback, useEffect, useState } from "react"

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
// request. needs says it waits for a person, action names what answers it.
export type Process = {
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
// worker knobs it overrides, each NAME=VALUE. It answers the warnings of what force lifted, or throws
// the controller's reason for refusing it.
export const claim = (path: string, issue: number, mode: "manual" | "yolo", env: string[], force: boolean) =>
  call<{ warnings: string[] }>("POST", "/api/processes", { project: path, issue, mode, env, force })

// abandon removes the worktree and the process of the issue, or throws the controller's reason.
export const abandon = (path: string, issue: number, force: boolean) =>
  call<{ branch: string }>("DELETE", "/api/processes", { project: path, issue, force })

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
