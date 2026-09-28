import { IssueRow, Notes, ProcessRow } from "@/components/rows"
import { Section } from "@/components/section"
import { broken, type Board, type ProjectBoard } from "@/api"

// The Orchestrator page is the board over every project: what waits for a person, what runs, and the
// issues ready to start. A spec whose tickets are all closed waits for a person too.
export function Orchestrator({ board }: { board: Board }) {
  if (board.state === "failed") return <p role="alert" className="text-sm text-destructive">{board.error}</p>
  const boards = board.state === "loaded" ? board.projects.filter((b): b is ProjectBoard => !broken(b)) : []
  const processes = boards.flatMap((b) => b.processes.map((p) => ({ p, b })))
  const needs = processes.filter(({ p }) => p.needs)
  const running = processes.filter(({ p }) => !p.needs)
  const acceptance = boards.flatMap((b) => b.acceptance.map((i) => ({ i, b })))
  const frontier = boards.flatMap((b) => b.frontier.map((i) => ({ i, b })))
  return (
    <>
      <Notes boards={boards} />
      <Section title="Needs you" count={needs.length + acceptance.length} empty="Nothing waits for you">
        {needs.map(({ p, b }) => <ProcessRow key={b.path + p.branch} p={p} project={b} />)}
        {acceptance.map(({ i, b }) => <IssueRow key={b.path + i.number} i={i} project={b} accept />)}
      </Section>
      <Section title="Running" count={running.length} empty="Nothing running">
        {running.map(({ p, b }) => <ProcessRow key={b.path + p.branch} p={p} project={b} />)}
      </Section>
      <Section title="Ready to start" count={frontier.length} empty="Frontier empty">
        {frontier.map(({ i, b }) => <IssueRow key={b.path + i.number} i={i} project={b} />)}
      </Section>
    </>
  )
}
