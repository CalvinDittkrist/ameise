// The GitHub tools of a planner session (ADR 0059): the one way the session writes GitHub. The
// controller registers them in the session as the in-process MCP server github. They create an issue with
// its parent and milestone, set labels, link blockers, comment, close, attach a milestone and create one.
// They own the label vocabulary: a vocabulary label the repository lacks is created on first use. They
// refuse the label sets the factory cannot work (the routing label only beside ready-for-agent and never beside ready-for-human). Every write goes into the
// process's event log with what it changed, and so does every refusal. A hook of the session denies a
// Bash call that writes GitHub with gh past them (directWrite).
//
// Every call goes through gh api with the endpoint last, so the scripted gh of fake mode answers it by
// its endpoint.
//
// The tools import no stage module and no module that reaches one, so the session runtime (session.ts)
// imports them without a cycle. The shape of a milestone's version is held here, and the release
// (actions.ts) reads it from here.
import { createSdkMcpServer, type McpSdkServerConfigWithInstance, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { labels as named, pages } from './board.js'
import { run } from '../exec.js'

// The shape of a milestone a release tags, as the orchestrator's release takes it.
export const version = /^v[0-9]+\.[0-9]+\.[0-9]+$/

export interface Label {
  name: string
  color: string
  description: string
}

// The label vocabulary the tools create, in the order of the contract fixture, without the labels the
// fixture marks planner false. A test holds it to the fixture.
export const vocabulary: Label[] = [
  { name: 'ready-for-agent', color: '0E8A16', description: 'Fully specified; an agent can take it' },
  { name: 'needs-triage', color: 'FBCA04', description: 'A maintainer has to evaluate this' },
  { name: 'needs-info', color: 'D876E3', description: 'Waiting on the reporter' },
  { name: 'ready-for-human', color: '1D76DB', description: 'Needs a human to implement' },
  { name: 'wontfix', color: 'FFFFFF', description: 'Will not be actioned; the closing comment says why' },
  { name: 'spec', color: '5319E7', description: 'Spec issue; its tickets carry the work' },
  { name: 'factory', color: 'FFC799', description: 'Routed to the factory host; local claims leave it alone' },
  { name: 'factory:spec-run', color: 'F29D4B', description: 'Routes a spec and its tickets to a spec run on the factory host' },
  { name: 'bug', color: 'D73A4A', description: 'Something is broken' },
  { name: 'enhancement', color: 'A2EEEF', description: 'New feature or improvement' },
]

// The label of the vocabulary the fixture marks planner false: a standardisation marks its catalogue issue of
// removed skills with it, and the tools never create it.
export const skillCandidate: Label = { name: 'skill-candidate', color: 'C5DEF5', description: 'A removed skill that could move into the marketplace' }

// The factory's routing label, which the frontier rule of the contract fixture names, and the spec-run
// label beside it. The factory works an issue that carries either unattended, with nobody to ask.
const routingLabel = named.routing
export const specRunLabel = named.specRun

// The server's name in a session: its tools are mcp__github__<tool>, and mcp__github the rule that allows them.
export const githubServer = 'github'

// A Refused is a call the tools turn down, with the reason and the fix.
export class Refused extends Error {}

// A write the tools made, as the event log holds it: what was written, and on what.
type Write = Record<string, unknown> & { write: string }

interface Issue {
  id: number
  number: number
  state: string
  labels: { name: string }[]
  milestone: { title: string } | null
  html_url?: string
}

interface Milestone {
  number: number
  title: string
  state: string
  open_issues: number
  closed_issues: number
}

// GitHub names labels case-insensitively: Factory is the label factory. key is the name the rules
// compare, and canonical spells a label of the vocabulary as the vocabulary does.
const key = (label: string) => label.toLowerCase()
const has = (labels: string[], name: string) => labels.some((l) => key(l) === key(name))
const inVocabulary = (label: string) => vocabulary.find((v) => v.name === key(label))
const canonical = (label: string) => inVocabulary(label)?.name ?? label
// distinct drops the labels that name one already in the list, whatever their case.
const distinct = (labels: string[]) => labels.filter((l, i) => labels.findIndex((x) => key(x) === key(l)) === i)

// attempt runs a call of gh, and refuses with what failed when it fails.
async function attempt<T>(what: string, call: Promise<T>): Promise<T> {
  try {
    return await call
  } catch (err) {
    throw new Refused(`${what} failed: ${(err as Error).message}`)
  }
}

// unavailable tells a failed call that GitHub lacks the feature here (404 or 422) from any other failure.
const unavailable = (err: unknown) => /\b(404|422)\b|Not Found|Unprocessable/.test((err as Error).message)

// routable refuses a label set that routes an issue the factory cannot work: the routing label goes
// only beside ready-for-agent, and never beside ready-for-human. drop says how this call drops it.
function routable(subject: string, drop: string, labels: string[]) {
  if (!has(labels, routingLabel)) return
  if (has(labels, named.human)) {
    throw new Refused(`${subject} would carry ${routingLabel} and ready-for-human: the factory works unattended, so an issue a person has to implement is never routed to it. Drop one of the two labels; ${drop}.`)
  }
  if (!has(labels, named.ready)) {
    throw new Refused(`${subject} would carry ${routingLabel} without ready-for-agent: the factory takes only issues a worker can finish from the brief alone. Add ready-for-agent, or ${drop}.`)
  }
}

// specRun refuses a label set a spec run cannot work. The spec-run label goes never beside the routing
// label or ready-for-human, and only on a spec or on a ticket whose spec carries it. parent is the
// ticket's spec, read only when the set carries no spec label; parentLabels reads the spec's labels.
async function specRun(subject: string, drop: string, labels: string[], parent: () => Promise<number | undefined>, parentLabels: (n: number) => Promise<string[]>) {
  if (!has(labels, specRunLabel)) return
  if (has(labels, routingLabel)) {
    throw new Refused(`${subject} would carry ${routingLabel} and ${specRunLabel}: a spec run routes its tickets itself, so an issue carries one of the two. Drop one of them; ${drop}, or drop ${routingLabel}.`)
  }
  if (has(labels, named.human)) {
    throw new Refused(`${subject} would carry ${specRunLabel} and ready-for-human: the factory skips a ticket a person works, so that ticket keeps ready-for-human alone. Drop one of the two labels; ${drop}.`)
  }
  if (has(labels, named.spec)) return
  const p = await parent()
  if (p === undefined) {
    throw new Refused(`${subject} would carry ${specRunLabel} but is no spec and has no parent: the label marks a spec and the tickets of its spec run. Label the spec, or make the issue a ticket of a spec that carries it; ${drop}.`)
  }
  if (!has(await parentLabels(p), specRunLabel)) {
    throw new Refused(`${subject} would carry ${specRunLabel} but its spec #${p} does not: a ticket joins a spec run only once its spec is one. Label #${p} first with set_labels on ${p} adding ${specRunLabel}, or ${drop}.`)
  }
}

// milestoneName refuses a milestone that is not named vX.Y.Z.
function milestoneName(title: string): string {
  if (!version.test(title)) throw new Refused(`milestone must be named vX.Y.Z, got '${title}'`)
  return title
}

// GitHub is the repository the tools write, through gh.
class GitHub {
  private known: Promise<Set<string>> | undefined
  // creating holds the creation of each missing label in flight, so parallel calls create it once.
  private readonly creating = new Map<string, Promise<void>>()
  constructor(
    private readonly gh: string,
    readonly repo: string,
    readonly log: (w: Write) => void,
  ) {}

  api(endpoint: string, fields: string[] = [], method?: string): Promise<string> {
    return run(this.gh, ['api', ...(method ? ['--method', method] : []), ...fields, endpoint])
  }

  async json<T>(endpoint: string, fields: string[] = [], method?: string): Promise<T> {
    return JSON.parse(await this.api(endpoint, fields, method)) as T
  }

  // list reads every page of a list endpoint.
  async list<T>(endpoint: string): Promise<T[]> {
    return pages<T>(await this.api(endpoint, ['--paginate']))
  }

  path = (rest: string) => `repos/${this.repo}/${rest}`

  // issue reads an issue, or refuses: a rule judged on a guess would let through what it refuses.
  async issue(n: number): Promise<Issue> {
    try {
      return await this.json<Issue>(this.path(`issues/${n}`))
    } catch (err) {
      throw new Refused(`could not read #${n} of ${this.repo}: ${(err as Error).message}; does the issue exist, and is gh authenticated for this repository?`)
    }
  }

  labelsOf = async (n: number) => (await this.issue(n)).labels.map((l) => l.name)

  // parent is the number of the issue's parent, or undefined when it has none. GitHub answers 404 for an
  // issue without a parent, so only not found means no parent. A 422 is no answer about the parent, so
  // unlike unavailable it refuses with every other failed read: a guessed no parent would let a label
  // set through that the spec-run rule refuses.
  async parent(n: number): Promise<number | undefined> {
    try {
      return (await this.json<{ number: number }>(this.path(`issues/${n}/parent`))).number
    } catch (err) {
      const m = (err as Error).message
      if (/Not Found|404/.test(m)) return undefined
      throw new Refused(`could not read the parent of #${n}: ${m}; is gh authenticated for this repository, and are sub-issues available here?`)
    }
  }

  async milestones(): Promise<Milestone[]> {
    try {
      return await this.list<Milestone>(this.path('milestones?state=all&per_page=100'))
    } catch (err) {
      throw new Refused(`cannot read the milestones of ${this.repo}: ${(err as Error).message}`)
    }
  }

  // milestone is the open milestone of that title, or undefined when there is none. A closed one refuses.
  async milestone(title: string): Promise<Milestone | undefined> {
    const m = (await this.milestones()).find((x) => x.title === title)
    if (m && m.state !== 'open') throw new Refused(`milestone ${title} is closed (released); pick a new version`)
    return m
  }

  // openMilestone is the open milestone of that title, or the refusal that says why there is none.
  async openMilestone(title: string): Promise<Milestone> {
    const m = await this.milestone(title)
    if (!m) throw new Refused(`milestone ${title} does not exist; create it with create_milestone ${title} and its goal`)
    return m
  }

  // ensure makes every label of the set a label of the repository. A vocabulary label it lacks is created
  // with the vocabulary's colour and description. A label outside the vocabulary must exist already.
  async ensure(labels: string[]) {
    if (labels.length === 0) return
    this.known ??= this.list<{ name: string }>(this.path('labels?per_page=100')).then(
      (ls) => new Set(ls.map((l) => key(l.name))),
      (err: Error) => {
        this.known = undefined
        throw new Refused(`could not list the labels of ${this.repo}: ${err.message}; is gh authenticated for this repository?`)
      },
    )
    const known = await this.known
    for (const name of labels) {
      if (known.has(key(name))) continue
      const v = inVocabulary(name)
      if (!v) throw new Refused(`${name} is neither a label of the workflow's vocabulary nor one of ${this.repo}; use a label of the vocabulary (${vocabulary.map((l) => l.name).join(', ')}), or create ${name} on GitHub first`)
      let made = this.creating.get(v.name)
      if (!made) {
        made = this.create(v, known).finally(() => this.creating.delete(v.name))
        this.creating.set(v.name, made)
      }
      await made
    }
  }

  private async create(v: Label, known: Set<string>) {
    await attempt(`creating the label ${v.name} in ${this.repo}`, this.api(this.path('labels'), ['-f', `name=${v.name}`, '-f', `color=${v.color}`, '-f', `description=${v.description}`], 'POST'))
    known.add(v.name)
    this.log({ write: 'label-created', label: v.name })
  }
}

// Done is what a tool answers: its lines, one fact each.
type Done = string[]

// createIssue creates an issue with its labels, and with its parent and milestone when given. A ticket
// with a milestone takes its spec along onto the milestone when the spec carries none. A ticket of a
// spec run that cannot become a sub-issue loses the spec-run label and is refused.
async function createIssue(g: GitHub, a: { title: string; body: string; labels?: string[]; parent?: number; milestone?: string }): Promise<Done> {
  const title = a.title.trim()
  if (title === '' || a.body.trim() === '') throw new Refused('create_issue needs a title and a body')
  const labels = distinct((a.labels ?? []).map(canonical))
  const milestone = a.milestone === undefined ? undefined : milestoneName(a.milestone)
  // The parent is read before the issue exists: a parent that cannot be read refuses the call, so a
  // failed link below is one of a parent that exists, and no ticket is left pointing at nothing.
  const spec = a.parent === undefined ? undefined : await g.issue(a.parent)
  await specRun('the new issue', `leave the label ${specRunLabel} off`, labels, () => Promise.resolve(a.parent), () => Promise.resolve((spec?.labels ?? []).map((l) => l.name)))
  routable('the new issue', `leave the label ${routingLabel} off`, labels)
  const m = milestone === undefined ? undefined : await g.openMilestone(milestone)
  await g.ensure(labels)
  const fields = ['-f', `title=${title}`, '-f', `body=${a.body}`, ...labels.flatMap((l) => ['-f', `labels[]=${l}`]), ...(m ? ['-F', `milestone=${m.number}`] : [])]
  const made = await attempt('creating the issue', g.json<Issue>(g.path('issues'), fields, 'POST'))
  const n = made.number
  const url = made.html_url ?? `https://github.com/${g.repo}/issues/${n}`
  g.log({ write: 'issue-created', issue: n, title, labels, ...(milestone ? { milestone } : {}), url })
  const out = [`issue: #${n}`, `url: ${url}`, ...(milestone ? [`milestone: ${milestone}`] : [])]
  if (a.parent === undefined) return out
  const parent = a.parent
  try {
    await g.api(g.path(`issues/${parent}/sub_issues`), ['-F', `sub_issue_id=${made.id}`], 'POST')
    g.log({ write: 'sub-issue', issue: n, parent })
    out.push(`parent: #${parent} (sub-issue)`)
  } catch (err) {
    if (has(labels, specRunLabel)) {
      // A spec run finds its tickets through the sub-issues, so a ticket outside them loses the label.
      let removed = true
      try {
        await g.api(g.path(`issues/${n}/labels/${encodeURIComponent(specRunLabel)}`), [], 'DELETE')
        g.log({ write: 'labels', issue: n, removed: [specRunLabel] })
      } catch {
        removed = false
      }
      throw new Refused(
        `#${n} could not become a sub-issue of #${parent}, so it cannot join the spec run${removed ? ` and lost ${specRunLabel}` : `, and removing ${specRunLabel} from it failed; remove it on GitHub`}. Attach it to #${parent} on GitHub, then add ${specRunLabel} with set_labels on ${n}.`,
      )
    }
    out.push(
      unavailable(err)
        ? `warning: #${n} is not linked to #${parent} (sub-issues unavailable here); name #${parent} in its body`
        : `warning: linking #${n} as a sub-issue of #${parent} failed: ${(err as Error).message}; attach it to #${parent} on GitHub`,
    )
  }
  // The spec hangs on the milestone of its tickets, so the release waits for its acceptance.
  if (m) out.push(await attachParent(g, parent, spec?.milestone?.title ?? '', m))
  return out
}

// attachParent puts the spec on the milestone of its ticket when it carries none, and keeps another one.
// have is the milestone the spec carries, read before the ticket was created.
async function attachParent(g: GitHub, parent: number, have: string, { title: milestone, number }: Milestone): Promise<string> {
  if (have === milestone) return `parent-milestone: #${parent} already on ${milestone}`
  if (have !== '') return `warning: #${parent} stays on milestone ${have} while its sub-issues go to ${milestone}; move it if ${milestone} releases this work`
  try {
    await g.api(g.path(`issues/${parent}`), ['-F', `milestone=${number}`], 'PATCH')
  } catch {
    return `warning: attaching #${parent} to ${milestone} failed; attach it on GitHub`
  }
  g.log({ write: 'milestone-attached', issue: parent, milestone })
  return `parent-milestone: #${parent} attached to ${milestone}`
}

// setLabels adds and removes labels of an issue. The rules hold over the set the issue ends up with, so
// what it carries now is read first. That set replaces the issue's labels in one call, so the issue never
// carries a set in between that the rules would refuse.
async function setLabels(g: GitHub, a: { issue: number; add?: string[]; remove?: string[] }): Promise<Done> {
  const add = distinct((a.add ?? []).map(canonical))
  const remove = distinct((a.remove ?? []).map(canonical))
  if (add.length + remove.length === 0) throw new Refused('set_labels needs labels to add or to remove')
  const n = a.issue
  const current = await g.labelsOf(n)
  const added = add.filter((l) => !has(current, l))
  const removed = current.filter((l) => has(remove, l) && !has(add, l))
  const resulting = [...current.filter((l) => !removed.includes(l)), ...added]
  const drop = (label: string, kind: string) => (has(add, label) ? `leave ${label} out of add` : `take the ${kind} label off with remove ${label}`)
  await specRun(`#${n}`, drop(specRunLabel, 'spec-run'), resulting, () => g.parent(n), (p) => g.labelsOf(p))
  routable(`#${n}`, drop(routingLabel, 'routing'), resulting)
  await g.ensure(added)
  const changed = added.length + removed.length > 0
  if (changed) {
    const fields = resulting.flatMap((l) => ['-f', `labels[]=${l}`])
    await attempt(`setting the labels of #${n}`, g.api(g.path(`issues/${n}/labels`), fields, resulting.length > 0 ? 'PUT' : 'DELETE'))
    g.log({ write: 'labels', issue: n, ...(added.length ? { added } : {}), ...(removed.length ? { removed } : {}) })
  }
  return [`labels: #${n} ${resulting.length ? resulting.join(', ') : 'none'}`]
}

// block links the issue as blocked by each of the others through GitHub's native dependencies. Where
// they are unavailable it says the link was not made; any other failure refuses.
async function block(g: GitHub, a: { issue: number; by: number[] }): Promise<Done> {
  if (a.by.length === 0) throw new Refused('block needs the issues that block it')
  const out: Done = []
  for (const m of a.by) {
    const id = (await g.issue(m)).id
    try {
      await g.api(g.path(`issues/${a.issue}/dependencies/blocked_by`), ['-F', `issue_id=${id}`], 'POST')
      g.log({ write: 'blocked', issue: a.issue, by: m })
      out.push(`blocked: #${a.issue} by #${m} (native)`)
    } catch (err) {
      if (!unavailable(err)) throw new Refused(`linking #${a.issue} as blocked by #${m} failed: ${(err as Error).message}${out.length ? `; already linked: ${out.join('; ')}` : ''}`)
      out.push(`not linked: #${a.issue} blocked by #${m} (dependencies unavailable here); record the blocker with a comment on #${a.issue}`)
    }
  }
  return out
}

async function comment(g: GitHub, a: { issue: number; body: string }): Promise<Done> {
  if (a.body.trim() === '') throw new Refused('comment needs a body')
  await attempt(`commenting on #${a.issue}`, g.api(g.path(`issues/${a.issue}/comments`), ['-f', `body=${a.body}`], 'POST'))
  g.log({ write: 'comment', issue: a.issue, body: a.body })
  return [`comment: #${a.issue} posted`]
}

// close closes an issue, after its comment when one is given. A spec closed as completed is the end of
// its acceptance: it needs the closing comment and refuses while any of its tickets is open. Its tickets
// are its native sub-issues and the ones passed, which add to them.
async function close(g: GitHub, a: { issue: number; comment?: string; reason?: 'completed' | 'not planned'; tickets?: number[] }): Promise<Done> {
  const n = a.issue
  const reason = a.reason ?? 'completed'
  const out: Done = []
  const issue = await g.issue(n)
  if (issue.state !== 'open') throw new Refused(`#${n} is ${issue.state}, not open`)
  if (reason === 'completed' && has(issue.labels.map((l) => l.name), named.spec)) {
    if ((a.comment ?? '').trim() === '') throw new Refused(`closing the spec #${n} needs its closing comment; the closing comment records what the acceptance checked`)
    const hint = `pass the ticket numbers in tickets`
    const tickets = new Set(a.tickets ?? [])
    // The list of the native sub-issues carries their states, so only the tickets passed outside it are read.
    const states = new Map<number, string>()
    try {
      for (const s of await g.list<{ number: number; state: string }>(g.path(`issues/${n}/sub_issues?per_page=100`))) {
        tickets.add(s.number)
        states.set(s.number, s.state)
      }
    } catch {
      if (tickets.size === 0) throw new Refused(`could not read the sub-issues of #${n}; ${hint}`)
      out.push(`warning: could not read the sub-issues of #${n}; only the tickets passed were checked, a gap ticket outside them stays unseen`)
    }
    if (tickets.size === 0) throw new Refused(`#${n} has no native sub-issues; ${hint}`)
    const open: number[] = []
    // A ticket whose state cannot be read is never counted as closed: the refusal stops the close.
    for (const t of [...tickets].sort((x, y) => x - y)) if ((states.get(t) ?? (await g.issue(t)).state) === 'open') open.push(t)
    if (open.length > 0) throw new Refused(`#${n} still has open sub-issues: ${open.map((t) => `#${t}`).join(' ')}; the acceptance runs again once they are closed`)
    out.push(`tickets: ${tickets.size} checked, all closed`)
  }
  if (a.comment !== undefined && a.comment.trim() !== '') out.push(...(await comment(g, { issue: n, body: a.comment })))
  await attempt(`closing #${n}`, g.api(g.path(`issues/${n}`), ['-f', 'state=closed', '-f', `state_reason=${reason === 'not planned' ? 'not_planned' : 'completed'}`], 'PATCH'))
  g.log({ write: 'closed', issue: n, reason })
  out.push(`closed: #${n} (${reason})`)
  return out
}

async function attachMilestone(g: GitHub, a: { issue: number; milestone: string }): Promise<Done> {
  const title = milestoneName(a.milestone)
  const m = await g.openMilestone(title)
  await attempt(`attaching #${a.issue} to ${title}`, g.api(g.path(`issues/${a.issue}`), ['-F', `milestone=${m.number}`], 'PATCH'))
  g.log({ write: 'milestone-attached', issue: a.issue, milestone: title })
  return [`milestone: #${a.issue} attached to ${title}`]
}

// createMilestone creates the milestone with its goal, or reuses the open one of that title.
async function createMilestone(g: GitHub, a: { title: string; description?: string }): Promise<Done> {
  const title = milestoneName(a.title)
  const m = await g.milestone(title)
  if (m) return [`milestone: ${title} (existing, ${m.open_issues} open, ${m.closed_issues} closed)`]
  await attempt(`creating milestone ${title}`, g.api(g.path('milestones'), ['-f', `title=${title}`, '-f', `description=${a.description ?? ''}`], 'POST'))
  g.log({ write: 'milestone-created', milestone: title, ...(a.description ? { description: a.description } : {}) })
  return [`milestone: ${title} (created)`]
}

// The gh commands a planner session reads with: gh issue view and gh pr list read, gh issue create writes.
const readVerbs = new Set(['view', 'list', 'status', 'diff', 'checks', 'download', 'clone'])
const writeGroups = new Set(['issue', 'pr', 'label', 'release', 'repo', 'project', 'gist', 'secret', 'variable', 'workflow', 'run', 'cache', 'ruleset'])

// directWrite says why a Bash command writes GitHub past the tools, or undefined when it does not. It
// reads every gh in the command: a subcommand of a group that writes and does not only read, and a gh
// api call that sends a method other than GET or, without one, fields, which gh sends as a POST. A
// graphql call writes when it carries a mutation. It reads the command's words as the shell does
// (commands), so a gh call is a word gh of a command, and quoted text, as a grep pattern, a commit
// message or an echo, is one word and never names one. Quoted text that a command runs as a command
// of its own, as the script of sh -c or the words of eval, is read as a command again (scripts).
//
// It is a guard against a session's mistake, not a sandbox: a gh call whose words exist only when the
// command runs, as one read from a file or a pipe, stays unseen.
export function directWrite(command: string): string | undefined {
  return inspect(command, new Map())
}

// inspect is directWrite with the scripts it has read, so a script that many words hand on is read once.
function inspect(command: string, seen: Map<string, string | undefined>): string | undefined {
  if (seen.has(command)) return seen.get(command)
  seen.set(command, undefined)
  let why: string | undefined
  for (const words of commands(command)) {
    for (const script of scripts(words)) if (why === undefined) why = inspect(script, seen)
    why ??= ghWrite(words)
    if (why !== undefined) break
  }
  seen.set(command, why)
  return why
}

// The shells whose -c takes a script, and the commands that run their arguments joined as a command:
// eval here, and ssh and watch through a shell of their own.
const shells = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'mksh', 'fish', 'su'])
const runners = new Set(['eval', 'ssh', 'watch'])
const base = (word: string) => word.slice(word.lastIndexOf('/') + 1)
const isShell = (word: string) => shells.has(base(word)) || runners.has(base(word))

