import { AppSidebar } from "@/components/app-sidebar"
import { Warnings } from "@/components/process-actions"
import { Separator } from "@/components/ui/separator"
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar"
import { broken, label, QuotaContext, useBoard, useProjects, useQuota } from "@/api"
import { cn } from "@/lib/utils"
import { useRoute } from "@/route"
import { Orchestrator } from "@/views/orchestrator"
import { ProcessView } from "@/views/process"
import { ProjectView } from "@/views/project"

export default function App() {
  const route = useRoute()
  const [projects, reloadProjects] = useProjects()
  const [board, reloadBoard] = useBoard()
  const quota = useQuota()
  // A project added from the sidebar shows on the board at once.
  const reload = async () => {
    await Promise.all([reloadProjects(), reloadBoard()])
  }
  const listed = projects.state === "loaded" ? projects.projects : []
  const project = route.page === "project" ? listed.find((p) => p.path === route.path) : undefined
  const title = route.page === "orchestrator" ? "Orchestrator" : route.page === "process" ? "Process" : project ? label(project) : "Project"
  // The processes that turned blocked, ready or failed and whose page is not opened yet.
  const unseen = board.state === "loaded" ? board.projects.flatMap((b) => (broken(b) ? [] : b.processes.filter((p) => p.unseen))).length : 0
  return (
    <QuotaContext.Provider value={quota}>
      <SidebarProvider>
        <AppSidebar route={route} projects={projects} board={board} quota={quota} unseen={unseen} reload={reload} />
        {/* The process page scrolls its own log below the header, so it is as tall as the window. */}
        <SidebarInset className={cn(route.page === "process" && "h-svh")}>
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
          <div className={cn("flex flex-1 flex-col gap-4", route.page === "process" ? "min-h-0" : "p-4 lg:p-6")}>
            {route.page === "orchestrator" ? (
              <Orchestrator board={board} reload={reloadBoard} />
            ) : route.page === "process" ? (
              <ProcessView id={route.id} board={board} reload={reloadBoard} />
            ) : (
              <ProjectView
                path={route.path}
                project={project}
                loading={projects.state === "loading"}
                failed={projects.state === "failed" ? projects.error : undefined}
                board={board}
                reload={reloadBoard}
              />
            )}
          </div>
        </SidebarInset>
        <Warnings />
      </SidebarProvider>
    </QuotaContext.Provider>
  )
}
