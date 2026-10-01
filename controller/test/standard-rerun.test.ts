// What the finalize step makes of the cleanup pull request and its branch, a whole second run, and the apply
// phase on a repository without a commit.
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { ApplyFixture, BACKUP, CLEANUP_BRANCH, FINALIZE, ISSUES, OPEN, PREPARE, messy } from './standard.js'

const repo = messy()

describe('finalize', { timeout: 180_000 }, () => {
  test('a second run changes nothing', async () => {
    const f = await repo()
    const head = f.git('rev-parse', 'HEAD').trim()
    await f.throughOpen()
    await f.step(ISSUES)
    f.merge()
    await f.step(FINALIZE)
    f.git('pull', '-q', 'origin', 'main')
    const issues = f.github('issues.json')
    const pulls = f.github('pulls.json')
    f.resetCalls()
    let r = await f.step(BACKUP)
    expect(r.out).toContain('tag: pre-standard kept at')
    expect(r.out).toContain('protection: ruleset standard: pre-standard kept\n')
    expect(r.out).toContain('catalogue: #1 unchanged, 4 skills\n')
    r = await f.step(PREPARE)
    expect(r.out).toContain('gone: .claude/skills\n')
    expect(r.out).not.toContain('created:')
    expect((await f.step(OPEN)).out).toContain('pr: none needed, main already has every change\n')
    expect((await f.step(ISSUES)).out).toContain('issues: 0 opened, 2 kept\n')
    r = await f.step(FINALIZE)
    expect(r.out).toContain('workspace: applied: 0\n')
    expect(r.out).not.toContain('snapshot:')
    expect(f.calls().filter((c) => c.includes('--method') || c.startsWith('claude plugin install'))).toEqual([])
    expect([f.github('issues.json'), f.github('pulls.json')]).toEqual([issues, pulls])
    expect(f.originGit('rev-parse', 'refs/tags/pre-standard').trim()).toBe(head)
  })

  test('a commit no pull request carries is never thrown away', async () => {
    const f = await repo()
    await f.throughOpen()
    f.merge()
    // A new commit on the old branch whose push failed: no open pull request carries it.
    f.write('docs/runbook.md', '# Runbook\n', f.wt)
    f.gitIn(f.wt, 'add', '.')
    f.gitIn(f.wt, 'commit', '-qm', 'more')
    const head = f.gitIn(f.wt, 'rev-parse', 'HEAD').trim()
    const r = await f.step(FINALIZE, { ok: false })
    expect(r.code).toBe(1)
    expect(r.out).toContain('has a commit that no pull request carries; run cleanup.sh open')
    expect(f.git('rev-parse', CLEANUP_BRANCH).trim()).toBe(head)
    expect(f.originGit('branch', '--list', CLEANUP_BRANCH).trim()).toBe(CLEANUP_BRANCH)
    expect(f.github<{ allow_rebase_merge: boolean }>('repo.json').allow_rebase_merge, 'the workspace waited').toBe(true)
  })

  // clone commits a file on the branch from another clone and pushes it, the way GitHub's web editor would.
  const pushFromClone = (f: ApplyFixture, path: string) => {
    const clone = join(f.base, 'clone')
    f.git('clone', '-q', '-b', CLEANUP_BRANCH, f.origin, clone)
    f.write(path, 'x\n', clone)
    f.gitIn(clone, 'add', '.')
    f.gitIn(clone, '-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-qm', 'suggestion')
    f.gitIn(clone, 'push', '-q', 'origin', CLEANUP_BRANCH)
    return f.gitIn(clone, 'rev-parse', 'HEAD').trim()
  }

  test('a worktree behind the merged pull request is done, not pending', async () => {
    const f = await repo()
    await f.throughOpen()
    pushFromClone(f, 'docs/suggested.md') // a review suggestion the worktree never sees
    f.merge()
    f.originGit('branch', '-D', CLEANUP_BRANCH) // deleted on merge
    expect((await f.step(FINALIZE)).out).toContain(`worktree: ${f.wt} removed\n`)
  })

  test('a branch on origin ahead of the merged pull request is kept', async () => {
    const f = await repo()
    await f.throughOpen()
    f.merge()
    const late = pushFromClone(f, 'docs/late.md')
    expect((await f.step(FINALIZE)).out).toContain('branch: chore/standardize kept on origin, it has commits the merged pull request does not\n')
    expect(f.originGit('rev-parse', `refs/heads/${CLEANUP_BRANCH}`).trim()).toBe(late)
  })

  test('a pull request closed without a merge is refused', async () => {
    const f = await repo()
    await f.throughOpen()
    f.put(
      'pulls.json',
      f.github<object[]>('pulls.json').map((p) => ({ ...p, state: 'closed' })),
    )
    const r = await f.step(FINALIZE, { ok: false })
    expect(r.code).toBe(1)
    expect(r.out).toContain('error: the cleanup pull request https://github.com/o/r/pull/2 was closed without a merge')
  })

  test('prepared changes without a pull request hold the workspace back', async () => {
    const f = await repo()
    await f.step(BACKUP)
    await f.step(PREPARE)
    const r = await f.step(FINALIZE, { ok: false })
    expect(r.code).toBe(1)
    expect(r.out).toContain('has uncommitted changes that no pull request carries; run cleanup.sh open')
  })
})

