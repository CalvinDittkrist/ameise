// The pr stage of a work process, which the controller runs once the review has ended, with a passed or
// a failed panel. It pushes the branch and has a read-only author session report the pull request's title,
// its summary and its merge danger from the diff, the commits and the issue. The controller composes the
// body: Closes #N when the process has an issue, then Summary, Evidence and Merge Danger. Evidence holds
// the author's note, the gate result with the end of its output, the review panel with the findings left
// open when it failed, and the commits no reviewer read. It opens the pull request against the base, never
// as a draft, and asks the bot reviewers of WF_PR_BOT_REVIEWERS for a review. A pull request of the branch
// into the base that is open already, as for a follow-up, is pushed to, asked of the bots and kept. The
// gate's draft the gate on CI opened, while it is open, gets the author's title and the composed body, is
// marked ready for review and is asked of the bots, and the record notes when it was readied and drops its
// draft flag.
// The stage is the pr node of the delivery graph, which the engine (engine.ts) runs. The opening is an
// attempt in the record's history, and its outcome takes the process to the ci stage (ci.ts). A push, an
// author session, or a gh pr create or edit that fails returns failed with the reason, which parks the
// process failed.
import { rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { git, push } from '../github/git.js'
import { botsOf } from './ci.js'
import { run } from '../exec.js'
import { defaultGate, tailOf } from './gate.js'
import { author, type Authored } from '../sessions/agents.js'
import { authorBrief } from '../sessions/briefs.js'
import type { Node, NodeContext, Outcome } from '../engine/engine.js'
import { agents, type Runtime } from '../sessions/session.js'
import type { Attempt, Pull, StageRecord } from '../records/records.js'
import { event } from '../records/store.js'

// prNode is the pr node of the delivery graph (delivery.ts): it opens, finds or finishes the pull
// request and returns opened, found or finished, or failed with the reason. It starts no stage itself; the
// engine follows its outcome. A stop ends its author session; a resume enters the node again.
export const prNode: Node = { run: open }

async function open({ record, project, rt, running: s, own, attempt, event }: NodeContext): Promise<Outcome> {
  const id = record.id
  const repo = `${project.owner}/${project.name}`
  const failed = (note: string): Outcome => ({ outcome: 'failed', note })
  let bots: string[]
  try {
    bots = botsOf(record)
  } catch (err) {
    return failed((err as Error).message)
  }
  try {
    await push(record.worktree, record.branch, rt.fake)
  } catch (err) {
    return failed(`could not push ${record.branch} to origin: ${(err as Error).message}`)
  }
  if (!own()) return stopped
  const commit = await git(record.worktree, 'rev-parse', 'HEAD')
  const now = () => new Date().toISOString()

  const base = record.base.replace(/^origin\//, '')
  // The gate's draft the gate on CI opened is the process's pull request while it is open: the stage
  // finishes it rather than opening a second one. A draft closed or merged meanwhile is left.
  const draft = record.draft && record.pull ? await openDraft(rt, id, repo, record.pull) : undefined
  if (!own()) return stopped
  // A pull request of the branch into its base that is open already takes the push, and a new one is not
  // opened. The bot reviewers are asked of it as of a new one.
  const found = draft
    ? undefined
    : await openPull(rt.gh, repo, record.branch, base).catch((err: Error) => {
        event({ event: 'pr-note', note: `could not read the open pull requests of ${repo}: ${err.message}; opening one` })
        return undefined
      })
  if (!own()) return stopped
  if (found) {
    await askBots(rt, id, repo, found.number, bots)
    if (!own()) return stopped
    const a: Attempt = { stage: 'pr', kind: 'open', result: 'found', at: now(), commit, pr: found.number, url: found.url }
    event({ event: 'pr-end', stage: 'pr', state: 'found', pr: found.number, url: found.url })
    attempt(a, { pull: found })
    return { outcome: 'found' }
  }

  const [ended] = await agents(record, rt, s, own, [{ run: author, brief: authorBrief(record, repo) }])
  if (!own()) return stopped
  if (ended.state !== 'complete' || !ended.pull) return failed(`the author session wrote no pull request: ${ended.note}`)
  const title = ended.pull.title
  // A hunt closes no issue, so its body has no closing line.
  const body = prBody(record.issue, ended.pull, evidence(record, commit))
  const file = join(rt.stateDir, 'processes', `${id}.pr.md`)
  let pull: Pull
  try {
    writeFileSync(file, body)
    if (draft) {
      // The draft gets the author's title and body, and is lifted out of GitHub's draft state.
      const n = String(draft.number)
      await run(rt.gh, ['pr', 'edit', n, '--repo', repo, '--title', title, '--body-file', file])
      await run(rt.gh, ['pr', 'ready', n, '--repo', repo])
      pull = draft
    } else {
      const url = await run(rt.gh, ['pr', 'create', '--repo', repo, '--base', base, '--head', record.branch, '--title', title, '--body-file', file])
      const number = Number(/\/pull\/([0-9]+)\s*$/.exec(url)?.[1] ?? NaN)
      if (!Number.isInteger(number)) throw new Error(`gh pr create answered ${JSON.stringify(url)}, which names no pull request`)
      pull = { number, url: url.trim() }
    }
  } catch (err) {
    return failed(`could not ${draft ? `finish the gate's draft PR #${draft.number}` : 'open the pull request'} of ${record.branch}: ${(err as Error).message}`)
  } finally {
    rmSync(file, { force: true })
  }
  if (!own()) return stopped

  await askBots(rt, id, repo, pull.number, bots)
  if (!own()) return stopped
  const result = draft ? 'finished' : 'opened'
  const a: Attempt = { stage: 'pr', kind: 'open', result, at: now(), commit, pr: pull.number, url: pull.url, note: title }
  event({ event: 'pr-end', stage: 'pr', state: result, pr: pull.number, url: pull.url })
  attempt(a, draft ? { pull, draft: false, readied: a.at } : { pull })
  return { outcome: result }
}

// stopped is what the node returns once a stop has taken the process over, which the engine discards.
const stopped: Outcome = { outcome: 'stopped' }

// openDraft is the gate's draft the record names while GitHub reads it open, or undefined, with a note,
// once it is closed or merged or cannot be read.
async function openDraft(rt: Runtime, id: string, repo: string, pull: Pull): Promise<Pull | undefined> {
  try {
    const { state } = JSON.parse(await run(rt.gh, ['pr', 'view', String(pull.number), '--repo', repo, '--json', 'state'])) as { state?: string }
    if (state === 'OPEN') return pull
    event(rt.stateDir, id, { event: 'pr-note', note: `the gate's draft PR #${pull.number} is ${(state ?? 'unknown').toLowerCase()}; looking for an open pull request of the branch` })
  } catch (err) {
    event(rt.stateDir, id, { event: 'pr-note', note: `could not read the gate's draft PR #${pull.number}: ${(err as Error).message}; looking for an open pull request of the branch` })
  }
  return undefined
}

// askBots asks each bot reviewer for a review of the pull request on its own, so one GitHub will not
// take leaves the others asked.
async function askBots(rt: Runtime, id: string, repo: string, number: number, bots: string[]): Promise<void> {
  for (const login of bots) {
    await run(rt.gh, ['pr', 'edit', String(number), '--repo', repo, '--add-reviewer', login]).catch((err: Error) => {
      event(rt.stateDir, id, { event: 'pr-note', note: `could not ask ${login} for a review of PR #${number}: ${err.message}` })
    })
  }
}

// openPull is the open pull request of the branch into the base in the repository, not a fork's of the
// same name nor one into another base, or undefined when there is none.
async function openPull(gh: string, repo: string, branch: string, base: string): Promise<Pull | undefined> {
  const list = JSON.parse(await run(gh, ['pr', 'list', '--repo', repo, '--state', 'open', '--limit', '100', '--json', 'number,headRefName,baseRefName,isCrossRepository,url'])) as {
    number: number
    headRefName: string
    baseRefName?: string
    isCrossRepository?: boolean
    url: string
  }[]
  const p = list.find((x) => x.headRefName === branch && x.baseRefName === base && !x.isCrossRepository)
  return p ? { number: p.number, url: p.url } : undefined
}

// prBody is the body of the pull request the controller composes, as the contract fixture's pr_body rule
// states it: Closes #N when there is an issue, then the author's summary, the evidence with the author's
// note before it, and the merge danger.
export function prBody(issue: number | null, a: Omit<Authored, 'title'>, evidence: string): string {
  return [
    ...(issue === null ? [] : [`Closes #${issue}`]),
    '## Summary',
    a.summary,
    '## Evidence',
    ...(a.evidence_note ? [a.evidence_note] : []),
    evidence,
    '## Merge Danger',
    `**Door:** ${a.door}`,
    `**Blast Radius:** ${a.blast_radius}`,
    a.rollback,
  ].join('\n\n')
}

// fenced is the text in a fenced code block whose fence is longer than any run of backticks in it.
function fenced(text: string): string {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((r) => r.length))
  const fence = '`'.repeat(Math.max(3, longest + 1))
  return `${fence}\n${text}\n${fence}`
}

// evidence is what the controller recorded for the Evidence section: the last gate run with the end of
// its output, and the review panel with each reviewer's last verdict. A failed panel names the reviewers
// that did not pass and their findings of the last round. Commits since the last round are named, as no
// reviewer read them.
export function evidence(record: StageRecord, head: string): string {
  const history = record.history ?? []
  const short = (c: string | undefined) => (c ?? '').slice(0, 7)
  const lines: string[] = []
  const gated = [...history].reverse().find((h) => h.stage === 'gate' && h.kind === 'run')
  const command = gated?.gate ?? defaultGate
  if (!gated) lines.push(`No gate result was recorded for this branch.`)
  else if (gated.result === 'skipped') lines.push(`The gate form is none, so no gate ran at ${short(gated.commit)}.`)
  else if (gated.checks) lines.push(`The gate on CI \`${command}\` ${gated.result === 'pass' ? 'passed' : 'failed'} at ${short(gated.commit)}: ${gated.checks.map((c) => `${c.name} ${c.state}`).join(', ')}.`)
  else {
    lines.push(`The gate \`${command}\` ${gated.result === 'pass' ? 'passed' : `failed with exit ${gated.exit ?? 'none'}`} at ${short(gated.commit)}${gated.dirty ? ', with changes not committed' : ''}.`)
    // The record keeps the end of the output capped already; a record of an older controller may not.
    const tail = tailOf(gated.tail ?? '')
    if (tail !== '') lines.push('', 'The end of its output:', '', fenced(tail), '')
  }

  const since = history.map((h) => h.stage === 'implement' || h.stage === 'hunt').lastIndexOf(true)
  const rounds = history.slice(since + 1).filter((h) => h.stage === 'review' && h.kind === 'round')
  const last = new Map<string, string>()
  for (const r of rounds) for (const v of r.verdicts ?? []) last.set(v.reviewer, v.verdict)
  const final = rounds.at(-1)
  if (!final) {
    lines.push('No review panel was recorded for this branch.')
    return lines.join('\n')
  }
  const verdicts = [...last].map(([reviewer, verdict]) => `${reviewer} ${verdict}`).join(', ')
  if (record.panel === 'failed') {
    const open = [...last].filter(([, v]) => v !== 'pass').map(([r]) => r)
    lines.push(`The review panel failed: it spent its ${rounds.length} round(s) with ${open.join(', ')} not passing (${verdicts}).`)
    const findings = (final.verdicts ?? []).filter((v) => v.verdict !== 'pass').flatMap((v) => v.findings)
    if (findings.length > 0) {
      lines.push('', 'The findings of the last round, which no fix session took:', '')
      for (const f of findings) lines.push(`- ${f.id} ${f.severity} \`${f.where}\`: ${f.claim.replace(/\s+/g, ' ')}`)
    }
  } else {
    lines.push(`The review panel passed in round ${final.round ?? rounds.length}: ${verdicts}.`)
  }
  if (final.commit && final.commit !== head) lines.push('', `The branch has commits after ${short(final.commit)}, where the last round read it, which no reviewer read.`)
  return lines.join('\n')
}
