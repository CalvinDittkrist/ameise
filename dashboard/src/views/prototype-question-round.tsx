// PROTOTYPE: throwaway variants of the question round card. Not for merge.
import { BotIcon, CheckIcon, ChevronDownIcon, MessageCircleQuestionIcon, SparklesIcon, UserIcon } from "lucide-react"
import { useState } from "react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Prose } from "@/components/markdown"
import { cn } from "@/lib/utils"

type Q = { title: string; question: string; options: string[]; recommended?: string; why?: string }

const round: Q[] = [
  {
    title: "Wie kommt die Runde ins Dashboard?",
    question: "Über `AskUserQuestion`, ein neues Controller-Tool `ask`, oder parst das Dashboard das Markdown?",
    options: ["AskUserQuestion", "Controller-Tool ask", "Markdown parsen"],
    recommended: "Controller-Tool ask",
    why: "Kein Limit von 4 Fragen, Empfehlung und Begründung sind eigene Felder, das Dashboard zeichnet Daten statt geparsten Text.",
  },
  {
    title: "Bedienung pro Frage",
    question: "Pro Frage: Empfehlung übernehmen, Option wählen oder eigener Text, dazu **Alle Empfehlungen übernehmen**; Senden erst, wenn jede Frage beantwortet ist.",
    options: [],
    recommended: "Genau so",
    why: "„Alle Empfehlungen“ deckt das häufigste „passt“ mit einem Klick ab.",
  },
  {
    title: "Chat bei offener Runde",
    question: "Was passiert mit einer Chat-Nachricht, während die Runde offen ist?\n\n- (a) gilt als allgemeine Antwort\n- (b) Chat ist gesperrt",
    options: ["(a) allgemeine Antwort", "(b) Chat gesperrt"],
    recommended: "(a) allgemeine Antwort",
    why: "So kannst du jederzeit „stopp, falsche Richtung“ sagen.",
  },
  {
    title: "Prototyp vor der Spec?",
    question: "Soll die Karte vor der Spec als Prototyp gebaut werden?",
    options: ["Ja", "Nein"],
    recommended: "Ja",
    why: "Die Optik klärt sich am Bild besser als im Gespräch.",
  },
]

type A = { text: string; rec: boolean } | undefined

function useAnswers() {
  const [answers, setAnswers] = useState<A[]>(round.map(() => undefined))
  const [sent, setSent] = useState(false)
  const set = (i: number, a: A) => setAnswers((x) => x.map((y, k) => (k === i ? a : y)))
  const all = () => setAnswers(round.map((q) => (q.recommended ? { text: q.recommended, rec: true } : undefined)))
  const done = answers.every(Boolean)
  return { answers, set, all, done, sent, send: () => setSent(true), reset: () => (setSent(false), setAnswers(round.map(() => undefined))) }
}

function Header({ open }: { open: boolean }) {
  return (
    <CardHeader>
      <CardTitle className="flex items-center gap-2 text-sm">
        <MessageCircleQuestionIcon className={cn("size-4", open ? "text-primary" : "text-muted-foreground")} />
        Question round
        <span className="font-normal text-muted-foreground">· {round.length} questions</span>
      </CardTitle>
    </CardHeader>
  )
}

function Other({ value, onChange }: { value: string; onChange: (s: string) => void }) {
  return <Input placeholder="Eigene Antwort …" value={value} onChange={(e) => onChange(e.target.value)} className="h-8 text-sm" />
}

// The answered round, the same for every variant: one line per question, the question behind a toggle.
function Answered({ answers, reset }: { answers: A[]; reset: () => void }) {
  return (
    <Card size="sm">
      <Header open={false} />
      <CardContent className="flex flex-col divide-y">
        {round.map((q, i) => (
          <details key={i} className="group py-2 first:pt-0">
            <summary className="flex cursor-pointer list-none items-baseline gap-2">
              <span className="w-6 shrink-0 font-mono text-xs text-muted-foreground">Q{i + 1}</span>
              <span className="min-w-0 flex-1 truncate text-muted-foreground">{q.title}</span>
              <span className="font-medium">{answers[i]?.text}</span>
              {answers[i]?.rec && <Badge variant="secondary" className="text-[10px]">recommended</Badge>}
              <ChevronDownIcon className="size-3.5 self-center text-muted-foreground transition group-open:rotate-180" />
            </summary>
            <div className="mt-2 pl-8 text-muted-foreground">
              <Prose text={q.question} />
              {q.why && <p className="mt-1 text-xs">Empfehlung: {q.recommended} — {q.why}</p>}
            </div>
          </details>
        ))}
      </CardContent>
      <CardFooter className="text-xs text-muted-foreground">
        <span>You answered</span>
        <button className="ml-auto underline" onClick={reset}>
          (prototype: reset)
        </button>
      </CardFooter>
    </Card>
  )
}

