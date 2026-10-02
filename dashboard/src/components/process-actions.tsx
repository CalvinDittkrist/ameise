import { XIcon } from "lucide-react"
import { type FormEvent, useContext, useState, useSyncExternalStore } from "react"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Label } from "@/components/ui/label"
import { abandon, adopt, claim, claimed, type Issue, type Process, QuotaContext, type Reading, resume, resumeHunt, runtimeName } from "@/api"
import { Until } from "@/components/span"
import { cn } from "@/lib/utils"

// Force lifts what the controller refuses, and says so in the dialog that asks for it.
export function Force({ id, checked, onChange, children }: { id: string; checked: boolean; onChange: (v: boolean) => void; children: string }) {
  return (
    <div className="flex items-start gap-2">
      <input id={id} type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="mt-0.5 size-4 accent-primary" />
      <Label htmlFor={id} className="font-normal leading-snug">{children}</Label>
    </div>
  )
}

export function Refused({ id, error }: { id: string; error: string }) {
  if (!error) return null
  return (
    <p id={id} role="alert" className="text-sm text-destructive">
      {error}
    </p>
  )
}

// What the last action that went through has to say, until it is closed: the warnings of a claim or a
// merge, or why a release waits. It lives outside the rows, because the refresh of the board drops the
// row an action acted on.
interface Warned {
  title: string
  said: string
  warnings: string[]
}
let warned: Warned | null = null
const watchers = new Set<() => void>()
export function warn(next: Warned | null) {
  warned = next
  for (const w of watchers) w()
}
const watch = (w: () => void) => {
  watchers.add(w)
  return () => watchers.delete(w)
}

