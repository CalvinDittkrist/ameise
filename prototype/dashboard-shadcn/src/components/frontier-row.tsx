import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Item, ItemActions, ItemContent, ItemMedia, ItemTitle } from "@/components/ui/item"
import type { Issue, Project } from "@/data"

export function FrontierRow({ p, i, withProject }: { p: Project; i: Issue; withProject: boolean }) {
  return (
    <Item variant="outline" size="sm">
      <ItemMedia><span className="size-2.5 rounded-full border-2 border-muted-foreground/40" /></ItemMedia>
      <ItemContent>
        <ItemTitle className="gap-2">
          {withProject && <span className="text-muted-foreground">{p.name}</span>}
          <span><span className="font-semibold">#{i.n}</span> {i.title}</span>
        </ItemTitle>
      </ItemContent>
      <ItemActions className="gap-3">
        <Badge variant="outline">{i.m}</Badge>
        <Button size="sm" variant="outline">Claim</Button>
        <Button size="sm" variant="ghost">Plan</Button>
      </ItemActions>
    </Item>
  )
}
