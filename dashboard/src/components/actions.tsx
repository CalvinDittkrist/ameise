import { ChevronDownIcon } from "lucide-react"
import { type FormEvent, type ReactNode, useState } from "react"
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
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Refused, warn } from "@/components/process-actions"
import { accept, type Issue, merge, type Process, release } from "@/api"

// Confirm asks once before an action changes anything: its trigger opens a dialog that says what the
// action does, and its button runs it. The controller's reason for a refusal shows in the dialog.
function Confirm({
  id,
  trigger,
  title,
  description,
  confirm,
  children,
  run,
  reset,
}: {
  id: string
  trigger: ReactNode
  title: string
  description: ReactNode
  confirm: string
  children?: ReactNode
  run: () => Promise<void>
  reset?: () => void
}) {
  const [open, setOpen] = useState(false)
  const [error, setError] = useState("")
  const [running, setRunning] = useState(false)

  const change = (next: boolean) => {
    setOpen(next)
    setError("")
    reset?.()
  }

  async function submit(e: FormEvent) {
    e.preventDefault()
    setRunning(true)
    try {
      await run()
      change(false)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setRunning(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={change}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent>
        <form onSubmit={submit} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>{description}</DialogDescription>
          </DialogHeader>
          {children}
          <Refused id={`${id}-error`} error={error} />
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline">Cancel</Button>
            </DialogClose>
            <Button type="submit" disabled={running}>{confirm}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

// Merge takes the ready pull request of a process into its base and removes its branch, worktree and
// process. What the merge warns of stays on screen until it is closed.
export function Merge({ p, path, reload }: { p: Process & { pr: NonNullable<Process["pr"]> }; path: string; reload: () => Promise<void> }) {
  const n = p.pr.number
  return (
    <Confirm
      id={`merge-${n}`}
      trigger={<Button size="sm">Merge</Button>}
      title={`Merge PR #${n}`}
      description={`Merges PR #${n} into its base, deletes ${p.branch} and removes its worktree and process. A merge outside the default branch closes the issue.`}
      confirm="Merge"
      run={async () => {
        const done = await merge(path, n)
        if (done.warnings.length > 0) warn({ title: `Merge PR #${n}`, said: "The merge went through with these warnings.", warnings: done.warnings })
        await reload()
      }}
    />
  )
}

// Accept opens a plan process on a spec whose tickets are all closed, with the acceptance route.
export function Accept({ i, path, reload }: { i: Issue; path: string; reload: () => Promise<void> }) {
  return (
    <Confirm
      id={`accept-${i.number}`}
      trigger={<Button size="sm">Accept</Button>}
      title={`Accept #${i.number}`}
      description={`Opens a plan process on ${i.title} with the acceptance route.`}
      confirm="Start acceptance"
      run={async () => {
        await accept(path, i.number)
        await reload()
      }}
    />
  )
}

// Release tags a finished milestone of the project at path, publishes its release and closes it. With
// dev and main it merges the promotion first; while the promotion is not green, it says why it waits.
export function Release({ path, reload }: { path: string; reload: () => Promise<void> }) {
  const [milestone, setMilestone] = useState("")
  return (
    <Confirm
      id="release"
      trigger={
        <Button size="sm" variant="ghost">
          Release <ChevronDownIcon />
        </Button>
      }
      title="Release"
      description="Tags the finished milestone, publishes its release and closes the milestone. With dev and main it merges the promotion first."
      confirm="Release"
      reset={() => setMilestone("")}
      run={async () => {
        const done = await release(path, milestone.trim())
        if (done.status === "waiting") warn({ title: `Release ${done.milestone}`, said: `The promotion ${done.promotion} is not merged yet.`, warnings: [done.reason] })
        await reload()
      }}
    >
      <div className="grid gap-2">
        <Label htmlFor="release-milestone">Milestone</Label>
        <Input id="release-milestone" value={milestone} onChange={(e) => setMilestone(e.target.value)} placeholder="v1.2.3" spellCheck={false} autoComplete="off" />
      </div>
    </Confirm>
  )
}
