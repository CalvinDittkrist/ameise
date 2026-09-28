// Canned data. State lives in memory only.
export type State = "running" | "waiting" | "blocked" | "idle" | "ready" | "needs"
export type Kind = "work" | "plan" | "hunt" | "standardize"
export type Process = {
  id: string; kind: Kind; mode?: "manual" | "yolo"; issue?: number; title: string; branch: string
  stage: string; state: State; since: string; note: string; pr?: number
}
export type Issue = { n: number; title: string; m: string }
export type Project = { id: string; name: string; base: string; processes: Process[]; frontier: Issue[] }

export const projects: Project[] = [
  { id: "workflows", name: "workflows", base: "main",
    processes: [
      { id: "p142", kind: "work", mode: "manual", issue: 142, title: "Read the configuration and derive the projects", branch: "feat/142-read-the-configuration", stage: "implement", state: "running", since: "12m", note: "Writing the config reader, tests green" },
      { id: "p131", kind: "work", mode: "yolo", issue: 131, title: "Log the sensor drift", branch: "fix/131-log-the-sensor-drift", stage: "ci", state: "waiting", since: "3m", note: "PR #250, checks pending", pr: 250 },
      { id: "p118", kind: "work", mode: "manual", issue: 118, title: "Refuse a project without an origin", branch: "feat/118-refuse-a-project", stage: "implement", state: "blocked", since: "41m", note: "Asks: keep the project in the file, or drop it?" },
      { id: "plan1", kind: "plan", title: "Open planning session", branch: "plan/open-20260928-0011", stage: "plan", state: "idle", since: "2h", note: "Waiting for you" },
    ],
    frontier: [
      { n: 144, title: "Board lists every project with its processes", m: "v0.12.0" },
      { n: 145, title: "Claim from the frontier by one action", m: "v0.12.0" },
      { n: 151, title: "Native notification on blocked, ready and failed", m: "v0.12.0" },
    ],
  },
  { id: "trader", name: "ultimate-trader", base: "dev",
    processes: [
      { id: "p88", kind: "work", mode: "manual", issue: 88, title: "Reconnect the broker stream on drop", branch: "feat/88-reconnect-the-broker-stream", stage: "review", state: "running", since: "6m", note: "Round 2 of 3, security asked for a fix" },
      { id: "h1", kind: "hunt", title: "Test hunt", branch: "hunt/tests-2026-09-27", stage: "pr", state: "ready", since: "1h", note: "PR #412 green, 7 tests removed", pr: 412 },
    ],
    frontier: [{ n: 91, title: "Backfill candles after a gap", m: "v2.4.0" }],
  },
  { id: "box", name: "smart-box", base: "main",
    processes: [{ id: "s1", kind: "standardize", title: "Standardize", branch: "chore/standardize", stage: "approve", state: "needs", since: "9m", note: "3 categories wait for your approval" }],
    frontier: [],
  },
]

export const quota = [
  { r: "claude", pct: 63, reset: "resets 14:00", low: false },
  { r: "codex", pct: 9, reset: "resets 19:30", low: true },
]

export const stagesOf: Record<Kind, string[]> = {
  work: ["implement", "gate", "review", "pr", "ci", "address-reviews"],
  plan: ["plan"],
  hunt: ["hunt", "review", "pr", "ci"],
  standardize: ["audit", "approve", "apply"],
}

export type Turn =
  | { who: "assistant" | "you"; text: string; tools?: string[] }
  | { who: "permission"; tool: string; cmd: string; why: string }
  | { who: "question"; text: string }

export const conv: Turn[] = [
  { who: "assistant", text: "I read the issue and AGENTS.md. The reader needs the listen address, the quota command and the projects; owner and name come from origin. Starting with a failing test.", tools: ["Read config.ts", "Edit config.test.ts", "Run vitest → 1 failed"] },
  { who: "assistant", text: "Red as expected. Implementing the derivation from the origin URL.", tools: ["Edit config.ts"] },
  { who: "permission", tool: "Bash", cmd: "git remote set-url origin git@github.com:CalvinDittkrist/workflows.git", why: "Rewrites the remote of the checkout." },
  { who: "you", text: "Deny. Read the URL, never change it. An ssh URL and an https URL name the same repository." },
  { who: "assistant", text: "Understood: parsing both forms, changing nothing. Adding the ssh case to the test.", tools: ["Edit config.test.ts", "Run vitest → 2 passed"] },
  { who: "question", text: "A project without an origin is refused. Should the controller keep it in the file, marked unusable, or drop it from the file?" },
]

export const all = () => projects.flatMap((p) => p.processes.map((x) => ({ ...x, project: p })))
export type Row = ReturnType<typeof all>[number]
export const primary = (x: Process) => ({ blocked: "Answer", needs: "Approve", ready: "Merge", idle: "Continue" } as Partial<Record<State, string>>)[x.state]
export const dotClass: Record<State, string> = {
  running: "bg-blue-500", waiting: "bg-amber-500", blocked: "bg-red-500", idle: "bg-violet-500", ready: "bg-emerald-500", needs: "bg-amber-500",
}

// Hash routing: #view=...&project=...&process=...&cmd=on|off
export const query = () => new URLSearchParams(location.hash.slice(1))
export const go = (patch: Record<string, string | null>) => {
  const p = query()
  for (const [k, v] of Object.entries(patch)) v == null ? p.delete(k) : p.set(k, v)
  location.hash = p.toString()
}
export const href = (patch: Record<string, string | null>) => {
  const p = new URLSearchParams()
  for (const [k, v] of Object.entries(patch)) if (v != null) p.set(k, v)
  return "#" + p.toString()
}
