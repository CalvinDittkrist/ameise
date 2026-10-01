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
import { Textarea } from "@/components/ui/textarea"
import { Force, Refused, warn } from "@/components/process-actions"
import { accept, capture, finish, hunt, type Issue, merge, plan, type Process, release, standardize } from "@/api"
import { href } from "@/route"

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

// Accept starts the acceptance of a spec whose tickets are all closed, in a plan process whose page shows
// the checker's items.
export function Accept({ i, path, reload }: { i: Issue; path: string; reload: () => Promise<void> }) {
  return (
    <Confirm
      id={`accept-${i.number}`}
      trigger={<Button size="sm">Accept</Button>}
      title={`Accept #${i.number}`}
      description={`Gathers the facts of ${i.title}, runs the spec checker read-only and shows its items in a plan process.`}
      confirm="Start acceptance"
      run={async () => {
        await accept(path, i.number)
        await reload()
      }}
    />
  )
}

// Plan opens a plan process in the project at path from an idea, or an open session without one, and
// opens its page, where the planner's session runs.
export function Plan({ path }: { path: string }) {
  const [idea, setIdea] = useState("")
  return (
    <Confirm
      id="plan"
      trigger={<Button size="sm" variant="outline">Plan</Button>}
      title="Plan"
      description="Opens a planning session on a plan branch of its own. Without an idea it is an open session that answers questions about the code and the design."
      confirm="Start planning"
      reset={() => setIdea("")}
      run={async () => {
        const text = idea.trim()
        const done = await plan(path, text ? { idea: text } : {})
        location.hash = href({ page: "process", id: done.record.id })
      }}
    >
      <div className="grid gap-2">
        <Label htmlFor="plan-idea">Idea</Label>
        <Textarea id="plan-idea" value={idea} onChange={(e) => setIdea(e.target.value)} placeholder="Leave it empty for an open session" rows={3} />
      </div>
    </Confirm>
  )
}

// PlanIssue opens a plan process on an issue of the frontier and opens its page.
export function PlanIssue({ i, path }: { i: Issue; path: string }) {
  return (
    <Confirm
      id={`plan-${i.number}`}
      trigger={<Button size="sm" variant="ghost">Plan</Button>}
      title={`Plan #${i.number}`}
      description={`Opens a planning session on ${i.title}, on a plan branch of its own.`}
      confirm="Start planning"
      run={async () => {
        const done = await plan(path, { issue: i.number })
        location.hash = href({ page: "process", id: done.record.id })
      }}
    />
  )
}

// Capture moves the prototype the planner left in a plan's worktree to a pushed prototype branch, so
// the plan branch stays clean. Where it went stays on screen until it is closed.
export function Capture({ id }: { id: string }) {
  const [name, setName] = useState("")
  return (
    <Confirm
      id="capture"
      trigger={<Button size="sm" variant="outline">Capture prototype</Button>}
      title="Capture prototype"
      description="Moves every change in the worktree to a prototype branch of its own and pushes it. The plan branch stays clean."
      confirm="Capture"
      reset={() => setName("")}
      run={async () => {
        const done = await capture(id, name)
        warn({ title: "Prototype captured", said: `The prototype is on ${done.branch}. Link it from the issue.`, warnings: [done.url] })
      }}
    >
      <div className="grid gap-2">
        <Label htmlFor="capture-name">Name</Label>
        <Input id="capture-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="state machine" spellCheck={false} autoComplete="off" />
      </div>
    </Confirm>
  )
}

// Finish ends a plan, a hunt or a standardisation: it stops its session and removes its worktree, its
// branch and its process, then opens the page of its project.
export function Finish({ id, project, kind = "plan" }: { id: string; project: string; kind?: "plan" | "hunt" | "standardize" }) {
  const [force, setForce] = useState(false)
  return (
    <Confirm
      id="finish"
      trigger={<Button size="sm" variant="outline">Finish</Button>}
      title="Finish"
      description={
        kind === "hunt"
          ? "Stops the hunt session and removes the worktree, the hunt branch and the process."
          : kind === "standardize"
            ? "Stops the standardisation and removes its worktree, its local branch and the process. The tag pre-standard, the cleanup pull request and the catalogue issue stay."
            : "Stops the planner session and removes the worktree, the plan branch and the process. The issues it wrote and the prototype branches stay."
      }
      confirm="Finish"
      reset={() => setForce(false)}
      run={async () => {
        await finish(id, force)
        location.hash = href({ page: "project", path: project })
      }}
    >
      <Force id="finish-force" checked={force} onChange={setForce}>
        {kind === "plan"
          ? "Force: finish even with changes not captured or commits on the plan branch, which are lost"
          : "Force: finish even with changes not committed or commits not on origin, which are lost"}
      </Force>
    </Confirm>
  )
}

// Hunt opens a hunt process in the project at path, a test hunt on a hunt branch of its own, and opens
// its page, where the hunt session runs. What the hunt could not check stays on screen until it is closed.
export function Hunt({ path }: { path: string }) {
  return (
    <Confirm
      id="hunt"
      trigger={<Button size="sm" variant="outline">Hunt tests</Button>}
      title="Hunt tests"
      description="Hunts the tests that prove nothing on a hunt branch of its own and removes them. A hunt that removed a test goes through the gate, the review and a pull request; one that removed nothing opens none."
      confirm="Start the hunt"
      run={async () => {
        const done = await hunt(path)
        if (done.warnings.length > 0) warn({ title: "Hunt tests", said: "The hunt started with these warnings.", warnings: done.warnings })
        location.hash = href({ page: "process", id: done.record.id })
      }}
    />
  )
}

// Standardize opens a standardize process in the project at path and opens its page, where the auditors
// run read-only and their findings wait per category for an approval.
export function Standardize({ path }: { path: string }) {
  return (
    <Confirm
      id="standardize"
      trigger={<Button size="sm" variant="outline">Standardize</Button>}
      title="Standardize"
      description="Runs the repo-standards auditors read-only and shows their findings per category. Nothing changes until you approve a category; the approved ones go into a cleanup pull request on chore/standardize, after a backup tag."
      confirm="Start the audit"
      run={async () => {
        const done = await standardize(path)
        location.hash = href({ page: "process", id: done.record.id })
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
