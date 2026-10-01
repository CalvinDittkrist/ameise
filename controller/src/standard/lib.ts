// What the steps of a standardize process share: how a step runs and reports, the state it keeps in the git
// directory, the categories and their answers, and the GitHub and origin reads every step makes.
//
// A step runs git, gh and the scripts of the bundled repo-standards plugin as argument lists, never through a
// shell. It reports in lines, as a person reads them in the process view, and ends with a code: 0 when it held,
// 1 when it refused or failed, with an `error:` line that names the reason and the fix.
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { pages } from '../board.js'
import { attempt, type Ran, run } from '../exec.js'
import { type Label, skillCandidate, vocabulary } from '../github.js'

// The six finding categories, one per auditor, in the order of the report.
export const categories = ['files', 'agent-config', 'docs', 'tests-ci', 'workspace', 'security'] as const
export type Category = (typeof categories)[number]

// The categories scaffold.sh of the plugin has templates for. Approving one of them creates every baseline file
// of it that is missing, whether a finding lists it or not, so the report says so and asks about every one of
// them (ADR 0035). A test scaffolds each category on its own, with every other one skipped, and expects files
// from exactly these.
export const scaffoldCategories: Category[] = ['agent-config', 'docs', 'tests-ci', 'workspace']

// The names the README and the licence may have, the standard's name first. The facts here and check.sh and
// scaffold.sh of the plugin accept exactly these, so the audit, the check and the scaffold agree on what exists.
export const readmeNames = ['README.md', 'README.rst', 'README.txt', 'README', 'readme.md']
export const licenseNames = ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'COPYING']

// Everything the apply creates on GitHub is found again by these names, so a second run updates instead of
// duplicating: the tag, its ruleset, the catalogue issue, the cleanup branch.
export const tag = 'pre-standard'
export const cleanupBranch = 'chore/standardize'
export const catalogueTitle = 'Standardisation: removed skills and how to restore them'

// The labels a standardisation creates: the workflow's vocabulary, which the controller's github tools own, and
// skill-candidate, which marks the catalogue issue.
export const standardLabels: Label[] = [...vocabulary, skillCandidate]

// The ruleset that protects the tag from deletion and moving; the workspace wants the same one.
export function tagRuleset() {
  return {
    name: `standard: ${tag}`,
    target: 'tag',
    enforcement: 'active',
    bypass_actors: [],
    conditions: { ref_name: { include: [`refs/tags/${tag}`], exclude: [] } },
    rules: [{ type: 'deletion' }, { type: 'update' }],
  }
}

// The repo-standards plugin, whose templates, scaffold.sh, writing.sh and check.sh the steps use. The build
// puts this module in dist/standard beside the bundled plugins in dist/plugins; in a checkout it sits in
// controller/src/standard, three levels below plugins/.
export function standards(): string {
  const here = dirname(fileURLToPath(import.meta.url))
  for (const at of [join(here, '..', 'plugins', 'repo-standards'), join(here, '..', '..', '..', 'plugins', 'repo-standards')]) {
    if (existsSync(join(at, 'scripts', 'check.sh'))) return resolve(at)
  }
  throw new Stop(`no repo-standards plugin beside ${here}; build the controller from a checkout of ameise (npm --prefix controller run build)`)
}

// How long any command of a step may run: the check of the finalize runs the repository's gate, a commit runs
// the repository's hooks, and a fetch, push or paginated gh call can be slow. The signal stops a step sooner.
export const scriptTimeout = 30 * 60 * 1000

// Ctx is where a step runs: the checkout, the gh it calls, what it adds to the environment of every command
// (the scripted gh on PATH and origin redirected in fake mode), the signal that stops it, the
// WF_PROJECT_TEMPLATE of the repository, and the lines it reports.
export interface Ctx {
  root: string
  gh: string
  env: Record<string, string>
  signal?: AbortSignal
  template?: string
  lines: string[]
}

// Stop ends a step with its reason, which the step reports as an `error:` line.
export class Stop extends Error {}

// step runs a step and answers how it ended: its code and every line it reported.
export async function step(ctx: Omit<Ctx, 'lines'>, work: (c: Ctx) => Promise<number | void>): Promise<{ code: number; lines: string[] }> {
  const c: Ctx = { ...ctx, lines: [] }
  try {
    const code = (await work(c)) ?? 0
    return { code, lines: c.lines }
  } catch (err) {
    c.lines.push(`error: ${(err as Error).message}`)
    return { code: 1, lines: c.lines }
  }
}

export const say = (c: Ctx, ...lines: string[]) => void c.lines.push(...lines)

// last is the last line a command wrote, which names why it failed.
export const last = (s: string) =>
  s
    .trimEnd()
    .split('\n')
    .at(-1) ?? ''

