import type { ReactNode } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Empty, EmptyDescription, EmptyHeader } from "@/components/ui/empty"
import { Skeleton } from "@/components/ui/skeleton"

// Section is a card of rows under a title with their count, or the sentence it says when it has none.
// While its rows are loading it shows placeholders and no count, so it never claims to be empty.
export function Section({
  title,
  count,
  empty,
  loading = false,
  children,
}: {
  title: string
  count: number
  empty: string
  loading?: boolean
  children?: ReactNode
}) {
  return (
    <Card aria-label={title}>
      <CardHeader>
        <CardTitle className="flex items-baseline gap-2">
          {title}
          {!loading && <span className="text-sm font-normal text-muted-foreground">{count}</span>}
        </CardTitle>
      </CardHeader>
      <CardContent>
        {loading ? (
          <div className="flex flex-col gap-2" aria-busy="true">
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-2/3" />
          </div>
        ) : count ? (
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
