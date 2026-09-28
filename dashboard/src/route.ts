import { useEffect, useState } from "react"

// The page lives in the URL's fragment, which the browser keeps to itself: the controller serves the
// same files for every page, and a reload or a link opens the page it names. No fragment is the
// Orchestrator page; #project=<path> is the page of the project at that checkout.
export type Route = { page: "orchestrator" } | { page: "project"; path: string }

export function parse(hash: string): Route {
  const path = new URLSearchParams(hash.slice(1)).get("project")
  return path ? { page: "project", path } : { page: "orchestrator" }
}

export function href(route: Route): string {
  return route.page === "project" ? "#" + new URLSearchParams({ project: route.path }).toString() : "#"
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
