// The records of the processes, as the state directory holds them in processes/<id>.json: what every
// process has, the work and hunt records with their attempts and what those carry, the plan record with
// its acceptance and the standardize record with its standardization, and the union of the records that
// run sessions. The store (store.ts) reads and writes them. This module holds types and the lists they
// are spelled from, and imports no module that drives a process.
import type { confidences, sections, verdicts } from '../stages/checkitems.js'
import type { Category } from '../stages/standard/lib.js'

// The modes a work process runs in.
export const modes = ['manual', 'yolo'] as const
export type Mode = (typeof modes)[number]

// The record an action writes for a new process in processes/<id>.json: what every kind of process has.
// The board reads records in the looser shape of its ProcessRecord.
export interface CreatedRecord {
  id: string
  project: string
  kind: string
  branch: string
  // issue is the issue the process works or plans, or null for a plan from an idea or an open one.
  issue: number | null
  worktree: string
  // base is the ref the branch merges into, origin/<base> where origin has it.
  base: string
  // start is the ref the worktree started from: the base, or the branch on origin a forced claim adopted.
  start?: string
  stage: string
  state: string
  note: string
  // workflow is the id of the process graph the process runs on, and node the node it is on or parks
  // on (engine.ts), once the engine has entered one.
  workflow?: string
  node?: string
  // session_id is the id of the implement session, once it has started.
  session_id?: string
  // context is the size of the session's context in tokens, from the usage of its latest message.
  context?: number
  // allowed are the calls and rules the maintainer allowed for this process, which no card asks again.
  allowed?: string[]
  // unseen says the process turned blocked, ready or failed and its page has not been opened since.
  unseen?: boolean
  created_at: string
  updated_at: string
}

// The stages of a work process the controller drives, in their order. A hunt process runs hunt in place
// of implement, and the same stages after it.
export const workStages = ['implement', 'hunt', 'gate', 'review', 'pr', 'ci', 'address-reviews'] as const
export type WorkStage = (typeof workStages)[number]

// A finding of a reviewer, with the id the controller gives it: <reviewer>-<round>-<n>, such as code-1-2.
export interface Finding {
  id: string
  // severity is S1 (must fix), S2 (should fix) or S3 (a nit).
  severity: 'S1' | 'S2' | 'S3'
  // where is the file and line it is about, such as src/a.ts:12.
  where: string
  claim: string
  fix: string
}

// The verdict of one reviewer in a round of the review, with its findings. A reviewer whose session did
// not report has failed, and its note says why.
export interface Verdict {
  reviewer: string
  verdict: 'pass' | 'fix' | 'failed'
  session_id?: string
  findings: Finding[]
  note?: string
}

// What a fix session of the review did with one finding: fixed it, or declined it with the reason.
export interface Fix {
  finding: string
  outcome: 'fixed' | 'declined'
  note: string
}

// A check of a pull request as the ci stage reads it: its name, where to read it, and pass, fail or
// pending.
export interface Check {
  name: string
  url?: string
  state: 'pass' | 'fail' | 'pending'
}

// The pull request of a work process, once the pr stage has opened it or found it open.
export interface Pull {
  number: number
  url: string
}

// A point of a review the address-reviews stage answers: a writer's request for changes, answered by
// one comment on the pull request, or a review thread nobody resolved, answered by a reply that resolves
// it. key is the review's id or the thread's, by which a later reading knows it answered.
export interface Point {
  kind: 'request' | 'thread'
  key: string
  login: string
  body: string
  url?: string
  // where is the file and line of a thread, bot whether a bot opened it.
  where?: string
  bot?: boolean
}

