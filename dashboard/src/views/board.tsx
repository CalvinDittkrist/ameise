import { IssueRow, Notes, ProcessRow } from "@/components/rows"
import { Section } from "@/components/section"
import { broken, type Board, type ProjectBoard } from "@/api"

// The Board page is the view over every project: what waits for a person, what runs, and the
// issues ready to start. A spec whose tickets are all closed waits for a person too.
export function BoardView({ board, reload }: { board: Board; reload: () => Promise<void> }) {
  if (board.state === "failed") return <p role="alert" className="text-sm text-destructive">{board.error}</p>
  const boards = board.state === "loaded" ? board.projects.filter((b): b is ProjectBoard => !broken(b)) : []
  const processes = boards.flatMap((b) => b.processes.map((p) => ({ p, b })))
  const needs = processes.filter(({ p }) => p.needs)
  const running = processes.filter(({ p }) => !p.needs)
  const acceptance = boards.flatMap((b) => b.acceptance.map((i) => ({ i, b })))
  const frontier = boards.flatMap((b) => b.frontier.map((i) => ({ i, b })))
  const loading = board.state === "loading"
  return (
    <>
      <Notes boards={boards} />
      <Section title="Needs you" count={needs.length + acceptance.length} empty="Nothing waits for you" loading={loading}>
        {needs.map(({ p, b }) => <ProcessRow key={b.path + p.branch} p={p} project={b} path={b.path} reload={reload} />)}
        {acceptance.map(({ i, b }) => <IssueRow key={b.path + i.number} i={i} project={b} path={b.path} reload={reload} accept />)}
      </Section>
      <Section title="Running" count={running.length} empty="Nothing running" loading={loading}>
        {running.map(({ p, b }) => <ProcessRow key={b.path + p.branch} p={p} project={b} path={b.path} reload={reload} />)}
      </Section>
      <Section title="Ready to start" count={frontier.length} empty="Frontier empty" loading={loading}>
        {frontier.map(({ i, b }) => <IssueRow key={b.path + i.number} i={i} project={b} path={b.path} reload={reload} />)}
      </Section>
    </>
  )
}
