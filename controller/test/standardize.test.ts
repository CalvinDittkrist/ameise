import { type ChildProcess, execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { api, canApi, canPages, canPulls, checkout, cleanup, type Machine, machine, read, start, tools } from './controller.js'

afterEach(cleanup)

let m: Machine
let dir: string
let bare: string
let server: ChildProcess

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: 'pipe' }).trim()
const catalogueTitle = 'Standardisation: removed skills and how to restore them'

beforeEach(async () => {
  m = await machine()
  // The repo-standards scripts the controller runs call these.
  tools(m, ['sed', 'awk', 'grep', 'wc', 'tr', 'head', 'tail', 'sort', 'uniq', 'date', 'mv', 'mkdir', 'dirname', 'rm', 'cut', 'ls', 'basename', 'jq', 'mktemp', 'find', 'xargs', 'comm', 'touch', 'cp', 'tee', 'od', 'stat', 'du', 'rmdir', 'chmod', 'readlink', 'diff', 'cmp', 'expr', 'env', 'sleep'])
  const s = await start(m)
  expect(s.running, s.stderr).toBe(true)
  server = s.process
  dir = checkout(m, 'repo', { origin: 'https://github.com/owner/repo.git', originHead: 'main' })
  // The base carries leftover notes and a repository-local skill, which the auditors below find.
  writeFileSync(join(dir, 'NOTES.md'), 'notes of an agent\n')
  mkdirSync(join(dir, '.claude', 'skills', 'old-helper'), { recursive: true })
  writeFileSync(join(dir, '.claude', 'skills', 'old-helper', 'SKILL.md'), '---\nname: old-helper\ndescription: Helps the old way\n---\nDo it.\n')
  writeFileSync(join(dir, 'Makefile'), 'check:\n\t@:\n')
  git(dir, 'add', '-A')
  git(dir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'the base')
  git(dir, 'update-ref', 'refs/remotes/origin/main', 'HEAD')
  // origin in fake mode is the canned GitHub's repository, which the scripts push to and fetch from.
  bare = join(m.github, 'git', 'owner', 'repo.git')
  mkdirSync(bare, { recursive: true })
  git(bare, 'init', '-q', '--bare', '-b', 'main')
  git(dir, 'push', '-q', bare, 'main')

  canPulls(m, 'owner/repo', [])
  canApi(m, 'repos/owner/repo/issues?labels=ready-for-agent&state=open&per_page=100', [])
  canApi(m, 'repos/owner/repo/issues?labels=spec&state=open&per_page=100', [])
  canPages(m, 'repos/owner/repo/branches?per_page=100', [[]])
  canApi(m, 'repos/owner/repo', { full_name: 'owner/repo', default_branch: 'main', visibility: 'private', private: true, owner: { login: 'owner', type: 'User' } })
  canPages(m, 'repos/owner/repo/rulesets?includes_parents=false&per_page=100', [[]])
  canPages(m, 'repos/owner/repo/labels?per_page=100', [[{ name: 'skill-candidate' }, { name: 'ready-for-agent' }]])
  // The catalogue issue is found by its title; the backup updates its body.
  canPages(m, 'repos/owner/repo/issues?labels=skill-candidate&state=all&per_page=100', [[{ number: 5, title: catalogueTitle }]])
  canApi(m, 'repos/owner/repo/issues/5', { number: 5, body: '' })
  canPages(m, 'repos/owner/repo/pulls?head=owner:chore/standardize&state=all&per_page=100', [[]])
  canApi(m, 'repos/owner/repo/pulls', { number: 9, html_url: 'https://github.com/owner/repo/pull/9' })
  expect((await api(m, 'POST', '/api/projects', { path: dir })).status).toBe(201)
})

interface Category {
  name: string
  findings: { target: string; action: string; reason: string; confidence: string }[]
  report: string[]
  answer?: string
}

