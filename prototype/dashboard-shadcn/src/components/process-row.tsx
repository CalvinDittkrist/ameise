import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Item, ItemActions, ItemContent, ItemDescription, ItemMedia, ItemTitle } from "@/components/ui/item"
import { dotClass, go, primary, type Row } from "@/data"
import { cn } from "@/lib/utils"

export function ProcessRow({ x, withProject = true }: { x: Row; withProject?: boolean }) {
  const p = primary(x)
  return (
    <Item variant="outline" size="sm" className="cursor-pointer hover:bg-muted/50" onClick={() => go({ view: "process", process: x.id })}>
      <ItemMedia><span className={cn("size-2.5 rounded-full", dotClass[x.state], x.state === "running" && "animate-pulse")} /></ItemMedia>
      <ItemContent>
        <ItemTitle className="gap-2">
          {withProject && <span className="text-muted-foreground">{x.project.name}</span>}
          <span>{x.issue && <span className="font-semibold">#{x.issue} </span>}{x.title}</span>
        </ItemTitle>
        <ItemDescription>{x.note}</ItemDescription>
      </ItemContent>
      <ItemActions className="gap-3">
        <Badge variant={x.state === "running" ? "default" : "secondary"}>{x.stage}</Badge>
        <span className="w-8 text-right text-xs tabular-nums text-muted-foreground">{x.since}</span>
        {p
          ? <Button size="sm" onClick={(e) => e.stopPropagation()}>{p}</Button>
          : <Button size="sm" variant="ghost" onClick={(e) => e.stopPropagation()}>Open</Button>}
      </ItemActions>
    </Item>
  )
}
