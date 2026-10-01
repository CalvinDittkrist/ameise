// The backup of the apply phase: the tag pre-standard on origin, its ruleset and the catalogue of removed skills.
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { report } from '../src/standard/report.js'
import { BACKUP, CATALOGUE, FILES, FINALIZE, ISSUES, PREPARE, REPLIES, WT, messy } from './standard.js'

const repo = messy()

interface Issue {
  title: string
  body: string
  labels: { name: string }[]
}

describe('backup', { timeout: 120_000 }, () => {
  test('tags the head, protects the tag and catalogues each removed skill', async () => {
    const f = await repo()
    const head = f.git('rev-parse', 'HEAD').trim()
    const before = f.git('status', '--porcelain', '--ignored')
    const r = await f.step(BACKUP)
    expect(r.out).toContain(`tag: pre-standard pushed at ${head.slice(0, 7)} (the head of main)\n`)
    expect(f.originGit('rev-parse', 'refs/tags/pre-standard').trim()).toBe(head)
    expect(r.out).toContain('protection: ruleset standard: pre-standard created (no deletion, no moving)\n')
    const rulesets = readdirSync(f.ws)
      .filter((n) => /^ruleset-.*\.json$/.test(n))
      .map((n) => f.github<{ name: string; target: string; rules: { type: string }[] }>(n))
    expect(rulesets.map((s) => [s.name, s.target, s.rules.map((x) => x.type)])).toEqual([['standard: pre-standard', 'tag', ['deletion', 'update']]])
    expect(r.out).toContain('catalogue: #1 opened, 4 skills\n')
    const [issue, ...rest] = f.github<Issue[]>('issues.json')
    expect(rest).toEqual([])
    expect([issue?.title, issue?.labels.map((x) => x.name)]).toEqual([CATALOGUE, ['skill-candidate']])
    expect(f.github<{ name: string }[]>('labels.json').map((x) => x.name)).toContain('skill-candidate')
    const size = (...paths: string[]) => paths.reduce((n, p) => n + Buffer.byteLength(FILES[p] ?? ''), 0)
    expect(issue?.body.split('\n').filter((l) => l.startsWith('| '))).toEqual([
      '| Skill | Description | Origin | Files | Restore |',
      '| --- | --- | --- | --- | --- |',
      `| deploy | Deploy the app to production. | audit: three skills, deploy written for this repository | 2 files, ${size('.claude/skills/deploy/SKILL.md', '.claude/skills/deploy/run.sh')} B | \`git checkout pre-standard -- .claude/skills/deploy\` |`,
      `| lint | none | upstream: acme/skills (from skills-lock.json) | 1 file, ${size('.claude/skills/lint/SKILL.md')} B | \`git checkout pre-standard -- .claude/skills/lint\` |`,
      `| review | Review a diff carefully. | upstream (carries LICENSE) | 2 files, ${size('.claude/skills/review/SKILL.md', '.claude/skills/review/LICENSE')} B | \`git checkout pre-standard -- .claude/skills/review\` |`,
      `| ship | Ship a release | audit: one command, written for this repository | 1 file, ${size('.claude/commands/ship.md')} B | \`git checkout pre-standard -- .claude/commands/ship.md\` |`,
    ])
    expect(issue?.body).toContain('git fetch origin tag pre-standard')
    expect(f.git('status', '--porcelain', '--ignored')).toBe(before)
  })

  test('a restore command brings the skill back', async () => {
    const f = await repo()
    await f.throughOpen()
    f.merge()
    f.git('pull', '-q', 'origin', 'main')
    expect(existsSync(join(f.repo, '.claude/skills/deploy'))).toBe(false)
    f.git('checkout', 'pre-standard', '--', '.claude/skills/deploy')
    expect(f.read('.claude/skills/deploy/run.sh')).toBe(FILES['.claude/skills/deploy/run.sh'])
  })

  test('an existing tag is kept and never moved', async () => {
    const f = await repo()
    const head = f.git('rev-parse', 'HEAD').trim()
    f.originGit('tag', 'pre-standard', head)
    f.write('later.txt')
    f.git('add', '.')
    f.git('commit', '-qm', 'later')
    f.git('push', '-q', 'origin', 'main')
    const r = await f.step(BACKUP)
    expect(r.out).toContain(`tag: pre-standard kept at ${head.slice(0, 7)} (pushed before)\n`)
    expect(f.originGit('rev-parse', 'refs/tags/pre-standard').trim()).toBe(head)
    expect(f.git('rev-parse', 'refs/tags/pre-standard').trim()).toBe(head)
  })

  test('a different local tag is refused and the one on origin kept', async () => {
    const f = await repo()
    const head = f.git('rev-parse', 'HEAD').trim()
    f.originGit('tag', 'pre-standard', head)
    f.git('commit', '-q', '--allow-empty', '-m', 'local')
    f.git('tag', 'pre-standard')
    const r = await f.step(BACKUP, { ok: false })
    expect(r.code).toBe(1)
    expect(r.out).toContain('error: the local tag pre-standard differs from the one on origin')
    expect(f.originGit('rev-parse', 'refs/tags/pre-standard').trim()).toBe(head)
  })

  test('nothing is applied while a category is pending', async () => {
    const f = await repo()
    expect((await f.run((c) => report(c, REPLIES.split('\n')))).code).toBe(0)
    for (const work of [BACKUP, PREPARE, ISSUES, FINALIZE]) {
      const r = await f.step(work, { ok: false })
      expect(r.code).toBe(1)
      expect(r.out).toContain('error: files is still pending; record it with approve.sh files=approve|reject')
    }
    expect(f.originGit('tag')).toBe('')
    expect(existsSync(join(f.ws, 'issues.json'))).toBe(false)
  })

  test('nothing is deleted before the backup', async () => {
    const f = await repo()
    const r = await f.step(PREPARE, { ok: false })
    expect(r.code).toBe(1)
    expect(r.out).toContain('error: the tag pre-standard is not on origin; run backup.sh first')
    expect(existsSync(join(f.repo, WT))).toBe(false)
    expect(f.git('branch', '--list', 'chore/standardize')).toBe('')
  })

  test('the backup succeeds without rulesets and names the manual step', async () => {
    const f = await repo()
    f.put('plan-free', '')
    const r = await f.step(BACKUP)
    expect(r.out).toContain('manual: protect the tag pre-standard: rulesets cannot be read')
    expect(f.originGit('rev-parse', 'refs/tags/pre-standard').trim()).toBe(f.git('rev-parse', 'HEAD').trim())
    expect(r.out).toContain('catalogue: #1 opened, 4 skills\n')
  })

  test('a local tag on the default branch is pushed where it is', async () => {
    const f = await repo()
    const head = f.git('rev-parse', 'HEAD').trim()
    f.git('tag', 'pre-standard', 'HEAD')
    f.git('commit', '-q', '--allow-empty', '-m', 'later')
    f.git('push', '-q', 'origin', 'main')
    const r = await f.step(BACKUP)
    expect(r.out).toContain(`tag: pre-standard pushed at ${head.slice(0, 7)} (kept at the local tag)\n`)
    expect(f.originGit('rev-parse', 'refs/tags/pre-standard').trim()).toBe(head)
  })

  test('a local tag off the default branch is refused', async () => {
    const f = await repo()
    f.git('commit', '-q', '--allow-empty', '-m', 'unpushed')
    f.git('tag', 'pre-standard')
    const r = await f.step(BACKUP, { ok: false })
    expect(r.code).toBe(1)
    expect(r.out).toContain('error: the local tag pre-standard is not on main')
    expect(f.originGit('tag')).toBe('')
  })

  test('a catalogue edited by hand is brought back', async () => {
    const f = await repo()
    await f.step(BACKUP)
    f.put(
      'issues.json',
      f.github<Issue[]>('issues.json').map((i) => ({ ...i, body: 'edited' })),
    )
    const r = await f.step(BACKUP)
    expect(r.out).toContain('catalogue: #1 updated, 4 skills\n')
    const all = f.github<Issue[]>('issues.json')
    expect(all).toHaveLength(1)
    expect(all[0]?.body).toContain('| deploy |')
  })
})
