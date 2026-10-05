import { useEffect } from "react"
import { FolderGit2Icon, LayoutDashboardIcon, TriangleAlertIcon, WorkflowIcon } from "lucide-react"
import { AddProject } from "@/components/add-project"
import { QuotaBars } from "@/components/quota"
import { dot } from "@/components/rows"
import { Badge } from "@/components/ui/badge"
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
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  SidebarRail,
  useSidebar,
} from "@/components/ui/sidebar"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { broken, label, type Board, type Process, type Projects, type Quota } from "@/api"
import { cn } from "@/lib/utils"
import { href, type Route } from "@/route"

// The sidebar collapses to its icons. It holds the Board entry, the projects of this machine and
// the action that adds one; the quota sits in its footer, which the icon state hides. The Board
// entry counts the processes that turned blocked, ready or failed and whose page is not opened yet.
// Under each project stand its processes once the board has loaded, in the board's order; the icon state
// hides them too.
export function AppSidebar({
  route,
  projects,
  board,
  quota,
  unseen,
  reload,
}: {
  route: Route
  projects: Projects
  board: Board
  quota: Quota
  unseen: number
  reload: () => Promise<void>
}) {
  // On a phone the sidebar is a sheet over the page, so a new page closes it, whichever link or action
  // led there.
  const { setOpenMobile } = useSidebar()
  const at = href(route)
  useEffect(() => setOpenMobile(false), [at, setOpenMobile])
  // A board that is loading or could not be read leaves the projects alone; the pages say why.
  const processes = new Map(
    board.state === "loaded" ? board.projects.flatMap((b) => (broken(b) ? [] : [[b.path, b.processes] as const])) : [],
  )
  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size="lg" asChild>
              <a href={href({ page: "board" })}>
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
                <SidebarMenuButton asChild isActive={route.page === "board"} tooltip="Board">
                  <a href={href({ page: "board" })}>
                    <LayoutDashboardIcon />
                    <span>Board</span>
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
                  {!broken(p) && (processes.get(p.path)?.length ?? 0) > 0 && (
                    <SidebarMenuSub aria-label={`Processes of ${label(p)}`}>
                      {processes.get(p.path)!.map((x) => (
                        <ProcessEntry key={x.branch} p={x} active={route.page === "process" && route.id === x.id} />
                      ))}
                    </SidebarMenuSub>
                  )}
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
        {/* The footer pads the group already, so its content stands where the other groups' content stands. */}
        <SidebarGroup className="p-0">
          <SidebarGroupContent className="px-2 py-1 text-xs text-muted-foreground">
            <QuotaBars quota={quota} />
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  )
}

// ProcessEntry is one process under its project: its state as the dot of its row, its issue and branch,
// and the badge of a process that turned blocked, ready or failed since its page was last opened. It
// links to the process's page; a worktree without a record has none and stands as text. Its tooltip is
// the full branch and the note.
function ProcessEntry({ p, active }: { p: Process; active: boolean }) {
  const content = (
    <>
      <span className={cn("size-2 shrink-0 rounded-full", dot[p.state])} title={p.state} />
      <span className="min-w-0 flex-1 truncate">
        {p.issue !== null && <span className="font-semibold">#{p.issue} </span>}
        {p.branch}
      </span>
      {p.unseen && <Badge variant="destructive" className="h-4 px-1.5">new</Badge>}
    </>
  )
  return (
    <SidebarMenuSubItem>
      <Tooltip>
        <TooltipTrigger asChild>
          {p.id !== null ? (
            <SidebarMenuSubButton asChild size="sm" isActive={active}>
              <a href={href({ page: "process", id: p.id })}>{content}</a>
            </SidebarMenuSubButton>
          ) : (
            <SidebarMenuSubButton asChild size="sm" className="cursor-default hover:bg-transparent hover:text-sidebar-foreground active:bg-transparent">
              <span>{content}</span>
            </SidebarMenuSubButton>
          )}
        </TooltipTrigger>
        <TooltipContent side="right" align="center" className="max-w-80">
          <p className="break-all font-medium">{p.branch}</p>
          {p.note && <p>{p.note}</p>}
        </TooltipContent>
      </Tooltip>
    </SidebarMenuSubItem>
  )
}