// lines are the lines of a command's output, without the empty ones.
export const lines = (s: string) => s.split('\n').filter((l) => l !== '')

// git runs git in the checkout or in dir and answers its output; it fails with what git wrote on stderr.
export const git = (c: Ctx, args: string[], dir = c.root, input?: string) => run('git', args, c.env, dir, { signal: c.signal, timeout: scriptTimeout, input })
// tryGit runs git and answers how it ended.
export const tryGit = (c: Ctx, args: string[], dir = c.root) => attempt('git', args, c.env, dir, { signal: c.signal, timeout: scriptTimeout })
// gh runs gh in the checkout, with input on its stdin, and answers how it ended.
export const gh = (c: Ctx, args: string[], input?: unknown): Promise<Ran> =>
  attempt(c.gh, args, c.env, c.root, { signal: c.signal, timeout: scriptTimeout, input: input === undefined ? undefined : typeof input === 'string' ? input : JSON.stringify(input) })
// plugin runs a script of the repo-standards plugin, executable on its own, and answers how it ended.
export const plugin = (c: Ctx, name: string, args: string[], dir = c.root, opts: { input?: string; env?: Record<string, string> } = {}) =>
  attempt(join(standards(), 'scripts', name), args, { ...c.env, ...opts.env }, dir, { signal: c.signal, timeout: scriptTimeout, input: opts.input })

// stateDir is the state of the standardisation: inside the git directory, so the audit never changes the working
// tree, and shared by every worktree of the repository.
export async function stateDir(c: Ctx): Promise<string> {
  const d = await git(c, ['rev-parse', '--path-format=absolute', '--git-common-dir']).catch(() => {
    throw new Stop('not inside a git repository; run git init first')
  })
  return join(d, 'standardize')
}

// A finding as the report stores it.
export interface Finding {
  category: string
  target: string
  action: string
  reason: string
  confidence: string
}

// readFindings reads the findings of the last report, or undefined while there is none.
export function readFindings(dir: string): Finding[] | undefined {
  const file = join(dir, 'findings')
  if (!existsSync(file)) return undefined
  return lines(readFileSync(file, 'utf8')).map((l) => {
    const [category = '', target = '', action = '', reason = '', confidence = ''] = l.split('\t')
    return { category, target, action, reason, confidence }
  })
}

// readApprovals reads the recorded answer per category; a later line for a category wins.
export function readApprovals(dir: string): Map<string, string> {
  const file = join(dir, 'approvals')
  const out = new Map<string, string>()
  if (!existsSync(file)) return out
  for (const l of lines(readFileSync(file, 'utf8'))) {
    const [c = '', v = ''] = l.split('\t')
    out.set(c, v)
  }
  return out
}

export const hasFindings = (findings: Finding[], category: string, action?: string) => findings.some((f) => f.category === category && (action === undefined || f.action === action))

// answerable is the categories the report asks about and the approve step answers, in report order: every
// category with a finding, plus every scaffolded one, because the apply creates its missing baseline files
// whether a finding lists them or not (ADR 0035). One source for the report and the answer, so the two cannot
// drift.
export const answerable = (findings: Finding[]): Category[] => categories.filter((c) => hasFindings(findings, c) || scaffoldCategories.includes(c))

// Decisions are the recorded answer per answerable category of the last report.
export type Decisions = [Category, string][]

// decisions reads the recorded answers. It fails while the audit has not run or a category with findings is still
// pending, so no finding is applied that was not answered. A scaffolded category without findings is left out
// while it is unanswered: the apply then scaffolds it as it always has, and only a rejection takes it out
// (ADR 0035).
export async function decisions(c: Ctx): Promise<{ dir: string; findings: Finding[]; answers: Decisions }> {
  const dir = await stateDir(c)
  const findings = readFindings(dir)
  if (!findings) throw new Stop('no findings recorded; run the audit of the standardize process first')
  const approvals = readApprovals(dir)
  const answers: Decisions = []
  for (const cat of answerable(findings)) {
    const v = approvals.get(cat) ?? ''
    if (v === '') {
      if (!hasFindings(findings, cat)) continue
      throw new Stop(`${cat} is still pending; record it with approve.sh ${cat}=approve|reject`)
    }
    answers.push([cat, v])
  }
  return { dir, findings, answers }
}

// answered is the categories with this answer.
export const answered = (answers: Decisions, v: string): string[] => answers.filter(([, a]) => a === v).map(([cat]) => cat)

// approvedFindings is the findings of approved categories with this action, as stored.
export const approvedFindings = (findings: Finding[], answers: Decisions, action: string) => {
  const ok = answered(answers, 'approve')
  return findings.filter((f) => ok.includes(f.category) && f.action === action)
}

// unique keeps the first of every value.
export const unique = <T>(xs: T[]) => xs.filter((x, i) => xs.indexOf(x) === i)

