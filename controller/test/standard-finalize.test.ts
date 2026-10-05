// The issues and the workspace of the apply phase: issue findings become agent-ready issues, and once the cleanup
// pull request is merged the finalize step applies the GitHub workspace, posts its snapshot and runs the check.
import { existsSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { ANSWERS, BACKUP, FINALIZE, ISSUES, OPEN, PREPARE, REPLIES, messy } from './standard.js'

const repo = messy()

interface Issue {
  body: string
  labels: { name: string }[]
  comments: string[]
}

const issue = (f: { github<T>(n: string): T }) => f.github<Issue[]>('issues.json')[0] as Issue
const WORKSPACE_FINDING = 'finding: workspace | repo allow_rebase_merge | configure | rebase merges are allowed | high\n'

describe('issues', { timeout: 120_000 }, () => {
  test('issue findings become agent-ready issues once', async () => {
    const f = await repo()
    let r = await f.step(ISSUES)
    expect(r.out).toBe('opened: #1 Standard (tests-ci): src\nopened: #2 Standard (security): src/app.py\nissues: 2 opened, 0 kept\n')
    const [first] = f.github<Issue[]>('issues.json')
    expect(first?.labels.map((x) => x.name)).toEqual(['ready-for-agent'])
    expect(first?.body).toContain('audit of `src`, confidence medium:\n\n> src/app.py has no tests\n')
    expect(f.github<{ name: string }[]>('labels.json').map((x) => x.name)).toContain('ready-for-agent')
    r = await f.step(ISSUES)
    expect(r.out).toBe('kept: #1 Standard (tests-ci): src\nkept: #2 Standard (security): src/app.py\nissues: 0 opened, 2 kept\n')
    expect(f.github<Issue[]>('issues.json')).toHaveLength(2)
  })

  test('rejected issue findings open nothing', async () => {
    const f = await repo()
    await f.approve('tests-ci=reject', 'security=reject')
    expect((await f.step(ISSUES)).out).toBe('issues: none approved\n')
    expect(existsSync(join(f.ws, 'issues.json'))).toBe(false)
  })
})

describe('workspace', { timeout: 180_000 }, () => {
  test('waits for the merge', async () => {
    const f = await repo()
    await f.throughOpen()
    f.resetCalls()
    const before = f.github('repo.json')
    const r = await f.step(FINALIZE, { ok: false })
    expect(r.code).toBe(1)
    expect(r.out).toContain('error: the cleanup pull request https://github.com/o/r/pull/2 is not merged yet')
    expect(f.calls().filter((c) => c.includes('--method'))).toEqual([])
    expect(f.github('repo.json')).toEqual(before)
    expect(readdirSync(f.ws).filter((n) => n.startsWith('ruleset-')), "the tag's only").toEqual(['ruleset-100.json'])
  })

  test('after the merge the workspace is applied, its snapshot posted and the check run', async () => {
    const f = await repo()
    await f.throughOpen()
    f.merge()
    const out = (await f.step(FINALIZE)).out
    expect(out).toContain('pr: https://github.com/o/r/pull/2 merged\n')
    expect(out).toContain('workspace: diff: repo allow_rebase_merge: true -> false\n')
    expect(out).toContain('snapshot: posted to #1\n')
    expect(issue(f).comments).toHaveLength(1)
    expect(issue(f).comments[0]).toContain('diff: repo allow_rebase_merge: true -> false')
    expect(issue(f).comments[0]).toContain('"allow_rebase_merge": true')
    expect(f.github<{ allow_rebase_merge: boolean }>('repo.json').allow_rebase_merge).toBe(false)
    expect(out).toContain(`worktree: ${f.wt} removed\n`)
    expect(f.git('branch', '--list', 'chore/standardize')).toBe('')
    expect(out).toContain('branch: chore/standardize deleted on origin\n')
    expect(f.originGit('branch', '--list', 'chore/standardize')).toBe('')
    expect(out).toContain('untouched: files (rejected in the audit)\n')
    expect(out).toContain('check: warn: src/app.py has 1 em dash; use a comma, a colon or two sentences\n')
    expect(out).toContain('check: warn: docs/adr/0001-use-make.md has "Status: superseded"; a status is exactly proposed or accepted\n')
    expect(out.endsWith('result: pass\n'), out).toBe(true)
  })

  test('the check reports what is left', async () => {
    const f = await repo()
    await f.approve('agent-config=reject')
    await f.throughOpen()
    f.merge()
    const r = await f.step(FINALIZE, { ok: false })
    expect(r.code).toBe(1)
    expect(r.out).toContain('check: fail: .claude/skills/deploy: agent configuration the standard does not define; remove it\n')
    expect(r.out).toContain('check: fail: AGENTS.md missing; it is the instruction source, move the project instructions there\n')
    expect(r.out).toContain('untouched: files, agent-config (rejected in the audit)\n')
    expect(r.out.endsWith('result: fail\n'), r.out).toBe(true)
  })

  test('a rejected workspace is left alone', async () => {
    const f = await repo()
    await f.approve('workspace=reject')
    await f.throughOpen()
    f.merge()
    const before = f.github('repo.json')
    expect((await f.step(FINALIZE)).out).toContain('workspace: rejected, left untouched\n')
    expect(f.github('repo.json')).toEqual(before)
    expect(issue(f).comments).toEqual([])
  })

  test('an approved workspace without findings configures nothing', async () => {
    // Approving it answers for the baseline file it scaffolds, not for GitHub settings no audit found.
    const f = await repo()
    await f.audit(REPLIES.replace(WORKSPACE_FINDING, ''), ...ANSWERS)
    await f.throughOpen()
    f.merge()
    const before = f.github('repo.json')
    expect((await f.step(FINALIZE)).out).toContain('workspace: no approved configure finding, left untouched\n')
    expect(f.github('repo.json')).toEqual(before)
    expect(issue(f).comments).toEqual([])
    expect(f.originGit('ls-tree', '-r', '--name-only', 'main'), 'the category was approved, so its baseline file is scaffolded').toContain('.github/dependabot.yml')
  })

  test('an approved workspace whose findings are files configures nothing', async () => {
    // The report promises GitHub is configured on a configure finding; a file finding answers for the file.
    const f = await repo()
    await f.audit(REPLIES.replace(WORKSPACE_FINDING, 'finding: workspace | .github/dependabot.yml | create | no update configuration | high\n'), ...ANSWERS)
    await f.throughOpen()
    f.merge()
    const before = f.github('repo.json')
    expect((await f.step(FINALIZE)).out).toContain('workspace: no approved configure finding, left untouched\n')
    expect(f.github('repo.json')).toEqual(before)
    expect(issue(f).comments, 'no snapshot: nothing was applied').toEqual([])
  })

  test('a workspace that refuses leaves no snapshot and a rerun finishes', async () => {
    const f = await repo()
    await f.throughOpen()
    f.merge()
    writeFileSync(join(f.ws, 'check-runs'), '0')
    let r = await f.step(FINALIZE, { ok: false })
    expect(r.out).toContain('workspace: failed')
    expect(r.out).not.toContain('snapshot:')
    expect(issue(f).comments).toEqual([])
    expect(readdirSync(join(f.repo, '.git/standardize')).filter((n) => n.startsWith('workspace-snapshot'))).toEqual([])
    expect(r.out.endsWith('result: fail\n'), r.out).toBe(true)
    writeFileSync(join(f.ws, 'check-runs'), '1')
    r = await f.step(FINALIZE)
    expect(r.out).toContain('snapshot: posted to #1\n')
    expect(r.out.endsWith('result: pass\n'), r.out).toBe(true)
  })

  test('a workspace that fails halfway keeps its snapshot on the catalogue', async () => {
    const f = await repo()
    await f.throughOpen()
    f.merge()
    const r = await f.step(FINALIZE, { ok: false, env: { SHIM_WS_FAIL: 'api --method POST repos/o/r/labels' } })
    expect(r.code).toBe(1)
    expect(r.out).toContain('workspace: failed; fix the error above and run finalize.sh again\n')
    expect(r.out).toContain('snapshot: posted to #1\n')
    expect(issue(f).comments).toHaveLength(1)
    expect(issue(f).comments[0]).toContain('"allow_rebase_merge": true')
    expect(r.out.endsWith('result: fail\n'), r.out).toBe(true)
  })
})

// The line the finalize step says when what the workspace applied differs from what the audit recorded.
describe('workspace deviation', { timeout: 180_000 }, () => {
  const deviation = (lines: string[]) => {
    const found = lines.filter((l) => l.startsWith('workspace: the applied difference'))
    expect(found.length, lines.join('\n')).toBeLessThanOrEqual(1)
    return found[0] ?? ''
  }

  test('names the settings it changed that no finding recorded', async () => {
    const f = await repo()
    await f.throughOpen()
    f.merge()
    const r = await f.step(FINALIZE)
    const line = deviation(r.lines)
    expect(line).toContain('changed without a finding: ')
    expect(line, 'applied, and the audit recorded no finding for it').toContain('ruleset standard: main')
    expect(line, 'audited, so not named').not.toContain('repo allow_rebase_merge')
    expect(line).not.toContain('; in the report but already at the standard')
    expect(r.out.endsWith('result: pass\n'), r.out).toBe(true)
  })

  test('names an audited setting that was already at the standard', async () => {
    const f = await repo()
    await f.audit(REPLIES + 'finding: workspace | repo has_wiki | configure | the wiki is on | high\n', ...ANSWERS)
    await f.throughOpen()
    f.merge()
    const r = await f.step(FINALIZE) // the wiki is off on GitHub, so the difference no longer holds that setting
    expect(deviation(r.lines)).toContain('; in the report but already at the standard: repo has_wiki')
    expect(r.out.endsWith('result: pass\n'), r.out).toBe(true)
  })

  test('a second finalize does not report what the first one applied', async () => {
    const f = await repo()
    await f.throughOpen()
    f.merge()
    expect((await f.step(FINALIZE)).out).toContain('workspace: applied: ')
    const r = await f.step(FINALIZE) // the supported "run it again" path: the workspace conforms, so 0 differences
    expect(r.out).toContain('workspace: applied: 0\n')
    expect(deviation(r.lines)).toBe('')
  })

  test('a workspace that failed reports no deviation', async () => {
    const f = await repo()
    await f.throughOpen()
    f.merge()
    writeFileSync(join(f.ws, 'check-runs'), '0') // the workspace refuses: nothing was applied to compare
    const r = await f.step(FINALIZE, { ok: false })
    expect(r.out).toContain('workspace: failed')
    expect(deviation(r.lines)).toBe('')
  })

  test('says nothing when it applied what the audit recorded', async () => {
    const f = await repo()
    await f.throughOpen()
    f.merge()
    await f.step(FINALIZE)
    f.git('pull', '-q', 'origin', 'main')
    f.put('repo.json', { ...f.github<object>('repo.json'), allow_rebase_merge: true }) // drifted again after the run
    await f.audit(WORKSPACE_FINDING, 'workspace=approve')
    await f.step(BACKUP)
    await f.step(PREPARE)
    await f.step(OPEN)
    const r = await f.step(FINALIZE)
    expect(r.out).toContain('workspace: applied: 1\n')
    expect(deviation(r.lines)).toBe('')
    expect(f.github<{ allow_rebase_merge: boolean }>('repo.json').allow_rebase_merge).toBe(false)
  })
})
