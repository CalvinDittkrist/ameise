// The agent runs: every subagent a stage starts beside the process's own session. The one runner of
// session.ts starts each with a brief of the caller's.
//
// The five reviewers of the review stage, the author session of the pr stage, the spec checker of an
// acceptance, the six auditors and the apply session of a standardize process are agent runs. The author,
// the spec checker and the apply session run as no agent, on their brief alone. A plugin agent is named by
// its Agent SDK name; its prompt, tools, model and effort stay in the plugin's agent file.
//
// This module imports no stage module, so each stage imports it without a cycle. It reads the report
// schema of a work session from the session runtime (session.ts), which imports this module for its types
// alone.
import type { JsonSchemaOutputFormat, Options } from '@anthropic-ai/claude-agent-sdk'
import { confidences, sections, verdicts } from '../stages/checkitems.js'
import type { Finding, Fix } from '../records/records.js'
import { report } from './session.js'
import type { Category } from '../stages/standard/lib.js'

// Ended is how a session ended: the state and the note its process ends with. A planner session that
// ends its turn waits for input. A work session that reports complete names its commits, and the
// controller decides the next stage.
// A fix session of the review names what it did with each finding. A reviewer that reported has a
// verdict with its findings, which the review numbers. The author session reports the pull request.
export interface Ended {
  state: 'complete' | 'blocked' | 'failed' | 'input'
  note: string
  commits?: string[]
  session_id?: string
  fixes?: Fix[]
  verdict?: { verdict: 'pass' | 'fix'; findings: Omit<Finding, 'id'>[] }
  pull?: Authored
  addressed?: Addressed
  // items are what the spec checker of an acceptance reported, as acceptance.ts reads them.
  items?: unknown[]
  // findings are the finding lines an auditor of a standardize process reported.
  findings?: string[]
}

// Authored is what the author session reported: the title, the summary and the merge danger of the pull
// request, and an optional note on its evidence.
export interface Authored {
  title: string
  summary: string
  door: 'one-way' | 'two-way'
  blast_radius: string
  rollback: string
  evidence_note?: string
}

// What an address-reviews session reported for the controller to post, and what it fixed and declined.
export interface Addressed {
  replies: { thread: string; body: string }[]
  answer: string
  fixed: string[]
  declined: string[]
}

// An agent run: a subagent a stage starts beside the process's own session.
export interface AgentRun {
  // name names it in notes, stage is what the scripted claude of fake mode plays by.
  name: string
  stage: string
  // agent is the plugin agent it runs as, by its Agent SDK name; without one it runs on its brief alone.
  agent?: Options['agent']
  schema: JsonSchemaOutputFormat['schema']
  // read reads the structured result it reported.
  read: (out: unknown, sessionId: string | undefined) => Ended
  // writes says it writes the worktree as the process's own session, whose stream the event log follows,
  // in the auto mode and with every tool. A run that does not write runs in the default mode with the
  // read-only tools denied.
  writes: boolean
}

// The result a reviewer reports through: its verdict and its findings.
const verdictReport = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['pass', 'fix'], description: 'fix when any finding is S1 or S2, else pass' },
    findings: {
      type: 'array',
      description: 'what you verified is wrong; empty with pass is a good result',
      items: {
        type: 'object',
        properties: {
          severity: { type: 'string', enum: ['S1', 'S2', 'S3'], description: 'S1 must be fixed (bug, vulnerability, data loss, broken contract), S2 should be fixed, S3 is a nit' },
          where: { type: 'string', description: 'the file and line, such as src/a.ts:12' },
          claim: { type: 'string', description: 'what is wrong and why' },
          fix: { type: 'string', description: 'one line on how to verify or fix it' },
        },
        required: ['severity', 'where', 'claim', 'fix'],
        additionalProperties: false,
      },
    },
  },
  required: ['verdict', 'findings'],
  additionalProperties: false,
}

