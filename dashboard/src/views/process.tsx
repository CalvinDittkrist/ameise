import { MessageScroller } from "@shadcn/react/message-scroller"
import { ArrowDownIcon, BotIcon, MessageCircleQuestionIcon, PauseIcon, SendIcon, ShieldAlertIcon, ShieldCheckIcon, TerminalIcon, UserIcon } from "lucide-react"
import { type FormEvent, type KeyboardEvent, useEffect, useState } from "react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty"
import { Progress } from "@/components/ui/progress"
import { Separator } from "@/components/ui/separator"
import { Textarea } from "@/components/ui/textarea"
import { Capture, Finish } from "@/components/actions"
import { Prose } from "@/components/markdown"
import { dot } from "@/components/rows"
import {
  age,
  type Answer,
  answer,
  type Attempt,
  type Board,
  broken,
  type Entry,
  type Fix,
  hold,
  type Hunt,
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

// The stages a process of each kind runs in the controller. A work process runs implement, the gate, the
// review, pr and ci, and address-reviews once a review of its pull request asks for an answer. A hunt
// runs hunt in place of implement.
const stagesOf: Record<Process["kind"], string[]> = {
  work: ["implement", "gate", "review", "pr", "ci"],
  plan: ["plan"],
  hunt: ["hunt", "gate", "review", "pr", "ci"],
  standardize: ["audit"],
}

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
      <Empty className="m-4 lg:m-6">
        <EmptyHeader>
          <EmptyTitle>No such process</EmptyTitle>
          <EmptyDescription>{followed.state === "gone" ? `${id} was removed.` : `${id} is not a process of this machine.`}</EmptyDescription>
        </EmptyHeader>
      </Empty>
    )
  }
  const { record, entries } = followed
  const { list, settled } = turns(entries)
  const asking = list.some((t) => t.kind === "question" && !settled.has(t.entry.request))
  // The page scrolls through shadcn's message scroller. It opens at the end of the conversation and
  // follows the end while the log grows; once the maintainer scrolled up it keeps their place and offers
  // the way back. The viewport stays hidden until it stands at the end, so a fresh page does not flash
  // the top first.
  return (
    <MessageScroller.Provider autoScroll>
      <MessageScroller.Root className="flex min-h-0 flex-1 flex-col">
        <div className="relative flex min-h-0 flex-1 flex-col">
          <MessageScroller.Viewport aria-label="Process" className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4 pb-3 outline-none data-pending-scroll:invisible lg:p-6 lg:pb-3">
            <Header record={record} />
            <Facts record={record} project={found?.b} process={found?.p} reconnecting={followed.state === "reconnecting"} />
            <Separator />
            <Conversation record={record} list={list} settled={settled} />
          </MessageScroller.Viewport>
          <div className="pointer-events-none absolute inset-x-4 bottom-3 flex max-w-3xl justify-center lg:inset-x-6">
            <MessageScroller.Button className="pointer-events-auto data-[active=false]:hidden" render={<Button variant="outline" size="sm" className="rounded-full bg-background shadow-md" />}>
              <ArrowDownIcon />
              Back to the end
            </MessageScroller.Button>
          </div>
        </div>
        <Chat
          id={record.id}
          disabled={!writable(record)}
          placeholder={asking ? "Answer the question…" : record.state === "running" || record.state === "approval" ? "Write to the session…" : "Write to resume the session…"}
        />
      </MessageScroller.Root>
    </MessageScroller.Provider>
  )
}

