import { ArrowLeftIcon, BotIcon, MessageCircleQuestionIcon, PauseIcon, SendIcon, ShieldAlertIcon, TerminalIcon, Trash2Icon, UserIcon } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import { Progress } from "@/components/ui/progress"
import { Separator } from "@/components/ui/separator"
import { Textarea } from "@/components/ui/textarea"
import { all, conv, dotClass, href, stagesOf } from "@/data"
import { cn } from "@/lib/utils"

export function ProcessView({ id }: { id: string | null }) {
  const x = all().find((y) => y.id === id) ?? all()[0]
  const st = stagesOf[x.kind]
  const i = st.indexOf(x.stage)
  return (
    <>
      <a href={href({ view: "orchestrator" })} className="flex w-fit items-center gap-1 text-sm text-muted-foreground hover:text-foreground"><ArrowLeftIcon className="size-3.5" />Orchestrator</a>
      <div className="flex items-center gap-3">
        <span className={cn("size-3 rounded-full", dotClass[x.state])} />
        <h1 className="text-xl font-semibold">{x.issue && <span>#{x.issue} </span>}{x.title}</h1>
        <div className="ml-auto flex gap-2">
          <Button size="sm" variant="outline"><TerminalIcon />Open in terminal</Button>
          <Button size="sm" variant="ghost"><PauseIcon />Hold</Button>
          <Button size="sm" variant="ghost"><Trash2Icon />Abandon</Button>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted-foreground">
        <span>{x.project.name}</span>
        <span className="font-mono text-xs">{x.branch}</span>
        {x.mode && <Badge variant="outline">{x.mode}</Badge>}
        <span>{x.since}</span>
        <span className="flex items-center gap-2">context<Progress value={42} className="h-1.5 w-20" />84k</span>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {st.map((s, j) => (
          <Badge key={s} variant={j === i ? "default" : "outline"} className={cn(j < i && "border-transparent bg-muted text-muted-foreground line-through", j > i && "text-muted-foreground")}>{s}</Badge>
        ))}
      </div>
      <Separator />
      <div className="flex max-w-3xl flex-col gap-5">
        {conv.map((m, k) => {
          if (m.who === "permission") return (
            <Card key={k} className="border-amber-500/40 bg-amber-500/5">
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-sm"><ShieldAlertIcon className="size-4 text-amber-600" />{m.tool} wants to run</CardTitle>
                <CardDescription>{m.why}</CardDescription>
              </CardHeader>
              <CardContent><code className="block rounded-md bg-muted px-3 py-2 font-mono text-xs">{m.cmd}</code></CardContent>
              <CardFooter className="gap-2">
                <Button size="sm">Allow once</Button>
                <Button size="sm" variant="outline">Allow for this process</Button>
                <Button size="sm" variant="ghost">Deny</Button>
              </CardFooter>
            </Card>
          )
          if (m.who === "question") return (
            <Card key={k} className="border-primary/40 bg-primary/5">
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-sm"><MessageCircleQuestionIcon className="size-4 text-primary" />The session asks</CardTitle>
              </CardHeader>
              <CardContent className="text-sm">{m.text}</CardContent>
              <CardFooter className="text-xs text-muted-foreground">Answer below</CardFooter>
            </Card>
          )
          const me = m.who === "you"
          return (
            <div key={k} className={cn("flex gap-3", me && "flex-row-reverse")}>
              <div className={cn("flex size-7 shrink-0 items-center justify-center rounded-full", me ? "bg-primary text-primary-foreground" : "bg-muted")}>
                {me ? <UserIcon className="size-3.5" /> : <BotIcon className="size-3.5" />}
              </div>
              <div className={cn("flex max-w-[85%] flex-col gap-2", me && "items-end")}>
                <div className={cn("rounded-lg px-3 py-2 text-sm", me ? "bg-primary text-primary-foreground" : "bg-muted")}>{m.text}</div>
                {m.tools && (
                  <div className="flex flex-wrap gap-1.5">
                    {m.tools.map((t) => <Badge key={t} variant="outline" className="font-mono text-[11px] font-normal"><span className="font-semibold">{t.split(" ")[0]}</span>{t.split(" ").slice(1).join(" ")}</Badge>)}
                  </div>
                )}
              </div>
            </div>
          )
        })}
        <div className="flex items-end gap-2">
          <Textarea placeholder="Write to the session…" className="min-h-10 resize-none" rows={1} />
          <Button size="icon"><SendIcon /><span className="sr-only">Send</span></Button>
        </div>
      </div>
    </>
  )
}