// verdictOf reads the verdict a reviewer reported. A finding of S1 or S2 makes it fix, whatever it said.
function verdictOf(raw: unknown, sessionId: string | undefined, name: string): Ended {
  const out = raw as { verdict?: unknown; findings?: unknown } | undefined
  if (!out || (out.verdict !== 'pass' && out.verdict !== 'fix') || !Array.isArray(out.findings)) {
    return { state: 'failed', note: `the reviewer ${name} ended without a verdict`, session_id: sessionId }
  }
  const findings = out.findings.flatMap((f: unknown) => {
    const x = f as Partial<Finding> | null
    if (!x || !['S1', 'S2', 'S3'].includes(x.severity as string)) return []
    const text = (v: unknown) => (typeof v === 'string' ? v : '')
    return [{ severity: x.severity as Finding['severity'], where: text(x.where), claim: text(x.claim), fix: text(x.fix) }]
  })
  // A fix verdict without a finding leaves the fix session nothing to act on.
  if (out.verdict === 'fix' && findings.length === 0) {
    return { state: 'failed', note: `the reviewer ${name} said fix without a finding`, session_id: sessionId }
  }
  const verdict = out.verdict === 'fix' || findings.some((f) => f.severity !== 'S3') ? 'fix' : 'pass'
  return { state: 'complete', note: verdict, session_id: sessionId, verdict: { verdict, findings } }
}

const reviewer = (name: string, agent: string): AgentRun => ({
  name: `reviewer ${name}`,
  stage: `reviewer-${name}`,
  agent,
  schema: verdictReport,
  read: (out, sessionId) => verdictOf(out, sessionId, name),
  writes: false,
})

// The reviewers a repository may name in WF_REVIEWERS, each run as a worker's agent.
export const reviewers: Record<string, AgentRun> = {
  code: reviewer('code', 'worker:code-reviewer'),
  security: reviewer('security', 'worker:security-reviewer'),
  docs: reviewer('docs', 'worker:docs-reviewer'),
  tests: reviewer('tests', 'worker:test-reviewer'),
  senior: reviewer('senior', 'worker:senior-reviewer'),
}

// The result the author session of the pr stage reports through: the pull request's title, the summary
// and the merge danger. The controller composes the body from them and the evidence it recorded.
const pullReport = {
  type: 'object',
  properties: {
    title: { type: 'string', description: 'the title of the pull request, in conventional-commit style, under 70 characters' },
    summary: { type: 'string', description: "the Summary section in Markdown: the smallest view that makes the change's key point clear" },
    door: { type: 'string', enum: ['one-way', 'two-way'], description: 'one-way when the merge is hard to undo, two-way when a revert undoes it' },
    blast_radius: { type: 'string', description: 'one word naming how far the change reaches' },
    rollback: { type: 'string', description: 'one sentence: how to undo the merge' },
    evidence_note: { type: 'string', description: 'optional: what a reader needs to read the evidence the controller adds' },
  },
  required: ['title', 'summary', 'door', 'blast_radius', 'rollback'],
  additionalProperties: false,
}

// The author session of the pr stage reports the pull request's title, summary and merge danger. A title
// or summary that is empty after trimming, a door other than one-way or two-way, a blast radius that is
// not one word or a rollback that is empty is no report.
export const author: AgentRun = {
  name: 'author session',
  stage: 'author',
  schema: pullReport,
  read: (raw, sessionId) => {
    const out = (raw ?? {}) as { title?: unknown; summary?: unknown; door?: unknown; blast_radius?: unknown; rollback?: unknown; evidence_note?: unknown }
    const text = (v: unknown) => (typeof v === 'string' ? v.trim() : '')
    const title = text(out.title).replace(/\s+/g, ' ')
    const [summary, door, radius, rollback, note] = [text(out.summary), text(out.door), text(out.blast_radius), text(out.rollback), text(out.evidence_note)]
    const fail = (why: string): Ended => ({ state: 'failed', note: why, session_id: sessionId })
    if (title === '') return fail('it reported no title')
    if (summary === '') return fail('it reported no summary')
    if (door !== 'one-way' && door !== 'two-way') return fail(`its door ${JSON.stringify(door)} is neither one-way nor two-way`)
    if (!/^\S+$/.test(radius)) return fail(`its blast radius ${JSON.stringify(radius)} is not one word`)
    if (rollback === '') return fail('it reported no rollback')
    const pull: Authored = { title, summary, door, blast_radius: radius, rollback, ...(note ? { evidence_note: note } : {}) }
    return { state: 'complete', note: title, session_id: sessionId, pull }
  },
  writes: false,
}

