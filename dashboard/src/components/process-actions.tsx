import { XIcon } from "lucide-react"
import { type FormEvent, useState } from "react"
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
import { abandon, claim, type Issue } from "@/api"
import { cn } from "@/lib/utils"

// Force lifts what the controller refuses, and says so in the dialog that asks for it.
function Force({ id, checked, onChange, children }: { id: string; checked: boolean; onChange: (v: boolean) => void; children: string }) {
  return (
    <div className="flex items-start gap-2">
      <input id={id} type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="mt-0.5 size-4 accent-primary" />
      <Label htmlFor={id} className="font-normal leading-snug">{children}</Label>
    </div>
  )
}

function Refused({ id, error }: { id: string; error: string }) {
  if (!error) return null
  return (
    <p id={id} role="alert" className="text-sm text-destructive">
      {error}
    </p>
  )
}

// Claim takes an issue of the frontier into a work process of the project at path. The dialog asks
// for the mode and the worker knobs the process overrides, one NAME=VALUE per line. The controller
// refuses what it will not claim, and its reason is shown in the dialog. The warnings of a claim that
// went through stay in the dialog until it is closed.
export function Claim({ i, path, reload }: { i: Issue; path: string; reload: () => Promise<void> }) {
  const [open, setOpen] = useState(false)
  const [mode, setMode] = useState<"manual" | "yolo">("manual")
  const [knobs, setKnobs] = useState("")
  const [force, setForce] = useState(false)
  const [error, setError] = useState("")
  const [claiming, setClaiming] = useState(false)
  // warnings are what a claim that went through lifted with force or could not check.
  const [warnings, setWarnings] = useState<string[]>([])
  const id = `claim-${i.number}`

  const change = (next: boolean) => {
    // The board is read again once the warnings are closed: it drops this row, and the dialog with it.
    if (!next && warnings.length > 0) void reload()
    setOpen(next)
    setMode("manual")
    setKnobs("")
    setForce(false)
    setError("")
    setWarnings([])
  }

  async function submit(e: FormEvent) {
    e.preventDefault()
    setClaiming(true)
    try {
      const env = knobs.split("\n").map((l) => l.trim()).filter((l) => l !== "")
      const done = await claim(path, i.number, mode, env, force)
      // A claim with warnings keeps the dialog open, so they are read before it closes.
      if (done.warnings.length > 0) {
        setError("")
        setWarnings(done.warnings)
      } else {
        await reload()
        change(false)
      }
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
          <Refused id={`${id}-error`} error={error} />
          {warnings.length > 0 && (
            <ul role="status" aria-label="Warnings" className="grid gap-1 text-sm text-amber-700 dark:text-amber-400">
              {warnings.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          )}
          <DialogFooter>
            {warnings.length > 0 ? (
              <DialogClose asChild>
                <Button type="button">Done</Button>
              </DialogClose>
            ) : (
              <>
                <DialogClose asChild>
                  <Button type="button" variant="outline">Cancel</Button>
                </DialogClose>
                <Button type="submit" disabled={claiming}>Claim</Button>
              </>
            )}
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
