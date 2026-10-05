import { CheckIcon, ChevronDownIcon, MessageCircleQuestionIcon, SparklesIcon } from "lucide-react"
import { useState } from "react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Prose } from "@/components/markdown"
import { answerRound, type Reply, type RoundAnswer, type RoundQuestion } from "@/api"
import { cn } from "@/lib/utils"

// How a round was settled: by one answer per question, by a chat message in the maintainer's words, or by
// the end of its session without an answer.
export type RoundSettled = { answers?: RoundAnswer[]; text?: string } | "closed"

// offered are the labels of a question in the order the card offers them: the recommendation first, also
// when it is none of the options. The controller joins a multi-select answer in the same order.
const offered = (q: RoundQuestion): string[] => (q.recommended ? [q.recommended, ...q.options.filter((o) => o !== q.recommended)] : q.options)

// chosen are the labels a reply chose of a question.
const chosen = (q: RoundQuestion, r: Reply | undefined): string[] => {
  if (!r) return []
  if ("recommended" in r) return q.recommended ? [q.recommended] : []
  return Array.isArray(r.answer) ? r.answer : offered(q).includes(r.answer) ? [r.answer] : []
}

// QuestionRound is a question round the session asks through the controller tool ask. Open, it shows one
// question at a time under tabs Q1 to Qn: the options as rows with the recommendation first, and a field
// for an answer of the maintainer's own. Choosing an option of a question that takes one answers it and
// moves to the next tab. Send stays disabled until every question has an answer. Answered, it shows one
// line per question, which opens to the question and the recommendation with its reason.
export function QuestionRound({ id, request, questions, settled }: { id: string; request: string; questions: RoundQuestion[]; settled?: RoundSettled }) {
  const count = `${questions.length} question${questions.length === 1 ? "" : "s"}`
  const open = settled === undefined
  return (
    <Card role="article" aria-label="Question round" size="sm" className={cn(open && "bg-primary/5 ring-primary/40")}>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-sm">
          <MessageCircleQuestionIcon className={cn("size-4", open ? "text-primary" : "text-muted-foreground")} />
          Question round
          <span className="font-normal text-muted-foreground">· {count}</span>
        </CardTitle>
      </CardHeader>
      {open ? <Asking id={id} request={request} questions={questions} /> : <Answered questions={questions} settled={settled} />}
    </Card>
  )
}