function Header({ record }: { record: ProcessRecord }) {
  const [error, setError] = useState("")
  const [opening, setOpening] = useState(false)
  const [holding, setHolding] = useState(false)
  // A work process in implement may be held: its next complete keeps the session open, not the gate.
  const holdable = record.kind === "work" && record.stage === "implement"
  const toggle = async () => {
    setHolding(true)
    setError("")
    try {
      await hold(record.id, !record.hold)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setHolding(false)
    }
  }
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
        {/* A plan's own actions: its prototype leaves on a branch of its own, and a finish ends it. */}
        {record.kind === "plan" && (
          <div className="ml-auto flex gap-2">
            <Capture id={record.id} />
            <Finish id={record.id} project={record.project} />
          </div>
        )}
        {/* A hunt that removed nothing is done, and a finish ends it. */}
        {record.kind === "hunt" && record.state === "done" && (
          <div className="ml-auto flex gap-2">
            <Finish id={record.id} project={record.project} kind="hunt" />
          </div>
        )}
        {holdable && (
          <Button
            size="sm"
            variant={record.hold ? "default" : "outline"}
            className="ml-auto"
            aria-pressed={record.hold === true}
            disabled={holding}
            title={record.hold ? "Its next complete keeps the session open instead of starting the gate; click to release the hold" : "Keep the session open at its next complete instead of starting the gate"}
            onClick={() => void toggle()}
          >
            <PauseIcon />
            {record.hold ? "Held" : "Hold"}
          </Button>
        )}
        <Button
          size="sm"
          variant="outline"
          className={cn(record.kind !== "plan" && !holdable && !(record.kind === "hunt" && record.state === "done") && "ml-auto")}
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

const reported: Process["state"][] = ["blocked", "ready", "done", "failed"]

// tokens is a size in tokens as the fact row shows it: in thousands from a thousand on.
const tokens = (n: number) => (n < 1000 ? String(n) : `${Math.round(n / 1000)}k`)

// Facts is the row of facts under the title: the project, the branch, the pull request with its checks
// (the board's, else the one the record names),
// the mode, the time since the process last changed and the size of the session's context against the
// size at which a work session compacts. Below it are the stages, the current one filled, the ones done struck through.
function Facts({ record, project, process, reconnecting }: { record: ProcessRecord; project?: ProjectBoard; process?: Process; reconnecting: boolean }) {
  const kind = process?.kind ?? record.kind ?? "work"
  // A work process lists address-reviews once a review of its pull request was answered or is.
  const answering = (kind === "work" || kind === "hunt") && (record.history ?? []).some((a) => a.stage === "address-reviews")
  const listed = answering ? [...stagesOf[kind], "address-reviews"] : stagesOf[kind]
  const stages = listed.includes(record.stage) ? listed : [...listed, record.stage]
  const at = stages.indexOf(record.stage)
  const pinned = record.compact_at
  const pr = process?.pr ?? record.pull
  const share = record.context === undefined || pinned === undefined ? 0 : Math.min(100, (record.context / pinned) * 100)
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
        {pr && (
          <span aria-label="Pull request">
            <a href={pr.url} className="hover:text-foreground hover:underline">
              #{pr.number}
            </a>
            {record.draft && " the gate's draft"}
            {process?.checks && process.checks !== "none" && ` checks ${process.checks}`}
          </span>
        )}
        <Badge variant="outline">{record.mode ?? record.kind}</Badge>
        <span title={record.updated_at}>{age(record.updated_at)}</span>
        <span
          aria-label="Context"
          className="flex items-center gap-2"
          title={
            record.context === undefined
              ? "No usage yet"
              : pinned === undefined
                ? `${record.context.toLocaleString("en")} tokens`
                : `${record.context.toLocaleString("en")} of ${pinned.toLocaleString("en")} tokens before it compacts`
          }
        >
          context
          {pinned !== undefined && <Progress value={share} className="h-1.5 w-20" aria-label="Context size" />}
          {record.context === undefined ? "–" : tokens(record.context)}
        </span>
        {reconnecting && <span role="status">reconnecting…</span>}
      </div>
      {/* The report a session ended with: what is ready, the question a block asks, the reason of a failure. */}
      {reported.includes(record.state) && record.note && (
        <p aria-label="Note" className={cn("text-sm whitespace-pre-line", record.state === "failed" && "text-destructive")}>
          {record.note}
        </p>
      )}
      <ol aria-label="Stages" className="flex flex-wrap items-start gap-1.5">
        {stages.map((s, j) => {
          const attempts = (record.history ?? []).filter((a) => a.stage === s)
          return (
            <li key={s} className="flex flex-col gap-1">
              <Badge
                variant={j === at ? "default" : "outline"}
                aria-current={j === at ? "step" : undefined}
                className={cn(j < at && "border-transparent bg-muted text-muted-foreground line-through", j > at && "text-muted-foreground")}
              >
                {s}
              </Badge>
              {attempts.length > 0 && (
                <ol aria-label={`Records of ${s}`} className="flex flex-col gap-0.5 text-xs text-muted-foreground">
                  {attempts.map((a, i) => (
                    <li key={i} className={cn(failed(a) && "text-destructive")} title={a.tail ?? a.note ?? a.at}>
                      {described(a)} · {age(a.at)}
                    </li>
                  ))}
                </ol>
              )}
            </li>
          )
        })}
      </ol>
      {record.hunt && <HuntLog hunt={record.hunt} />}
      <Rounds history={record.history ?? []} />
      <FollowUps history={record.history ?? []} />
      {(record.stage === "ci" || record.stage === "gate" || record.stage === "address-reviews") && <Wait record={record} />}
    </>
  )
}