interface Record {
  id: string
  kind: string
  branch: string
  issue: null
  worktree: string
  stage: string
  state: string
  note: string
  standardize?: {
    facts: string[]
    auditors: { category: string; state: string; findings: number }[]
    summary: string
    categories: Category[]
    dropped: string[]
    applied?: { step: string; ok: boolean; lines: string[] }[]
    pull?: string
    catalogue?: number
  }
}

const recordOf = (id: string) => JSON.parse(read(join(m.state, 'processes', `${id}.json`))) as Record
async function until(id: string, done: (r: Record) => boolean): Promise<Record> {
  for (let i = 0; i < 600; i++) {
    if (existsSync(join(m.state, 'processes', `${id}.json`))) {
      const r = recordOf(id)
      if (done(r)) return r
    }
    await new Promise((d) => setTimeout(d, 50))
  }
  throw new Error(`the process ${id} did not get there: ${JSON.stringify(recordOf(id))}`)
}
const settled = (id: string) => until(id, (r) => !['running', 'created'].includes(r.state))
const board = async () =>
  ((await api(m, 'GET', '/api/board?' + new URLSearchParams({ project: dir }).toString())).body as { processes: { kind: string; state: string; stage: string; action: string; needs: boolean }[] }).processes

const audited = async (): Promise<Record> => {
  const r = await api(m, 'POST', '/api/standardize', { project: dir })
  expect(r.status, JSON.stringify(r.body)).toBe(201)
  const record = (r.body as { record: Record }).record
  expect(record).toMatchObject({ kind: 'standardize', branch: 'chore/standardize', issue: null, stage: 'audit' })
  return settled(record.id)
}

// auditor cans the reply of the auditor of a category: its finding lines.
const auditor = (category: string, ...lines: string[]) => writeFileSync(join(m.claude, `auditor-${category}`), [...lines.map((l) => `found ${l}`), 'findings'].join('\n') + '\n')

test('a standardize runs the six auditors read-only beside the facts and shows their findings per category, each waiting for an answer', async () => {
  const r = await audited()
  expect(r.state, r.note).toBe('input')
  expect(r.note).toBe('findings: 6 in 6 categories; 5 for the run, 1 as issues; approve or reject each category in the process view')
  const st = r.standardize
  expect(st?.auditors.map((a) => [a.category, a.state, a.findings])).toEqual([
    ['files', 'complete', 1],
    ['agent-config', 'complete', 1],
    ['docs', 'complete', 1],
    ['tests-ci', 'complete', 1],
    ['workspace', 'complete', 1],
    ['security', 'complete', 1],
  ])
  // The fake auditors find something in every category, each grouped under its own.
  expect(st?.categories.map((c) => [c.name, c.findings.map((f) => `${f.action} ${f.target}`)])).toEqual([
    ['files', ['delete NOTES.md']],
    ['agent-config', ['delete .claude/commands/old.md']],
    ['docs', ['create docs/glossary.md']],
    ['tests-ci', ['replace Makefile']],
    ['workspace', ['configure branch protection of main']],
    ['security', ['issue config/deploy.env']],
  ])
  // The report says what approving a category triggers.
  expect(st?.categories.find((c) => c.name === 'files')?.report).toContain('  deletes: NOTES.md')
  expect(st?.categories.every((c) => c.answer === undefined)).toBe(true)
  expect(st?.facts.join('\n')).toMatch(/^languages: /m)
  expect(await board()).toMatchObject([{ kind: 'standardize', state: 'input', stage: 'audit', action: 'Approve', needs: true }])

  // Each auditor runs as its agent, in the default mode, with no tool that writes.
  const args = read(m.claudeLog).split('\n')
  const agents = args.flatMap((a, i) => (a === '--agent' ? [args[i + 1]] : []))
  expect(agents.sort()).toEqual(['agent-config', 'docs', 'files', 'security', 'tests-ci', 'workspace'].map((c) => `repo-standards:${c}-auditor`))
  const modes = args.flatMap((a, i) => (a === '--permission-mode' ? [args[i + 1]] : []))
  expect(modes).toEqual(Array(6).fill('default'))
  const disallowed = args.flatMap((a, i) => (a === '--disallowedTools' ? [args[i + 1]] : []))
  expect(disallowed).toHaveLength(6)
  for (const d of disallowed) expect(d).toMatch(/Edit,Write,MultiEdit,NotebookEdit,Agent/)
  // The workspace auditor alone gets the dry run of workspace.sh.
  const briefs = args.filter((l) => l.startsWith('< ') && l.includes('"type":"user"'))
  expect(briefs.filter((b) => b.includes('# workspace.sh (dry run)'))).toHaveLength(1)
  // Nothing changed: the base on origin is as it was, and no tag was pushed.
  expect(git(bare, 'tag')).toBe('')
})

