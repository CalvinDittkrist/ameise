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

// addProject adds the checkout at an absolute path and answers the project, or throws the controller's
// reason for refusing it.
export const addProject = (path: string) => call<Listed>("POST", "/api/projects", { path })

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
