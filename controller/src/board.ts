// The board: for every project the processes this machine knows, the frontier of issues ready to
// start and the specs ready for acceptance. It is derived on every request from the state directory,
// git and GitHub, and stored nowhere.
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { run } from './exec.js'
import type { Project } from './project.js'

// The labels of the frontier rule, as the contract fixture's vocabulary names them.
export const labels = {
  ready: 'ready-for-agent',
  human: 'ready-for-human',
  routing: 'factory',
  specRun: 'factory:spec-run',
  spec: 'spec',
}

// The query the frontier asks GitHub, the contract fixture's own.
export const frontierQuery = `issues?labels=${labels.ready}&state=open&per_page=100`

export type Kind = 'work' | 'plan' | 'hunt' | 'standardize'

// The states of a process. The first six wait for a person, each with the one action that answers it,
// and a failed one waits for a person who opens it to read the reason. A process in any other state runs
// on its own and is opened to be watched. A claimed process is created until its first session starts.
// An interrupted one either had its session stopped with the controller and resumes by its session id,
// or was adopted with no session yet and starts a fresh one. A foreign one is a worktree of an issue the state does not know, which a person adopts or removes.
export const states = ['blocked', 'approval', 'ready', 'input', 'interrupted', 'foreign', 'failed', 'running', 'waiting', 'created'] as const
export type State = (typeof states)[number]
const actions: Partial<Record<State, string>> = {
  blocked: 'Answer',
  approval: 'Approve',
  ready: 'Merge',
  input: 'Continue',
  interrupted: 'Resume',
  foreign: 'Adopt',
  failed: 'Open',
}

export type Checks = 'none' | 'pending' | 'pass' | 'fail'

export interface Process {
  kind: Kind
  state: State
  stage: string
  issue: number | null
  branch: string
  worktree: string | null
  pr: { number: number; url: string; draft: boolean } | null
  checks: Checks | null
  // since is when the process last changed: its record's time, else the last commit of its branch.
  since: string | null
  note: string
  needs: boolean
  action: string
}

export interface Issue {
  number: number
  title: string
  milestone: string | null
}

export interface ProjectBoard extends Project {
  processes: Process[]
  frontier: Issue[]
  acceptance: Issue[]
  // notes says what could not be read, so an empty section reads as unknown and not as idle.
  notes: string[]
}

// kindOf is the kind of process a branch holds, or undefined for a branch that holds none.
export function kindOf(branch: string): Kind | undefined {
  if (branch.startsWith('plan/')) return 'plan'
  if (branch.startsWith('hunt/')) return 'hunt'
  if (branch === 'chore/standardize') return 'standardize'
  if (!branch.startsWith('spec/') && issueOf(branch) !== null) return 'work'
  return undefined
}

// issueOf is the issue a branch belongs to by the branch contract, or null.
export function issueOf(branch: string): number | null {
  if (branch.startsWith('plan/')) return null
  const m = /^[a-z]+\/([0-9]+)-/.exec(branch)
  return m ? Number(m[1]) : null
}

// issueFromBranch is the issue a branch belongs to by the branch contract, spelled as the branch spells
// it, or '' for a branch of no issue. A spec branch belongs to its spec.
export function issueFromBranch(branch: string): string {
  if (branch.startsWith('plan/')) return ''
  return /^[a-z]+\/([0-9]+)-/.exec(branch)?.[1] ?? ''
}

// A record is what the state directory holds of a process: one JSON file per process under
// processes/. It names its project by the checkout's path.
export interface ProcessRecord {
  project: string
  kind: Kind
  branch: string
  issue?: number | null
  worktree?: string | null
  stage?: string
  state?: string
  note?: string
  updated_at?: string
}

// recordFiles are the process records of a project, each with the path of its file. A record counts
// when its branch is of the kind it names. The board and a claim read the processes through it alone.
export function recordFiles(stateDir: string, project: string): { file: string; record: ProcessRecord }[] {
  const dir = join(stateDir, 'processes')
  let names: string[]
  try {
    names = readdirSync(dir).filter((n) => n.endsWith('.json'))
  } catch {
    return []
  }
  const out: { file: string; record: ProcessRecord }[] = []
  for (const name of names.sort()) {
    try {
      const r = JSON.parse(readFileSync(join(dir, name), 'utf8')) as ProcessRecord
      if (r && r.project === project && typeof r.branch === 'string' && kindOf(r.branch) === r.kind) out.push({ file: join(dir, name), record: r })
    } catch {
      // a record that cannot be read is skipped, as one that is being written
    }
  }
  return out
}

const records = (stateDir: string, project: string): ProcessRecord[] => recordFiles(stateDir, project).map((r) => r.record)

export interface Worktree {
  path: string
  branch: string
}

// worktrees are the worktrees of a checkout other than the checkout itself, each on its branch.
export async function worktrees(top: string): Promise<Worktree[]> {
  const out: Worktree[] = []
  let path = ''
  for (const line of (await run('git', ['-C', top, 'worktree', 'list', '--porcelain'])).split('\n')) {
    if (line.startsWith('worktree ')) path = line.slice('worktree '.length)
    else if (line.startsWith('branch refs/heads/') && path !== top) out.push({ path, branch: line.slice('branch refs/heads/'.length) })
  }
  return out
}

