import { BotIcon, MessageCircleQuestionIcon, SendIcon, ShieldAlertIcon, ShieldCheckIcon, TerminalIcon, UserIcon } from "lucide-react"
import { type FormEvent, type KeyboardEvent, useEffect, useLayoutEffect, useRef, useState } from "react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty"
import { Progress } from "@/components/ui/progress"
import { Separator } from "@/components/ui/separator"
import { Textarea } from "@/components/ui/textarea"
import { dot } from "@/components/rows"
import {
  age,
  type Answer,
  answer,
  type Board,
  broken,
  type Entry,
  openTerminal,
  type Process,
  type ProcessRecord,
  type ProjectBoard,
  type Question,
  say,
  seen,
  useProcess,
} from "@/api"
import { cn } from "@/lib/utils"
import { href } from "@/route"

// The stages a process of each kind runs in the controller. A work process runs implement, whose
// session runs the worker's own pipeline after it; the later stages join as the controller drives them.
const stagesOf: Record<Process["kind"], string[]> = { work: ["implement"], plan: ["plan"], hunt: ["hunt"], standardize: ["audit"] }

// The process page: the facts of one process, its stages and its session as a conversation, with cards
// for the permissions and questions that wait for the maintainer, a chat that writes to the session and
// an action that opens it in a terminal. It follows the process's event log as it is written. Opening it
// marks the process seen, which clears the badge it carries since it turned blocked, ready or failed.
export function ProcessView({ id, board, reload }: { id: string; board: Board; reload: () => Promise<void> }) {
  const followed = useProcess(id)
  const found =
    board.state === "loaded"
      ? board.projects.flatMap((b) => (broken(b) ? [] : b.processes.filter((p) => p.id === id).map((p) => ({ p, b: b as ProjectBoard }))))[0]
      : undefined
  const unseen = followed.state === "live" ? followed.record.unseen === true : found?.p.unseen === true
  // A mark that fails, as while the controller restarts, is tried again until it lands or the page closes.
  useEffect(() => {
    if (!unseen) return
    let live = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const mark = () =>
      void seen(id).then(reload, () => {
        if (live) timer = setTimeout(mark, 5000)
      })
    mark()
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [id, unseen, reload])
  if (followed.state === "loading") return null
  if (followed.state === "failed" || followed.state === "gone") {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyTitle>No such process</EmptyTitle>
          <EmptyDescription>{followed.state === "gone" ? `${id} was removed.` : `${id} is not a process of this machine.`}</EmptyDescription>
        </EmptyHeader>
      </Empty>
    )
  }
  const { record, entries } = followed
  return (
    <>
      <Header record={record} />
      <Facts record={record} project={found?.b} process={found?.p} reconnecting={followed.state === "reconnecting"} />
      <Separator />
      <Conversation record={record} entries={entries} />
    </>
  )
}

function Header({ record }: { record: ProcessRecord }) {
  const [error, setError] = useState("")
  const [opening, setOpening] = useState(false)
  const open = async () => {
    setOpening(true)
    setError("")
    try {
      await openTerminal(record.id)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setOpening(false)
    }
  }
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span className={cn("size-3 shrink-0 rounded-full", dot[record.state])} title={record.state} />
        <h1 className="text-xl font-semibold break-all">
          {record.issue ? `#${record.issue} ` : ""}
          {record.branch}
        </h1>
        <Button
          size="sm"
          variant="outline"
          className="ml-auto"
          disabled={!record.session_id || opening}
          title={record.session_id ? `claude --resume ${record.session_id}` : "The session has not started"}
          onClick={() => void open()}
        >
          <TerminalIcon />
          Open in terminal
        </Button>
      </div>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  )
}

const reported: Process["state"][] = ["blocked", "ready", "failed"]

// tokens is a size in tokens as the fact row shows it: in thousands from a thousand on.
const tokens = (n: number) => (n < 1000 ? String(n) : `${Math.round(n / 1000)}k`)