// Warnings shows what an action that went through has to say until it is closed, whatever the board
// does meanwhile. The app mounts it once.
export function Warnings() {
  const w = useSyncExternalStore(watch, () => warned)
  return (
    <Dialog open={w !== null} onOpenChange={(open) => !open && warn(null)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{w?.title}</DialogTitle>
          <DialogDescription>{w?.said}</DialogDescription>
        </DialogHeader>
        <ul role="status" aria-label="Warnings" className="grid gap-1 text-sm text-amber-700 dark:text-amber-400">
          {w?.warnings.map((x) => (
            <li key={x}>{x}</li>
          ))}
        </ul>
        <DialogFooter>
          <DialogClose asChild>
            <Button type="button">Done</Button>
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// Claim takes an issue of the frontier into a work process of the project at path. The dialog asks
// for the mode and the worker knobs the process overrides, one NAME=VALUE per line. The controller
// refuses what it will not claim, and its reason is shown in the dialog. The warnings of a claim that
// went through show in Warnings until they are closed. Claude below the minimum is a warning in the
// dialog: the claim goes on when it is confirmed, and nothing waits for the reset.
export function Claim({ i, path, reload }: { i: Issue; path: string; reload: () => Promise<void> }) {
  const quota = useContext(QuotaContext)
  const low = quota.state === "loaded" ? quota.runtimes.filter((r): r is Extract<Reading, { known: true }> => r.runtime === claimed && r.known && r.below) : []
  const [open, setOpen] = useState(false)
  const [mode, setMode] = useState<"manual" | "yolo">("manual")
  const [knobs, setKnobs] = useState("")
  const [force, setForce] = useState(false)
  const [error, setError] = useState("")
  const [claiming, setClaiming] = useState(false)
  const id = `claim-${i.number}`

  const change = (next: boolean) => {
    setOpen(next)
    setMode("manual")
    setKnobs("")
    setForce(false)
    setError("")
  }

  async function submit(e: FormEvent) {
    e.preventDefault()
    setClaiming(true)
    try {
      const env = knobs.split("\n").map((l) => l.trim()).filter((l) => l !== "")
      const done = await claim(path, i.number, mode, env, force)
      // What a claim lifted with force or could not check stays on screen until it is closed. So does a
      // quota line of a runtime the dialog did not warn of before the claim, such as one that fell below
      // the minimum since the last reading; a runtime the dialog warned of is not told again.
      const unwarned = done.quota.filter((l) => !low.some((r) => l.startsWith(`${r.runtime} `)))
      const all = [...unwarned, ...done.warnings]
      if (all.length > 0) warn({ title: `Claim #${i.number}`, said: "The claim went through with these warnings.", warnings: all })
      change(false)
      await reload()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setClaiming(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={change}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline">Claim</Button>
      </DialogTrigger>
      <DialogContent>
        <form onSubmit={submit} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>Claim #{i.number}</DialogTitle>
            <DialogDescription>{i.title}</DialogDescription>
          </DialogHeader>
          <fieldset className="grid gap-2">
            <legend className="mb-2 text-sm font-medium">Mode</legend>
            <div role="radiogroup" aria-label="Mode" className="flex gap-2">
              {(["manual", "yolo"] as const).map((m) => (
                <Button key={m} type="button" size="sm" role="radio" aria-checked={mode === m} variant={mode === m ? "default" : "outline"} onClick={() => setMode(m)}>
                  {m === "manual" ? "Manual" : "Yolo"}
                </Button>
              ))}
            </div>
            <p className="text-xs text-muted-foreground">
              {mode === "manual" ? "You merge the pull request when it is ready." : "The worker merges its own pull request when it is green."}
            </p>
          </fieldset>
          <div className="grid gap-2">
            <Label htmlFor={`${id}-knobs`}>Knobs</Label>
            <textarea
              id={`${id}-knobs`}
              value={knobs}
              onChange={(e) => setKnobs(e.target.value)}
              placeholder="WF_REVIEWERS=2"
              rows={3}
              spellCheck={false}
              aria-describedby={`${id}-knobs-hint`}
              className={cn(
                "w-full min-w-0 rounded-lg border border-input bg-transparent px-2.5 py-1.5 font-mono text-sm outline-none placeholder:text-muted-foreground",
                "focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30",
              )}
            />
            <p id={`${id}-knobs-hint`} className="text-xs text-muted-foreground">One NAME=VALUE per line; each overrides a worker knob for this process.</p>
          </div>
          <Force id={`${id}-force`} checked={force} onChange={setForce}>
            Force: claim it even when it is not agent-ready, routed, held in a spec run or claimed on origin
          </Force>
          {low.length > 0 && quota.state === "loaded" && (
            <ul role="status" aria-label="Quota" className="grid gap-1 text-sm text-amber-700 dark:text-amber-400">
              {/* The sentence of the controller's quota warning, with the reset as a time from now. */}
              {low.map((r) => (
                <li key={r.runtime}>
                  {runtimeName(r.runtime)} has {Math.round(r.remaining)}% of its quota left, below the minimum of {quota.minimum}%
                  {r.reset && <>; it resets in <Until at={r.reset} /></>}. Claim anyway?
                </li>
              ))}
            </ul>
          )}
          <Refused id={`${id}-error`} error={error} />
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline">Cancel</Button>
            </DialogClose>
            <Button type="submit" disabled={claiming}>{low.length > 0 ? "Claim anyway" : "Claim"}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

// Abandon removes the worktree and the process of an issue and leaves its branch and the issue. The
// controller refuses work that is not on origin unless forced, and its reason is shown in the dialog.
export function Abandon({ issue, branch, path, reload }: { issue: number; branch: string; path: string; reload: () => Promise<void> }) {
  const [open, setOpen] = useState(false)
  const [force, setForce] = useState(false)
  const [error, setError] = useState("")
  const [abandoning, setAbandoning] = useState(false)
  const id = `abandon-${issue}`

  const change = (next: boolean) => {
    setOpen(next)
    setForce(false)
    setError("")
  }

  async function submit(e: FormEvent) {
    e.preventDefault()
    setAbandoning(true)
    try {
      await abandon(path, issue, force)
      await reload()
      change(false)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setAbandoning(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={change}>
      <DialogTrigger asChild>
        <Button size="icon-sm" variant="ghost" aria-label={`Abandon #${issue}`} title="Abandon" className="text-muted-foreground">
          <XIcon />
        </Button>
      </DialogTrigger>
      <DialogContent>
        <form onSubmit={submit} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>Abandon #{issue}</DialogTitle>
            <DialogDescription>
              Removes the worktree and the process of {branch}. The branch and the issue stay as they are.
            </DialogDescription>
          </DialogHeader>
          <Force id={`${id}-force`} checked={force} onChange={setForce}>
            Force: abandon it even with commits not on origin or changes not committed, which are lost
          </Force>
          <Refused id={`${id}-error`} error={error} />
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline">Cancel</Button>
            </DialogClose>
            <Button type="submit" variant="destructive" disabled={abandoning}>Abandon</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

// ProcessAction is the one action that moves a process on. Resume goes on with an interrupted session, a
// hunt's by its id, and
// Adopt takes a foreign worktree into a process; the controller does not serve the others yet, so they
// are shown disabled. The controller's reason for refusing one is shown beside it.
export function ProcessAction({ p, path, reload }: { p: Process; path: string; reload: () => Promise<void> }) {
  const [error, setError] = useState("")
  const [busy, setBusy] = useState(false)
  // Adopt names the row's branch, so it takes this worktree when another names the same issue.
  const { id, issue } = p
  const act =
    p.kind === "hunt" && p.action === "Resume" && id !== null
      ? () => resumeHunt(id)
      : issue === null
        ? undefined
        : p.action === "Resume"
          ? () => resume(path, issue)
          : p.action === "Adopt"
            ? () => adopt(path, issue, p.branch)
            : undefined

  async function run() {
    if (!act) return
    setBusy(true)
    setError("")
    try {
      await act()
      await reload()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      {error && (
        <span role="alert" className="max-w-64 text-xs text-destructive">
          {error}
        </span>
      )}
      <Button size="sm" variant={p.needs ? "default" : "ghost"} disabled={!act || busy} onClick={run}>
        {p.action}
      </Button>
    </>
  )
}