test('an apply takes an answer per category and applies the approved ones alone: the backup first, then the cleanup pull request with its restore lines and the catalogue issue', async () => {
  auditor('agent-config', 'finding: agent-config | .claude/skills/old-helper | delete | a repository-local skill | high')
  const r = await audited()
  expect(r.state, r.note).toBe('input')

  // Every category needs an answer, and an answer is approve or reject.
  const partial = await api(m, 'POST', '/api/standardize/apply', { id: r.id, answers: { files: 'approve' } })
  expect(partial.status).toBe(400)
  expect((partial.body as { error: string }).error).toBe('answer every category before the apply; agent-config, docs, tests-ci, workspace, security have no answer')
  const wrong = await api(m, 'POST', '/api/standardize/apply', { id: r.id, answers: { files: 'maybe' } })
  expect((wrong.body as { error: string }).error).toBe('the answer of files is "maybe"; answer approve or reject')

  // The apply session fills the placeholders of the baseline files the approved agent-config scaffolds.
  writeFileSync(join(m.claude, 'apply'), [`run for f in $(grep -rl --exclude-dir=.git '<fill in>' .); do sed 's/<fill in>/filled/g' "$f" > "$f.new" && mv "$f.new" "$f"; done`, 'complete Filled the placeholders'].join('\n') + '\n')
  const answers = { files: 'approve', 'agent-config': 'approve', docs: 'reject', 'tests-ci': 'reject', workspace: 'reject', security: 'reject' }
  const applying = await api(m, 'POST', '/api/standardize/apply', { id: r.id, answers })
  expect(applying.status, JSON.stringify(applying.body)).toBe(200)
  const done = await settled(r.id)
  expect(done.state, `${done.note}\n${JSON.stringify(done.standardize?.applied, null, 1)}`).toBe('ready')
  expect(done.stage).toBe('apply')
  expect(done.note).toBe('the cleanup pull request https://github.com/owner/repo/pull/9 is open; merge it once its check passes, then finalize')
  expect(done.standardize?.categories.map((c) => [c.name, c.answer])).toEqual(Object.entries(answers))
  // The plugin's order: the answers, the backup before anything is deleted, the cleanup and its session, the pull request, the issues.
  expect(done.standardize?.applied?.map((s) => `${s.step} ${s.ok}`)).toEqual(['approve true', 'backup true', 'prepare true', 'session true', 'open true', 'issues true'])
  expect(done.standardize).toMatchObject({ pull: 'https://github.com/owner/repo/pull/9', catalogue: 5 })
  expect(await board()).toMatchObject([{ kind: 'standardize', state: 'ready', action: 'Finalize', needs: true }])

  // The tag pre-standard keeps the base as it was, with what the cleanup removes.
  const tagged = git(bare, 'ls-tree', '-r', '--name-only', 'pre-standard')
  expect(tagged.split('\n')).toEqual(expect.arrayContaining(['NOTES.md', '.claude/skills/old-helper/SKILL.md']))
  // The cleanup branch removes the approved deletions and creates nothing of a rejected category.
  const cleaned = git(bare, 'ls-tree', '-r', '--name-only', 'chore/standardize').split('\n')
  expect(cleaned).not.toContain('NOTES.md')
  expect(cleaned).not.toContain('.claude/skills/old-helper/SKILL.md')
  expect(cleaned).toContain('AGENTS.md')
  expect(cleaned).not.toContain('docs/glossary.md')
  expect(git(bare, 'show', 'chore/standardize:Makefile')).toBe('check:\n\t@:')

  // The pull request lists how to restore each removed path, and the catalogue issue the removed skill.
  const pull = JSON.parse(read(join(m.github, 'api', 'repos', 'owner', 'repo', 'pulls.POST'))) as { head: string; base: string; body: string }
  expect(pull).toMatchObject({ head: 'chore/standardize', base: 'main' })
  expect(pull.body).toContain('Restore: `git checkout pre-standard -- NOTES.md`')
  expect(pull.body).toContain('Restore: `git checkout pre-standard -- .claude/skills/old-helper`')
  const catalogue = JSON.parse(read(join(m.github, 'api', 'repos', 'owner', 'repo', 'issues', '5.PATCH'))) as { body: string }
  expect(catalogue.body).toMatch(/\| old-helper \| Helps the old way \| .* \| `git checkout pre-standard -- \.claude\/skills\/old-helper` \|/)
  // The rejected security category opens no issue.
  expect(existsSync(join(m.github, 'api', 'repos', 'owner', 'repo', 'issues.POST'))).toBe(false)

  // The finalize waits while the pull request is not merged.
  canPages(m, 'repos/owner/repo/pulls?head=owner:chore/standardize&state=all&per_page=100', [
    [{ number: 9, html_url: 'https://github.com/owner/repo/pull/9', body: '', state: 'open', merged_at: null, head: { sha: git(bare, 'rev-parse', 'chore/standardize') } }],
  ])
  const early = await api(m, 'POST', '/api/standardize/finalize', { id: r.id })
  expect(early.status, JSON.stringify(early.body)).toBe(200)
  const waiting = await settled(r.id)
  expect(waiting).toMatchObject({ stage: 'finalize', state: 'ready' })
  expect(waiting.note).toMatch(/^finalize\.sh refused: the cleanup pull request https:\/\/github\.com\/owner\/repo\/pull\/9 is not merged yet/)
})

