// The pr stage of a work process, which the controller runs once the review has ended, with a passed or
// a failed panel. It pushes the branch and has a read-only author session write the pull request's title
// and body from the diff, the commits and the issue. It appends the verification section: the gate
// result, the review panel, and the reviewers that did not pass when the panel failed. It opens the pull
// request against the base, never as a draft, and asks the bot reviewers of WF_PR_BOT_REVIEWERS for a
// review. A pull request of the branch that is open already, as for a follow-up, is pushed to and kept.
// The opening is an attempt in the record's history, and the ci stage (ci.ts) follows. A push, an author
// session or a gh pr create that fails ends the process failed with the reason.
import { rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { type Attempt, git, type Pull, push, type WorkRecord } from './claim.js'
import { botsOf, ci } from './ci.js'
import { run } from './exec.js'
import { gateCommand } from './gate.js'
import type { Project } from './project.js'
import { attempt, author, authorBrief, event, type Runtime, type Running, track, update } from './session.js'

// pr starts the pr stage of a process and answers the record as it runs. A stop ends its author session;
// a resume runs the stage again.
export function pr(record: WorkRecord, project: Project, rt: Runtime): WorkRecord {
  const id = record.id
  const started = (update(rt.stateDir, id, { stage: 'pr', state: 'running', note: 'the author session writes the pull request', fixing: false, wait: undefined } as Partial<WorkRecord>) as WorkRecord | undefined) ?? record
  event(rt.stateDir, id, { event: 'pr-start', stage: 'pr' })
  const abort = new AbortController()
  // The stage starts on the next turn, once it is tracked, so a stop meanwhile ends it.
  const tracked: { own: () => boolean; s?: Running } = { own: () => false }
  const own = () => tracked.own()
  const done = Promise.resolve()
    .then(() => (tracked.s ? open(started, project, rt, tracked.s, own) : undefined))
    .catch((err: unknown) => {
      if (!own()) return
      const note = `the pr stage failed: ${(err as Error).message}`
      event(rt.stateDir, id, { event: 'pr-end', stage: 'pr', state: 'failed', note })
      const failed = update(rt.stateDir, id, { state: 'failed', note, unseen: true })
      if (failed) rt.announce(failed)
    })
    .catch((err: unknown) => {
      process.stderr.write(`warning: ${id}: its pr stage ended unexpectedly: ${(err as Error).message}\n`)
    })
  Object.assign(tracked, track(id, abort, done, 'the author session writes the pull request'))
  return started
}

async function open(record: WorkRecord, project: Project, rt: Runtime, s: Running, own: () => boolean): Promise<void> {
  const id = record.id
  const repo = `${project.owner}/${project.name}`
  const fail = (note: string) => {
    if (!own()) return
    event(rt.stateDir, id, { event: 'pr-end', stage: 'pr', state: 'failed', note })
    const failed = update(rt.stateDir, id, { state: 'failed', note, unseen: true })
    if (failed) rt.announce(failed)
  }
  let bots: string[]
  try {
    bots = botsOf(record)
  } catch (err) {
    return fail((err as Error).message)
  }
  try {
    await push(record.worktree, record.branch, rt.fake)
  } catch (err) {
    return fail(`could not push ${record.branch} to origin: ${(err as Error).message}`)
  }
  if (!own()) return
  const commit = await git(record.worktree, 'rev-parse', 'HEAD')
  const now = () => new Date().toISOString()

  // A pull request of the branch that is open already takes the push, and a new one is not opened.
  const found = await openPull(rt.gh, repo, record.branch).catch((err: Error) => {
    event(rt.stateDir, id, { event: 'pr-note', note: `could not read the open pull requests of ${repo}: ${err.message}; opening one` })
    return undefined
  })
  if (!own()) return
  if (found) {
    const a: Attempt = { stage: 'pr', kind: 'open', result: 'found', at: now(), commit, pr: found.number, url: found.url }
    event(rt.stateDir, id, { event: 'pr-end', stage: 'pr', state: 'found', pr: found.number, url: found.url })
    const next = attempt(rt.stateDir, id, a, { pull: found })
    if (next && own()) ci(next, project, rt)
    return
  }

  const ended = await author(record, rt, s, own, authorBrief(record, repo))
  if (!own()) return
  if (ended.state !== 'complete' || !ended.pull) return fail(`the author session wrote no pull request: ${ended.note}`)
  const title = ended.pull.title
  const body = [closing(ended.pull.body, record.issue), '', verification(record, commit)].join('\n')
  const file = join(rt.stateDir, 'processes', `${id}.pr.md`)
  let url: string
  try {
    writeFileSync(file, body)
    url = await run(rt.gh, ['pr', 'create', '--repo', repo, '--base', record.base.replace(/^origin\//, ''), '--head', record.branch, '--title', title, '--body-file', file])
  } catch (err) {
    return fail(`could not open the pull request of ${record.branch}: ${(err as Error).message}`)
  } finally {
    rmSync(file, { force: true })
  }
  const number = Number(/\/pull\/([0-9]+)\s*$/.exec(url)?.[1] ?? NaN)
  if (!Number.isInteger(number)) return fail(`gh pr create answered ${JSON.stringify(url)}, which names no pull request`)
  const pull: Pull = { number, url: url.trim() }
  if (!own()) return

  // Each bot reviewer is asked on its own, so one GitHub will not take leaves the others asked.
  for (const login of bots) {
    await run(rt.gh, ['pr', 'edit', String(number), '--repo', repo, '--add-reviewer', login]).catch((err: Error) => {
      event(rt.stateDir, id, { event: 'pr-note', note: `could not ask ${login} for a review of PR #${number}: ${err.message}` })
    })
  }
  if (!own()) return
  const a: Attempt = { stage: 'pr', kind: 'open', result: 'opened', at: now(), commit, pr: number, url: pull.url, note: title }
  event(rt.stateDir, id, { event: 'pr-end', stage: 'pr', state: 'opened', pr: number, url: pull.url })
  const next = attempt(rt.stateDir, id, a, { pull })
  if (next && own()) ci(next, project, rt)
}

// openPull is the open pull request of the branch in the repository, not a fork's of the same name, or
// undefined when there is none.
async function openPull(gh: string, repo: string, branch: string): Promise<Pull | undefined> {
  const list = JSON.parse(await run(gh, ['pr', 'list', '--repo', repo, '--state', 'open', '--limit', '100', '--json', 'number,headRefName,isCrossRepository,url'])) as {
    number: number
    headRefName: string
    isCrossRepository?: boolean
    url: string
  }[]
  const p = list.find((x) => x.headRefName === branch && !x.isCrossRepository)
  return p ? { number: p.number, url: p.url } : undefined
}

// closing is the author's body with a line that closes the issue, unless it names the issue already.
function closing(body: string, issue: number): string {
  if (new RegExp(`\\b(close[sd]?|fix(e[sd])?|resolve[sd]?) #${issue}\\b`, 'i').test(body)) return body
  return `Closes #${issue}\n\n${body}`
}

// verification is the section the controller appends to the author's body: the last gate run, and the
// review panel with each reviewer's last verdict. A failed panel names the reviewers that did not pass and
// their findings of the last round. Commits since the last round are named, as no reviewer read them.
export function verification(record: WorkRecord, head: string): string {
  const history = record.history ?? []
  const short = (c: string | undefined) => (c ?? '').slice(0, 7)
  const lines = ['## Verification', '']
  const gated = [...history].reverse().find((h) => h.stage === 'gate' && h.kind === 'run')
  const command = gateCommand.join(' ')
  if (!gated) lines.push(`No gate result was recorded for this branch.`)
  else lines.push(`The gate \`${command}\` ${gated.result === 'pass' ? 'passed' : `failed with exit ${gated.exit ?? 'none'}`} at ${short(gated.commit)}${gated.dirty ? ', with changes not committed' : ''}.`)

  const since = history.map((h) => h.stage === 'implement').lastIndexOf(true)
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