// An attempt of a stage as the process record keeps it: a session of the stage, a merge of the base, a
// run of the gate command, a round of the review, the opening of the pull request, a verdict of the
// ci stage's wait or the answer the address-reviews stage posted, with its result and the time it ended.
export interface Attempt {
  stage: WorkStage
  kind: 'session' | 'merge' | 'run' | 'round' | 'open' | 'wait' | 'answer'
  // result is complete, blocked or failed for a session, conflict for a merge, pass or fail for a run,
  // skipped for a run of the gate form none, missing for a run of the gate on CI that did not find the
  // checks it reads, pass, fix or failed for a round, opened, found or finished for the
  // opening of the pull request, green, conflicts, checks-failed, review-comments, answered, unmergeable,
  // merged or closed for a wait, and posted or partial for an answer.
  result: string
  at: string
  // gate is the gate form a run ran: the command, or none.
  gate?: string
  session_id?: string
  // commits are those a session reported, each a short hash and a subject.
  commits?: string[]
  note?: string
  // commit is the head a merge or a run of the gate was at, and dirty whether the worktree had changes.
  commit?: string
  dirty?: boolean
  // files are the files a merge of the base left in conflict.
  files?: string[]
  exit?: number | null
  // tail is the end of the gate command's output.
  tail?: string
  // round is the number of a round of the review, verdicts are its reviewers' verdicts.
  round?: number
  verdicts?: Verdict[]
  // fixes are what a fix session of the review did with each finding.
  fixes?: Fix[]
  // pr is the number of the pull request an opening opened or found, a wait or a run of the gate on CI
  // read, or a merge of the gate on CI was for, and url where it is.
  pr?: number
  url?: string
  // checks are the checks a wait or a run of the gate on CI read, and reviews the requests for changes and unresolved threads it
  // met, one line each.
  checks?: Check[]
  reviews?: string[]
  // mandate is what an address-reviews session answers: a writer's request for changes, which starts the
  // repair count afresh, or a bot's review, whose round is a repair round. fixed and declined are the
  // points it reported as such, one line each.
  mandate?: 'writer' | 'bot'
  fixed?: string[]
  declined?: string[]
  // answered are the keys of the requests an answer commented on, replied the threads it replied to.
  answered?: string[]
  replied?: string[]
  // asked are the keys of the points a wait gave an address-reviews session to answer. A writer's request
  // starts the repair count afresh the first time it is asked, and never again.
  asked?: string[]
}

// A work process on an issue, as a claim writes it.
export interface WorkRecord extends CreatedRecord {
  kind: 'work'
  issue: number
  mode: Mode
  env: Record<string, string>
  // simplify is the WF_SIMPLIFY the claim read, on as true: the override, else the settings the worktree
  // started with. The brief and the session's settings both follow it. An adopted process has none.
  simplify?: boolean
  // hold says the next complete report of the implement session keeps it open instead of starting the gate.
  hold?: boolean
  // held says the implement session reported complete under a hold and waits for the maintainer's next
  // message, with no session running.
  held?: boolean
  // fixing says the work of the gate, the review or the ci stage is a fix session, not the gate
  // command, the reviewers or the wait, so a resume goes on with it.
  fixing?: boolean
  // panel is how the review ended: pass once every reviewer passed, failed once its rounds were spent
  // with a reviewer that still says fix. The pull request names a failed panel.
  panel?: 'pass' | 'failed'
  // pull is the pull request of the branch, once the gate on CI has opened its draft or the pr stage has
  // opened or found it. draft says it is the gate's draft, by the controller's record and never by
  // GitHub's draft state. readied is when the pr stage finished that draft and marked it ready for
  // review, which clears draft. checks are the checks the gate on CI or the ci stage read last, and wait
  // what it waits for while it waits.
  pull?: Pull
  draft?: boolean
  readied?: string
  checks?: Check[]
  wait?: string
  // repairs are the repair rounds the ci stage spent on the pull request and its budget, as it read them last.
  repairs?: { spent: number; of: number }
  // addressing is what the address-reviews session of the stage answers: its mandate and the points its
  // brief listed, the only ones a reply of its result is posted to. reported is the replies and the answer
  // the session reported complete with, kept until the ci stage has posted them, so a restart between the
  // two posts them still.
  addressing?: { mandate: 'writer' | 'bot'; points: Point[]; reported?: { replies: { thread: string; body: string }[]; answer: string } }
  // history is every attempt of a stage, in the order they ended.
  history?: Attempt[]
}

// A test removed by a test hunt, as the hunt record holds it: the round and the commit that removed it,
// the hunter's candidate and the worker's reason.
export interface Removal {
  round: number
  commit: string
  path: string
  test: string
  category: string
  reason: string
  why: string
  still_proven: string
}

// A candidate a test hunt checked and kept, as the hunt record holds it.
export interface Kept {
  round: number
  path: string
  test: string
  category: string
  reason: string
  confidence: string
}

// The hunt record of a test hunt as the worker's hunt.sh json prints it: the rounds it ran of at most
// max_rounds, why it ended, or null while it runs, the tests it removed and the candidates it kept.
// stale counts the removals recorded whose commit left the branch or whose test is back.
export interface HuntLog {
  rounds: number
  max_rounds: number
  ended: string | null
  removed: Removal[]
  kept: Kept[]
  stale: number
}