test('a backup that fails deletes nothing and fails the apply, which applies again with the answers it has', async () => {
  const r = await audited()
  writeFileSync(`${join(m.github, 'api', 'repos', 'owner', 'repo', 'labels?per_page=100')}.fails`, 'gh: Server Error (HTTP 500)\n')
  const answers = { files: 'approve', 'agent-config': 'reject', docs: 'reject', 'tests-ci': 'reject', workspace: 'reject', security: 'reject' }
  expect((await api(m, 'POST', '/api/standardize/apply', { id: r.id, answers })).status).toBe(200)
  const failed = await settled(r.id)
  expect(failed).toMatchObject({ stage: 'apply', state: 'failed' })
  expect(failed.note).toMatch(/^the backup failed, so nothing was deleted: cannot read the labels of owner\/repo: gh: Server Error \(HTTP 500\); apply again$/)
  expect(failed.standardize?.applied?.map((s) => s.step)).toEqual(['approve', 'backup'])
  expect(git(bare, 'branch', '--list', 'chore/standardize')).toBe('')

  // Applied again, it takes no new answers and goes on with the recorded ones.
  const twice = await api(m, 'POST', '/api/standardize/apply', { id: r.id, answers })
  expect(twice.status).toBe(409)
  rmFails('repos/owner/repo/labels?per_page=100')
  const again = await api(m, 'POST', '/api/standardize/apply', { id: r.id })
  expect(again.status, JSON.stringify(again.body)).toBe(200)
  const done = await settled(r.id)
  expect(done.state, done.note).toBe('ready')
  expect(git(bare, 'ls-tree', '-r', '--name-only', 'chore/standardize').split('\n')).not.toContain('NOTES.md')
})

