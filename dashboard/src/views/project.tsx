import { TriangleAlertIcon } from "lucide-react"
import { Plan, Release } from "@/components/actions"
import { IssueRow, Notes, ProcessRow } from "@/components/rows"
import { Section } from "@/components/section"
import { Button } from "@/components/ui/button"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { broken, type Board, type Listed, type ProjectBoard } from "@/api"

// The project page: the project's facts and actions, its processes, its frontier and, when there are
// any, its specs ready for acceptance. Its actions but plan and release wait for the controller to serve them.
// failed is the reason the projects could not be read, which leaves open whether this one is a project.
export function ProjectView({
  path,
  project,
  loading,
  failed,
  board,
  reload,
}: {
  path: string
  project?: Listed
  loading: boolean
  failed?: string
  board: Board
  reload: () => Promise<void>
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
  const found = board.state === "loaded" ? board.projects.find((x) => x.path === project.path) : undefined
  const b = found && !broken(found) ? (found as ProjectBoard) : undefined
  const pending = board.state === "loading"
  return (
    <>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <h1 className="text-xl font-semibold">{project.name}</h1>
        <span className="text-sm text-muted-foreground">
          {project.owner} · base {project.base}
        </span>
        <div className="ml-auto flex flex-wrap gap-2">
          <Plan path={project.path} />
          <Button size="sm" variant="outline" disabled>Standardize</Button>
          <Button size="sm" variant="outline" disabled>Hunt tests</Button>
          <Release path={project.path} reload={reload} />
        </div>
      </div>
      {board.state === "failed" && <p role="alert" className="text-sm text-destructive">{board.error}</p>}
      {b && <Notes boards={[b]} />}
      <Section title="Processes" count={b?.processes.length ?? 0} empty="Nothing running" loading={pending}>
        {b?.processes.map((p) => <ProcessRow key={p.branch} p={p} path={project.path} reload={reload} />)}
      </Section>
      <Section title="Ready to start" count={b?.frontier.length ?? 0} empty="Frontier empty" loading={pending}>
        {b?.frontier.map((i) => <IssueRow key={i.number} i={i} path={project.path} reload={reload} />)}
      </Section>
      {b && b.acceptance.length > 0 && (
        <Section title="Ready for acceptance" count={b.acceptance.length} empty="">
          {b.acceptance.map((i) => <IssueRow key={i.number} i={i} path={project.path} reload={reload} accept />)}
        </Section>
      )}
    </>
  )
}
