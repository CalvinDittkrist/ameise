import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Item, ItemActions, ItemContent, ItemDescription, ItemMedia, ItemTitle } from "@/components/ui/item"
import { Abandon, Claim, ProcessAction } from "@/components/process-actions"
import { Accept, Merge, PlanIssue } from "@/components/actions"
import { age, type Issue, type Process, type ProjectBoard } from "@/api"
import { cn } from "@/lib/utils"
import { href } from "@/route"

// dot is the colour of a process's state, on its row and on its page.
export const dot: Record<Process["state"], string> = {
  running: "bg-blue-500",
  waiting: "bg-amber-500",
  blocked: "bg-red-500",
  approval: "bg-amber-500",
  input: "bg-violet-500",
  ready: "bg-emerald-500",
  failed: "bg-red-700",
  created: "border-2 border-blue-500",
  interrupted: "bg-orange-500",
  done: "bg-muted-foreground",
  foreign: "border-2 border-dashed border-muted-foreground",
}

// The controller carries out claim, abandon, resume, adopt, merge, plan, a hunt and the start of an
// acceptance. A permission, a question, a blocked session and a failed one are answered or read on the
// process's page, which their actions open, and so are the finish of a hunt that removed nothing and the
// answers and the finalize of a standardize process. It does not serve any other action yet, so a row
// shows those disabled.
const opens = ["Answer", "Approve", "Continue", "Open", "Finish", "Finalize"]

// ProcessRow is one process of the project at path: its state as a dot, its issue and branch, the note,
// the stage and the time since it last changed. It shows the one action that moves it on, and a work
// process the action that abandons it. Its branch opens its page, and a badge says it turned blocked,
// ready or failed since that page was last opened.
export function ProcessRow({ p, project, path, reload }: { p: Process; project?: ProjectBoard; path: string; reload: () => Promise<void> }) {
  return (
    <Item variant="outline" size="sm" aria-label={p.branch}>
      <ItemMedia>
        <span className={cn("size-2.5 rounded-full", dot[p.state])} title={p.state} />
      </ItemMedia>
      <ItemContent className="min-w-0">
        <ItemTitle className="flex-wrap gap-x-2 gap-y-0">
          {project && <span className="text-muted-foreground">{project.name}</span>}
          {p.issue !== null && <span className="font-semibold">#{p.issue}</span>}
          {p.id !== null ? (
            <a href={href({ page: "process", id: p.id })} className="break-all hover:underline">{p.branch}</a>
          ) : (
            <span className="break-all">{p.branch}</span>
          )}
          {p.unseen && <Badge variant="destructive">new</Badge>}
        </ItemTitle>
        <ItemDescription>{p.note}</ItemDescription>
      </ItemContent>
      <ItemActions className="gap-3">
        <Badge variant={p.state === "running" ? "default" : "secondary"}>{p.stage}</Badge>
        <span data-slot="age" className="w-8 text-right text-xs tabular-nums text-muted-foreground">
          {age(p.since)}
        </span>
        {p.action === "Merge" && p.pr ? (
          <Merge p={{ ...p, pr: p.pr }} path={path} reload={reload} />
        ) : opens.includes(p.action) ? (
          <Button
            size="sm"
            variant={p.needs ? "default" : "ghost"}
            disabled={p.id === null}
            onClick={() => p.id !== null && (location.hash = href({ page: "process", id: p.id }))}
          >
            {p.action}
          </Button>
        ) : (
          <ProcessAction p={p} path={path} reload={reload} />
        )}
        {p.kind === "work" && p.issue !== null && <Abandon issue={p.issue} branch={p.branch} path={path} reload={reload} />}
      </ItemActions>
    </Item>
  )
}

// IssueRow is an issue of the frontier of the project at path, which a claim starts, or a spec whose
// tickets are all closed, which waits for its acceptance.
export function IssueRow({
  i,
  project,
  accept,
  path,
  reload,
}: {
  i: Issue
  project?: ProjectBoard
  accept?: boolean
  path: string
  reload: () => Promise<void>
}) {
  return (
    <Item variant="outline" size="sm" aria-label={`#${i.number}`}>
      <ItemMedia>
        <span className={cn("size-2.5 rounded-full", accept ? "bg-emerald-500" : "border-2 border-muted-foreground/40")} />
      </ItemMedia>
      <ItemContent className="min-w-0">
        <ItemTitle className="flex-wrap gap-x-2 gap-y-0">
          {project && <span className="text-muted-foreground">{project.name}</span>}
          <span className="font-semibold">#{i.number}</span>
          <span>{i.title}</span>
        </ItemTitle>
        {accept && <ItemDescription>Every ticket is closed</ItemDescription>}
      </ItemContent>
      <ItemActions className="gap-3">
        {i.milestone && <Badge variant="outline">{i.milestone}</Badge>}
        {accept ? (
          <Accept i={i} path={path} reload={reload} />
        ) : (
          <>
            <Claim i={i} path={path} reload={reload} />
            <PlanIssue i={i} path={path} />
          </>
        )}
      </ItemActions>
    </Item>
  )
}

// Notes are what GitHub did not answer for a project, so an empty section reads as unknown.
export function Notes({ boards }: { boards: ProjectBoard[] }) {
  const notes = boards.flatMap((b) => b.notes.map((n) => `${b.name}: ${n}`))
  if (notes.length === 0) return null
  return (
    <ul aria-label="Notes" className="flex flex-col gap-1 text-sm text-muted-foreground">
      {notes.map((n) => (
        <li key={n}>{n}</li>
      ))}
    </ul>
  )
}