// The result the spec checker of an acceptance reports through: one item per checkable statement.
const checkerReport = {
  type: 'object',
  properties: {
    items: {
      type: 'array',
      description: 'one item per checkable statement of the spec',
      items: {
        type: 'object',
        properties: {
          section: { type: 'string', enum: [...sections] },
          statement: { type: 'string', description: "the spec's statement in one line of your own words, specific enough to find it again" },
          verdict: { type: 'string', enum: [...verdicts] },
          evidence: { type: 'string', description: 'path:line for met, deviates and untested; for missing what you searched and found nothing' },
          confidence: { type: 'string', enum: [...confidences] },
        },
        required: ['section', 'statement', 'verdict', 'evidence', 'confidence'],
        additionalProperties: false,
      },
    },
  },
  required: ['items'],
  additionalProperties: false,
}

// The spec checker of an acceptance reports its items. It runs without the planner's agent, on its
// brief alone, as the author session does.
export const checker: AgentRun = {
  name: 'spec checker',
  stage: 'checker',
  schema: checkerReport,
  read: (raw, sessionId) => {
    const items = (raw as { items?: unknown } | undefined)?.items
    if (!Array.isArray(items)) return { state: 'failed', note: 'the spec checker ended without its items', session_id: sessionId }
    return { state: 'complete', note: `${items.length} item(s)`, session_id: sessionId, items }
  },
  writes: false,
}

// The result an auditor of a standardize process reports through: its finding lines.
const auditorReport = {
  type: 'object',
  properties: {
    findings: {
      type: 'array',
      description: 'one finding line each, in the format of your instructions: finding: <category> | <target> | <action> | <reason> | <confidence>; empty when nothing in your area differs from the standard',
      items: { type: 'string' },
    },
  },
  required: ['findings'],
  additionalProperties: false,
}

// auditor is the auditor of a category of a standardize process, run as the repo-standards agent of
// its category, which reports its finding lines.
export const auditor = (category: Category): AgentRun => ({
  name: `${category} auditor`,
  stage: `auditor-${category}`,
  agent: `repo-standards:${category}-auditor`,
  schema: auditorReport,
  read: (raw, sessionId) => {
    const findings = (raw as { findings?: unknown } | undefined)?.findings
    if (!Array.isArray(findings)) return { state: 'failed', note: `the ${category} auditor ended without its findings`, session_id: sessionId }
    const lines = findings.filter((f): f is string => typeof f === 'string')
    return { state: 'complete', note: `${lines.length} finding line(s)`, session_id: sessionId, findings: lines }
  },
  writes: false,
})

// The apply session of a standardize process works the todo lines of the cleanup in its worktree and
// reports complete, or blocked with its question.
export const applier: AgentRun = {
  name: 'apply session',
  stage: 'apply',
  schema: report,
  read: (raw, sessionId) => {
    const out = raw as { outcome?: unknown; message?: unknown } | undefined
    if (out && (out.outcome === 'complete' || out.outcome === 'blocked') && typeof out.message === 'string') return { state: out.outcome, note: out.message, session_id: sessionId }
    return { state: 'failed', note: 'the apply session ended without a report of complete or blocked', session_id: sessionId }
  },
  writes: true,
}
