// The helper of the tests of the standardize steps: a temporary repository with one commit on main, and a step
// run in it against the gh and claude shims of controller/test/shims, whose stateful GitHub lives in a directory of JSON
// files (SHIM_WS). The steps run as the controller runs them, in this process, and every command they start gets
// the shims first on PATH and a git that reads no configuration of the host.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, expect } from 'vitest'
import { backup } from '../src/standard/backup.js'
import { cleanupOpen, cleanupPrepare } from '../src/standard/cleanup.js'
import { finalize } from '../src/standard/finalize.js'
import { issues } from '../src/standard/issues.js'
import { type Ctx, step } from '../src/standard/lib.js'
import { approve, report } from '../src/standard/report.js'

export const root = fileURLToPath(new URL('../..', import.meta.url))
export const shims = fileURLToPath(new URL('./shims', import.meta.url))

// What the host's environment would change: the workflow's own variables, the shims' settings of a suite this
// one runs in, the settings of a Claude Code session and of a make that runs the suite.
for (const k of Object.keys(process.env)) if (/^(WF_|SHIM_|CLAUDE_CODE_|MAKE|MFLAGS)/.test(k)) delete process.env[k]
const isolation = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }

export interface Ran {
  code: number
  lines: string[]
  // out is the lines as the script printed them, one a line.
  out: string
}

export class Fixture {
  readonly base: string
  readonly repo: string
  readonly ws: string
  readonly log: string

  constructor() {
    this.base = realpathSync(mkdtempSync(join(tmpdir(), 'ameise-standard-')))
    this.repo = join(this.base, 'repo')
    this.ws = join(this.base, 'github')
    this.log = join(this.base, 'calls.log')
    mkdirSync(this.repo)
    mkdirSync(this.ws)
    mkdirSync(join(this.base, 'wt'))
    this.git('init', '-q', '-b', 'main')
    this.git('config', 'user.email', 't@example.com')
    this.git('config', 'user.name', 't')
    this.write('README.md', 'hello\n')
    this.git('add', '.')
    this.git('commit', '-qm', 'init')
  }

  git(...args: string[]): string {
    return this.gitIn(this.repo, ...args)
  }

