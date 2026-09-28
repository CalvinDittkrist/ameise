import { Section } from "@/components/section"

// The Orchestrator page is the board over every project: what waits for a person, what runs, and the
// issues ready to start. The controller serves no processes and no frontier yet, so each section says
// it is empty.
export function Orchestrator() {
  return (
    <>
      <Section title="Needs you" count={0} empty="Nothing waits for you" />
      <Section title="Running" count={0} empty="Nothing running" />
      <Section title="Ready to start" count={0} empty="Frontier empty" />
    </>
  )
}
