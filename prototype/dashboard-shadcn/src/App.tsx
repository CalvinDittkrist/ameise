import { useEffect, useState } from "react"
import { AppSidebar } from "@/components/app-sidebar"
import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar"
import { all, go, projects, query } from "@/data"
import { Orchestrator } from "@/views/orchestrator"
import { ProcessView } from "@/views/process"
import { ProjectView } from "@/views/project"

export default function App() {
  const [hash, setHash] = useState(location.hash)
  useEffect(() => {
    const on = () => setHash(location.hash)
    addEventListener("hashchange", on)
    return () => removeEventListener("hashchange", on)
  }, [hash])
  const p = query()
  const view = p.get("view") ?? "orchestrator"
  const cmd = (p.get("cmd") ?? "on") === "on"
  const title = view === "process" ? "Process" : view === "project" ? "Project" : "Orchestrator"
  return (
    <SidebarProvider>
      <AppSidebar view={view} selected={p.get("project")} />
      <SidebarInset>
        <header className="flex h-12 shrink-0 items-center gap-2 border-b px-4">
          <SidebarTrigger className="-ml-1" />
          <Separator orientation="vertical" className="mx-2 data-[orientation=vertical]:h-4" />
          <span className="text-sm font-medium">{title}</span>
          {view === "orchestrator" && <span className="text-sm text-muted-foreground">{projects.length} projects · {all().length} processes</span>}
        </header>
        <main className="flex flex-1 flex-col gap-4 p-4 pb-20 lg:p-6 lg:pb-20">
          {view === "process" ? <ProcessView id={p.get("process")} /> : view === "project" ? <ProjectView id={p.get("project")} /> : <Orchestrator cmd={cmd} />}
        </main>
      </SidebarInset>
      {view === "orchestrator" && (
        <div className="fixed right-4 bottom-4 flex gap-1 rounded-lg border bg-background p-1 shadow-md">
          <Button size="sm" variant={cmd ? "secondary" : "ghost"} onClick={() => go({ cmd: "on" })}>with command bar</Button>
          <Button size="sm" variant={!cmd ? "secondary" : "ghost"} onClick={() => go({ cmd: "off" })}>without</Button>
        </div>
      )}
    </SidebarProvider>
  )
}
