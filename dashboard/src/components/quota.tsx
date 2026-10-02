import { type Quota, type QuotaScope, type QuotaWindow, runtimeName, until } from "@/api"
import { cn } from "@/lib/utils"

// windowName is how the dashboard names a window quota-axi reports: the five-hour session window, and the
// weekly window, which Claude names seven_day and Codex weekly.
const windowName = (id: string) => ({ five_hour: "5-hour", seven_day: "Weekly", weekly: "Weekly" })[id] ?? id

// QuotaBars is the quota of each runtime the controller reads: the runtime's name and under it a bar per
// window, five-hour, weekly and Claude's Fable scope, of what is left and when it resets. A runtime below
// the configured minimum is marked, and one quota-axi could not read says unknown with the reason on
// hover. A quota check switched off says so in place of the bars.
export function QuotaBars({ quota }: { quota: Quota }) {
  if (quota.state === "loading") return <p className="text-muted-foreground">Reading</p>
  if (quota.state === "failed") return <p className="text-destructive">{quota.error}</p>
  if (quota.off) return <p className="text-muted-foreground">Off: no quota_axi is configured</p>
  return (
    <ul aria-label="Quota" className="flex flex-col gap-3">
      {quota.runtimes.map((r) => (
        <li key={r.runtime} aria-label={runtimeName(r.runtime)} data-below={r.below} className="grid gap-1.5">
          <div className="flex items-baseline justify-between gap-2">
            <span className={cn("font-medium text-sidebar-foreground", r.below && "text-destructive")}>{runtimeName(r.runtime)}</span>
            {!r.known ? (
              <span title={r.reason}>unknown</span>
            ) : (
              r.below && <span className="font-medium text-destructive">below {quota.minimum}%</span>
            )}
          </div>
          {r.known && (r.windows.length > 0 || r.fable) && (
            <ul aria-label={`${runtimeName(r.runtime)} windows`} className="grid gap-1.5">
              {r.windows.map((w) => (
                <Bar key={w.id} name={windowName(w.id)} scope={w} below={r.below} />
              ))}
              {r.fable && <Bar name="Fable" scope={r.fable} below={r.below} />}
            </ul>
          )}
        </li>
      ))}
    </ul>
  )
}

// Bar is one window or model scope under a runtime: its name, the percentage left over a bar of it where
// quota-axi reports one, and its reset. A scope quota-axi does not know says unknown with the reason on
// hover.
function Bar({ name, scope, below }: { name: string; scope: QuotaWindow | QuotaScope; below: boolean }) {
  if ("known" in scope && !scope.known)
    return (
      <li aria-label={name} className="flex items-baseline justify-between gap-2">
        <span>{name}</span>
        <span title={scope.reason}>unknown</span>
      </li>
    )
  const { remaining, reset } = scope
  return (
    <li aria-label={name} className="grid gap-1">
      <div className="flex items-baseline justify-between gap-2">
        <span>{name}</span>
        <span className="tabular-nums">
          {remaining !== null ? `${Math.round(remaining)}%` : ""}
          {remaining !== null && reset ? " · " : ""}
          {reset ? <span title={new Date(reset).toLocaleString()}>resets in {until(reset)}</span> : remaining === null ? "no reset named" : ""}
        </span>
      </div>
      {remaining !== null && (
        <div role="meter" aria-label={`${name} left`} aria-valuenow={Math.round(remaining)} aria-valuemin={0} aria-valuemax={100} className="h-1.5 overflow-hidden rounded-full bg-sidebar-accent">
          <div className={cn("h-full rounded-full", below ? "bg-destructive" : "bg-primary")} style={{ width: `${Math.max(0, Math.min(100, remaining))}%` }} />
        </div>
      )}
    </li>
  )
}