const EMPTY_REPLIES = `finding: docs | README.md | create | the repository has no README | high
finding: agent-config | AGENTS.md | create | no instruction source | high
finding: tests-ci | Makefile | create | no gate | high
finding: workspace | repo allow_rebase_merge | configure | rebase merges are allowed | high
`

// A repository without a commit, here or on GitHub: the init case of the same run.
describe('an empty repository', { timeout: 180_000 }, () => {
  let made: ApplyFixture | undefined
  afterEach(() => {
    made?.remove()
    made = undefined
  })
  const empty = async () => {
    const f = (made = new ApplyFixture())
    f.git('update-ref', '-d', 'HEAD') // the fixture's first commit is undone: nothing is committed
    f.git('rm', '-q', '--cached', 'README.md')
    f.git('clean', '-qf', 'README.md')
    f.write('src/main.py', "print('draft')\n") // work the maintainer has not committed yet
    await f.audit(EMPTY_REPLIES, 'docs=approve', 'agent-config=approve', 'tests-ci=approve', 'workspace=approve')
    return f
  }

  test('the run starts the default branch and brings the standard through one pull request', async () => {
    const f = await empty()
    let r = await f.step(BACKUP)
    const root = f.originGit('rev-parse', 'refs/heads/main').trim()
    expect(r.out).toContain(`root: ${root.slice(0, 7)} pushed as the first commit of main (the repository was empty)\n`)
    expect(f.originGit('ls-tree', '-r', '--name-only', root)).toBe('')
    expect(f.originGit('rev-parse', 'refs/tags/pre-standard^{commit}').trim()).toBe(root)
    expect(f.github<{ body: string }[]>('issues.json')[0]?.body).toContain('No skills are removed.')
    f.fillIn((await f.step(PREPARE)).out)
    r = await f.step(OPEN)
    expect(r.out).toContain('pr: https://github.com/o/r/pull/2 opened\n')
    const added = f.originGit('diff', '--name-only', root, `refs/heads/${CLEANUP_BRANCH}`).split('\n')
    for (const p of ['README.md', 'AGENTS.md', 'CLAUDE.md', 'Makefile', '.github/workflows/check.yml', '.claude/settings.json']) expect(added).toContain(p)
    f.merge()
    r = await f.step(FINALIZE)
    expect(r.out).toContain('workspace: diff: repo allow_rebase_merge: true -> false\n')
    expect(r.out).toContain('next: the checkout has no commit yet; git pull origin main brings the standard into it\n')
    expect(r.out.endsWith('result: pass\n'), r.out).toBe(true)
    // The checkout is untouched: still without a commit, the maintainer's draft still there.
    expect(() => execFileSync('git', ['rev-parse', '-q', '--verify', 'HEAD'], { cwd: f.repo, stdio: 'ignore' })).toThrow()
    expect(f.read('src/main.py')).toBe("print('draft')\n")
    // A second run finds the first commit and the tag and starts nothing new.
    r = await f.step(BACKUP)
    expect(r.out).not.toContain('root:')
    expect(r.out).toContain(`tag: pre-standard kept at ${root.slice(0, 7)} (pushed before)\n`)
  })

  test('local commits that were never pushed are not replaced', async () => {
    const f = await empty()
    f.write('README.md', 'mine\n')
    f.git('add', 'README.md')
    f.git('commit', '-qm', 'first')
    const r = await f.step(BACKUP, { ok: false })
    expect(r.code).not.toBe(0)
    expect(r.out).toContain('error: origin has no branch main')
    expect(r.out).toContain('git push -u origin HEAD')
    expect(f.originGit('for-each-ref')).toBe('')
  })
})