// committed is the time of the last commit of every local branch.
async function committed(top: string): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  const refs = await run('git', ['-C', top, 'for-each-ref', '--format=%(refname:short) %(committerdate:iso-strict)', 'refs/heads'])
  for (const line of refs.split('\n')) {
    const i = line.lastIndexOf(' ')
    if (i > 0) out.set(line.slice(0, i), line.slice(i + 1))
  }
  return out
}

interface PullRequest {
  number: number
  headRefName: string
  isCrossRepository?: boolean
  isDraft: boolean
  url: string
  statusCheckRollup?: { conclusion?: string | null; state?: string | null; status?: string | null }[]
}

export function checksOf(pr: PullRequest): Checks {
  const c = (pr.statusCheckRollup ?? []).map((x) => x.conclusion || x.state || 'PENDING')
  if (c.length === 0) return 'none'
  if (c.some((s) => ['FAILURE', 'ERROR', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE'].includes(s))) return 'fail'
  if (c.some((s) => ['PENDING', 'EXPECTED', 'QUEUED', 'IN_PROGRESS', 'WAITING', 'REQUESTED'].includes(s))) return 'pending'
  return 'pass'
}

const firstStage: Record<Kind, string> = { work: 'implement', plan: 'plan', hunt: 'hunt', standardize: 'audit' }

// derived joins what a record says with what git and GitHub say. The record decides state, stage and
// note. A work worktree without a record is foreign, which its pull request does not change. A worktree
// of another kind without a record is read from its pull request, as the controller runs no process of
// that kind yet.
function derived(branch: string, record: ProcessRecord | undefined, tree: Worktree | undefined, pr: PullRequest | undefined, since: string | undefined): Process {
  const kind = record?.kind ?? kindOf(branch) ?? 'work'
  const checks = pr ? checksOf(pr) : null
  let state: State
  let stage: string
  let note: string
  if (record) {
    state = states.includes(record.state as State) ? (record.state as State) : 'running'
    stage = record.stage || firstStage[kind]
    note = oneLine(record.note ?? '')
  } else if (kind === 'work') {
    stage = pr ? 'ci' : firstStage.work
    state = 'foreign'
    note = `not started by this controller${pr ? `; PR #${pr.number}${pr.isDraft ? ' draft' : ''}, checks ${checks}` : ''}; adopt it or remove it`
  } else if (pr) {
    stage = 'ci'
    state = checks === 'pass' && !pr.isDraft ? 'ready' : checks === 'pending' ? 'waiting' : 'running'
    note = `PR #${pr.number}${pr.isDraft ? ' draft' : ''}, checks ${checks}`
  } else {
    stage = firstStage[kind]
    state = 'running'
    note = 'no process record; no pull request yet'
  }
  return {
    kind,
    state,
    stage,
    issue: record?.issue ?? issueOf(branch),
    branch,
    worktree: tree?.path ?? record?.worktree ?? null,
    pr: pr ? { number: pr.number, url: pr.url, draft: pr.isDraft } : null,
    checks,
    since: record?.updated_at ?? since ?? null,
    note,
    needs: actions[state] !== undefined,
    action: actions[state] ?? 'Open',
  }
}

// oneLine keeps a note or a title to one line: every control character and line separator is a space.
function oneLine(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').trim()
}

// GitHubIssue is what the REST issue list carries of an issue: the fields the frontier rule reads.
export interface GitHubIssue {
  number: number
  title: string
  state?: string
  labels?: ({ name?: string } | string)[]
  assignees?: unknown[]
  milestone?: { title?: string } | null
  pull_request?: unknown
  parent_issue_url?: string | null
  repository_url?: string
  issue_dependencies_summary?: { blocked_by?: number }
}

// labelNames are the names of an issue's labels, whether GitHub gives them as names or as objects.
export const labelNames = (i: GitHubIssue) => (i.labels ?? []).map((l) => (typeof l === 'string' ? l : (l.name ?? '')))

// frontier is the frontier rule over the agent-ready issues. It keeps the ones without assignee, open
// blocker, routing label or a process of this machine. It leaves out the ones held in a spec run.
// An issue is in a spec run when it or its parent carries the spec-run label. It is held there unless
// it carries the human label.
// A parent that cannot be read holds the issue, since a ticket of a spec run is the factory's.
// parent answers the parent of an issue, or throws when it cannot be read.
export async function frontier(
  issues: GitHubIssue[],
  claimed: Set<number>,
  parent: (n: number) => Promise<GitHubIssue>,
): Promise<{ free: GitHubIssue[]; unknown: number }> {
  let unknown = 0
  // The parents are read at once, and the issues keep their order.
  const kept = await Promise.all(
    issues.map(async (i) => {
      const l = labelNames(i)
      if (i.pull_request || (i.assignees ?? []).length > 0 || (i.issue_dependencies_summary?.blocked_by ?? 0) > 0) return undefined
      if (l.includes(labels.routing) || claimed.has(i.number)) return undefined
      const human = l.includes(labels.human)
      if (l.includes(labels.specRun) && !human) return undefined
      if (i.parent_issue_url && !human) {
        let p: GitHubIssue
        try {
          p = await parent(i.number)
          if (!(p.number > 0)) throw new Error('no issue')
        } catch {
          unknown++
          return undefined
        }
        if (labelNames(p).includes(labels.specRun)) return undefined
      }
      return i
    }),
  )
  return { free: kept.filter((i): i is GitHubIssue => i !== undefined), unknown }
}

// pages reads the output of gh api --paginate, which writes one JSON array per page, into one array.
export function pages<T>(out: string): T[] {
  const all: T[] = []
  let depth = 0
  let start = -1
  let quoted = false
  for (let i = 0; i < out.length; i++) {
    const c = out[i]
    if (quoted) {
      if (c === '\\') i++
      else if (c === '"') quoted = false
      continue
    }
    if (c === '"') quoted = true
    else if (c === '[' || c === '{') {
      if (depth++ === 0) start = i
    } else if (c === ']' || c === '}') {
      if (--depth === 0) {
        const page = JSON.parse(out.slice(start, i + 1)) as T[] | T
        if (Array.isArray(page)) all.push(...page)
        else all.push(page)
      }
    }
  }
  return all
}

const issue = (i: GitHubIssue): Issue => ({ number: i.number, title: oneLine(i.title), milestone: i.milestone?.title ? oneLine(i.milestone.title) : null })

// ghApi answers the REST endpoints of a repository through gh, each page of a paginated one merged.
export function ghApi(gh: string, repo: string) {
  return async <T>(endpoint: string, paginate = false): Promise<T> => {
    const out = await run(gh, ['api', ...(paginate ? ['--paginate'] : []), `repos/${repo}/${endpoint}`])
    return (paginate ? pages(out) : JSON.parse(out)) as T
  }
}

// board derives the board of one project.
export async function board(project: Project, stateDir: string, gh: string): Promise<ProjectBoard> {
  const repo = `${project.owner}/${project.name}`
  const notes: string[] = []
  const api = ghApi(gh, repo)

  const [trees, times, prs] = await Promise.all([
    worktrees(project.path),
    committed(project.path),
    run(gh, ['pr', 'list', '--repo', repo, '--state', 'open', '--limit', '100', '--json', 'number,headRefName,isCrossRepository,isDraft,url,statusCheckRollup'])
      .then((out) => JSON.parse(out) as PullRequest[])
      .catch(() => {
        notes.push('could not read the pull requests; processes show none')
        return [] as PullRequest[]
      }),
  ])
  const recorded = records(stateDir, project.path)
  // The processes are in the order of their branches, so the board reads the same on every request.
  const branches = [...new Set([...trees.filter((t) => kindOf(t.branch)).map((t) => t.branch), ...recorded.map((r) => r.branch)])].sort()
  const processes = branches.map((b) =>
    derived(
      b,
      recorded.find((r) => r.branch === b),
      trees.find((t) => t.branch === b),
      // A pull request from a fork may carry the same branch name, but it is not this checkout's.
      prs.find((p) => p.headRefName === b && !p.isCrossRepository),
      times.get(b),
    ),
  )
  const claimed = new Set(processes.map((p) => p.issue).filter((n): n is number => n !== null))

  // Both reads run at once and each answers its own note, so the notes keep one order however they settle.
  const [free, acceptance] = await Promise.all([
    api<GitHubIssue[]>(frontierQuery)
      .then(async (ready) => {
        const f = await frontier(ready, claimed, (n) => api<GitHubIssue>(`issues/${n}/parent`))
        const note = f.unknown
          ? `could not read the parent of ${f.unknown} ready-for-agent issue(s); they are left out, since a ticket of a spec run is the factory's`
          : undefined
        return { issues: f.free.map(issue), note }
      })
      .catch(() => ({ issues: [] as Issue[], note: 'could not read the agent-ready issues; the frontier is empty, not idle' })),
    api<GitHubIssue[]>(`issues?labels=${labels.spec}&state=open&per_page=100`, true)
      .then(async (specs) => {
        let unknown = 0
        const ready = await Promise.all(
          specs
            .filter((s) => !s.pull_request)
            .map(async (s) => {
              try {
                const subs = await api<GitHubIssue[]>(`issues/${s.number}/sub_issues?per_page=100`, true)
                return subs.length > 0 && subs.every((t) => t.state === 'closed') ? s : undefined
              } catch {
                unknown++
                return undefined
              }
            }),
        )
        const note = unknown ? `could not read the sub-issues of ${unknown} spec(s); they are not listed` : undefined
        return { issues: ready.filter((s): s is GitHubIssue => s !== undefined).map(issue), note }
      })
      .catch(() => ({ issues: [] as Issue[], note: 'could not read the open specs; ready for acceptance is empty, not idle' })),
  ])
  for (const n of [free.note, acceptance.note]) if (n) notes.push(n)
  return { ...project, processes, frontier: free.issues, acceptance: acceptance.issues, notes }
}