// byteOrder compares two strings as sort does in the C locale.
export const byteOrder = (a: string, b: string) => Buffer.compare(Buffer.from(a), Buffer.from(b))

// The GitHub side of the steps. Each fails with the reason when GitHub cannot be read.
export interface Repo {
  nwo: string
  defaultBranch: string
}

// githubRepo reads the repository's owner/name and its default branch.
export async function githubRepo(c: Ctx): Promise<Repo> {
  const v = await gh(c, ['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner'])
  if (v.code !== 0) throw new Stop(`cannot read the GitHub repository (run gh auth status): ${last(v.stderr)}`)
  const nwo = v.stdout.trim()
  const r = await gh(c, ['api', `repos/${nwo}`])
  if (r.code !== 0) throw new Stop(`cannot read repos/${nwo}: ${last(r.stderr)}`)
  const defaultBranch = (JSON.parse(r.stdout) as { default_branch?: string | null }).default_branch ?? ''
  if (defaultBranch === '') throw new Stop(`cannot read the default branch of ${nwo}`)
  return { nwo, defaultBranch }
}

// listAll reads every page of a list with gh api --paginate, or fails with the reason given and gh's last line.
export async function listAll<T>(c: Ctx, endpoint: string, why: string): Promise<T[]> {
  const r = await gh(c, ['api', '--paginate', endpoint])
  if (r.code !== 0) throw new Stop(`${why}: ${last(r.stderr)}`)
  return pages<T>(r.stdout)
}

// catalogueIssue is the number of the catalogue issue, the oldest when several issues carry its title, or
// undefined when there is none.
export async function catalogueIssue(c: Ctx, repo: Repo): Promise<number | undefined> {
  const issues = await listAll<{ number: number; title: string; pull_request?: unknown }>(c, `repos/${repo.nwo}/issues?labels=skill-candidate&state=all&per_page=100`, 'cannot list the skill-candidate issues')
  return issues
    .filter((i) => i.title === catalogueTitle && (i.pull_request ?? null) === null)
    .map((i) => i.number)
    .sort((a, b) => a - b)[0]
}

// A pull request from the cleanup branch: state is open, closed (without a merge) or merged, sha its head.
export interface BranchPull {
  number: number
  url: string
  body: string
  sha: string
  state: string
}

// branchPulls is the pull requests from the cleanup branch, newest first.
export async function branchPulls(c: Ctx, repo: Repo): Promise<BranchPull[]> {
  const owner = repo.nwo.split('/')[0]
  const pulls = await listAll<{ number: number; html_url: string; body?: string | null; head?: { sha?: string }; merged_at?: string | null; state: string }>(
    c,
    `repos/${repo.nwo}/pulls?head=${owner}:${cleanupBranch}&state=all&per_page=100`,
    `cannot list the pull requests from ${cleanupBranch}`,
  )
  return pulls
    .map((p) => ({ number: p.number, url: p.html_url, body: p.body ?? '', sha: p.head?.sha ?? '', state: p.merged_at ? 'merged' : p.state }))
    .sort((a, b) => b.number - a.number)
}

// cleanupWorktree is the path of the cleanup worktree, inside the main checkout like every workflow worktree.
export async function cleanupWorktree(c: Ctx): Promise<string> {
  const common = await git(c, ['rev-parse', '--path-format=absolute', '--git-common-dir'])
  return join(dirname(common), '.claude', 'worktrees', cleanupBranch.replace(/\//g, '-'))
}

// remoteRef is the commit a ref has on origin, empty when origin has no such ref; it fails when origin cannot
// be reached.
export async function remoteRef(c: Ctx, ref: string): Promise<string> {
  const r = await tryGit(c, ['ls-remote', 'origin', ref])
  if (r.code !== 0) throw new Stop(`cannot reach origin: ${last(r.stderr)}`)
  return (r.stdout.split('\n')[0] ?? '').split('\t')[0] ?? ''
}

// ensureLabel creates a label of the vocabulary unless the repository has it, in any case.
export async function ensureLabel(c: Ctx, repo: Repo, name: string) {
  const labels = await listAll<{ name: string }>(c, `repos/${repo.nwo}/labels?per_page=100`, `cannot read the labels of ${repo.nwo}`)
  if (labels.some((l) => l.name.toLowerCase() === name)) return
  const label = standardLabels.find((l) => l.name === name)
  const r = await gh(c, ['api', '--method', 'POST', `repos/${repo.nwo}/labels`, '--input', '-'], label ?? { name })
  if (r.code !== 0) throw new Stop(`cannot create the label ${name}: ${last(r.stderr)}`)
}

// isDir is whether the path is a directory, following links.
export const isDir = (p: string) => {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}

// ensureDir creates a directory with its parents.
export const ensureDir = (p: string) => void mkdirSync(p, { recursive: true })