function Asking({ id, request, questions }: { id: string; request: string; questions: RoundQuestion[] }) {
  const [step, setStep] = useState(0)
  const [replies, setReplies] = useState<(Reply | undefined)[]>(() => questions.map(() => undefined))
  // own is the answer of the maintainer's own per question, which stands in place of a chosen option.
  const [own, setOwn] = useState<string[]>(() => questions.map(() => ""))
  const [error, setError] = useState("")
  const [sending, setSending] = useState(false)
  const q = questions[step]
  const reply = replies[step]
  const set = (i: number, r: Reply | undefined) => setReplies((x) => x.map((y, k) => (k === i ? r : y)))
  const choose = (o: string) => {
    setOwn((x) => x.map((y, k) => (k === step ? "" : y)))
    if (q.multiSelect) {
      const before = chosen(q, reply)
      const now = offered(q).filter((l) => (l === o ? !before.includes(l) : before.includes(l)))
      set(step, now.length === 0 ? undefined : now.length === 1 && now[0] === q.recommended ? { recommended: true } : { answer: now })
      return
    }
    set(step, o === q.recommended ? { recommended: true } : { answer: o })
    if (step < questions.length - 1) setStep(step + 1)
  }
  const write = (text: string) => {
    setOwn((x) => x.map((y, k) => (k === step ? text : y)))
    set(step, text.trim() === "" ? undefined : { answer: text })
  }
  const recommended = questions.some((x) => x.recommended)
  const acceptAll = () => {
    setReplies((x) => x.map((r, k) => (questions[k].recommended ? { recommended: true } : r)))
    setOwn((x) => x.map((t, k) => (questions[k].recommended ? "" : t)))
  }
  const done = replies.every((r) => r !== undefined)
  const send = async () => {
    setSending(true)
    setError("")
    try {
      await answerRound(id, request, replies as Reply[])
    } catch (err) {
      setError((err as Error).message)
      setSending(false)
    }
  }
  const picked = chosen(q, reply)
  return (
    <>
      <CardContent className="flex flex-col gap-3">
        <div role="tablist" aria-label="Questions" className="flex gap-1.5">
          {questions.map((x, i) => (
            <button
              key={i}
              type="button"
              role="tab"
              aria-selected={i === step}
              aria-label={`Q${i + 1}${replies[i] ? ", answered" : ""}`}
              title={x.title}
              onClick={() => setStep(i)}
              className={cn(
                "flex h-7 flex-1 items-center justify-center gap-1 rounded-md text-xs font-medium ring-1 ring-foreground/10 transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring",
                i === step ? "bg-primary text-primary-foreground ring-primary" : replies[i] ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400" : "bg-background hover:bg-muted",
              )}
            >
              {replies[i] && i !== step && <CheckIcon className="size-3" />}Q{i + 1}
            </button>
          ))}
        </div>
        <div role="tabpanel" aria-label={`Q${step + 1} ${q.title}`} className="flex flex-col gap-2 rounded-lg bg-background p-4 ring-1 ring-foreground/10">
          <h3 className="text-base font-medium">{q.title}</h3>
          <Prose text={q.question} className="text-sm text-muted-foreground" />
          {q.multiSelect && <p className="text-xs text-muted-foreground">Choose any of them.</p>}
          <div className="mt-1 flex flex-col gap-1.5">
            {offered(q).map((o) => (
              <button
                key={o}
                type="button"
                aria-pressed={picked.includes(o)}
                disabled={sending}
                onClick={() => choose(o)}
                className={cn(
                  "flex items-start gap-2 rounded-md px-3 py-2 text-left text-sm ring-1 ring-foreground/10 transition-colors outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50",
                  picked.includes(o) && "bg-primary/5 ring-2 ring-primary",
                )}
              >
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span>{o}</span>
                  {o === q.recommended && q.why && <span className="text-xs text-muted-foreground">{q.why}</span>}
                </span>
                {o === q.recommended && <Badge className="text-[10px]">Recommended</Badge>}
              </button>
            ))}
            <Input aria-label="Your own answer" placeholder="Your own answer…" disabled={sending} value={own[step]} onChange={(e) => write(e.target.value)} className="h-8 text-sm" />
          </div>
        </div>
      </CardContent>
      <CardFooter className="flex-wrap gap-2">
        {recommended && (
          <Button size="sm" variant="outline" disabled={sending} onClick={acceptAll}>
            <SparklesIcon />
            Accept all recommendations
          </Button>
        )}
        <Button size="sm" className="ml-auto" disabled={!done || sending} onClick={() => void send()}>
          Send
        </Button>
        {error && (
          <p role="alert" className="w-full text-sm text-destructive">
            {error}
          </p>
        )}
      </CardFooter>
    </>
  )
}

function Answered({ questions, settled }: { questions: RoundQuestion[]; settled: RoundSettled }) {
  const answers = settled === "closed" ? undefined : settled.answers
  return (
    <>
      <CardContent className="flex flex-col divide-y text-sm">
        {questions.map((q, i) => (
          <details key={i} className="group py-2 first:pt-0 last:pb-0">
            <summary className="flex h-6 cursor-pointer list-none items-center gap-2 [&::-webkit-details-marker]:hidden">
              <span className="w-6 shrink-0 font-mono text-xs text-muted-foreground">Q{i + 1}</span>
              <span className="min-w-0 flex-1 truncate text-muted-foreground">{q.title}</span>
              {answers?.[i] && <span className="min-w-0 truncate font-medium">{answers[i].answer}</span>}
              {answers?.[i]?.recommended && (
                <Badge variant="secondary" className="text-[10px]">
                  recommended
                </Badge>
              )}
              <ChevronDownIcon className="size-3.5 shrink-0 text-muted-foreground transition group-open:rotate-180" />
            </summary>
            <div className="mt-2 flex flex-col gap-1 pl-8 text-muted-foreground">
              <Prose text={q.question} />
              {q.recommended && (
                <p className="text-xs">
                  Recommended: {q.recommended}
                  {q.why && `. ${q.why}`}
                </p>
              )}
            </div>
          </details>
        ))}
      </CardContent>
      <CardFooter className="text-xs text-muted-foreground">
        <span role="status">{settled === "closed" ? "The session ended before it was answered" : answers ? "You answered" : `You replied: ${settled.text ?? ""}`}</span>
      </CardFooter>
    </>
  )
}
