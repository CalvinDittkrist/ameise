import { ChevronDownIcon } from "lucide-react"
import { FrontierRow } from "@/components/frontier-row"
import { ProcessRow } from "@/components/process-row"
import { Section } from "@/components/section"
import { Button } from "@/components/ui/button"
import { projects } from "@/data"

export function ProjectView({ id }: { id: string | null }) {
  const p = projects.find((x) => x.id === id) ?? projects[0]
  const ps = p.processes.map((x) => ({ ...x, project: p }))
  return (
    <>
      <div className="flex items-center gap-3">
        <h1 className="text-xl font-semibold">{p.name}</h1>
        <span className="text-sm text-muted-foreground">base {p.base}</span>
        <div className="ml-auto flex gap-2">
          <Button size="sm" variant="outline">Plan</Button>
          <Button size="sm" variant="outline">Standardize</Button>
          <Button size="sm" variant="outline">Hunt tests</Button>
          <Button size="sm" variant="ghost">Release <ChevronDownIcon /></Button>
        </div>
      </div>
      <Section title="Processes" count={ps.length} empty="Nothing running">{ps.map((x) => <ProcessRow key={x.id} x={x} withProject={false} />)}</Section>
      <Section title="Ready to start" count={p.frontier.length} empty="Frontier empty">{p.frontier.map((i) => <FrontierRow key={i.n} p={p} i={i} withProject={false} />)}</Section>
    </>
  )
}
