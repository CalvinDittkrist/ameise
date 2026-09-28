import { ChevronDownIcon, TriangleAlertIcon } from "lucide-react"
import { Section } from "@/components/section"
import { Button } from "@/components/ui/button"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { broken, type Listed } from "@/api"

// The project page: the project's facts and actions, its processes and its frontier. The actions and
// the sections wait for the processes and the frontier the controller does not serve yet.
// failed is the reason the projects could not be read, which leaves open whether this one is a project.
export function ProjectView({
  path,
  project,
  loading,
  failed,
}: {
  path: string
  project?: Listed
  loading: boolean
  failed?: string
}) {
  if (loading) return null
  if (failed) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon" className="text-destructive">
            <TriangleAlertIcon />
          </EmptyMedia>
          <EmptyTitle>The projects could not be read</EmptyTitle>
          <EmptyDescription>{failed}</EmptyDescription>
        </EmptyHeader>
      </Empty>
    )
  }
  if (!project) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyTitle>No such project</EmptyTitle>
          <EmptyDescription>{path} is not a project of this machine.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    )
  }
  if (broken(project)) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon" className="text-destructive">
            <TriangleAlertIcon />
          </EmptyMedia>
          <EmptyTitle>{project.path}</EmptyTitle>
          <EmptyDescription>{project.error}</EmptyDescription>
        </EmptyHeader>
      </Empty>
    )
  }
  return (
    <>
      <div className="flex items-center gap-3">
        <h1 className="text-xl font-semibold">{project.name}</h1>
        <span className="text-sm text-muted-foreground">
          {project.owner} · base {project.base}
        </span>
        <div className="ml-auto flex gap-2">
          <Button size="sm" variant="outline" disabled>Plan</Button>
          <Button size="sm" variant="outline" disabled>Standardize</Button>
          <Button size="sm" variant="outline" disabled>Hunt tests</Button>
          <Button size="sm" variant="ghost" disabled>
            Release <ChevronDownIcon />
          </Button>
        </div>
      </div>
      <Section title="Processes" count={0} empty="Nothing running" />
      <Section title="Ready to start" count={0} empty="Frontier empty" />
    </>
  )
}