const rmFails = (endpoint: string) => execFileSync('rm', ['-f', `${join(m.github, 'api', endpoint)}.fails`])

test('a standardize is refused while one runs or its branch exists, and a finish removes its worktree, branch and process', async () => {
  git(dir, 'branch', 'chore/standardize')
  const here = await api(m, 'POST', '/api/standardize', { project: dir })
  expect(here.status).toBe(409)
  expect((here.body as { error: string }).error).toBe('the branch chore/standardize exists already; delete it with git branch -D chore/standardize before the next standardisation')
  git(dir, 'branch', '-D', 'chore/standardize')

  canPages(m, 'repos/owner/repo/branches?per_page=100', [[{ name: 'main' }, { name: 'chore/standardize' }]])
  const origin = await api(m, 'POST', '/api/standardize', { project: dir })
  expect(origin.status).toBe(409)
  expect((origin.body as { error: string }).error).toMatch(/^the branch chore\/standardize exists on origin/)
  canPages(m, 'repos/owner/repo/branches?per_page=100', [[]])

  const r = await audited()
  const twice = await api(m, 'POST', '/api/standardize', { project: dir })
  expect(twice.status).toBe(409)
  expect((twice.body as { error: string }).error).toMatch(/^a standardize process runs already on chore\/standardize/)

  const f = await api(m, 'POST', '/api/processes/finish', { id: r.id })
  expect(f.status, JSON.stringify(f.body)).toBe(200)
  expect(git(dir, 'branch', '--list', 'chore/standardize')).toBe('')
  expect(existsSync(r.worktree)).toBe(false)
  expect(await board()).toEqual([])
})

test('a controller stopped mid-audit fails the audit at its next start, and the audit runs again on request', async () => {
  writeFileSync(join(m.claude, 'auditor-docs'), 'wait\n')
  const res = await api(m, 'POST', '/api/standardize', { project: dir })
  const id = (res.body as { record: Record }).record.id
  await until(id, (r) => r.note === 'the six auditors run')
  const exited = new Promise((d) => server.once('exit', d))
  server.kill('SIGKILL')
  await exited
  const s = await start(m)
  expect(s.running, s.stderr).toBe(true)
  server = s.process
  expect(recordOf(id)).toMatchObject({ stage: 'audit', state: 'failed', note: 'the controller stopped while its audit ran; audit again in the process view' })

  execFileSync('rm', [join(m.claude, 'auditor-docs')])
  const again = await api(m, 'POST', '/api/standardize/audit', { id })
  expect(again.status, JSON.stringify(again.body)).toBe(200)
  const r = await settled(id)
  expect(r.state, r.note).toBe('input')
  // Only a failed audit runs again.
  const twice = await api(m, 'POST', '/api/standardize/audit', { id })
  expect(twice.status).toBe(409)
})

test('an auditor without a result fails the audit, and a finding line report.sh refuses is dropped and named', async () => {
  auditor('files', 'finding: files | /etc/passwd | delete | outside | high', 'finding: files | NOTES.md | delete | agent notes | high')
  const r = await audited()
  expect(r.state, r.note).toBe('input')
  expect(r.standardize?.dropped).toEqual(['finding: files | /etc/passwd | delete | outside | high (target /etc/passwd leaves the repository; use a path relative to its root)'])
  expect(r.standardize?.categories.find((c) => c.name === 'files')?.findings.map((f) => f.target)).toEqual(['NOTES.md'])

  const f = await api(m, 'POST', '/api/processes/finish', { id: r.id })
  expect(f.status).toBe(200)
  writeFileSync(join(m.claude, 'auditor-security'), 'silent\n')
  const broke = await audited()
  expect(broke).toMatchObject({ state: 'failed', stage: 'audit' })
  expect(broke.note).toMatch(/^the security auditor failed: the security auditor exited without a result; audit again$/)
})
