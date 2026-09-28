import { AppSidebar } from "@/components/app-sidebar"
import { Separator } from "@/components/ui/separator"
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar"
import { label, useProjects } from "@/api"
import { useRoute } from "@/route"
import { Orchestrator } from "@/views/orchestrator"
import { ProjectView } from "@/views/project"

export default function App() {
  const route = useRoute()
  const [projects, reload] = useProjects()
  const listed = projects.state === "loaded" ? projects.projects : []
  const project = route.page === "project" ? listed.find((p) => p.path === route.path) : undefined
  const title = route.page === "orchestrator" ? "Orchestrator" : project ? label(project) : "Project"
  return (
    <SidebarProvider>
      <AppSidebar route={route} projects={projects} reload={reload} />
      <SidebarInset>
        <header className="flex h-12 shrink-0 items-center gap-2 border-b px-4">
          <SidebarTrigger className="-ml-1" />
          <Separator orientation="vertical" className="mx-2 data-vertical:h-4 data-vertical:self-center" />
          <span className="text-sm font-medium">{title}</span>
          {route.page === "orchestrator" && projects.state === "loaded" && (
            <span className="text-sm text-muted-foreground">
              {listed.length} {listed.length === 1 ? "project" : "projects"}
            </span>
          )}
        </header>
        <div className="flex flex-1 flex-col gap-4 p-4 lg:p-6">
          {route.page === "orchestrator" ? (
            <Orchestrator />
          ) : (
            <ProjectView path={route.path} project={project} loading={projects.state === "loading"} />
          )}
        </div>
      </SidebarInset>
    </SidebarProvider>
  )
}