// Facts is the row of facts under the title: the project, the branch, the pull request with its checks,
// the mode, the time since the process last changed and the size of the session's context against the
// size at which it compacts. Below it are the stages, the current one filled, the ones done struck through.
function Facts({ record, project, process, reconnecting }: { record: ProcessRecord; project?: ProjectBoard; process?: Process; reconnecting: boolean }) {
  const kind = process?.kind ?? "work"
  const stages = stagesOf[kind].includes(record.stage) ? stagesOf[kind] : [...stagesOf[kind], record.stage]
  const at = stages.indexOf(record.stage)
  const share = record.context === undefined ? 0 : Math.min(100, (record.context / record.compact_at) * 100)
  return (
    <>
      <div aria-label="Facts" className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted-foreground">
        {project ? (
          <a href={href({ page: "project", path: project.path })} className="hover:text-foreground hover:underline">
            {project.owner}/{project.name}
          </a>
        ) : (
          <span>{record.project.split("/").filter(Boolean).pop()}</span>
        )}
        <span className="font-mono text-xs">{record.branch}</span>
        {process?.pr && (
          <span aria-label="Pull request">
            <a href={process.pr.url} className="hover:text-foreground hover:underline">
              #{process.pr.number}
            </a>
            {process.checks && process.checks !== "none" && ` checks ${process.checks}`}
          </span>
        )}
        <Badge variant="outline">{record.mode}</Badge>
        <span title={record.updated_at}>{age(record.updated_at)}</span>
        <span
          aria-label="Context"
          className="flex items-center gap-2"
          title={record.context === undefined ? "No usage yet" : `${record.context.toLocaleString("en")} of ${record.compact_at.toLocaleString("en")} tokens before it compacts`}
        >
          context
          <Progress value={share} className="h-1.5 w-20" aria-label="Context size" />
          {record.context === undefined ? "–" : tokens(record.context)}
        </span>
        {reconnecting && <span role="status">reconnecting…</span>}
      </div>
      {/* The report a session ended with: what is ready, the question a block asks, the reason of a failure. */}
      {reported.includes(record.state) && record.note && (
        <p aria-label="Note" className={cn("text-sm", record.state === "failed" && "text-destructive")}>
          {record.note}
        </p>
      )}
      <ol aria-label="Stages" className="flex flex-wrap gap-1.5">
        {stages.map((s, j) => (
          <li key={s}>
            <Badge
              variant={j === at ? "default" : "outline"}
              aria-current={j === at ? "step" : undefined}
              className={cn(j < at && "border-transparent bg-muted text-muted-foreground line-through", j > at && "text-muted-foreground")}
            >
              {s}
            </Badge>
          </li>
        ))}
      </ol>
    </>
  )
}

// A turn of the conversation as the page draws it: the session's text with the tool calls that follow
// it, the maintainer's message, a card, or a line between sessions.
type Turn =
  | { kind: "session"; seq: number; text: string; tools: { name: string; detail: string; allowed: boolean }[] }
  | { kind: "you"; seq: number; text: string }
  | { kind: "permission"; seq: number; entry: Extract<Entry, { kind: "permission" }> }
  | { kind: "question"; seq: number; entry: Extract<Entry, { kind: "question" }> }
  | { kind: "line"; seq: number; text: string }

// Settled is how a request was settled: by an answer, or by the end of its session without one.
type Settled = { answer?: Answer; text?: string } | "closed"

function turns(entries: Entry[]): { list: Turn[]; settled: Map<string, Settled> } {
  const list: Turn[] = []
  const settled = new Map<string, Settled>()
  for (const e of entries) {
    const last = list.at(-1)
    switch (e.kind) {
      case "text":
        list.push({ kind: "session", seq: e.seq, text: e.text, tools: [] })
        break
      case "tool":
      case "allowed": {
        const tool = { name: e.kind === "tool" ? e.name : e.tool, detail: e.detail, allowed: e.kind === "allowed" }
        // A call the maintainer had allowed for the process marks the chip of that call.
        const called = e.kind === "allowed" && last?.kind === "session" ? last.tools.findLast((t) => !t.allowed && t.name === tool.name && t.detail === tool.detail) : undefined
        if (called) called.allowed = true
        else if (last?.kind === "session") last.tools.push(tool)
        else list.push({ kind: "session", seq: e.seq, text: "", tools: [tool] })
        break
      }
      case "you":
        list.push({ kind: "you", seq: e.seq, text: e.text })
        break
      case "permission":
      case "question":
        list.push(e.kind === "permission" ? { kind: "permission", seq: e.seq, entry: e } : { kind: "question", seq: e.seq, entry: e })
        break
      case "answer":
        settled.set(e.request, { answer: e.answer, text: e.text })
        break
      case "closed":
        settled.set(e.request, "closed")
        break
      case "start":
        if (e.resumed) list.push({ kind: "line", seq: e.seq, text: "The session resumed" })
        break
      case "end":
        list.push({ kind: "line", seq: e.seq, text: e.state === "failed" ? `Failed: ${e.note}` : `Reported ${e.state}: ${e.note}` })
        break
    }
  }
  return { list, settled }
}

// A process the maintainer can write to: one whose session runs, or has run and can be resumed.
const writable = (r: ProcessRecord) => r.session_id !== undefined || r.state === "running" || r.state === "approval" || r.state === "input"