// A hunt process: a test hunt on a hunt branch, which works no issue (ADR 0045). The hunt record stands
// where the issue stands, and after the hunt session it runs the stages of a work process.
export interface HuntRecord extends Omit<WorkRecord, 'kind' | 'issue'> {
  kind: 'hunt'
  issue: null
  // hunt is the hunt record, as the controller last read it from the worktree.
  hunt?: HuntLog
}

// A process that runs the stages after implement: a work process or a hunt process.
export type StageRecord = WorkRecord | HuntRecord

// The routes a plan process starts on: an idea, an issue, nothing (an open session), or the
// acceptance of a spec, which the acceptance start opens.
export const routes = ['idea', 'issue', 'open', 'accept'] as const
export type Route = (typeof routes)[number]

// A plan process, as the state directory holds it in processes/<id>.json. Its route names the planner's
// route its session takes, and its topic is the idea or the issue's title it plans. Its language is the
// repository's WF_PLANNER_LANGUAGE when the plan opened, the language the planner talks in. An
// acceptance keeps its facts, its items and what their answers wrote (acceptance.ts).
export interface PlanRecord extends CreatedRecord {
  kind: 'plan'
  route: Route
  topic?: string
  language?: string
  acceptance?: Acceptance
}

// The answers to an item not met: a gap ticket with its title and what it builds, an accepted deviation
// with the reason the code is right, or no finding with the reason it is overruled.
export type ItemAnswer = { answer: 'gap'; title: string; what?: string } | { answer: 'deviation'; reason: string } | { answer: 'none'; reason?: string }

export interface Item {
  id: string
  section: (typeof sections)[number]
  statement: string
  verdict: (typeof verdicts)[number]
  evidence: string
  confidence: (typeof confidences)[number]
  // answer is the maintainer's, and written what the controller wrote for it: the gap ticket as #<n>,
  // deviation or none. An item written is not written again when the answers are sent once more.
  answer?: ItemAnswer
  written?: string
  // unlinked marks a gap ticket created that did not become a sub-issue of the spec. The next acceptance
  // reads the tickets from the sub-issues, so the answers go on only once it is one.
  unlinked?: boolean
}

// What the acceptance keeps on the process's record: the facts the checker was briefed with, its items,
// and what the answers wrote.
export interface Acceptance {
  spec: { title: string; milestone: string | null; labels: string[] }
  tickets: { number: number; title: string; prs: number[] }[]
  files: number
  // deviations are the deviations accepted earlier, each @<login>: <text>.
  deviations: string[]
  // notes say what could not be read, so a short list of facts reads as unknown and not as none.
  notes: string[]
  items: Item[]
  // repeated counts the items the checker reported again although they were accepted as deviations.
  repeated: number
  gaps?: number[]
  closed?: boolean
}

// The answer to a category of the standardize report.
export type Answer = 'approve' | 'reject'

// A finding of the report, as the report stores it.
export interface StandardFinding {
  target: string
  action: string
  reason: string
  confidence: string
}

// A category the report asks about: its findings and the report's lines on it, which say what approving
// it triggers, and the maintainer's answer once given.
export interface CategoryReport {
  name: Category
  findings: StandardFinding[]
  report: string[]
  answer?: Answer
}

// A step of the apply or the finalize: the step or the session, what it printed, and whether it held.
export interface Step {
  step: string
  ok: boolean
  lines: string[]
  at: string
}

// What a standardize process keeps on its record: the facts the auditors were briefed with, how each
// auditor ended, the report per category, the finding lines the report refused, the error of the workspace step
// when the workspace could not be audited, and what the apply and the finalize did.
export interface Standardization {
  facts: string[]
  workspace: string[]
  auditors: { category: Category; state: string; note: string; findings: number }[]
  summary: string
  categories: CategoryReport[]
  dropped: string[]
  applied?: Step[]
  unaudited?: string
  pull?: string
  catalogue?: number
  result?: 'pass' | 'fail'
}

// A standardize process, as the state directory holds it in processes/<id>.json.
export interface StandardizeRecord extends CreatedRecord {
  kind: 'standardize'
  issue: null
  mode: Mode
  env: Record<string, string>
  standardize?: Standardization
}

// A process that runs sessions: a work process, a plan process or a standardize process.
export type SessionRecord = StageRecord | PlanRecord | StandardizeRecord