// scripts answers the texts a command's words hand on to run as commands: the word after a -c of a
// shell, the words after eval, ssh or watch, and the string env -S splits into words, with the words
// after it. It looks at every word, so a wrapper in front, as sudo, env or xargs, does not hide one.
// The first runner's words hold every later one, so the search ends there. Reading too much only
// refuses a command that writes nothing for a word that looks like gh, while reading too little lets a
// write past the tools.
function scripts(words: string[]): string[] {
  const out = new Set<string>()
  for (const [i, w] of words.entries()) {
    const name = base(w)
    if (runners.has(name)) {
      out.add(words.slice(i + 1).join(' '))
      break
    }
    if (name === 'env') {
      const split = splitString(words.slice(i + 1))
      if (split !== undefined) {
        out.add(split)
        break
      }
    }
    if (shells.has(name)) {
      const flag = words.findIndex((f, j) => j > i && /^-[a-zA-Z]*c[a-zA-Z]*$/.test(f))
      const script = flag < 0 ? undefined : words[flag + 1]
      if (script !== undefined) out.add(script)
    }
  }
  return [...out]
}

// splitString answers the command env runs from the arguments after it when one is -S or
// --split-string: the string, split again as a command, followed by the words after it.
function splitString(args: string[]): string | undefined {
  const at = args.findIndex((w) => /^(-[a-zA-Z0-9]*S|--split-string(=|$))/.test(w))
  if (at < 0) return undefined
  const flag = args[at] ?? ''
  const inline = flag.startsWith('--') ? flag.slice('--split-string='.length) : flag.slice(flag.indexOf('S') + 1)
  return (inline === '' ? args.slice(at + 1) : [inline, ...args.slice(at + 1)]).join(' ')
}

