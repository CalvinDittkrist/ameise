// The actions without a process of their own: merge, release and acceptance start. A merge takes a
// ready pull request into its base and cleans up after it, by the rules of the orchestrator's merge. A
// release tags a finished milestone, by the branch model. An acceptance start opens a plan process on a
// spec whose tickets are all closed.
import { rmSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { run } from './exec.js'
import { checksOf, ghApi, issueFromBranch, labels, recordFiles, worktrees, type GitHubIssue } from './board.js'
import { addWorktree, exists, fetch, git, held, slug, writeProcess, type CreatedRecord } from './claim.js'
import { type Project, Refusal } from './project.js'

// The pull request as gh pr view answers it: the fields a merge decides by.
interface PullRequest {
  number: number
  title: string
  state: string
  isDraft: boolean
  mergeable: string
  mergeStateStatus: string
  headRefName: string
  headRefOid: string
  baseRefName: string
  isCrossRepository: boolean
  reviewDecision: string | null
  statusCheckRollup: { conclusion?: string | null; state?: string | null; status?: string | null }[]
  mergeCommit: { oid: string } | null
}

const prFields = 'number,title,state,isDraft,mergeable,mergeStateStatus,headRefName,headRefOid,baseRefName,isCrossRepository,reviewDecision,statusCheckRollup,mergeCommit'

async function view(gh: string, repo: string, pr: number): Promise<PullRequest> {
  try {
    return JSON.parse(await run(gh, ['pr', 'view', String(pr), '--repo', repo, '--json', prFields])) as PullRequest
  } catch (err) {
    throw new Refusal(`could not read PR #${pr} of ${repo}: ${(err as Error).message}`, 502)
  }
}

// defaultBranch is the default branch GitHub names for the repository, or '' when it does not answer.
const defaultBranch = (gh: string, repo: string) =>
  run(gh, ['repo', 'view', `github.com/${repo}`, '--json', 'defaultBranchRef', '--jq', '.defaultBranchRef.name']).catch(() => '')

// unresolved counts the review threads of a pull request nobody resolved, by the first hundred threads
// as the orchestrator's merge reads them.
async function unresolved(gh: string, owner: string, name: string, n: number): Promise<number> {
  const query = 'query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){reviewThreads(first:100){nodes{isResolved}}}}}'
  let out: { data?: { repository?: { pullRequest?: { reviewThreads?: { nodes?: { isResolved: boolean }[] } } } } }
  try {
    out = JSON.parse(await run(gh, ['api', 'graphql', '-F', `owner=${owner}`, '-F', `name=${name}`, '-F', `number=${n}`, '-f', `query=${query}`])) as typeof out
  } catch (err) {
    throw new Refusal(`could not read the review threads of PR #${n}: ${(err as Error).message}`, 502)
  }
  const nodes = out.data?.repository?.pullRequest?.reviewThreads?.nodes
  if (!nodes) throw new Refusal(`GitHub named no review threads of PR #${n}`, 502)
  return nodes.filter((t) => !t.isResolved).length
}

// green refuses a pull request that is not ready to merge: not open, a draft, in conflict or not yet
// computed, not clean, with a check failed or pending, with changes requested or a review thread open.
function green(pr: PullRequest, open: number) {
  const n = pr.number
  const no = (why: string) => new Refusal(`PR #${n} ${why}`, 409)
  if (pr.state !== 'OPEN') throw no(`is ${pr.state}, not open`)
  if (pr.isDraft) throw no(`is a draft; lift it with gh pr ready ${n} and merge again`)
  if (pr.mergeable === 'UNKNOWN') throw no('is still being checked for conflicts by GitHub; try again in a moment')
  if (pr.mergeable !== 'MERGEABLE') throw no(`is ${pr.mergeable}; resolve its conflicts first`)
  const checks = checksOf(pr)
  if (checks === 'fail') throw no('has failed checks')
  if (checks === 'pending') throw no('has checks still pending; merge it once they pass')
  if (pr.mergeStateStatus !== 'CLEAN') throw no(`has the merge state ${pr.mergeStateStatus}, not CLEAN`)
  if (pr.reviewDecision === 'CHANGES_REQUESTED') throw no('has changes requested')
  if (open > 0) throw no(`has ${open} unresolved review thread(s); address and resolve them first`)
}

export interface Merged {
  pr: number
  title: string
  method: 'squash' | 'merge'
  base: string
  branch: string
  // kept says why the branch stays: a long-lived branch or a fork's; '' when it was deleted.
  kept: string
  worktree: string | null
  // closed is the issue the merge closed here, since GitHub closes it only on the default branch.
  closed: number | null
  // queued says the base has a merge queue that took the pull request, which is not merged yet; its
  // branch, worktree and process stay until it is.
  queued: boolean
  warnings: string[]
}

// merge takes a ready pull request of the project into its base. A process branch is squash-merged and
// deleted, its worktree and its process removed. A promotion from dev or main gets a merge commit and its
// branch stays, as a fork's does. A merge into a branch other than the default closes the head branch's
// issue, which GitHub does only on the default branch. A pull request a merge queue takes keeps all of
// that until GitHub merges it. It refuses a pull request that is not green, a branch the checkout stands
// on, and a worktree with work not on origin, before it changes anything.
export function merge(project: Project, stateDir: string, gh: string, fake: boolean, n: number): Promise<Merged> {
  return held(project, `PR #${n}`, () => mergeHeld(project, stateDir, gh, fake, n))
}

async function mergeHeld(project: Project, stateDir: string, gh: string, fake: boolean, n: number): Promise<Merged> {
  const top = project.path
  const repo = `${project.owner}/${project.name}`
  const pr = await view(gh, repo, n)
  green(pr, pr.state === 'OPEN' ? await unresolved(gh, project.owner, project.name, n) : 0)
  const branch = pr.headRefName
  const warnings: string[] = []
  let method: Merged['method'] = 'squash'
  let kept = ''
  if (pr.isCrossRepository) kept = 'a fork'
  else if (branch === 'dev' || branch === 'main') {
    method = 'merge'
    kept = 'long-lived'
  }

  // A fork's branch may carry the name of one of ours, so it names no worktree and no process here.
  const tree = kept ? undefined : (await worktrees(top)).find((t) => t.branch === branch)
  // worktrees leaves the checkout itself out, and a branch it stands on cannot be deleted.
  if (!kept && (await git(top, 'rev-parse', '--abbrev-ref', 'HEAD').catch(() => '')) === branch) {
    throw new Refusal(`the checkout ${top} stands on ${branch}; switch it to ${pr.baseRefName} and merge again`, 409)
  }
  // The merge deletes the local branch, with or without a worktree, so either must hold nothing unpushed.
  if (!kept && (await exists(top, `refs/heads/${branch}`))) {
    const unpushed = Number(await git(top, 'rev-list', '--count', branch, '--not', '--remotes=origin'))
    if (unpushed > 0) throw new Refusal(`${branch} has ${unpushed} commit(s) not on origin, which the merge would lose; push them first`, 409)
  }
  if (tree && (await git(tree.path, 'status', '--porcelain')) !== '') throw new Refusal(`${tree.path} has changes not committed, which the merge would lose; commit and push them first`, 409)

  // The merge takes the head the checks were read of, so a push since then is refused, not merged unchecked.
  try {
    await run(gh, ['pr', 'merge', String(n), '--repo', repo, `--${method}`, '--match-head-commit', pr.headRefOid, ...(kept ? [] : ['--delete-branch'])])
  } catch (err) {
    throw new Refusal(`could not merge PR #${n}: ${(err as Error).message}`, 502)
  }

  // A base with a merge queue takes the pull request into its queue, so only a MERGED state lets the
  // cleanup go on; the queue may still reject it.
  const after = await view(gh, repo, n).catch(() => undefined)
  if (after?.state !== 'MERGED') {
    warnings.push(`PR #${n} is in the merge queue of ${pr.baseRefName}, not merged yet; its branch, worktree and process stay, abandon the process once GitHub merges it`)
    return { pr: n, title: pr.title, method, base: pr.baseRefName, branch, kept, worktree: null, closed: null, queued: true, warnings }
  }

  if (!kept) {
    // The pull request is merged already, so a cleanup that fails is a warning, never an error.
    if (tree) {
      try {
        await git(top, 'worktree', 'remove', '--force', tree.path)
      } catch (err) {
        warnings.push(`PR #${n} is merged, but ${tree.path} could not be removed: ${(err as Error).message}; remove it by hand`)
      }
      await git(top, 'worktree', 'prune').catch(() => undefined)
    }
    await git(top, 'branch', '-D', branch).catch(() => undefined)
    for (const { file } of recordFiles(stateDir, top).filter((r) => r.record.branch === branch)) {
      for (const f of [file, file.replace(/\.json$/, '.events.jsonl')]) {
        try {
          rmSync(f, { force: true })
        } catch (err) {
          warnings.push(`PR #${n} is merged, but ${f} could not be removed: ${(err as Error).message}; remove it by hand`)
        }
      }
    }
  }

  let closed: number | null = null
  const issue = pr.isCrossRepository ? '' : issueFromBranch(branch)
  if (issue) {
    const main = await defaultBranch(gh, repo)
    if (!main) warnings.push(`could not read the default branch of ${repo}; if ${pr.baseRefName} is not it, close #${issue} by hand`)
    else if (pr.baseRefName !== main) {
      const comment = `Merged in #${n} into ${pr.baseRefName}. GitHub closes a linked issue only for a merge into the default branch ${main}, so the merge closes it here.`
      try {
        await run(gh, ['issue', 'close', issue, '--repo', repo, '--comment', comment])
        closed = Number(issue)
      } catch {
        warnings.push(`PR #${n} is merged into ${pr.baseRefName}, but #${issue} could not be closed; close it by hand`)
      }
    }
  }

  // The checkout follows its base when it stands on it with nothing changed; untracked files never block.
  if (!fake) {
    await git(top, 'fetch', '-q', '--prune', 'origin').catch(() => undefined)
    const current = await git(top, 'rev-parse', '--abbrev-ref', 'HEAD').catch(() => '')
    if (current === pr.baseRefName && (await git(top, 'status', '--porcelain', '--untracked-files=no').catch(() => 'unknown')) === '') {
      await git(top, 'merge', '-q', '--ff-only', `origin/${pr.baseRefName}`).catch(() => warnings.push(`could not fast-forward ${pr.baseRefName}`))
    }
  }
  return { pr: n, title: pr.title, method, base: pr.baseRefName, branch, kept, worktree: tree?.path ?? null, closed, queued: false, warnings }
}

// A milestone as the REST API answers it.
interface Milestone {
  number: number
  title: string
  state: string
  open_issues: number
  closed_issues: number
}

export type Released =
  | { status: 'released'; milestone: string; model: 'main' | 'dev+main'; target: string; release: string; promotion: string | null }
  | { status: 'waiting'; milestone: string; model: 'dev+main'; promotion: string; reason: string }

// The shape of a milestone a release tags, as the orchestrator's release takes it.
export const version = /^v[0-9]+\.[0-9]+\.[0-9]+$/

// releaseRequest reads the milestone of a release's body, or refuses it.
export function releaseRequest(body: Record<string, unknown>): string {
  const m = body.milestone
  if (typeof m !== 'string' || !version.test(m)) throw new Refusal(`milestone ${JSON.stringify(m)} is not a version; name it as v1.2.3`)
  return m
}

// release tags a finished milestone and publishes its release, then closes the milestone. It refuses a
// milestone that is missing, closed or has open issues, and a tag that exists. The default branch decides
// the model: with main alone it tags the head of main; with dev it opens or finds the promotion dev to
// main, merges it and tags its merge commit. A promotion that is not green yet answers waiting, and a
// release once it is green goes on from there.
export function release(project: Project, stateDir: string, gh: string, fake: boolean, milestone: string): Promise<Released> {
  return held(project, milestone, () => releaseHeld(project, stateDir, gh, fake, milestone))
}

async function releaseHeld(project: Project, stateDir: string, gh: string, fake: boolean, v: string): Promise<Released> {
  const repo = `${project.owner}/${project.name}`
  const api = ghApi(gh, repo)
  const unread = (what: string) => (err: unknown) => {
    throw new Refusal(`could not read ${what} of ${repo}: ${(err as Error).message}`, 502)
  }

  const ms = (await api<Milestone[]>('milestones?state=all&per_page=100', true).catch(unread('the milestones'))).find((m) => m.title === v)
  if (!ms) throw new Refusal(`milestone ${v} does not exist; create it and attach its issues first`, 409)
  if (ms.state !== 'open') throw new Refusal(`milestone ${v} is closed already`, 409)
  if (ms.open_issues > 0) throw new Refusal(`milestone ${v} has ${ms.open_issues} open issue(s); finish them or move them to a later milestone`, 409)
  // Only a 404 says the tag is free: any other failure must not let the release reuse a tag.
  const tag = await api(`git/ref/tags/${v}`).then(
    () => true,
    (err: Error) => {
      if (/HTTP 404/.test(err.message)) return false
      throw new Refusal(`could not check whether the tag ${v} exists: ${err.message}`, 502)
    },
  )
  if (tag) throw new Refusal(`the tag ${v} exists already; if release ${v} is published, close the milestone on GitHub, otherwise release a new version`, 409)

  // The default branch decides the model, as everywhere in the standard; a stray dev beside main changes nothing.
  const main = await defaultBranch(gh, repo)
  if (!main) throw new Refusal(`could not read the default branch of ${repo}`, 502)
  if (main !== 'main' && main !== 'dev') throw new Refusal(`the default branch ${main} is neither main nor dev; the standard knows main alone or dev and main`, 409)
  const head = await api<{ commit?: { sha?: string } }>('branches/main').then(
    (b) => b.commit?.sha ?? '',
    (err: Error) => {
      if (/HTTP 404/.test(err.message)) return ''
      throw new Refusal(`could not read the branch main of ${repo}: ${err.message}`, 502)
    },
  )
  if (!head) throw new Refusal(`${repo} has no branch main; a release is tagged on main`, 409)

  let target = head
  let promotion: string | null = null
  if (main === 'dev') {
    const title = `chore(release): ${v}`
    let prs: { number: number; title: string; state: string; url: string; mergeCommit: { oid: string } | null; isCrossRepository: boolean }[]
    try {
      prs = JSON.parse(
        await run(gh, ['pr', 'list', '--repo', repo, '--base', 'main', '--head', 'dev', '--state', 'all', '--limit', '100', '--json', 'number,title,state,url,mergeCommit,isCrossRepository']),
      ) as typeof prs
    } catch (err) {
      throw new Refusal(`could not list the promotions of ${repo}: ${(err as Error).message}`, 502)
    }
    // --head cannot tell a fork's dev from ours, so the pull requests of other repositories are left out.
    prs = prs.filter((p) => !p.isCrossRepository)
    let pr = prs.find((p) => p.title === title && p.state !== 'CLOSED')
    const other = prs.find((p) => p.state === 'OPEN' && p.title !== title)
    if (!pr && other) throw new Refusal(`another promotion is open (${other.url}); merge or close it before releasing ${v}`, 409)
    if (!pr) {
      const body = `Promotes \`dev\` to \`main\` for milestone ${v}. The release of ${v} merges it and tags its merge commit.`
      let url: string
      try {
        url = await run(gh, ['pr', 'create', '--repo', repo, '--base', 'main', '--head', 'dev', '--title', title, '--body', body])
      } catch (err) {
        throw new Refusal(`could not open the promotion dev to main: ${(err as Error).message}; check that dev is ahead of main`, 502)
      }
      const number = Number(/\/pull\/([0-9]+)\s*$/.exec(url)?.[1])
      if (!(number > 0)) throw new Refusal(`gh answered ${url} for the promotion, which names no pull request`, 502)
      pr = { number, title, state: 'OPEN', url, mergeCommit: null, isCrossRepository: false }
    }
    promotion = pr.url
    if (pr.state === 'OPEN') {
      let done: Merged
      try {
        done = await merge(project, stateDir, gh, fake, pr.number)
      } catch (err) {
        if (!(err instanceof Refusal) || err.status !== 409) throw err
        return { status: 'waiting', milestone: v, model: 'dev+main', promotion: pr.url, reason: `${err.message}; release ${v} again once it is green` }
      }
      if (done.queued) return { status: 'waiting', milestone: v, model: 'dev+main', promotion: pr.url, reason: `PR #${pr.number} is in the merge queue of main; release ${v} again once it is merged` }
      pr = { ...pr, mergeCommit: (await view(gh, repo, pr.number)).mergeCommit }
    }
    const oid = pr.mergeCommit?.oid
    if (!oid) throw new Refusal(`the promotion ${pr.url} is merged, but GitHub names no merge commit of it`, 502)
    target = oid
  }

  let url: string
  try {
    url = await run(gh, ['release', 'create', v, '--repo', repo, '--target', target, '--title', v, '--generate-notes'])
  } catch (err) {
    throw new Refusal(`could not publish release ${v}: ${(err as Error).message}`, 502)
  }
  try {
    await run(gh, ['api', '--method', 'PATCH', `repos/${repo}/milestones/${ms.number}`, '-f', 'state=closed'])
  } catch (err) {
    throw new Refusal(`release ${v} is published at ${url}, but the milestone could not be closed: ${(err as Error).message}; close it on GitHub`, 502)
  }
  return { status: 'released', milestone: v, model: main === 'dev' ? 'dev+main' : 'main', target, release: url, promotion }
}

// A plan process on a spec, as the state directory holds it in processes/<id>.json. Its route names the
// planner's route its session takes.
export interface PlanRecord extends CreatedRecord {
  kind: 'plan'
  route: 'accept'
}

// mergeRequest reads the pull request of a merge's body, or refuses it.
export function mergeRequest(body: Record<string, unknown>): number {
  const pr = body.pr
  if (typeof pr !== 'number' || !Number.isInteger(pr) || pr < 1) throw new Refusal('pr is not a pull request number; send it as a whole number, such as 42')
  return pr
}

// specRequest reads the spec of an acceptance start's body, or refuses it.
export function specRequest(body: Record<string, unknown>): number {
  const s = body.spec
  if (typeof s !== 'number' || !Number.isInteger(s) || s < 1) throw new Refusal('spec is not an issue number; send it as a whole number, such as 42')
  return s
}

// accept opens a plan process on a spec ready for acceptance: the branch plan/<slug of its title> from
// the base, its worktree and a record with the acceptance route, in the state created. It refuses an
// issue that is not an open spec, a spec with a ticket open or none at all, and a spec with a process,
// by its record or by a worktree of its issue.
export function accept(project: Project, stateDir: string, gh: string, fake: boolean, spec: number): Promise<PlanRecord> {
  return held(project, `#${spec}`, () => acceptHeld(project, stateDir, gh, fake, spec))
}

async function acceptHeld(project: Project, stateDir: string, gh: string, fake: boolean, n: number): Promise<PlanRecord> {
  const top = project.path
  const repo = `${project.owner}/${project.name}`
  const recorded = recordFiles(stateDir, top).find((r) => r.record.issue === n)
  if (recorded) throw new Refusal(`#${n} has a process already on ${recorded.record.branch}; abandon it first`, 409)

  let issue: { number: number; title: string; state: string; labels: { name: string }[] }
  try {
    issue = JSON.parse(await run(gh, ['issue', 'view', String(n), '--repo', repo, '--json', 'number,title,state,labels'])) as typeof issue
  } catch (err) {
    throw new Refusal(`could not read #${n} of ${repo}: ${(err as Error).message}`, 502)
  }
  if (issue.state !== 'OPEN') throw new Refusal(`#${n} of ${repo} is ${issue.state}, not open`, 409)
  if (!issue.labels.some((l) => l.name === labels.spec)) throw new Refusal(`#${n} is not a spec (labels: ${issue.labels.map((l) => l.name).join(', ') || 'none'})`, 409)
  let tickets: GitHubIssue[]
  try {
    tickets = await ghApi(gh, repo)<GitHubIssue[]>(`issues/${n}/sub_issues?per_page=100`, true)
  } catch (err) {
    throw new Refusal(`could not read the tickets of #${n}: ${(err as Error).message}`, 502)
  }
  if (tickets.length === 0) throw new Refusal(`#${n} has no tickets, so there is nothing to accept yet`, 409)
  const open = tickets.filter((t) => t.state !== 'closed')
  if (open.length > 0) throw new Refusal(`#${n} has ${open.length} ticket(s) open (${open.map((t) => `#${t.number}`).join(', ')}); accept it once they are closed`, 409)

  const branch = `plan/${slug(issue.title) || `accept-${n}`}`
  const trees = await worktrees(top)
  // A worktree of the spec's issue is a process too, even when no record names it, as the board shows it.
  const other = trees.find((t) => issueFromBranch(t.branch) === String(n))
  if (other) throw new Refusal(`#${n} has a process already on ${other.branch} at ${other.path}; abandon it first`, 409)
  const tree = trees.find((t) => t.branch === branch)
  if (tree) throw new Refusal(`${branch} has a worktree already at ${tree.path}; abandon it first`, 409)
  if (await exists(top, `refs/heads/${branch}`)) throw new Refusal(`the branch ${branch} exists already; remove it with git branch -D ${branch} and start again`, 409)
  const base = project.base
  await fetch(top, base, fake)
  const start = (await exists(top, `origin/${base}`)) ? `origin/${base}` : base
  if (!(await exists(top, start))) throw new Refusal(`the base ${base} is neither on origin nor in ${top}; fetch it and start again`, 409)
  const { path } = await addWorktree(top, branch, start)

  const now = new Date().toISOString()
  const id = `plan-${n}-${createHash('sha256').update(top).digest('hex').slice(0, 8)}`
  const record: PlanRecord = {
    id,
    project: top,
    kind: 'plan',
    route: 'accept',
    branch,
    issue: n,
    worktree: path,
    base: start,
    stage: 'accept',
    state: 'created',
    note: `acceptance of #${n}; no session yet`,
    created_at: now,
    updated_at: now,
  }
  await writeProcess(stateDir, record, { event: 'accept', issue: n, branch, base: start, route: 'accept' }, async () => {
    await git(top, 'worktree', 'remove', '--force', path).catch(() => undefined)
    await git(top, 'branch', '-D', branch).catch(() => undefined)
  }, 'start')
  return record
}
