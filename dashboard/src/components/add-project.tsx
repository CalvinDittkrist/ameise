import { PlusIcon } from "lucide-react"
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
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { SidebarMenuButton } from "@/components/ui/sidebar"
import { addProject } from "@/api"
import { href } from "@/route"

// AddProject adds a checkout of this machine as a project. The controller derives the rest from the
// checkout and refuses a path it cannot, and its reason is shown in the dialog.
export function AddProject({ reload }: { reload: () => Promise<void> }) {
  const [open, setOpen] = useState(false)
  const [path, setPath] = useState("")
  const [error, setError] = useState("")
  const [adding, setAdding] = useState(false)

  const change = (next: boolean) => {
    setOpen(next)
    setPath("")
    setError("")
  }

  async function submit(e: FormEvent) {
    e.preventDefault()
    setAdding(true)
    try {
      const added = await addProject(path.trim())
      await reload()
      change(false)
      location.hash = href({ page: "project", path: added.path })
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setAdding(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={change}>
      <DialogTrigger asChild>
        <SidebarMenuButton tooltip="Add project" className="text-muted-foreground">
          <PlusIcon />
          <span>Add project</span>
        </SidebarMenuButton>
      </DialogTrigger>
      <DialogContent>
        <form onSubmit={submit} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>Add project</DialogTitle>
            <DialogDescription>A checkout of this machine whose origin is on GitHub.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-2">
            <Label htmlFor="project-path">Path</Label>
            <Input
              id="project-path"
              value={path}
              onChange={(e) => setPath(e.target.value)}
              placeholder="/home/me/src/repo"
              aria-invalid={error !== ""}
              aria-describedby={error ? "project-error" : undefined}
              autoComplete="off"
              spellCheck={false}
            />
            {error && (
              <p id="project-error" role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
          </div>
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline">Cancel</Button>
            </DialogClose>
            <Button type="submit" disabled={adding || path.trim() === ""}>Add</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
