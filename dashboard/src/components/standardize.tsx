import { type FormEvent, useState } from "react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { applyStandard, auditAgain, finalizeStandard, type ProcessRecord, type StandardAnswer, type StandardCategory } from "@/api"

const choices: { answer: StandardAnswer; label: string }[] = [
  { answer: "approve", label: "Approve" },
  { answer: "reject", label: "Reject" },
]

// Standardize is the audit and the apply of a standardize process on its page: the findings per category,
// what approving each triggers, and one approval per category. The answers are sent together and the
// controller applies the approved categories alone. Then the steps of the apply, the cleanup pull request
// and the catalogue issue, and the finalize once the pull request is merged. A failed stage runs again.
export function Standardize({ record }: { record: ProcessRecord }) {
  const st = record.standardize
  const [answers, setAnswers] = useState<Partial<Record<StandardCategory, StandardAnswer>>>({})
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
  const alert = error && (
    <p role="alert" className="text-sm text-destructive">
      {error}
    </p>
  )
  if (!st) {
    if (record.state !== "failed") return null
    return (
      <div className="flex flex-col gap-2">
        <Button size="sm" className="self-start" disabled={sending} onClick={() => void run(() => auditAgain(record.id))}>
          Audit again
        </Button>
        {alert}
      </div>
    )
  }
  const answering = record.stage === "audit" && record.state === "input"
  const ready = st.categories.every((c) => answers[c.name] !== undefined)
  const submit = (e: FormEvent) => {
    e.preventDefault()
    void run(() => applyStandard(record.id, answers))
  }
  return (
    <form aria-label="Standardisation" onSubmit={submit} className="flex max-w-3xl flex-col gap-3 text-sm">
      <p className="text-muted-foreground">{st.summary}</p>
      {st.unaudited && (
        <p role="status" className="text-xs text-amber-700 dark:text-amber-400">
          The GitHub workspace was not audited: {st.unaudited}
        </p>
      )}
      {st.dropped.length > 0 && (
        <ul aria-label="Dropped findings" className="flex flex-col gap-0.5 text-xs text-amber-700 dark:text-amber-400">
          {st.dropped.map((d) => (
            <li key={d}>dropped: {d}</li>
          ))}
        </ul>
      )}
      <ol aria-label="Categories" className="flex flex-col gap-3">
        {st.categories.map((c) => {
          const chosen = answering ? answers[c.name] : c.answer
          return (
            <li key={c.name} aria-label={c.name} className="flex flex-col gap-1.5 rounded-md border p-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{c.name}</span>
                <span className="text-xs text-muted-foreground">{c.findings.length === 0 ? "no finding; approving scaffolds its baseline" : `${c.findings.length} finding(s)`}</span>
                {!answering && c.answer && (
                  <Badge variant={c.answer === "approve" ? "default" : "outline"} className="ml-auto">
                    {c.answer === "approve" ? "approved" : "rejected"}
                  </Badge>
                )}
              </div>
              {c.findings.length > 0 && (
                <ul className="flex flex-col gap-1">
                  {c.findings.map((f) => (
                    <li key={`${f.action} ${f.target}`} className="flex flex-col">
                      <span>
                        <Badge variant="outline" className="mr-2">
                          {f.action}
                        </Badge>
                        <span className="break-all">{f.target}</span>
                      </span>
                      <span className="text-xs text-muted-foreground">
                        {f.reason} · confidence {f.confidence}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              {c.report.length > 0 && <pre className="overflow-x-auto rounded bg-muted p-2 text-xs whitespace-pre-wrap">{c.report.map((l) => l.trim()).join("\n")}</pre>}
              {answering && (
                <fieldset className="flex flex-wrap gap-2">
                  <legend className="sr-only">Answer to {c.name}</legend>
                  {choices.map((o) => (
                    <Button
                      key={o.answer}
                      type="button"
                      size="sm"
                      variant={chosen === o.answer ? "default" : "outline"}
                      aria-pressed={chosen === o.answer}
                      onClick={() => setAnswers((a) => ({ ...a, [c.name]: o.answer }))}
                    >
                      {o.label}
                    </Button>
                  ))}
                </fieldset>
              )}
            </li>
          )
        })}
      </ol>
      {answering && (
        <Button type="submit" className="self-start" disabled={sending || !ready}>
          Apply the approved categories
        </Button>
      )}
      {st.applied && st.applied.length > 0 && (
        <ol aria-label="Applied" className="flex flex-col gap-1.5">
          {st.applied.map((s) => (
            <li key={`${s.step} ${s.at}`} className="flex flex-col gap-0.5">
              <span className="flex items-center gap-2">
                <Badge variant={s.ok ? "outline" : "destructive"}>{s.ok ? "ok" : "failed"}</Badge>
                {s.step}
              </span>
              {s.lines.length > 0 && <pre className="overflow-x-auto text-xs whitespace-pre-wrap text-muted-foreground">{s.lines.join("\n")}</pre>}
            </li>
          ))}
        </ol>
      )}
      {(st.pull || st.catalogue) && (
        <p className="flex flex-wrap gap-x-4">
          {st.pull && (
            <a className="underline" href={st.pull} target="_blank" rel="noreferrer">
              cleanup pull request
            </a>
          )}
          {st.catalogue && <span>catalogue issue #{st.catalogue}</span>}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        {record.stage === "audit" && record.state === "failed" && (
          <Button type="button" size="sm" disabled={sending} onClick={() => void run(() => auditAgain(record.id))}>
            Audit again
          </Button>
        )}
        {record.stage === "apply" && (record.state === "failed" || record.state === "blocked") && (
          <Button type="button" size="sm" disabled={sending} onClick={() => void run(() => applyStandard(record.id))}>
            Apply again
          </Button>
        )}
        {(record.state === "ready" || (record.stage === "finalize" && record.state === "failed")) && (
          <Button type="button" size="sm" disabled={sending} onClick={() => void run(() => finalizeStandard(record.id))}>
            Finalize
          </Button>
        )}
      </div>
      {alert}
    </form>
  )
}