function Footer({ all, done, send }: { all: () => void; done: boolean; send: () => void }) {
  return (
    <CardFooter className="gap-2">
      <Button size="sm" variant="outline" onClick={all}>
        <SparklesIcon /> Alle Empfehlungen übernehmen
      </Button>
      <Button size="sm" className="ml-auto" disabled={!done} onClick={send}>
        Send
      </Button>
    </CardFooter>
  )
}

// A: every question a section of its own, options as buttons, the recommendation as a highlighted callout.
function VariantA() {
  const s = useAnswers()
  const [other, setOther] = useState<string[]>(round.map(() => ""))
  if (s.sent) return <Answered answers={s.answers} reset={s.reset} />
  return (
    <Card size="sm" className="bg-primary/5 ring-primary/40">
      <Header open />
      <CardContent className="flex flex-col gap-4">
        {round.map((q, i) => {
          const a = s.answers[i]
          return (
            <section key={i} className="flex flex-col gap-2 rounded-lg bg-background p-3 ring-1 ring-foreground/10">
              <h3 className="flex items-baseline gap-2 font-medium">
                <span className="font-mono text-xs text-muted-foreground">Q{i + 1}</span>
                {q.title}
                {a && <CheckIcon className="ml-auto size-4 self-center text-emerald-600" />}
              </h3>
              <Prose text={q.question} className="text-muted-foreground" />
              {q.recommended && (
                <button
                  onClick={() => s.set(i, { text: q.recommended!, rec: true })}
                  className={cn(
                    "flex flex-col items-start gap-0.5 rounded-md border border-dashed border-primary/40 px-3 py-2 text-left hover:bg-primary/5",
                    a?.rec && "border-solid border-primary bg-primary/10",
                  )}
                >
                  <span className="flex items-center gap-1.5 text-xs font-medium text-primary">
                    <SparklesIcon className="size-3.5" /> Empfehlung: {q.recommended}
                  </span>
                  {q.why && <span className="text-xs text-muted-foreground">{q.why}</span>}
                </button>
              )}
              <div className="flex flex-wrap items-center gap-2">
                {q.options
                  .filter((o) => o !== q.recommended)
                  .map((o) => (
                    <Button key={o} size="sm" variant={a?.text === o ? "default" : "outline"} onClick={() => s.set(i, { text: o, rec: false })}>
                      {o}
                    </Button>
                  ))}
                <div className="min-w-48 flex-1">
                  <Other
                    value={other[i]}
                    onChange={(t) => {
                      setOther((x) => x.map((y, k) => (k === i ? t : y)))
                      s.set(i, t ? { text: t, rec: false } : undefined)
                    }}
                  />
                </div>
              </div>
            </section>
          )
        })}
      </CardContent>
      <Footer all={s.all} done={s.done} send={s.send} />
    </Card>
  )
}

// B: dense list, one row per question with the recommendation as the default answer; "ändern" opens the rest.
function VariantB() {
  const s = useAnswers()
  const [openRow, setOpenRow] = useState<number | null>(null)
  if (s.sent) return <Answered answers={s.answers} reset={s.reset} />
  return (
    <Card size="sm" className="bg-primary/5 ring-primary/40">
      <Header open />
      <CardContent className="flex flex-col divide-y rounded-lg bg-background ring-1 ring-foreground/10">
        {round.map((q, i) => {
          const a = s.answers[i]
          const expanded = openRow === i
          return (
            <div key={i} className="flex flex-col gap-2 p-3">
              <div className="flex items-start gap-3">
                <span className="mt-0.5 w-6 shrink-0 font-mono text-xs text-muted-foreground">Q{i + 1}</span>
                <div className="min-w-0 flex-1">
                  <p className="font-medium">{q.title}</p>
                  {q.recommended && (
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      <span className="text-primary">Empfohlen: {q.recommended}</span>
                      {q.why && <> — {q.why}</>}
                    </p>
                  )}
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  {q.recommended && (
                    <Button size="sm" variant={a?.rec ? "default" : "outline"} onClick={() => s.set(i, { text: q.recommended!, rec: true })}>
                      <CheckIcon /> Übernehmen
                    </Button>
                  )}
                  <Button size="sm" variant="ghost" onClick={() => setOpenRow(expanded ? null : i)}>
                    {a && !a.rec ? a.text : "Ändern"} <ChevronDownIcon className={cn("transition", expanded && "rotate-180")} />
                  </Button>
                </div>
              </div>
              {expanded && (
                <div className="ml-9 flex flex-col gap-2">
                  <Prose text={q.question} className="text-muted-foreground" />
                  <div className="flex flex-wrap gap-2">
                    {q.options.map((o) => (
                      <Button key={o} size="sm" variant={a?.text === o ? "default" : "outline"} onClick={() => s.set(i, { text: o, rec: o === q.recommended })}>
                        {o}
                      </Button>
                    ))}
                  </div>
                  <Other value={a && !a.rec && !q.options.includes(a.text) ? a.text : ""} onChange={(t) => s.set(i, t ? { text: t, rec: false } : undefined)} />
                </div>
              )}
            </div>
          )
        })}
      </CardContent>
      <Footer all={s.all} done={s.done} send={s.send} />
    </Card>
  )
}

