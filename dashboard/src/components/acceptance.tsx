import { type FormEvent, useState } from "react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { type AcceptanceItem, answerItems, checkAgain, type ItemAnswer, type ProcessRecord } from "@/api"

// A draft of the answer to an item not met, as the form holds it before it is sent.
type Draft = { answer: ItemAnswer["answer"] | ""; title: string; what: string; reason: string }

const choices: { answer: ItemAnswer["answer"]; label: string }[] = [
  { answer: "gap", label: "Gap ticket" },
  { answer: "deviation", label: "Accepted deviation" },
  { answer: "none", label: "No finding" },
]

// written says what the controller wrote for an answered item.
const written = (w: string) => (w.startsWith("#") ? `gap ticket ${w}` : w === "deviation" ? "deviation posted on the spec" : "no finding")

// Acceptance is the items of an acceptance on its process page: each with its verdict, evidence and
// confidence. Each item not met takes one of three answers, a gap ticket, an accepted deviation or no
// finding, and the answers are sent together. With nothing left open the spec closes. A failed
// acceptance checks again.
export function Acceptance({ record }: { record: ProcessRecord }) {
  const a = record.acceptance
  const [drafts, setDrafts] = useState<Record<string, Draft>>({})
  const [error, setError] = useState("")
  const [sending, setSending] = useState(false)
  const run = async (f: () => Promise<unknown>) => {
    setSending(true)
    setError("")
    try {
      await f()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setSending(false)
    }
  }
  if (!a) {
    if (record.state !== "failed") return null
    return (
      <div className="flex flex-col gap-2">
        <Button size="sm" className="self-start" disabled={sending} onClick={() => void run(() => checkAgain(record.id))}>
          Check again
        </Button>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
      </div>
    )
  }
  const done = a.closed === true || a.gaps !== undefined
  const open = a.items.filter((i) => i.verdict !== "met" && !i.written)
  const draft = (i: AcceptanceItem): Draft => drafts[i.id] ?? { answer: "", title: i.statement, what: "", reason: "" }
  const set = (i: AcceptanceItem, change: Partial<Draft>) => setDrafts((d) => ({ ...d, [i.id]: { ...draft(i), ...change } }))
  const submit = (e: FormEvent) => {
    e.preventDefault()
    const answers = open.map((i) => {
      const d = draft(i)
      if (d.answer === "gap") return { item: i.id, answer: "gap" as const, title: d.title, ...(d.what.trim() ? { what: d.what } : {}) }
      if (d.answer === "deviation") return { item: i.id, answer: "deviation" as const, reason: d.reason }
      return { item: i.id, answer: "none" as const, ...(d.reason.trim() ? { reason: d.reason } : {}) }
    })
    void run(() => answerItems(record.id, answers))
  }
  const ready = open.every((i) => {
    const d = draft(i)
    return d.answer === "none" || (d.answer === "gap" && d.title.trim() !== "") || (d.answer === "deviation" && d.reason.trim() !== "")
  })
  return (
    <form aria-label="Acceptance" onSubmit={submit} className="flex max-w-3xl flex-col gap-3 text-sm">
      <p className="text-muted-foreground">
        {a.tickets.length} ticket(s), {a.files} file(s), {a.deviations.length} deviation(s) accepted earlier
        {a.repeated > 0 ? `, ${a.repeated} item(s) left out as accepted earlier` : ""}
      </p>
      {a.notes.length > 0 && (
        <ul aria-label="Notes" className="flex flex-col gap-0.5 text-xs text-amber-700 dark:text-amber-400">
          {a.notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      )}
      <ol aria-label="Items" className="flex flex-col gap-3">
        {a.items.map((i) => {
          const d = draft(i)
          const answering = i.verdict !== "met" && !i.written && !done
          return (
            <li key={i.id} aria-label={i.id} className="flex flex-col gap-1.5 rounded-md border p-3">
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant={i.verdict === "met" ? "outline" : "destructive"}>{i.verdict}</Badge>
                <span className="text-xs text-muted-foreground">
                  {i.section} · confidence {i.confidence}
                </span>
              </div>
              <span>{i.statement}</span>
              <span className="text-xs break-all text-muted-foreground">{i.evidence}</span>
              {i.written && <span className="text-xs">{written(i.written)}</span>}
              {answering && (
                <fieldset className="flex flex-col gap-2">
                  <legend className="sr-only">Answer to {i.id}</legend>
                  <div className="flex flex-wrap gap-2">
                    {choices.map((c) => (
                      <Button
                        key={c.answer}
                        type="button"
                        size="sm"
                        variant={d.answer === c.answer ? "default" : "outline"}
                        aria-pressed={d.answer === c.answer}
                        onClick={() => set(i, { answer: c.answer })}
                      >
                        {c.label}
                      </Button>
                    ))}
                  </div>
                  {d.answer === "gap" && (
                    <>
                      <Label htmlFor={`${i.id}-title`}>Title</Label>
                      <Input id={`${i.id}-title`} value={d.title} onChange={(e) => set(i, { title: e.target.value })} />
                      <Label htmlFor={`${i.id}-what`}>What to build</Label>
                      <Textarea id={`${i.id}-what`} value={d.what} placeholder="The statement as the item names it" onChange={(e) => set(i, { what: e.target.value })} />
                    </>
                  )}
                  {(d.answer === "deviation" || d.answer === "none") && (
                    <>
                      <Label htmlFor={`${i.id}-reason`}>{d.answer === "deviation" ? "Why the code is right" : "Why it is no finding"}</Label>
                      <Textarea id={`${i.id}-reason`} value={d.reason} onChange={(e) => set(i, { reason: e.target.value })} />
                    </>
                  )}
                </fieldset>
              )}
            </li>
          )
        })}
      </ol>
      {!done && record.state === "input" && (
        <Button type="submit" className="self-start" disabled={sending || !ready}>
          {open.length > 0 ? "Write the answers" : "Close the spec"}
        </Button>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </form>
  )
}