function Conversation({ record, entries }: { record: ProcessRecord; entries: Entry[] }) {
  const { list, settled } = turns(entries)
  const asking = list.some((t) => t.kind === "question" && !settled.has(t.entry.request))
  // The page stays at the end of the conversation while it grows, unless the maintainer scrolled up.
  const end = useRef<HTMLDivElement>(null)
  const following = useRef(true)
  useEffect(() => {
    const scrolled = () => {
      const el = document.scrollingElement
      if (el) following.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
    }
    addEventListener("scroll", scrolled, { passive: true })
    return () => removeEventListener("scroll", scrolled)
  }, [])
  useLayoutEffect(() => {
    if (following.current) end.current?.scrollIntoView({ block: "end" })
  }, [entries.length])
  return (
    <div aria-label="Conversation" className="flex w-full max-w-3xl flex-col gap-5">
      {list.length === 0 && <p className="text-sm text-muted-foreground">The session has written nothing yet.</p>}
      {/* A turn keeps its place as the log grows, and one line of the log can make several turns, so a
          turn is keyed by its place. */}
      {list.map((t, i) => {
        switch (t.kind) {
          case "session":
            return <Said key={i} text={t.text} tools={t.tools} />
          case "you":
            return <Said key={i} text={t.text} you />
          case "permission":
            return <Permission key={i} id={record.id} entry={t.entry} settled={settled.get(t.entry.request)} />
          case "question":
            return <Asked key={i} id={record.id} questions={t.entry.questions} settled={settled.get(t.entry.request)} />
          case "line":
            return (
              <p key={i} role="note" className="flex items-center gap-3 text-xs text-muted-foreground before:h-px before:flex-1 before:bg-border after:h-px after:flex-1 after:bg-border">
                {t.text}
              </p>
            )
        }
      })}
      <Chat id={record.id} disabled={!writable(record)} placeholder={asking ? "Answer the question…" : record.state === "running" || record.state === "approval" ? "Write to the session…" : "Write to resume the session…"} />
      <div ref={end} />
    </div>
  )
}

