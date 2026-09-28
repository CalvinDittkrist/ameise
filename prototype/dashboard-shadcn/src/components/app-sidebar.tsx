import { FolderGit2Icon, LayoutDashboardIcon, PlusIcon, WorkflowIcon } from "lucide-react"
import { Progress } from "@/components/ui/progress"
import {
  Sidebar, SidebarContent, SidebarFooter, SidebarGroup, SidebarGroupContent, SidebarGroupLabel,
  SidebarHeader, SidebarMenu, SidebarMenuBadge, SidebarMenuButton, SidebarMenuItem, SidebarRail,
} from "@/components/ui/sidebar"
import { all, href, primary, projects, quota } from "@/data"
import { cn } from "@/lib/utils"

export function AppSidebar({ view, selected }: { view: string; selected: string | null }) {
  const needs = all().filter((x) => primary(x)).length
  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size="lg" asChild>
              <a href={href({ view: "orchestrator" })}>
                <div className="flex aspect-square size-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
                  <WorkflowIcon className="size-4" />
                </div>
                <div className="grid flex-1 text-left text-sm leading-tight">
                  <span className="truncate font-semibold">workflows</span>
                  <span className="truncate text-xs text-muted-foreground">this machine</span>
                </div>
              </a>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton asChild isActive={view === "orchestrator"} tooltip="Orchestrator">
                  <a href={href({ view: "orchestrator" })}><LayoutDashboardIcon /><span>Orchestrator</span></a>
                </SidebarMenuButton>
                {needs > 0 && <SidebarMenuBadge><span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-primary px-1.5 text-xs font-medium text-primary-foreground">{needs}</span></SidebarMenuBadge>}
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
        <SidebarGroup>
          <SidebarGroupLabel>Projects</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {projects.map((p) => (
                <SidebarMenuItem key={p.id}>
                  <SidebarMenuButton asChild isActive={view === "project" && selected === p.id} tooltip={p.name}>
                    <a href={href({ view: "project", project: p.id })}><FolderGit2Icon /><span>{p.name}</span></a>
                  </SidebarMenuButton>
                  <SidebarMenuBadge>{p.processes.length}</SidebarMenuBadge>
                </SidebarMenuItem>
              ))}
              <SidebarMenuItem>
                <SidebarMenuButton tooltip="Add project" className="text-muted-foreground">
                  <PlusIcon /><span>Add project</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter className="group-data-[collapsible=icon]:hidden">
        <SidebarGroup>
          <SidebarGroupLabel>Quota</SidebarGroupLabel>
          <SidebarGroupContent className="flex flex-col gap-3 px-2 pt-1">
            {quota.map((x) => (
              <div key={x.r} className={cn("flex flex-col gap-1.5 text-xs", x.low && "text-destructive")}>
                <div className="flex justify-between"><span className="font-medium">{x.r}</span><span className={cn(!x.low && "text-muted-foreground")}>{x.pct}% · {x.reset}</span></div>
                <Progress value={x.pct} className={cn("h-1.5", x.low && "[&>[data-slot=progress-indicator]]:bg-destructive")} />
              </div>
            ))}
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  )
}
