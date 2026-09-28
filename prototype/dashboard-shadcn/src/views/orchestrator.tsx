import { SearchIcon } from "lucide-react"
import { FrontierRow } from "@/components/frontier-row"
import { ProcessRow } from "@/components/process-row"
import { Section } from "@/components/section"
import { Input } from "@/components/ui/input"
import { Kbd } from "@/components/ui/kbd"
import { all, primary, projects } from "@/data"

export function Orchestrator({ cmd }: { cmd: boolean }) {
  const need = all().filter((x) => primary(x))
  const run = all().filter((x) => !primary(x))
  const fr = projects.flatMap((p) => p.frontier.map((i) => ({ p, i })))
  return (
    <>
      {cmd && (
        <div className="relative">
          <SearchIcon className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input className="h-10 bg-background pr-16 pl-9 shadow-xs" placeholder="Tell the orchestrator what to do: claim #144, plan an idea, release v0.12.0, or ask a question" />
          <Kbd className="absolute top-1/2 right-3 -translate-y-1/2">⌘K</Kbd>
        </div>
      )}
      <Section title="Needs you" count={need.length} empty="Nothing waits for you">{need.map((x) => <ProcessRow key={x.id} x={x} />)}</Section>
      <Section title="Running" count={run.length} empty="Nothing running">{run.map((x) => <ProcessRow key={x.id} x={x} />)}</Section>
      <Section title="Ready to start" count={fr.length} empty="Frontier empty">{fr.map(({ p, i }) => <FrontierRow key={i.n} p={p} i={i} withProject />)}</Section>
    </>
  )
}