// Said is one turn of the session or of the maintainer, with the tool calls of the session as chips.
function Said({ text, tools = [], you = false }: { text: string; tools?: { name: string; detail: string; allowed: boolean }[]; you?: boolean }) {
  return (
    <div role="article" aria-label={you ? "You" : "Session"} className={cn("flex gap-3", you && "flex-row-reverse")}>
      <div className={cn("flex size-7 shrink-0 items-center justify-center rounded-full", you ? "bg-primary text-primary-foreground" : "bg-muted")}>
        {you ? <UserIcon className="size-3.5" /> : <BotIcon className="size-3.5" />}
      </div>
      <div className={cn("flex max-w-[85%] min-w-0 flex-col gap-2", you && "items-end")}>
        {text && <div className={cn("rounded-lg px-3 py-2 text-sm break-words whitespace-pre-wrap", you ? "bg-primary text-primary-foreground" : "bg-muted")}>{text}</div>}
        {tools.length > 0 && (
          <ul aria-label="Tool calls" className="flex flex-wrap gap-1.5">
            {tools.map((t, k) => (
              <li key={k} className="flex max-w-full">
                <Badge
                  variant="outline"
                  title={t.allowed ? `${t.name} ${t.detail}: allowed for this process` : `${t.name} ${t.detail}`}
                  className="max-w-full justify-start font-mono text-[11px] font-normal"
                >
                  {t.allowed && <ShieldCheckIcon className="text-emerald-600" />}
                  <span className="font-semibold">{t.name}</span>
                  {t.detail && <span className="truncate">{t.detail}</span>}
                </Badge>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}

const answered: Record<Answer, string> = { once: "Allowed once", process: "Allowed for this process", deny: "Denied" }

// Permission is a call the session waits to make until the maintainer answers: once, for the rest of
// the process, or not at all.
function Permission({ id, entry, settled }: { id: string; entry: Extract<Entry, { kind: "permission" }>; settled?: Settled }) {
  const [error, setError] = useState("")
  const [sending, setSending] = useState(false)
  const send = async (a: Answer) => {
    setSending(true)
    setError("")
    try {
      await answer(id, entry.request, a)
    } catch (err) {
      setError((err as Error).message)
      setSending(false)
    }
  }
  return (
    <Card role="article" aria-label="Permission" size="sm" className={cn(settled === undefined && "bg-amber-500/5 ring-amber-500/40")}>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-sm">
          <ShieldAlertIcon className={cn("size-4", settled === undefined ? "text-amber-600" : "text-muted-foreground")} />
          {entry.title}
        </CardTitle>
        {entry.reason && <CardDescription>{entry.reason}</CardDescription>}
      </CardHeader>
      {entry.detail && (
        <CardContent>
          <code className="block rounded-md bg-muted px-3 py-2 font-mono text-xs break-all whitespace-pre-wrap">{entry.detail}</code>
        </CardContent>
      )}
      <CardFooter className="flex-wrap gap-2">
        {settled === undefined ? (
          <>
            <Button size="sm" disabled={sending} onClick={() => void send("once")}>Allow once</Button>
            <Button size="sm" variant="outline" disabled={sending} onClick={() => void send("process")}>Allow for this process</Button>
            <Button size="sm" variant="ghost" disabled={sending} onClick={() => void send("deny")}>Deny</Button>
          </>
        ) : (
          <span role="status" className="text-xs text-muted-foreground">
            {settled === "closed" ? "The session ended before it was answered" : settled.answer ? answered[settled.answer] : "Answered"}
          </span>
        )}
        {error && (
          <p role="alert" className="w-full text-sm text-destructive">
            {error}
          </p>
        )}
      </CardFooter>
    </Card>
  )
}

// Asked is a question of the session. An option answers it with a click, the chat below with any text.
// A question that takes several options has them toggled, then sent together as the session reads them.
function Asked({ id, questions, settled }: { id: string; questions: Question[]; settled?: Settled }) {
  const [error, setError] = useState("")
  const [sending, setSending] = useState(false)
  const [chosen, setChosen] = useState<string[]>([])
  const pick = async (label: string) => {
    setSending(true)
    setError("")
    try {
      await say(id, label)
    } catch (err) {
      setError((err as Error).message)
      setSending(false)
    }
  }
  const toggle = (label: string) => setChosen((c) => (c.includes(label) ? c.filter((l) => l !== label) : [...c, label]))
  const open = settled === undefined
  return (
    <Card role="article" aria-label="Question" size="sm" className={cn(open && "bg-primary/5 ring-primary/40")}>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-sm">
          <MessageCircleQuestionIcon className={cn("size-4", open ? "text-primary" : "text-muted-foreground")} />
          The session asks
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 text-sm">
        {questions.map((q) => (
          <div key={q.question} className="flex flex-col gap-2">
            <p>{q.question}</p>
            {open && questions.length === 1 && q.options.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {q.options.map((o) =>
                  q.multiSelect ? (
                    <Button key={o.label} size="sm" variant={chosen.includes(o.label) ? "default" : "outline"} aria-pressed={chosen.includes(o.label)} title={o.description} disabled={sending} onClick={() => toggle(o.label)}>
                      {o.label}
                    </Button>
                  ) : (
                    <Button key={o.label} size="sm" variant="outline" title={o.description} disabled={sending} onClick={() => void pick(o.label)}>
                      {o.label}
                    </Button>
                  ),
                )}
                {q.multiSelect && (
                  <Button size="sm" disabled={sending || chosen.length === 0} onClick={() => void pick(q.options.map((o) => o.label).filter((l) => chosen.includes(l)).join(", "))}>
                    Send
                  </Button>
                )}
              </div>
            )}
          </div>
        ))}
      </CardContent>
      <CardFooter className="flex-wrap gap-2 text-xs text-muted-foreground">
        <span role="status">
          {open ? "Answer below" : settled === "closed" ? "The session ended before it was answered" : `You answered: ${settled.text ?? ""}`}
        </span>
        {error && (
          <p role="alert" className="w-full text-sm text-destructive">
            {error}
          </p>
        )}
      </CardFooter>
    </Card>
  )
}

// Chat writes to the session: Enter sends, Shift+Enter starts a new line.
function Chat({ id, disabled, placeholder }: { id: string; disabled: boolean; placeholder: string }) {
  const [text, setText] = useState("")
  const [error, setError] = useState("")
  const [sending, setSending] = useState(false)
  const send = async (e?: FormEvent) => {
    e?.preventDefault()
    if (text.trim() === "" || sending) return
    setSending(true)
    setError("")
    try {
      await say(id, text)
      setText("")
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setSending(false)
    }
  }
  const keys = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) void send(e)
  }
  return (
    <form onSubmit={(e) => void send(e)} className="sticky bottom-0 -mx-1 flex flex-col gap-2 bg-background px-1 pt-1 pb-4">
      <div className="flex items-end gap-2">
        <Textarea
          aria-label="Message"
          placeholder={disabled ? "The session has not started" : placeholder}
          disabled={disabled}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={keys}
          rows={1}
          className="max-h-48 min-h-9 resize-none"
        />
        <Button type="submit" size="icon-lg" disabled={disabled || sending || text.trim() === ""}>
          <SendIcon />
          <span className="sr-only">Send</span>
        </Button>
      </div>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </form>
  )
}
