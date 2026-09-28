import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Empty, EmptyDescription, EmptyHeader } from "@/components/ui/empty"
import { ItemGroup } from "@/components/ui/item"

export function Section({ title, count, empty, children }: { title: string; count: number; empty: string; children: React.ReactNode }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-baseline gap-2">{title}<span className="text-sm font-normal text-muted-foreground">{count}</span></CardTitle>
      </CardHeader>
      <CardContent>
        {count
          ? <ItemGroup className="gap-2">{children}</ItemGroup>
          : <Empty className="py-6"><EmptyHeader><EmptyDescription>{empty}</EmptyDescription></EmptyHeader></Empty>}
      </CardContent>
    </Card>
  )
}