  gitIn(cwd: string, ...args: string[]): string {
    return execFileSync('git', args, { cwd, env: { ...process.env, ...isolation }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  }

  write(path: string, text = 'x\n', at = this.repo) {
    const p = join(at, path)
    mkdirSync(dirname(p), { recursive: true })
    writeFileSync(p, text)
  }

  read(path: string, at = this.repo): string {
    return readFileSync(join(at, path), 'utf8')
  }

  // put writes a file of the shim's GitHub, JSON unless it is text.
  put(name: string, data: unknown) {
    writeFileSync(join(this.ws, name), typeof data === 'string' ? data : JSON.stringify(data))
  }

  github<T = unknown>(name: string): T {
    return JSON.parse(readFileSync(join(this.ws, name), 'utf8')) as T
  }

  // env is what every command of a step gets: the shims first on PATH, their logs, and git isolated from the host.
  env(extra: Record<string, string> = {}): Record<string, string> {
    return {
      PATH: `${shims}:${process.env.PATH ?? ''}`,
      SHIM_LOG: this.log,
      SHIM_ARGV_LOG: join(this.base, 'calls.argv.log'),
      SHIM_WT_ROOT: join(this.base, 'wt'),
      SHIM_MAIN: this.repo,
      ...isolation,
      ...extra,
    }
  }

  // run runs a step in the repository, or in cwd, against the shims' GitHub unless github is false.
  async run(work: (c: Ctx) => Promise<number | void>, opts: { cwd?: string; env?: Record<string, string>; github?: boolean; template?: string } = {}): Promise<Ran> {
    const env = this.env({ ...(opts.github === false ? {} : { SHIM_WS: this.ws }), ...opts.env })
    const r = await step({ root: opts.cwd ?? this.repo, gh: join(shims, 'gh'), env, ...(opts.template ? { template: opts.template } : {}) }, work)
    return { ...r, out: r.lines.map((l) => l + '\n').join('') }
  }

  // calls are the commands the shims logged, one a line.
  calls(): string[] {
    return existsSync(this.log) ? readFileSync(this.log, 'utf8').split('\n').filter((l) => l !== '') : []
  }

  resetCalls() {
    rmSync(this.log, { force: true })
    rmSync(join(this.base, 'calls.argv.log'), { force: true })
  }

  remove() {
    rmSync(this.base, { recursive: true, force: true })
  }
}

// fixture gives each test a repository of its own, removed after it.
export function fixture(): () => Fixture {
  let f: Fixture | undefined
  afterEach(() => {
    f?.remove()
    f = undefined
  })
  return () => (f ??= new Fixture())
}

// section is the lines of out that start with one of keys, in order; a key ending in ':' matches that line exactly
// plus the indented block below it.
export function section(out: string, ...keys: string[]): string[] {
  const result: string[] = []
  let block = false
  for (const line of out.split('\n')) {
    if (line.startsWith('  ') && block) {
      result.push(line)
      continue
    }
    block = false
    for (const k of keys) {
      if (line === k) {
        result.push(line)
        block = true
      } else if (line.startsWith(k + ' ')) result.push(line)
    }
  }
  return result
}

// The apply phase: a bare origin as the remote and the GitHub side of a private repository on main.
export const WT = '.claude/worktrees/chore-standardize'
export const CLEANUP_BRANCH = 'chore/standardize'
export const CATALOGUE = 'Standardisation: removed skills and how to restore them'

export const FILES: Record<string, string> = {
  'CLAUDE.md': '# Rules\nAlways use pnpm.\n',
  '.claude/skills/deploy/SKILL.md': '---\nname: deploy\ndescription: Deploy the app | to production.\n---\nRun run.sh.\n',
  '.claude/skills/deploy/run.sh': '#!/bin/sh\necho deploy\n',
  '.claude/skills/review/SKILL.md': '---\nname: review\ndescription: >\n  Review a diff\n  carefully.\n---\nBody.\n',
  '.claude/skills/review/LICENSE': 'MIT\n',
  '.claude/skills/lint/SKILL.md': 'Lint everything.\n',
  '.claude/commands/ship.md': '---\ndescription: Ship a release\n---\nShip it.\n',
  '.claude/settings.json': JSON.stringify({ enabledPlugins: { 'foo@bar': true }, env: { WF_REVIEW_ROUNDS: '5' } }) + '\n',
  'skills-lock.json': JSON.stringify({ version: 1, skills: { lint: { source: 'acme/skills' } } }) + '\n',
  '.cursor/rules/style.mdc': 'be nice\n',
  'NOTES.md': 'handover notes\n',
  'src/app.py': "print('hi')  # a \u2014 b\n", // an em dash the apply leaves to an issue: the check warns
}

export const REPLIES = `The agent-config auditor:
finding: agent-config | .claude/skills | delete | three skills, deploy written for this repository | high
finding: agent-config | .claude/commands | delete | one command, written for this repository | high
finding: agent-config | .cursor | delete | Cursor rules that repeat CLAUDE.md | high
finding: agent-config | skills-lock.json | delete | lock file of the skills CLI | high
finding: agent-config | CLAUDE.md | replace | its own instructions move to AGENTS.md | high
finding: files | NOTES.md | delete | agent handover notes | medium
finding: tests-ci | Makefile | create | no check target | high
finding: tests-ci | src | issue | src/app.py has no tests | medium
finding: security | src/app.py | issue | prints instead of logging | low
finding: workspace | repo allow_rebase_merge | configure | rebase merges are allowed | high
`

export const ANSWERS = ['agent-config=approve', 'tests-ci=approve', 'security=approve', 'workspace=approve', 'files=reject']

type Work = (c: Ctx) => Promise<number | void>
export const BACKUP: Work = (c) => backup(c)
export const PREPARE: Work = (c) => cleanupPrepare(c)
export const OPEN: Work = (c) => cleanupOpen(c)
export const ISSUES: Work = (c) => issues(c)
export const FINALIZE: Work = (c) => finalize(c)

export class ApplyFixture extends Fixture {
  readonly origin: string

  constructor() {
    super()
    this.origin = join(this.base, 'origin.git')
    this.git('init', '-q', '--bare', this.origin)
    this.git('remote', 'add', 'origin', this.origin)
    this.put('repo.json', {
      visibility: 'private',
      default_branch: 'main',
      permissions: { admin: true },
      allow_squash_merge: true,
      allow_merge_commit: false,
      allow_rebase_merge: true,
      delete_branch_on_merge: true,
      squash_merge_commit_title: 'PR_TITLE',
      squash_merge_commit_message: 'COMMIT_MESSAGES',
      has_wiki: false,
      has_discussions: false,
      security_and_analysis: { secret_scanning: { status: 'disabled' } },
    })
    this.put('labels.json', [{ name: 'bug' }])
    this.put('actions-workflow.json', { default_workflow_permissions: 'read', can_approve_pull_request_reviews: false })
    this.put('vulnerability-alerts', '')
    this.put('automated-security-fixes.json', { enabled: true })
    this.put('milestones.json', [])
    this.put('projects.json', [])
  }

  get wt(): string {
    return join(this.repo, WT)
  }

  originGit(...args: string[]): string {
    return this.git(`--git-dir=${this.origin}`, ...args)
  }

  async audit(replies: string, ...answers: string[]) {
    let r = await this.run((c) => report(c, replies.split('\n')))
    expect(r.code, r.out).toBe(0)
    r = await this.run((c) => approve(c, answers))
    expect(r.code, r.out).toBe(0)
  }

  approve(...answers: string[]): Promise<Ran> {
    return this.run((c) => approve(c, answers))
  }

  // step runs a step of the apply and expects it to pass unless ok is false.
  async step(work: Work, opts: { ok?: boolean; env?: Record<string, string> } = {}): Promise<Ran> {
    const r = await this.run(work, { env: opts.env })
    if (opts.ok !== false) expect(r.code, r.out).toBe(0)
    return r
  }

  // fillIn is what the agent does between prepare and open: the CLAUDE.md todo when prepare printed it, then every
  // placeholder the branch adds.
  fillIn(todo = '') {
    if (todo.includes('todo: agent-config replace CLAUDE.md')) writeFileSync(join(this.wt, 'CLAUDE.md'), '@AGENTS.md\n')
    for (const f of this.gitIn(this.wt, 'diff', '--cached', '--name-only', 'origin/main').split('\n').filter((l) => l !== '')) {
      const p = join(this.wt, f)
      if (existsSync(p) && statSync(p).isFile() && readFileSync(p, 'utf8').includes('<fill in>')) writeFileSync(p, readFileSync(p, 'utf8').replaceAll('<fill in>', 'true'))
    }
  }

  // merge is GitHub merging the pull request: the branch lands on main and the pull request is marked merged.
  merge() {
    const head = this.originGit('rev-parse', 'refs/heads/chore/standardize').trim()
    this.originGit('update-ref', 'refs/heads/main', head)
    const pulls = this.github<{ number: number; head: object }[]>('pulls.json')
    for (const p of pulls) this.originGit('update-ref', `refs/pull/${p.number}/head`, head)
    this.put(
      'pulls.json',
      pulls.map((p) => ({ ...p, state: 'closed', merged_at: '2026-09-18T12:00:00Z', head: { ...p.head, sha: head } })),
    )
  }

  async throughOpen(): Promise<Ran> {
    await this.step(BACKUP)
    this.fillIn((await this.step(PREPARE)).out)
    return this.step(OPEN)
  }
}

// messy gives each test a repository with agent configuration of its own, pushed and audited.
export function messy(): () => Promise<ApplyFixture> {
  let f: ApplyFixture | undefined
  afterEach(() => {
    f?.remove()
    f = undefined
  })
  return async () => {
    if (f) return f
    f = new ApplyFixture()
    for (const [path, text] of Object.entries(FILES)) f.write(path, text)
    f.git('add', '.')
    f.git('commit', '-qm', 'messy')
    f.git('push', '-q', 'origin', 'main')
    await f.audit(REPLIES, ...ANSWERS)
    return f
  }
}
