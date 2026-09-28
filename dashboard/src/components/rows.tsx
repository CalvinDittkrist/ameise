import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Item, ItemActions, ItemContent, ItemDescription, ItemMedia, ItemTitle } from "@/components/ui/item"
import { age, type Issue, type Process, type ProjectBoard } from "@/api"
import { cn } from "@/lib/utils"

const dot: Record<Process["state"], string> = {
  running: "bg-blue-500",
  waiting: "bg-amber-500",
  blocked: "bg-red-500",
  approval: "bg-amber-500",
  input: "bg-violet-500",
  ready: "bg-emerald-500",
}

// The actions are the controller's to carry out, and it serves none yet, so each row shows its one
// primary action disabled.

// ProcessRow is one process: its state as a dot, its issue and branch, the note, the stage and the
// time since it last changed. It shows the one action that moves it on.
export function ProcessRow({ p, project }: { p: Process; project?: ProjectBoard }) {
  return (
    <Item variant="outline" size="sm" aria-label={p.branch}>
      <ItemMedia>
        <span className={cn("size-2.5 rounded-full", dot[p.state])} title={p.state} />
      </ItemMedia>
      <ItemContent className="min-w-0">
        <ItemTitle className="flex-wrap gap-x-2 gap-y-0">
          {project && <span className="text-muted-foreground">{project.name}</span>}
          {p.issue !== null && <span className="font-semibold">#{p.issue}</span>}
          <span className="break-all">{p.branch}</span>
        </ItemTitle>
        <ItemDescription>{p.note}</ItemDescription>
      </ItemContent>
      <ItemActions className="gap-3">
        <Badge variant={p.state === "running" ? "default" : "secondary"}>{p.stage}</Badge>
        <span data-slot="age" className="w-8 text-right text-xs tabular-nums text-muted-foreground">
          {age(p.since)}
        </span>
        <Button size="sm" variant={p.needs ? "default" : "ghost"} disabled>
          {p.action}
        </Button>
      </ItemActions>
    </Item>
  )
}

// IssueRow is an issue of the frontier, which a claim starts, or a spec whose tickets are all closed,
// which waits for its acceptance.
export function IssueRow({ i, project, accept }: { i: Issue; project?: ProjectBoard; accept?: boolean }) {
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
          <Button size="sm" disabled>Accept</Button>
        ) : (
          <>
            <Button size="sm" variant="outline" disabled>Claim</Button>
            <Button size="sm" variant="ghost" disabled>Plan</Button>
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
