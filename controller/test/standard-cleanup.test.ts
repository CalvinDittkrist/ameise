// The cleanup of the apply phase: the branch chore/standardize in a worktree of its own, prepared, then opened as
// one pull request.
import { chmodSync, existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { report } from '../src/standard/report.js'
import { ANSWERS, BACKUP, FILES, FINALIZE, ISSUES, OPEN, PREPARE, REPLIES, messy } from './standard.js'

const repo = messy()

interface Pull {
  title: string
  body: string
  head: { ref: string }
  base: { ref: string }
}

const DOCS = ['docs/architecture.md', 'docs/adr/README.md', 'docs/adr/template.md', 'docs/glossary.md', '.github/PULL_REQUEST_TEMPLATE.md']

describe('cleanup', { timeout: 120_000 }, () => {
  test('the branch carries approved deletions and baseline files in one pull request', async () => {
    const f = await repo()
    const head = f.git('rev-parse', 'HEAD').trim()
    const before = f.git('status', '--porcelain')
    await f.step(BACKUP)
    const out = (await f.step(PREPARE)).out
    for (const t of ['.claude/skills', '.claude/commands', '.cursor', 'skills-lock.json']) expect(out).toContain(`deleted: ${t}\n`)
    expect(out, 'files was rejected').not.toContain('NOTES.md')
    expect(out).toContain('todo: agent-config replace CLAUDE.md: its own instructions move to AGENTS.md\n')
    expect(out).toContain('todo: tests-ci create Makefile: no check target\n')
    expect(out).toContain('todo: fill the <fill in> placeholders in Makefile\n')
    expect(out).toContain('untouched: files (rejected)\n')
    let r = await f.step(OPEN, { ok: false })
    expect(r.code).toBe(1)
    expect(r.out).toContain('error: <fill in> placeholders are left in')
    f.fillIn(out)
    r = await f.step(OPEN)
    expect(r.out).toContain('pr: https://github.com/o/r/pull/2 opened\n')

    const tree = f.originGit('ls-tree', '-r', '--name-only', 'chore/standardize').split('\n').filter((l) => l !== '')
    expect(new Set(tree)).toEqual(
      new Set([
        'README.md',
        'CLAUDE.md',
        'NOTES.md',
        'src/app.py',
        '.claude/settings.json',
        'AGENTS.md',
        'Makefile',
        'docs/architecture.md',
        'docs/adr/README.md',
        'docs/adr/template.md',
        'docs/glossary.md',
        '.github/PULL_REQUEST_TEMPLATE.md',
        '.github/dependabot.yml',
        '.github/workflows/check.yml',
      ]),
    )
    expect(f.originGit('rev-parse', 'chore/standardize~1').trim()).toBe(head)
    const settings = JSON.parse(f.originGit('show', 'chore/standardize:.claude/settings.json')) as {
      enabledPlugins: Record<string, boolean>
      extraKnownMarketplaces: { ameise: { source: { repo: string } } }
      env: Record<string, string>
      attribution: unknown
    }
    expect(settings.enabledPlugins).toEqual({ 'foo@bar': false, 'planner@ameise': true, 'repo-standards@ameise': true, 'worker@ameise': true })
    expect(settings.extraKnownMarketplaces.ameise.source.repo).toBe('CalvinDittkrist/ameise')
    expect(settings.env.WF_REVIEW_ROUNDS).toBe('5')
    expect(settings.attribution).toEqual({ commit: '', pr: '' })
    expect(f.calls()).toContain('claude plugin disable foo@bar --scope project')
    const check = f.originGit('show', 'chore/standardize:.github/workflows/check.yml')
    expect(check).toContain('  check:\n')
    expect(check).toContain('    branches: [main]\n')
    expect(f.originGit('show', 'chore/standardize:AGENTS.md').startsWith('# r\n')).toBe(true)

    const pulls = f.github<Pull[]>('pulls.json')
    expect(pulls).toHaveLength(1)
    const pr = pulls[0] as Pull
    expect([pr.title, pr.head.ref, pr.base.ref]).toEqual(['chore: bring the repository to the standard', 'chore/standardize', 'main'])
    expect(pr.body).toContain(
      '### agent-config\n' +
        '- `.claude/skills`: three skills, deploy written for this repository. Restore: `git checkout pre-standard -- .claude/skills`\n' +
        '- `.claude/commands`: one command, written for this repository. Restore: `git checkout pre-standard -- .claude/commands`\n' +
        '- `.cursor`: Cursor rules that repeat CLAUDE.md. Restore: `git checkout pre-standard -- .cursor`\n' +
        '- `skills-lock.json`: lock file of the skills CLI. Restore: `git checkout pre-standard -- skills-lock.json`\n',
    )
    expect(pr.body).toContain('Removed skills are listed in #1.')
    expect(pr.body).toContain('- added `.github/workflows/check.yml`')
    expect(pr.body).toContain('- changed `.claude/settings.json`')
    expect(pr.body).toContain('Rejected in the audit, untouched: files.')
    expect(pr.body).not.toContain('### files')
    // The checkout is untouched: same branch, same head, the worktree ignored.
    expect(f.git('rev-parse', 'HEAD').trim()).toBe(head)
    expect(f.git('status', '--porcelain')).toBe(before)
  })

  test('a rejected scaffolded category without findings is left alone', async () => {
    // docs has no finding in this audit; rejecting it is what keeps the apply phase out of its files.
    const f = await repo()
    expect((await f.approve('docs=reject')).code).toBe(0)
    await f.step(BACKUP)
    const out = (await f.step(PREPARE)).out
    expect(out).toContain('untouched: files, docs (rejected)\n')
    for (const p of DOCS) {
      expect(existsSync(join(f.wt, p)), p).toBe(false)
      expect(out).not.toContain(`created: ${p}`)
    }
    expect(existsSync(join(f.wt, 'AGENTS.md')), 'agent-config was approved').toBe(true)
  })

  test('a rejected agent-config without findings leaves the settings byte for byte', async () => {
    const f = await repo()
    const before = readFileSync(join(f.repo, '.claude/settings.json'))
    await f.audit('finding: files | NOTES.md | delete | agent handover notes | medium\n', 'files=approve', 'agent-config=reject')
    f.resetCalls()
    await f.step(BACKUP)
    const out = (await f.step(PREPARE)).out
    expect(readFileSync(join(f.wt, '.claude/settings.json'))).toEqual(before)
    expect(out).not.toContain('.claude/settings.json')
    expect(f.calls().filter((c) => c.startsWith('claude plugin'))).toEqual([])
    expect(existsSync(join(f.wt, 'AGENTS.md'))).toBe(false)
    expect(out).toContain('untouched: agent-config (rejected)\n')
    expect(out, 'the other categories are scaffolded as before').toContain('created: docs/architecture.md\n')
  })

  test('a scaffolded category without findings that was not answered is scaffolded', async () => {
    // An unanswered category is scaffolded as it always was, so it is listed apart from the pending ones, which do
    // stop the apply phase.
    const f = await repo()
    expect((await f.approve()).out).toContain('pending: none\nunanswered: docs\n')
    await f.step(BACKUP)
    const out = (await f.step(PREPARE)).out
    for (const p of ['docs/architecture.md', 'docs/adr/README.md', 'docs/glossary.md', '.github/PULL_REQUEST_TEMPLATE.md']) expect(out).toContain(`created: ${p}\n`)
    expect(out).toContain('untouched: files (rejected)\n')
    // The other two steps do not stop on it either. They may fail for a reason of their own, never for the
    // answer: a refusal over an answer names approve.sh.
    for (const work of [ISSUES, FINALIZE]) expect((await f.step(work, { ok: false })).out).not.toContain('approve.sh')
  })

  test('a prepare that stopped halfway resumes in the same worktree', async () => {
    const f = await repo()
    await f.step(BACKUP)
    await f.step(PREPARE)
    writeFileSync(join(f.wt, 'AGENTS.md'), '# r\nmine\n')
    const r = await f.step(PREPARE)
    expect(r.out).toContain(`worktree: ${f.wt} (resumed)\n`)
    expect(r.out).toContain('gone: .cursor\n')
    expect(r.out).toContain('kept: AGENTS.md\n')
    expect(f.read('AGENTS.md', f.wt)).toBe('# r\nmine\n')
  })

  test('a category rejected after a prepare is taken back off the branch', async () => {
    // docs is unanswered and scaffolded by the first prepare; the rejection that follows takes it back off.
    const f = await repo()
    await f.step(BACKUP)
    await f.step(PREPARE)
    for (const p of DOCS) expect(existsSync(join(f.wt, p)), p).toBe(true)
    expect((await f.approve('docs=reject')).code).toBe(0)
    const out = (await f.step(PREPARE)).out
    for (const p of DOCS) {
      expect(existsSync(join(f.wt, p)), p).toBe(false)
      expect(out).toContain(`restored: ${p} (rejected)\n`)
    }
    expect(f.gitIn(f.wt, 'diff', '--cached', '--name-only', 'origin/main', '--', ...DOCS)).toBe('')
    expect(existsSync(join(f.wt, 'AGENTS.md')), 'agent-config is still approved').toBe(true)
  })

  test('agent-config rejected after a prepare leaves the settings as they were', async () => {
    const f = await repo()
    await f.step(BACKUP)
    f.fillIn((await f.step(PREPARE)).out)
    expect(f.read('.claude/settings.json', f.wt)).not.toBe(FILES['.claude/settings.json'])
    expect((await f.approve('agent-config=reject')).code).toBe(0)
    const out = (await f.step(PREPARE)).out
    expect(f.read('.claude/settings.json', f.wt)).toBe(FILES['.claude/settings.json'])
    expect(existsSync(join(f.wt, 'AGENTS.md'))).toBe(false)
    for (const p of ['CLAUDE.md', '.claude/skills/deploy/run.sh', '.cursor/rules/style.mdc', 'skills-lock.json']) expect(f.read(p, f.wt), p).toBe(FILES[p])
    expect(out).toContain('restored: .claude/skills (rejected)\n')
    expect(out).toContain('untouched: files, agent-config (rejected)\n')
    expect(existsSync(join(f.wt, 'docs/architecture.md')), 'docs is still scaffolded').toBe(true)
  })

  test('a rejected directory target keeps what another category put inside it', async () => {
    // A rejected finding on docs/ takes back nothing the unanswered docs category scaffolded there, nor the edits.
    const f = await repo()
    await f.audit('finding: files | docs | delete | old notes | low\n', 'files=reject')
    await f.step(BACKUP)
    await f.step(PREPARE)
    writeFileSync(join(f.wt, 'docs/architecture.md'), '# Architecture\nfilled in\n')
    const out = (await f.step(PREPARE)).out
    expect(f.read('docs/architecture.md', f.wt)).toBe('# Architecture\nfilled in\n')
    expect(existsSync(join(f.wt, 'docs/glossary.md'))).toBe(true)
    expect(out).not.toContain('restored:')
  })

  test('a deletion rejected after a prepare is undone', async () => {
    const f = await repo()
    expect((await f.approve('files=approve')).code).toBe(0)
    await f.step(BACKUP)
    expect((await f.step(PREPARE)).out).toContain('deleted: NOTES.md\n')
    expect((await f.approve('files=reject')).code).toBe(0)
    const out = (await f.step(PREPARE)).out
    expect(out).toContain('restored: NOTES.md (rejected)\n')
    expect(f.read('NOTES.md', f.wt)).toBe(FILES['NOTES.md'])
    expect(f.gitIn(f.wt, 'status', '--porcelain', '--', 'NOTES.md')).toBe('')
  })

  test('a target changed since the tag or untracked is not deleted', async () => {
    const f = await repo()
    f.originGit('tag', 'pre-standard', f.git('rev-parse', 'HEAD').trim())
    f.write('.cursor/rules/new.mdc', 'newer\n')
    f.write('.claude/skills/deploy/run.sh', '#!/bin/sh\necho deploy v2\n')
    f.git('add', '.')
    f.git('commit', '-qm', 'newer rule')
    f.git('push', '-q', 'origin', 'main')
    f.write('GEMINI.md', 'untracked\n')
    const perSkill = REPLIES.replace(
      'finding: agent-config | .claude/skills | delete | three skills, deploy written for this repository | high\n',
      'finding: agent-config | .claude/skills/deploy | delete | written for this repository | high\n' +
        'finding: agent-config | .claude/skills/review | delete | copied from upstream | high\n',
    )
    expect((await f.run((c) => report(c, (perSkill + 'finding: agent-config | GEMINI.md | delete | Gemini instructions | high\n').split('\n')))).code).toBe(0)
    expect((await f.approve(...ANSWERS)).code).toBe(0)
    await f.step(BACKUP)
    const r = await f.step(PREPARE)
    expect(r.out).toContain('skipped: .cursor changed since the tag pre-standard was set, so the tag cannot restore it')
    const catalogue = f.github<{ body: string }[]>('issues.json')[0]?.body
    expect(catalogue).not.toContain('| deploy |')
    expect(catalogue).toContain('| review |')
    expect(r.out).toContain('local: GEMINI.md is not tracked')
    expect(r.out).toContain('skipped: .claude/skills/deploy changed since the tag')
    expect(r.out).toContain('deleted: .claude/skills/review\n')
    expect(existsSync(join(f.wt, '.cursor/rules/new.mdc'))).toBe(true)
    expect(existsSync(join(f.repo, 'GEMINI.md'))).toBe(true)
  })

  test('the description follows the branch and ignores later commits on main', async () => {
    const f = await repo()
    await f.throughOpen()
    f.write('src/app.py', "print('later')\n") // someone else's change lands on main meanwhile
    f.git('commit', '-qam', 'later')
    f.git('push', '-q', 'origin', 'main')
    f.write('docs/runbook.md', '# Runbook\n', f.wt)
    const r = await f.step(OPEN)
    expect(r.out).toContain('pr: https://github.com/o/r/pull/2 updated\n')
    const [pr] = f.github<Pull[]>('pulls.json')
    const added = pr?.body.split('## Added and changed\n')[1]?.split('\n\n')[0]?.split('\n')
    expect(added).toEqual([
      '- changed `.claude/settings.json`',
      '- added `.github/PULL_REQUEST_TEMPLATE.md`',
      '- added `.github/dependabot.yml`',
      '- added `.github/workflows/check.yml`',
      '- added `AGENTS.md`',
      '- changed `CLAUDE.md`',
      '- added `Makefile`',
      '- added `docs/adr/README.md`',
      '- added `docs/adr/template.md`',
      '- added `docs/architecture.md`',
      '- added `docs/glossary.md`',
      '- added `docs/runbook.md`',
    ])
    expect(pr?.body).toContain('- `.cursor`: Cursor rules that repeat CLAUDE.md.')
    expect((await f.step(OPEN)).lines[0]).toBe('pr: https://github.com/o/r/pull/2 unchanged')
  })

  test('a failing commit hook stops open and a second open continues', async () => {
    const f = await repo()
    await f.step(BACKUP)
    f.fillIn((await f.step(PREPARE)).out)
    const hook = join(f.repo, '.git/hooks/pre-commit')
    writeFileSync(hook, "#!/bin/sh\necho 'lint: trailing space in AGENTS.md' >&2\nexit 1\n")
    chmodSync(hook, 0o755)
    const r = await f.step(OPEN, { ok: false })
    expect(r.code).toBe(1)
    const error = r.lines.find((l) => l.startsWith('error: cannot commit in'))
    expect(error, r.out).toContain('lint: trailing space in AGENTS.md')
    expect(error).toContain("fix what the repository's commit hooks report there")
    expect(existsSync(join(f.ws, 'pulls.json'))).toBe(false)
    expect(f.originGit('branch', '--list', 'chore/standardize')).toBe('')
    unlinkSync(hook)
    expect((await f.step(OPEN)).out).toContain('pr: https://github.com/o/r/pull/2 opened\n')
  })

  test('an unreachable origin is named as such', async () => {
    const f = await repo()
    await f.step(BACKUP)
    f.git('remote', 'set-url', 'origin', join(f.base, 'missing.git'))
    const r = await f.step(PREPARE, { ok: false })
    expect(r.code).toBe(1)
    expect(r.out).toContain('error: cannot reach origin: ')
  })

  test('a merged branch left on origin is not reused', async () => {
    const f = await repo()
    await f.throughOpen()
    f.merge()
    f.git('worktree', 'remove', '--force', f.wt)
    const r = await f.step(PREPARE, { ok: false })
    expect(r.code).toBe(1)
    expect(r.out).toContain('error: chore/standardize on origin belongs to a merged pull request; run finalize.sh')
  })
})