// HuntLog is the hunt record of a hunt process: its rounds and why it ended, each test it removed with why
// it proved nothing and whether another still proves its behaviour, and each candidate it checked and kept.
function HuntLog({ hunt }: { hunt: Hunt }) {
  return (
    <section aria-label="Hunt record" className="flex flex-col gap-2 text-sm">
      <span className="text-xs text-muted-foreground">
        {hunt.rounds === 0 ? "no round yet" : `round ${hunt.rounds} of at most ${hunt.max_rounds}`}
        {hunt.ended && ` · ended: ${hunt.ended}`}
      </span>
      {hunt.removed.length > 0 && (
        <ul aria-label="Removed tests" className="flex flex-col gap-1">
          {hunt.removed.map((r) => (
            <li key={`${r.path} ${r.test}`} className="flex flex-col gap-0.5">
              <span>
                removed <span className="font-mono">{r.test}</span> in <span className="font-mono">{r.path}</span> · {r.category} · round {r.round} at{" "}
                <span className="font-mono">{r.commit}</span>
              </span>
              <span className="pl-2 text-xs text-muted-foreground">
                {r.why} Still proven: {r.still_proven}
              </span>
            </li>
          ))}
        </ul>
      )}
      {hunt.kept.length > 0 && (
        <ul aria-label="Kept candidates" className="flex flex-col gap-1 text-xs text-muted-foreground">
          {hunt.kept.map((k) => (
            <li key={`${k.path} ${k.test}`}>
              kept <span className="font-mono">{k.test}</span> in <span className="font-mono">{k.path}</span> · {k.category}, {k.confidence}: {k.reason}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

// Rounds are the rounds of the review: each reviewer's verdict with its findings, and what the fix
// session after the round did with each finding.
function Rounds({ history }: { history: Attempt[] }) {
  const rounds = history.flatMap((a, i) => (a.stage === "review" && a.kind === "round" ? [{ a, i }] : []))
  if (rounds.length === 0) return null
  // The fixes of a round are those its fix sessions reported before the next round, the last one's first.
  const fixesOf = (i: number): Map<string, Fix> => {
    const out = new Map<string, Fix>()
    for (const b of history.slice(i + 1)) {
      if (b.stage === "review" && b.kind === "round") break
      if (b.stage === "review" && b.kind === "session") for (const f of b.fixes ?? []) out.set(f.finding, f)
    }
    return out
  }
  return (
    <ol aria-label="Review rounds" className="flex flex-col gap-2 text-sm">
      {rounds.map(({ a, i }) => {
        const fixes = fixesOf(i)
        return (
          <li key={i} aria-label={`Round ${a.round ?? ""}`} className="flex flex-col gap-1">
            <span className="text-xs text-muted-foreground">
              round {a.round} · {a.result} · {age(a.at)}
            </span>
            <ul className="flex flex-col gap-1">
              {(a.verdicts ?? []).map((v) => (
                <li key={v.reviewer} aria-label={`Verdict of ${v.reviewer}`} className="flex flex-col gap-0.5">
                  <span className="flex items-center gap-1.5">
                    <Badge variant={v.verdict === "pass" ? "outline" : "destructive"}>
                      {v.reviewer} {v.verdict}
                    </Badge>
                    {v.note && <span className="text-xs text-destructive">{v.note}</span>}
                  </span>
                  {v.findings.length > 0 && (
                    <ul aria-label={`Findings of ${v.reviewer}`} className="flex flex-col gap-0.5 pl-2 text-xs">
                      {v.findings.map((f) => {
                        const fix = fixes.get(f.id)
                        return (
                          <li key={f.id} title={f.fix}>
                            <span className="font-mono">{f.id}</span> {f.severity} <span className="font-mono">{f.where}</span>: {f.claim}
                            {fix && (
                              <span className={cn("block pl-2 text-muted-foreground", fix.outcome === "declined" && "italic")}>
                                {fix.outcome}: {fix.note}
                              </span>
                            )}
                          </li>
                        )
                      })}
                    </ul>
                  )}
                </li>
              ))}
            </ul>
          </li>
        )
      })}
    </ol>
  )
}

// FollowUps are the answers of the address-reviews stage: what each session answered, and the points it
// fixed and declined.
function FollowUps({ history }: { history: Attempt[] }) {
  const sessions = history.filter((a) => a.stage === "address-reviews" && a.kind === "session")
  if (sessions.length === 0) return null
  return (
    <ol aria-label="Follow-ups" className="flex flex-col gap-2 text-sm">
      {sessions.map((a, i) => (
        <li key={i} aria-label={`Follow-up ${i + 1}`} className="flex flex-col gap-0.5">
          <span className="text-xs text-muted-foreground">
            {a.mandate === "writer" ? "a writer's request" : "a bot's review"} · {a.result} · {age(a.at)}
          </span>
          <ul className="flex flex-col gap-0.5 pl-2 text-xs">
            {(a.fixed ?? []).map((p, j) => (
              <li key={`f${j}`}>fixed: {p}</li>
            ))}
            {(a.declined ?? []).map((p, j) => (
              <li key={`d${j}`} className="italic text-muted-foreground">
                declined: {p}
              </li>
            ))}
          </ul>
        </li>
      ))}
    </ol>
  )
}

// Wait is what the gate on CI or the ci stage waits for while it waits, the repair rounds the ci stage
// spent of its budget, and the checks of the pull request it read last, each with its state and a link to
// where it ran.
function Wait({ record }: { record: ProcessRecord }) {
  const checks = record.checks ?? []
  if (!record.wait && checks.length === 0 && !record.repairs) return null
  return (
    <div aria-label="CI" className="flex flex-col gap-1 text-sm">
      {record.wait && <span aria-label="Wait" className="text-muted-foreground">waiting for {record.wait}</span>}
      {record.repairs && (
        <span aria-label="Repair rounds" className="text-muted-foreground">
          repair rounds {record.repairs.spent} of {record.repairs.of}
        </span>
      )}
      {checks.length > 0 && (
        <ul aria-label="Checks" className="flex flex-wrap gap-1.5">
          {checks.map((c, i) => (
            <li key={i}>
              <Badge variant={c.state === "fail" ? "destructive" : "outline"} className={cn(c.state === "pending" && "text-muted-foreground")}>
                {c.url ? (
                  <a href={c.url} className="hover:underline">
                    {c.name}
                  </a>
                ) : (
                  c.name
                )}{" "}
                {c.state}
              </Badge>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

// failed tells an attempt that did not get its stage through: a failed or blocked session, a conflict, a
// failing run, a pull request that is not green.
const failed = (a: Attempt) => ["failed", "blocked", "conflict", "fail", "missing", "conflicts", "checks-failed", "review-comments", "closed", "partial"].includes(a.result)

// described is an attempt as the stage rail lists it: what ran and how it ended.
function described(a: Attempt): string {
  const at = a.commit ? ` at ${a.commit.slice(0, 7)}` : ""
  switch (a.kind) {
    case "merge":
      return `merge conflict in ${(a.files ?? []).join(", ")}`
    case "run":
      if (a.result === "skipped") return `${a.gate ?? "none"}: no gate ran`
      if (a.checks) return `${a.gate ?? "ci"} ${a.result}${at} on PR #${a.pr ?? ""}: ${a.checks.map((c) => `${c.name} ${c.state}`).join(", ") || "no check"}`
      return `${a.gate ? `${a.gate} ` : ""}${a.result === "pass" ? `pass${at}` : `fail${at}, exit ${a.exit ?? "none"}`}`
    case "round":
      return `round ${a.round ?? ""} ${a.result}`
    case "open":
      return `PR #${a.pr ?? ""} ${a.result}`
    case "wait":
      if (a.result === "review-comments") return `changes asked: ${(a.reviews ?? []).join("; ")}`
      if (a.result === "answered") return `answered, waits for the review again: ${(a.reviews ?? []).join("; ")}`
      return a.result
    case "answer":
      return `replied to ${a.replied?.length ?? 0} thread${a.replied?.length === 1 ? "" : "s"}${a.answered?.length ? ", answered the request" : ""}${a.result === "partial" ? ", not all posted" : ""}`
    default:
      if (a.stage === "address-reviews") {
        const mandate = a.mandate === "writer" ? "a writer's request" : "a bot's review"
        return `session ${a.result} on ${mandate}, fixed ${a.fixed?.length ?? 0}, declined ${a.declined?.length ?? 0}`
      }
      return `session ${a.result}${a.commits?.length ? `, ${a.commits.length} commit${a.commits.length === 1 ? "" : "s"}` : ""}`
  }
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

// Conversation is the log of the message scroller, one item per turn.
function Conversation({ record, list, settled }: { record: ProcessRecord; list: Turn[]; settled: Map<string, Settled> }) {
  if (list.length === 0) return <p className="text-sm text-muted-foreground">The session has written nothing yet.</p>
  return (
    <MessageScroller.Content aria-label="Conversation" className="flex w-full max-w-3xl flex-col gap-5">
      {/* A turn keeps its place as the log grows, and one line of the log can make several turns, so a
          turn is keyed by its place. */}
      {list.map((t, i) => (
        <MessageScroller.Item key={i}>
          <Turned record={record} turn={t} settled={settled} />
        </MessageScroller.Item>
      ))}
    </MessageScroller.Content>
  )
}

// Turned draws one turn of the conversation.
function Turned({ record, turn: t, settled }: { record: ProcessRecord; turn: Turn; settled: Map<string, Settled> }) {
  switch (t.kind) {
    case "session":
      return <Said text={t.text} tools={t.tools} />
    case "you":
      return <Said text={t.text} you />
    case "permission":
      return <Permission id={record.id} entry={t.entry} settled={settled.get(t.entry.request)} />
    case "question":
      return <Asked id={record.id} questions={t.entry.questions} settled={settled.get(t.entry.request)} />
    case "line":
      return (
        <p role="note" className="flex items-center gap-3 text-xs text-muted-foreground before:h-px before:flex-1 before:bg-border after:h-px after:flex-1 after:bg-border">
          {t.text}
        </p>
      )
  }
}

// The typeset draws code on the muted colour, which is the session's bubble itself, so there code sits
// on the background. The maintainer's bubble is primary, so the typeset inside it takes its text, code
// and rules from the primary foreground. Both follow light and dark with the theme.
const onMuted = "[--color-muted:var(--color-background)]"
const onPrimary =
  "[--color-foreground:var(--color-primary-foreground)] [--color-muted:color-mix(in_oklab,var(--color-primary-foreground)_15%,transparent)] [--color-muted-foreground:color-mix(in_oklab,var(--color-primary-foreground)_70%,transparent)] [--color-border:color-mix(in_oklab,var(--color-primary-foreground)_25%,transparent)]"

// Said is one turn of the session or of the maintainer, its markdown rendered, with the tool calls of
// the session as chips.
function Said({ text, tools = [], you = false }: { text: string; tools?: { name: string; detail: string; allowed: boolean }[]; you?: boolean }) {
  return (
    <div role="article" aria-label={you ? "You" : "Session"} className={cn("flex gap-3", you && "flex-row-reverse")}>
      <div className={cn("flex size-7 shrink-0 items-center justify-center rounded-full", you ? "bg-primary text-primary-foreground" : "bg-muted")}>
        {you ? <UserIcon className="size-3.5" /> : <BotIcon className="size-3.5" />}
      </div>
      <div className={cn("flex max-w-[85%] min-w-0 flex-col gap-2", you && "items-end")}>
        {text && (
          <div className={cn("max-w-full rounded-lg px-3 py-2 text-sm", you ? cn("bg-primary text-primary-foreground", onPrimary) : cn("bg-muted", onMuted))}>
            <Prose text={text} />
          </div>
        )}
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
            <Prose text={q.question} />
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
    <div className="px-4 pt-3 pb-4 lg:px-6">
      <form onSubmit={(e) => void send(e)} className="flex w-full max-w-3xl flex-col gap-2">
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
    </div>
  )
}
