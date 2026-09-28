import { useEffect, useState } from "react"

// The page lives in the URL's fragment, which the browser keeps to itself: the controller serves the
// same files for every page, and a reload or a link opens the page it names. No fragment is the
// Orchestrator page; #project=<path> is the page of the project at that checkout, #process=<id> the page
// of the process with that id.
export type Route = { page: "orchestrator" } | { page: "project"; path: string } | { page: "process"; id: string }

export function parse(hash: string): Route {
  const q = new URLSearchParams(hash.slice(1))
  const path = q.get("project")
  const id = q.get("process")
  return path ? { page: "project", path } : id ? { page: "process", id } : { page: "orchestrator" }
}

export function href(route: Route): string {
  if (route.page === "project") return "#" + new URLSearchParams({ project: route.path }).toString()
  if (route.page === "process") return "#" + new URLSearchParams({ process: route.id }).toString()
  return "#"
}

export function useRoute(): Route {
  const [hash, setHash] = useState(location.hash)
  useEffect(() => {
    const changed = () => setHash(location.hash)
    addEventListener("hashchange", changed)
    return () => removeEventListener("hashchange", changed)
  }, [])
  return parse(hash)
}