// A word that holds an expansion, as $x, ${x}, $'\x67', $( ) or a backtick, carries this mark: its
// text is known only when the command runs.
const runTime = '\u0000'
const atRunTime = (word: string) => word.includes(runTime)
const shown = (word: string) => word.replaceAll(runTime, '')

// ghWrite says why a gh call among a command's words writes GitHub, or undefined when it has none or
// every one only reads. A command may run several, as find with an -exec each, so it reads every word
// gh. A word built at run time may be gh too, so it is read as one when the words after it name a write.
function ghWrite(words: string[]): string | undefined {
  for (const [at, w] of words.entries()) {
    const gh = w === 'gh' || w.endsWith('/gh')
    if (!gh && !atRunTime(w)) continue
    const why = ghCall(words.slice(at + 1), gh)
    if (why !== undefined) return why
  }
  return undefined
}

// ghCall says why gh with these arguments writes GitHub. A group or verb built at run time may name a
// write, so gh refuses it; a word that is only perhaps gh refuses its static writes alone.
function ghCall(args: string[], gh: boolean): string | undefined {
  // The repository flag takes a value, which is neither a group nor a verb.
  const [group, verb] = args.filter((w, i) => !w.startsWith('-') && args[i - 1] !== '-R' && args[i - 1] !== '--repo')
  if (group === undefined) return undefined
  if (atRunTime(group)) return gh ? 'gh with a group built at run time may write GitHub' : undefined
  if (writeGroups.has(group) && verb !== undefined && atRunTime(verb)) return gh ? `gh ${group} with a verb built at run time may write GitHub` : undefined
  if (writeGroups.has(group) && verb !== undefined && !readVerbs.has(verb)) return `gh ${group} ${verb} writes GitHub`
  if (group !== 'api') return undefined
  const method = args.flatMap((w, i) => (w === '-X' || w === '--method' ? [args[i + 1] ?? ''] : /^(-X|--method=)(.+)$/.exec(w)?.slice(2, 3) ?? []))[0]
  if (method !== undefined && method.toUpperCase() !== 'GET') return `gh api --method ${shown(method)} writes GitHub`
  if (args.includes('graphql')) return args.some((w) => /\bmutation\b/.test(w)) ? 'a graphql mutation writes GitHub' : undefined
  if (method === undefined && args.some((w) => /^(-f|-F|--field|--raw-field|--input)(=|$)|^-[fF]./.test(w))) return 'gh api with fields sends a POST, which writes GitHub'
  return undefined
}