// C: one question at a time with steps above; the recommendation is the preselected first option.
function VariantC() {
  const s = useAnswers()
  const [step, setStep] = useState(0)
  const [other, setOther] = useState("")
  if (s.sent) return <Answered answers={s.answers} reset={s.reset} />
  const q = round[step]
  const a = s.answers[step]
  const opts = [...(q.recommended ? [q.recommended] : []), ...q.options.filter((o) => o !== q.recommended)]
  return (
    <Card size="sm" className="bg-primary/5 ring-primary/40">
      <Header open />
      <CardContent className="flex flex-col gap-3">
        <div className="flex gap-1.5">
          {round.map((r, i) => (
            <button
              key={i}
              onClick={() => setStep(i)}
              title={r.title}
              className={cn(
                "flex h-7 flex-1 items-center justify-center gap-1 rounded-md text-xs ring-1 ring-foreground/10",
                i === step ? "bg-primary text-primary-foreground" : s.answers[i] ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400" : "bg-background",
              )}
            >
              {s.answers[i] && i !== step && <CheckIcon className="size-3" />} Q{i + 1}
            </button>
          ))}
        </div>
        <div className="flex flex-col gap-2 rounded-lg bg-background p-4 ring-1 ring-foreground/10">
          <h3 className="text-base font-medium">{q.title}</h3>
          <Prose text={q.question} className="text-muted-foreground" />
          <div className="mt-1 flex flex-col gap-1.5">
            {opts.map((o) => (
              <button
                key={o}
                onClick={() => {
                  s.set(step, { text: o, rec: o === q.recommended })
                  if (step < round.length - 1) setStep(step + 1)
                }}
                className={cn("flex items-start gap-2 rounded-md px-3 py-2 text-left ring-1 ring-foreground/10 hover:bg-muted", a?.text === o && "ring-2 ring-primary")}
              >
                <span className="flex-1">
                  {o}
                  {o === q.recommended && q.why && <span className="block text-xs text-muted-foreground">{q.why}</span>}
                </span>
                {o === q.recommended && <Badge className="text-[10px]">Empfohlen</Badge>}
              </button>
            ))}
            <Other
              value={other}
              onChange={(t) => {
                setOther(t)
                s.set(step, t ? { text: t, rec: false } : undefined)
              }}
            />
          </div>
        </div>
      </CardContent>
      <Footer all={s.all} done={s.done} send={s.send} />
    </Card>
  )
}

const variants = { A: VariantA, B: VariantB, C: VariantC }
const names = { A: "A · Abschnitte", B: "B · Kompakte Liste", C: "C · Schritt für Schritt" }

export function PrototypeQuestionRound() {
  const [v, setV] = useState<keyof typeof variants>("A")
  const V = variants[v]
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium">Prototype: question round</span>
        {(Object.keys(variants) as (keyof typeof variants)[]).map((k) => (
          <Button key={k} size="sm" variant={v === k ? "default" : "outline"} onClick={() => setV(k)}>
            {names[k]}
          </Button>
        ))}
        <Button size="sm" variant="ghost" onClick={() => document.documentElement.classList.toggle("dark")}>
          Hell/Dunkel
        </Button>
      </div>
      <div className="flex w-full max-w-3xl flex-col gap-5">
        <div className="flex gap-3">
          <div className="flex size-7 shrink-0 items-center justify-center rounded-full bg-muted">
            <BotIcon className="size-3.5" />
          </div>
          <div className="rounded-lg bg-muted px-3 py-2 text-sm">
            <Prose text="Fakten: `AskUserQuestion` erlaubt 1–4 Fragen mit 2–4 Optionen. Hier die zweite Runde." />
          </div>
        </div>
        <V key={v} />
        <div className="flex flex-row-reverse gap-3 opacity-50">
          <div className="flex size-7 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground">
            <UserIcon className="size-3.5" />
          </div>
          <div className="rounded-lg bg-primary px-3 py-2 text-sm text-primary-foreground">(Chat darunter wie bisher)</div>
        </div>
      </div>
    </div>
  )
}
