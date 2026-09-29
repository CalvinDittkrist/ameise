import { useEffect } from "react"
import { FolderGit2Icon, LayoutDashboardIcon, TriangleAlertIcon, WorkflowIcon } from "lucide-react"
import { AddProject } from "@/components/add-project"
import { QuotaBars } from "@/components/quota"
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSkeleton,
  SidebarRail,
  useSidebar,
} from "@/components/ui/sidebar"
import { broken, label, type Projects, type Quota } from "@/api"
import { href, type Route } from "@/route"

// The sidebar collapses to its icons. It holds the Orchestrator entry, the projects of this machine and
// the action that adds one; the quota sits in its footer, which the icon state hides. The Orchestrator
// entry counts the processes that turned blocked, ready or failed and whose page is not opened yet.
export function AppSidebar({
  route,
  projects,
  quota,
  unseen,
  reload,
}: {
  route: Route
  projects: Projects
  quota: Quota
  unseen: number
  reload: () => Promise<void>
}) {
  // On a phone the sidebar is a sheet over the page, so a new page closes it, whichever link or action
  // led there.
  const { setOpenMobile } = useSidebar()
  const at = href(route)
  useEffect(() => setOpenMobile(false), [at, setOpenMobile])
  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size="lg" asChild>
              <a href={href({ page: "orchestrator" })}>
                <div className="flex aspect-square size-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
                  <WorkflowIcon className="size-4" />
                </div>
                <div className="grid flex-1 text-left text-sm leading-tight">
                  <span className="truncate font-semibold">ameise controller</span>
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
                <SidebarMenuButton asChild isActive={route.page === "orchestrator"} tooltip="Orchestrator">
                  <a href={href({ page: "orchestrator" })}>
                    <LayoutDashboardIcon />
                    <span>Orchestrator</span>
                  </a>
                </SidebarMenuButton>
                {unseen > 0 && (
                  <SidebarMenuBadge aria-label={`${unseen} new`} className="bg-destructive text-white peer-hover/menu-button:text-white peer-data-active/menu-button:text-white">
                    {unseen}
                  </SidebarMenuBadge>
                )}
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
        <SidebarGroup>
          <SidebarGroupLabel>Projects</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu aria-label="Projects">
              {projects.state === "loading" && [0, 1].map((i) => (
                <SidebarMenuItem key={i}>
                  <SidebarMenuSkeleton showIcon />
                </SidebarMenuItem>
              ))}
              {projects.state === "failed" && (
                <SidebarMenuItem className="px-2 py-1.5 text-xs text-destructive group-data-[collapsible=icon]:hidden">
                  {projects.error}
                </SidebarMenuItem>
              )}
              {projects.state === "loaded" && projects.projects.map((p) => (
                <SidebarMenuItem key={p.path}>
                  <SidebarMenuButton
                    asChild
                    isActive={route.page === "project" && route.path === p.path}
                    tooltip={broken(p) ? `${label(p)}: ${p.error}` : `${p.owner}/${p.name}`}
                  >
                    <a href={href({ page: "project", path: p.path })}>
                      {broken(p) ? <TriangleAlertIcon className="text-destructive" /> : <FolderGit2Icon />}
                      <span>{label(p)}</span>
                    </a>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
              <SidebarMenuItem>
                <AddProject reload={reload} />
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter className="group-data-[collapsible=icon]:hidden">
        {/* The footer pads the group already, so its label stands where the other labels stand. */}
        <SidebarGroup className="p-0">
          <SidebarGroupLabel>Quota</SidebarGroupLabel>
          <SidebarGroupContent className="px-2 pt-1 text-xs text-muted-foreground">
            <QuotaBars quota={quota} />
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  )
}
