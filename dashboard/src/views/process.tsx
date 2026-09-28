import { useEffect } from "react"
import { Badge } from "@/components/ui/badge"
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty"
import { age, broken, type Board, type ProjectBoard, seen } from "@/api"
import { href } from "@/route"

// The process page: the facts of one process. Opening it marks the process seen, which clears the badge
// it carries on the board and on the Orchestrator entry since it turned blocked, ready or failed.
export function ProcessView({ id, board, reload }: { id: string; board: Board; reload: () => Promise<void> }) {
  const found =
    board.state === "loaded"
      ? board.projects.flatMap((b) => (broken(b) ? [] : b.processes.filter((p) => p.id === id).map((p) => ({ p, b: b as ProjectBoard }))))[0]
      : undefined
  const unseen = found?.p.unseen === true
  // A mark that fails, as while the controller restarts, is tried again until it lands or the page closes.
  useEffect(() => {
    if (!unseen) return
    let live = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const mark = () =>
      void seen(id).then(reload, () => {
        if (live) timer = setTimeout(mark, 5000)
      })
    mark()
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [id, unseen, reload])
  if (board.state === "loading") return null
  if (board.state === "failed") return <p role="alert" className="text-sm text-destructive">{board.error}</p>
  if (!found) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyTitle>No such process</EmptyTitle>
          <EmptyDescription>{id} is not a process of this machine.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    )
  }
  const { p, b } = found
  return (
    <>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <h1 className="text-xl font-semibold break-all">{p.issue !== null ? `#${p.issue} ` : ""}{p.branch}</h1>
        <a href={href({ page: "project", path: b.path })} className="text-sm text-muted-foreground hover:underline">
          {b.owner}/{b.name}
        </a>
      </div>
      <dl aria-label="Facts" className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
        <dt className="text-muted-foreground">State</dt>
        <dd>{p.state}</dd>
        <dt className="text-muted-foreground">Stage</dt>
        <dd><Badge variant="secondary">{p.stage}</Badge></dd>
        <dt className="text-muted-foreground">Since</dt>
        <dd>{age(p.since)}</dd>
        <dt className="text-muted-foreground">Note</dt>
        <dd>{p.note}</dd>
        {p.pr && (
          <>
            <dt className="text-muted-foreground">Pull request</dt>
            <dd><a href={p.pr.url} className="hover:underline">#{p.pr.number}</a> {p.checks && `checks ${p.checks}`}</dd>
          </>
        )}
      </dl>
    </>
  )
}
