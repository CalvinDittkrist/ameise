import { type Quota, type QuotaScope, type QuotaWindow, runtimeName, until } from "@/api"
import { cn } from "@/lib/utils"

// windowName is how the dashboard names a window quota-axi reports: the five-hour session window, and the
// weekly window, which Claude names seven_day and Codex weekly.
const windowName = (id: string) => ({ five_hour: "5-hour", seven_day: "Weekly", weekly: "Weekly" })[id] ?? id

// QuotaBars is the quota of each runtime the controller reads: a bar of what is left and when it resets. A
// runtime below the configured minimum is marked, and one quota-axi could not read says unknown with
// the reason on hover. Under the bar a row of each window and of Claude's Fable scope says what is left
// of it and when it resets. A quota check switched off says so in place of the bars.
export function QuotaBars({ quota }: { quota: Quota }) {
  if (quota.state === "loading") return <p className="text-muted-foreground">Reading</p>
  if (quota.state === "failed") return <p className="text-destructive">{quota.error}</p>
  if (quota.off) return <p className="text-muted-foreground">Off: no quota_axi is configured</p>
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
              {(r.windows.length > 0 || r.fable) && (
                <ul aria-label={`${runtimeName(r.runtime)} windows`} className="grid gap-0.5">
                  {r.windows.map((w) => (
                    <Row key={w.id} name={windowName(w.id)} scope={w} />
                  ))}
                  {r.fable && <Row name="Fable" scope={r.fable} />}
                </ul>
              )}
            </>
          )}
        </li>
      ))}
    </ul>
  )
}

// Row is one window or model scope under a runtime's bar: what is left of it where that is known, and its
// reset; a scope quota-axi does not know says unknown with the reason on hover.
function Row({ name, scope }: { name: string; scope: QuotaWindow | QuotaScope }) {
  const known = !("known" in scope) || scope.known
  const remaining = "remaining" in scope ? scope.remaining : null
  const reset = "reset" in scope ? scope.reset : null
  return (
    <li aria-label={name} className="flex items-baseline justify-between gap-2">
      <span>{name}</span>
      {known ? (
        <span className="tabular-nums">
          {remaining !== null ? `${Math.round(remaining)}%` : ""}
          {remaining !== null && reset ? " · " : ""}
          {reset ? <span title={new Date(reset).toLocaleString()}>resets in {until(reset)}</span> : remaining === null ? "no reset named" : ""}
        </span>
      ) : (
        <span title={"reason" in scope ? scope.reason : undefined}>unknown</span>
      )}
    </li>
  )
}
