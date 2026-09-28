import type { ReactNode } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Empty, EmptyDescription, EmptyHeader } from "@/components/ui/empty"

// Section is a card of rows under a title with their count, or the sentence it says when it has none.
export function Section({ title, count, empty, children }: { title: string; count: number; empty: string; children?: ReactNode }) {
  return (
    <Card aria-label={title}>
      <CardHeader>
        <CardTitle className="flex items-baseline gap-2">
          {title}
          <span className="text-sm font-normal text-muted-foreground">{count}</span>
        </CardTitle>
      </CardHeader>
      <CardContent>
        {count ? (
          <div className="flex flex-col gap-2">{children}</div>
        ) : (
          <Empty className="py-6">
            <EmptyHeader>
              <EmptyDescription>{empty}</EmptyDescription>
            </EmptyHeader>
          </Empty>
        )}
      </CardContent>
    </Card>
  )
}
