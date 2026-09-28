import { type Quota, runtimeName, until } from "@/api"
import { cn } from "@/lib/utils"

// QuotaBars is the quota of every runtime a process spends: a bar of what is left and when it resets. A
// runtime below the configured minimum is marked, and one quota-axi could not read says unknown with
// the reason on hover.
export function QuotaBars({ quota }: { quota: Quota }) {
  if (quota.state === "loading") return <p className="text-muted-foreground">Reading</p>
  if (quota.state === "failed") return <p className="text-destructive">{quota.error}</p>
  return (
    <ul aria-label="Quota" className="flex flex-col gap-3">
      {quota.runtimes.map((r) => (
        <li key={r.runtime} aria-label={runtimeName(r.runtime)} data-below={r.below} className="grid gap-1">
          <div className="flex items-baseline justify-between gap-2">
            <span className="font-medium text-sidebar-foreground">{runtimeName(r.runtime)}</span>
            {r.known ? (
              <span className={cn("tabular-nums", r.below && "font-medium text-destructive")}>{Math.round(r.remaining)}%</span>
            ) : (
              <span title={r.reason}>unknown</span>
            )}
          </div>
          {r.known && (
            <>
              <div className="h-1.5 overflow-hidden rounded-full bg-sidebar-accent">
                <div className={cn("h-full rounded-full", r.below ? "bg-destructive" : "bg-primary")} style={{ width: `${Math.max(0, Math.min(100, r.remaining))}%` }} />
              </div>
              <span className={cn(r.below && "text-destructive")}>
                {r.below ? `below ${quota.minimum}%` : ""}
                {r.below && r.reset ? " · " : ""}
                {r.reset ? <span title={new Date(r.reset).toLocaleString()}>resets in {until(r.reset)}</span> : r.below ? "" : "no reset named"}
              </span>
            </>
          )}
        </li>
      ))}
    </ul>
  )
}