// An expansion of a parameter: $ before a name, a digit, a brace or a special parameter.
const parameter = /^\$[A-Za-z0-9_{@*#?$!-]/

// commands splits a Bash command into its simple commands, each the list of its words with the quotes
// removed. A command ends at &&, ||, ;, |, &, a newline or a parenthesis outside quotes, so a subshell
// starts commands of its own, as do a $( ) and a backtick, inside double quotes too, which mark the
// word they stand in as built at run time. Whitespace outside quotes ends a word, single quotes keep
// everything, and a backslash outside single quotes escapes the next character. A # that starts a word
// starts a comment, whose quotes and substitutions are nothing, up to the end of its line or of the
// backtick it stands in.
//
// A here-document's body is text, not commands: its lines up to the delimiter are skipped, except for
// the $( ) and backticks of a body whose delimiter is unquoted, which the shell runs. Inside $(( )),
// (( )) and $[ ], << shifts and starts none. When a shell or a runner is among the words, a body or a
// here-string may be its script, so it is read as commands too. Reading fails closed: a quote that
// never closes is an ordinary character, and a here-document whose delimiter line never comes is not
// one, so neither hides the commands after it.
function commands(command: string): string[][] {
  const out: string[][] = []
  const bodies: string[] = []
  let pending: { delimiter: string; tabs: boolean; expands: boolean }[] = []
  let i = 0
  // The open parentheses and brackets of the arithmetic around i, and the backticks around it.
  let arithmetic = 0
  let backticks = 0
  // substitution reads a $( ) from its $ past its closing parenthesis; a $(( )) is arithmetic.
  const substitution = () => {
    if (arithmetic > 0 || command[i + 2] === '(') arithmetic++
    i += 2
    read(')')
  }
  const backtick = () => {
    i++
    read('`')
  }
  // read reads commands until the end, or until the backtick or the parenthesis that closes the
  // substitution it reads, and answers past it.
  const read = (close?: '`' | ')') => {
    let words: string[] = []
    let word: string | undefined
    let depth = 0
    let hereString = false
    if (close === '`') backticks++
    const endWord = () => {
      if (word !== undefined) {
        words.push(word)
        if (hereString) bodies.push(word)
        hereString = false
      }
      word = undefined
    }
    const endCommand = () => {
      endWord()
      if (words.length > 0) out.push(words)
      words = []
    }
    while (i < command.length) {
      const c = command[i]
      const next = command[i + 1] ?? ''
      if (c === close && (close === '`' || depth === 0)) {
        if (close === ')' && arithmetic > 0) arithmetic--
        i++
        break
      }
      if (c === '$' && next === '(') {
        word = (word ?? '') + runTime
        substitution()
      } else if (c === '`') {
        word = (word ?? '') + runTime
        backtick()
      } else if (c === '$' && next === '[') {
        arithmetic++
        word = (word ?? '') + runTime + '$['
        i += 2
      } else if (c === '$' && next === "'") {
        word = (word ?? '') + ansi()
      } else if (parameter.test(c + next)) {
        word = (word ?? '') + runTime + c
        i++
      } else if (c === '(') {
        if (arithmetic > 0 || next === '(') arithmetic++
        if (close === ')') depth++
        i++
        endCommand()
      } else if (c === ')') {
        if (arithmetic > 0) arithmetic--
        if (close === ')') depth--
        i++
        endCommand()
      } else if (arithmetic > 0 && (c === '[' || c === ']')) {
        arithmetic += c === '[' ? 1 : -1
        word = (word ?? '') + c
        i++
      } else if (c === '#' && word === undefined) {
        while (i < command.length && command[i] !== '\n' && !(backticks > 0 && command[i] === '`')) i++
      } else if (c === '\n') {
        i++
        endCommand()
        hereDocuments()
      } else if (c === '&' || c === '|' || c === ';') {
        i++
        endCommand()
      } else if (c === ' ' || c === '\t' || c === '\r') {
        i++
        endWord()
      } else if (c === '\\' && next === '`' && backticks > 0) {
        // An escaped backtick inside a backtick opens or closes one nested in it, so what follows is a command.
        i += 2
        endCommand()
      } else if (c === '\\') {
        // A backslash before a newline continues the line.
        if (next !== '\n') word = (word ?? '') + next
        i += 2
      } else if (c === "'") {
        const end = command.indexOf("'", i + 1)
        word = (word ?? '') + (end < 0 ? c : command.slice(i + 1, end))
        i = end < 0 ? i + 1 : end + 1
      } else if (c === '"') {
        word = (word ?? '') + quoted()
      } else if (command.startsWith('<<<', i)) {
        endWord()
        hereString = true
        i += 3
      } else if (c === '<' && next === '<' && arithmetic > 0) {
        word = (word ?? '') + '<<'
        i += 2
      } else if (c === '<' && next === '<') {
        endWord()
        hereDocument()
      } else {
        word = (word ?? '') + c
        i++
      }
    }
    endCommand()
    if (close === '`') backticks--
  }
  // ansi reads a $'' string from its $ past its closing quote, where a backslash escapes the quote, and
  // answers its text; one with an escape is built at run time. One that never closes is the $ itself.
  const ansi = () => {
    let end = i + 2
    while (end < command.length && command[end] !== "'") end += command[end] === '\\' ? 2 : 1
    if (end >= command.length) {
      i++
      return '$'
    }
    const text = command.slice(i + 2, end)
    i = end + 1
    return text.includes('\\') ? runTime + text : text
  }
  // quoted reads a double-quoted string from its opening quote past its closing one and answers its
  // text; the commands of a substitution inside it go into out. A quote that never closes is the
  // character itself, and what follows it is read again as unquoted text; it stays one when a later
  // reading meets it again, so nested quotes that never close are read once each and not once per path.
  const unclosed = new Set<number>()
  const quoted = () => {
    const start = i
    if (unclosed.has(start)) {
      i++
      return '"'
    }
    const before = { commands: out.length, pending: pending.length, bodies: bodies.length, arithmetic }
    let text = ''
    i++
    while (i < command.length && command[i] !== '"') {
      const c = command[i]
      const next = command[i + 1] ?? ''
      if (c === '\\' && '"\\$`\n'.includes(next) && next !== '') {
        text += next
        i += 2
      } else if (c === '`') {
        text += runTime
        backtick()
      } else if (c === '$' && next === '(') {
        text += runTime
        substitution()
      } else if (parameter.test(c + next)) {
        text += runTime + c
        i++
      } else {
        text += c
        i++
      }
    }
    if (i < command.length) {
      i++
      return text
    }
    out.length = before.commands
    pending.length = before.pending
    bodies.length = before.bodies
    arithmetic = before.arithmetic
    unclosed.add(start)
    i = start + 1
    return '"'
  }
  // hereDocument reads the operator << or <<- and the delimiter word after it, and keeps the
  // here-document for the end of its line. A delimiter with any quote in it leaves the body unexpanded.
  const hereDocument = () => {
    i += 2
    const tabs = command[i] === '-'
    if (tabs) i++
    while (command[i] === ' ' || command[i] === '\t') i++
    let delimiter = ''
    let expands = true
    while (i < command.length && !/[\s;&|()<>`]/.test(command[i] ?? '')) {
      const c = command[i]
      const end = c === "'" || c === '"' ? command.indexOf(c, i + 1) : -1
      if (end >= 0) {
        delimiter += command.slice(i + 1, end)
        expands = false
        i = end + 1
      } else if (c === '\\' && i + 1 < command.length) {
        delimiter += command[i + 1]
        expands = false
        i += 2
      } else {
        delimiter += c
        i++
      }
    }
    if (delimiter !== '') pending.push({ delimiter, tabs, expands })
  }
  // hereDocuments reads the bodies of the here-documents of the line that just ended, in order. A body
  // that expands has its substitutions read; every body is kept for a shell that may run it.
  const hereDocuments = () => {
    const documents = pending
    pending = []
    for (const { delimiter, tabs, expands } of documents) {
      let line = i
      let next = -1
      while (line < command.length) {
        const end = command.indexOf('\n', line)
        const text = command.slice(line, end < 0 ? undefined : end)
        next = end < 0 ? command.length : end + 1
        if ((tabs ? text.replace(/^\t+/, '') : text) === delimiter) break
        line = next
        next = -1
      }
      if (next < 0) return
      bodies.push(command.slice(i, line))
      if (expands) {
        while (i < line) {
          if (command[i] === '\\') i += 2
          else if (command[i] === '`') backtick()
          else if (command[i] === '$' && command[i + 1] === '(') substitution()
          else i++
        }
      }
      i = Math.max(i, next)
    }
  }
  read()
  if (out.some((words) => words.some((w) => isShell(w)))) for (const body of bodies) out.push(...commands(body))
  return out
}

const issueNumber = z.number().int().positive()
const label = z.string().min(1)

// connect is the repository owner/name written through gh, its writes logged into the process's event log.
const connect = (gh: string, repo: string, log: (e: Record<string, unknown>) => void) => new GitHub(gh, repo, (w) => log({ event: 'github', ...w }))

// githubTools is the server of the tools for one planner session on the repository owner/name. log
// writes into the process's event log.
export function githubTools(gh: string, repo: string, log: (e: Record<string, unknown>) => void): McpSdkServerConfigWithInstance {
  const g = connect(gh, repo, log)
  // answer runs a tool and answers its lines, or its refusal as an error the session reads.
  const answer = <A>(name: string, f: (g: GitHub, a: A) => Promise<Done>) => async (a: A) => {
    try {
      return { content: [{ type: 'text' as const, text: (await f(g, a)).join('\n') }] }
    } catch (err) {
      const reason = (err as Error).message
      log({ event: 'github-refused', tool: name, reason })
      return { isError: true, content: [{ type: 'text' as const, text: `error: ${reason}` }] }
    }
  }
  return createSdkMcpServer({
    name: githubServer,
    version: '1.0.0',
    tools: [
      tool(
        'create_issue',
        `Create an issue of ${repo} with its labels, and with its parent (it becomes a sub-issue) and its milestone (vX.Y.Z, open) when given. A ticket with a milestone takes its spec along when the spec has none.`,
        { title: z.string(), body: z.string(), labels: z.array(label).optional(), parent: issueNumber.optional(), milestone: z.string().optional() },
        answer('create_issue', createIssue),
      ),
      tool(
        'set_labels',
        `Add and remove labels of an issue of ${repo}. The routing rules hold over the labels the issue ends up with.`,
        { issue: issueNumber, add: z.array(label).optional(), remove: z.array(label).optional() },
        answer('set_labels', setLabels),
      ),
      tool('block', `Link an issue of ${repo} as blocked by each of the others.`, { issue: issueNumber, by: z.array(issueNumber) }, answer('block', block)),
      tool('comment', `Comment on an issue of ${repo}.`, { issue: issueNumber, body: z.string() }, answer('comment', comment)),
      tool(
        'close',
        `Close an issue of ${repo}, after the comment when given. A spec closed as completed needs its closing comment and every ticket closed; tickets adds ticket numbers to its native sub-issues.`,
        { issue: issueNumber, comment: z.string().optional(), reason: z.enum(['completed', 'not planned']).optional(), tickets: z.array(issueNumber).optional() },
        answer('close', close),
      ),
      tool('attach_milestone', `Attach an issue of ${repo} to an open milestone vX.Y.Z.`, { issue: issueNumber, milestone: z.string() }, answer('attach_milestone', attachMilestone)),
      tool(
        'create_milestone',
        `Create the milestone vX.Y.Z of ${repo} with its goal as the description, or reuse the open one of that name.`,
        { title: z.string(), description: z.string().optional() },
        answer('create_milestone', createMilestone),
      ),
    ],
  })
}

// writer is the writes of the tools for the controller's own use: an acceptance creates its gap tickets,
// posts its deviations and closes its spec with them, under the same rules and into the same event log.
// A write it refuses throws a Refused with the reason.
export function writer(gh: string, repo: string, log: (e: Record<string, unknown>) => void) {
  const g = connect(gh, repo, log)
  return {
    createIssue: (a: Parameters<typeof createIssue>[1]) => createIssue(g, a),
    comment: (a: Parameters<typeof comment>[1]) => comment(g, a),
    close: (a: Parameters<typeof close>[1]) => close(g, a),
  }
}
