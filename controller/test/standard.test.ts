// The facts, the report and the approval of a standardisation, run as the controller runs them against the shims'
// GitHub. They read the repository and keep their state in its git directory; none changes the working tree.
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { facts } from '../src/standard/facts.js'
import { categories, plugin, scaffoldCategories } from '../src/standard/lib.js'
import { approve, report } from '../src/standard/report.js'
import { fixture, root, section } from './standard.js'

const repo = fixture()

const BASELINE =
  'README.md, AGENTS.md, CLAUDE.md, Makefile, docs/architecture.md, docs/adr/README.md, docs/glossary.md, .github/PULL_REQUEST_TEMPLATE.md, .github/dependabot.yml, .claude/settings.json'

describe('facts', () => {
  const run = async (opts: { cwd?: string; github?: boolean } = {}) => {
    const r = await repo().run((c) => facts(c), opts)
    expect(r.code, r.out).toBe(0)
    return r.out
  }

  // A public repository clicked together by hand, with agent configuration of three tools.
  const messy = () => {
    const f = repo()
    f.write('package.json', JSON.stringify({ scripts: { test: 'vitest', lint: 'eslint .', dev: 'vite', 'test:e2e': 'playwright test' } }))
    f.write('pnpm-lock.yaml', '')
    f.write('src/app.ts')
    f.write('src/util.ts')
    f.write('src/view.tsx')
    f.write('api/pyproject.toml', "[project]\nname = 'api'\n\n[tool.pytest.ini_options]\n\n[tool.ruff]\n")
    f.write('api/main.py')
    f.write('Makefile', 'VAR := 1\ntest:\n\tpnpm test\nlint:\n\tpnpm lint\nbuild: lint\n\ttrue\n')
    f.write('docs/big.bin', '0'.repeat(3000))
    f.write(
      '.github/workflows/ci.yml',
      'name: CI\non: push\njobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n      - run: make build\n  review:\n    name: AI review\n    runs-on: ubuntu-latest\n    steps:\n      - uses: anthropics/claude-code-action@v1\n',
    )
    f.write('CLAUDE.md', '# Rules\nAlways use pnpm.\n')
    f.write('.claude/skills/deploy/SKILL.md')
    f.write('.claude/skills/deploy/run.sh')
    f.write('.claude/commands/ship.md')
    f.write('.claude/settings.json', '{}\n')
    f.write('.cursor/rules/style.mdc')
    f.write('.mcp.json', '{}\n')
    f.write('.gitignore', '.claude/settings.local.json\nCLAUDE.local.md\n')
    f.git('add', '.')
    f.git('commit', '-qm', 'messy')
    f.write('.claude/settings.local.json', '{}\n') // ignored
    f.write('CLAUDE.local.md') // ignored
    f.write('GEMINI.md') // untracked
    f.put('repo.json', { visibility: 'public', default_branch: 'main', owner: { login: 'o', type: 'User' } })
    f.put('user.json', { login: 'o', plan: { name: 'pro' } })
  }

  test('an empty repository has only missing baseline files', async () => {
    const f = repo()
    const empty = join(f.base, 'empty')
    mkdirSync(empty)
    f.gitIn(empty, 'init', '-q', '-b', 'main')
    const out = await run({ cwd: empty, github: false })
    expect(
      section(out, 'github:', 'head:', 'branch-model:', 'languages:', 'manifests:', 'gate:', 'test:', 'lint:', 'ci:', 'ci-check-job:', 'agent-config:', 'baseline-present:', 'baseline-missing:', 'writing-findings:', 'files:', 'largest:'),
    ).toEqual([
      'github: unreachable (gh shim: unhandled: api repos/o/r)',
      'branch-model: main',
      'head: none (no commits yet)',
      'languages: none',
      'manifests: none',
      'gate: none (no check target in a Makefile)',
      'test: none',
      'lint: none',
      'ci: none',
      'ci-check-job: no',
      'agent-config: none',
      'baseline-present: none',
      `baseline-missing: ${BASELINE}`,
      'writing-findings: none',
      'files: 0 tracked, 0 untracked, 0 B',
      'largest: none',
    ])
  })

  test('a messy public repository', async () => {
    messy()
    const before = repo().git('status', '--porcelain', '--ignored')
    const out = await run()
    expect(
      section(out, 'github:', 'visibility:', 'plan:', 'default-branch:', 'branch-model:', 'languages:', 'manifests:', 'gate:', 'test:', 'lint:', 'ci:', 'ci-check-job:', 'agent-config:', 'baseline-missing:', 'files:', 'top-dirs:'),
    ).toEqual([
      'github: o/r, owner o',
      'visibility: public',
      'plan: pro',
      'default-branch: main',
      'branch-model: main',
      'languages: Markdown 5, TypeScript 3, Python 1, Shell 1',
      'manifests: Makefile, package.json, api/pyproject.toml',
      'gate: none (no check target in a Makefile)',
      'test: make test (Makefile), pnpm test (package.json), pnpm run test:e2e (package.json), pytest (api/pyproject.toml)',
      'lint: make lint (Makefile), pnpm run lint (package.json), ruff check (api/pyproject.toml)',
      'ci:',
      '  .github/workflows/ci.yml: build, review ("AI review")',
      'ci-check-job: no',
      'agent-config:',
      '  .claude/commands/ship.md: 1 file, tracked, outside the standard',
      '  .claude/settings.json: 1 file, tracked, standard',
      '  .claude/settings.local.json: 1 file, ignored, standard',
      '  .claude/skills/deploy: 2 files, tracked, outside the standard',
      '  .cursor/rules/style.mdc: 1 file, tracked, outside the standard',
      '  .mcp.json: 1 file, tracked, needs judgement (stays when something in the repository uses it)',
      '  CLAUDE.local.md: 1 file, ignored, outside the standard',
      '  CLAUDE.md: 1 file, tracked, standard',
      '  GEMINI.md: 1 file, untracked, outside the standard',
      'baseline-missing: AGENTS.md, docs/architecture.md, docs/adr/README.md, docs/glossary.md, .github/PULL_REQUEST_TEMPLATE.md, .github/dependabot.yml, LICENSE, SECURITY.md',
      'files: 19 tracked, 1 untracked, 3 KB',
      'top-dirs: .claude/ 4, src/ 3, api/ 2, .cursor/ 1, .github/ 1, docs/ 1',
    ])
    expect(out).toContain('largest: docs/big.bin (3 KB), ')
    expect(repo().git('status', '--porcelain', '--ignored'), 'the facts changed the working tree').toBe(before)
  })

  test('the writing findings are the ones the check counts and are cut at twenty', async () => {
    const f = repo()
    f.write('README.md', '# shop\n\n' + Array(81).fill('word').join(' ') + '\n')
    f.write('src/app.py', 'x = 1  # a \u2014 b\n')
    f.git('add', '.')
    f.git('commit', '-qm', 'docs')
    expect(section(await run(), 'writing-findings:')).toEqual([
      'writing-findings:',
      '  src/app.py has 1 em dash; use a comma, a colon or two sentences',
      '  README.md:3: paragraph of 81 words (>80); split it or make it bullets',
    ])
    for (let i = 0; i < 25; i++) f.write(`docs/n${String(i).padStart(2, '0')}.md`, '\u2014\n')
    const out = section(await run(), 'writing-findings:')
    expect(out).toHaveLength(22)
    expect(out.at(-1)).toBe('  (+7 more)')
  })

  test('a private repository on dev plus main owned by an organisation', async () => {
    const f = repo()
    f.write('Makefile', 'check: lint test\nlint:\n\ttrue\ntest:\n\ttrue\n')
    f.write('go.mod', 'module x\n')
    f.write('.github/workflows/ci.yml', 'on: push\njobs:\n    gate:\n        name: check\n        runs-on: x\n        steps:\n            - run: make check\n')
    f.write('.gitlab-ci.yml')
    f.git('add', '.')
    f.git('commit', '-qm', 'ci')
    f.put('repo.json', { visibility: 'private', default_branch: 'dev', owner: { login: 'o', type: 'Organization' } })
    const out = await run()
    expect(section(out, 'visibility:', 'plan:', 'branch-model:', 'gate:', 'test:', 'lint:', 'ci:', 'ci-check-job:')).toEqual([
      'visibility: private',
      'plan: unknown (visible to organisation owners only)',
      'branch-model: dev+main',
      'gate: make check (Makefile)',
      'test: make test (Makefile), go test ./... (go.mod)',
      'lint: make lint (Makefile), go vet ./... (go.mod)',
      'ci:',
      '  .github/workflows/ci.yml: gate ("check")',
      '  .gitlab-ci.yml: not GitHub Actions',
      'ci-check-job: yes',
    ])
    expect(out, 'a private repository needs no licence').not.toContain('LICENSE')
  })

  test('each of the four profiles comes from GitHub, not from the checkout', async () => {
    // The checkout is on main in every case; visibility and branch model are GitHub's.
    for (const [visibility, branch, model, publicFiles] of [
      ['public', 'main', 'main', true],
      ['public', 'dev', 'dev+main', true],
      ['private', 'main', 'main', false],
      ['private', 'dev', 'dev+main', false],
    ] as const) {
      repo().put('repo.json', { visibility, default_branch: branch, owner: { login: 'o', type: 'User' } })
      const out = await run()
      expect(section(out, 'visibility:', 'default-branch:', 'branch-model:')).toEqual([`visibility: ${visibility}`, `default-branch: ${branch}`, `branch-model: ${model}`])
      const missing = section(out, 'baseline-missing:')[0] ?? ''
      expect(missing.includes('LICENSE, SECURITY.md'), missing).toBe(publicFiles)
    }
  })

  test('symlinked agent configuration is listed and deleted files are skipped', async () => {
    const f = repo()
    f.write('AGENTS.md', '# rules\n')
    symlinkSync('AGENTS.md', join(f.repo, 'CLAUDE.md'))
    f.write('shared/skills/x/SKILL.md')
    mkdirSync(join(f.repo, '.claude/skills'), { recursive: true })
    symlinkSync(join(f.repo, 'shared/skills/x'), join(f.repo, '.claude/skills/x'))
    f.write('Makefile', 'test:\n\ttrue\n')
    f.write('.github/workflows/ci.yml', 'jobs:\n  check:\n    runs-on: x\n')
    f.git('add', '.')
    f.git('commit', '-qm', 'links')
    unlinkSync(join(f.repo, 'Makefile'))
    unlinkSync(join(f.repo, '.github/workflows/ci.yml'))
    const r = await f.run((c) => facts(c), { github: false })
    expect(r.code).toBe(0)
    expect(r.lines.filter((l) => l.startsWith('error: '))).toEqual([])
    expect(section(r.out, 'agent-config:', 'test:', 'ci:')).toEqual([
      'test: none',
      'ci: none',
      'agent-config:',
      '  .claude/skills/x: 1 file, tracked, outside the standard',
      '  AGENTS.md: 1 file, tracked, standard',
      '  CLAUDE.md: 1 file, tracked, standard',
    ])
  })

  test('a symlinked .claude directory is listed', async () => {
    const f = repo()
    f.write('shared/claude/skills/x/SKILL.md')
    symlinkSync('shared/claude', join(f.repo, '.claude'))
    f.git('add', '.')
    f.git('commit', '-qm', 'link')
    expect(await run({ github: false })).toContain('agent-config:\n  .claude: 1 file, tracked, outside the standard (a symlinked .claude)\n')
  })

  test('an organisation owner sees the plan', async () => {
    repo().put('repo.json', { visibility: 'private', default_branch: 'main', owner: { login: 'o', type: 'Organization' } })
    repo().put('org.json', { login: 'o', plan: { name: 'team' } })
    expect(await run()).toContain('visibility: private\nplan: team\n')
  })

  test('the status of agent configuration scales to large repositories', async () => {
    // Thousands of tracked paths exceed what one argument or environment string may hold (128 KB on Linux).
    const f = repo()
    for (let i = 0; i < 3000; i++) f.write(`src/${'deeply/nested/'.repeat(4)}module_${String(i).padStart(5, '0')}_with_a_long_name.py`, '')
    f.write('.cursor/rules/a.mdc')
    f.git('add', '.')
    f.git('commit', '-qm', 'large')
    expect(await run({ github: false })).toContain('agent-config:\n  .cursor/rules/a.mdc: 1 file, tracked, outside the standard\n')
  })

  test('a repository owned by someone else has an unknown plan', async () => {
    repo().put('repo.json', { visibility: 'public', default_branch: 'main', owner: { login: 'o', type: 'User' } })
    repo().put('user.json', { login: 'someone', plan: { name: 'free' } })
    expect(await run()).toContain('plan: unknown (owned by o, not the gh user)\n')
  })

  test('offline the branch model comes from the remote head', async () => {
    const f = repo()
    f.git('update-ref', 'refs/remotes/origin/dev', 'HEAD')
    f.git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/dev')
    expect(await run({ github: false })).toContain('visibility: unknown\nplan: unknown\ndefault-branch: dev\nbranch-model: dev+main\n')
    f.git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/trunk')
    expect(await run({ github: false })).toContain('branch-model: none (default branch trunk is neither main nor dev)\n')
  })

  test('refuses outside a git repository', async () => {
    const f = repo()
    const plain = join(f.base, 'plain')
    mkdirSync(plain)
    const r = await f.run((c) => facts(c, plain))
    expect(r.code).toBe(1)
    expect(r.out).toContain('is not a git repository; run git init first')
  })
})

// The approval explains its unanswered line, which names the categories that have no findings and are scaffolded.
const NOTE = 'note: the unanswered categories have no findings; the apply phase scaffolds them unless they are rejected\n'

const AUDIT = `Here are my findings.
finding: agent-config | .claude/skills/deploy | delete | repository-local skill written for this repository | high
- finding: agent-config | CLAUDE.md | replace | holds instructions instead of importing AGENTS.md | high
finding: agent-config | .claude/skills/deploy | delete | repository-local skill (duplicate) | high
no findings
\`finding: security | api/db.py:12 | issue | SQL built by string concatenation | Medium\`
finding: files | NOTES.md | delete | agent resume notes from 2025 | medium
finding: workspace | repo has_wiki | configure | true -> false | high
`

describe('report and approve', () => {
  const reported = (text: string) => repo().run((c) => report(c, text.split('\n')), { github: false })
  const approved = (...answers: string[]) => repo().run((c) => approve(c, answers), { github: false })
  const state = (name: string) => {
    const p = join(repo().repo, '.git/standardize', name)
    return existsSync(p) ? readFileSync(p, 'utf8') : undefined
  }

  test('findings are grouped by category, with counts, deletions and issues apart', async () => {
    const r = await reported(AUDIT)
    expect(r.code, r.out).toBe(0)
    expect(r.lines.filter((l) => l !== '').join('\n') + '\n').toBe(`findings: 5 in 4 categories; 4 for the run, 1 as issues
files: 1 finding (delete 1)
  deletes: NOTES.md
  the run performs, one by one:
    delete NOTES.md: agent resume notes from 2025 (medium)
  become issues: none
agent-config: 2 findings (delete 1, replace 1)
  deletes: .claude/skills/deploy
  the run performs, one by one:
    delete .claude/skills/deploy: repository-local skill written for this repository (high)
    replace CLAUDE.md: holds instructions instead of importing AGENTS.md (high)
  approving agent-config also creates every baseline file of the category that is missing, whether a finding above lists it or not
  approving agent-config also brings .claude/settings.json to the template: the workflow plugins enabled, every other project plugin disabled, the template permissions and env merged
  become issues: none
docs: no findings
  approving docs creates every baseline file of the category that is missing
  rejecting docs leaves it alone: the apply phase creates none of them
  leaving docs unanswered scaffolds it: only a rejection keeps the apply phase out
tests-ci: no findings
  approving tests-ci creates every baseline file of the category that is missing
  rejecting tests-ci leaves it alone: the apply phase creates none of them
  leaving tests-ci unanswered scaffolds it: only a rejection keeps the apply phase out
workspace: 1 finding (configure 1)
  deletes: nothing
  the run performs, one by one: nothing
  workspace.sh decides these; the lines are what it found at the audit:
    configure repo has_wiki: true -> false (high)
  approving workspace applies the whole difference between the GitHub workspace and the standard, recomputed after the cleanup pull request is merged, so it can differ from the lines above
  approving workspace also creates every baseline file of the category that is missing, whether a finding above lists it or not
  become issues: none
security: 1 finding (issue 1)
  deletes: nothing
  the run performs, one by one: nothing
  become issues:
    issue api/db.py:12: SQL built by string concatenation (medium)
next: ask for approval per category, then record the answers with approve.sh <category>=approve|reject ...
`)
    // A blank line sets each category apart.
    expect(r.lines.filter((l) => l === '')).toHaveLength(7)
    expect(repo().git('status', '--porcelain', '--ignored'), 'the report changed the working tree').toBe('')
    expect(state('findings')?.split('\n').filter((l) => l !== '')).toHaveLength(5)
  })

  test('a target two categories delete is marked in both', async () => {
    const r = await reported(AUDIT + 'finding: security | .claude/skills/deploy | delete | carries a prompt injection | high\nfinding: security | .env | delete | holds a token | high\n')
    expect(r.code, r.out).toBe(0)
    expect(r.out).toContain('agent-config: 2 findings (delete 1, replace 1)\n  deletes: .claude/skills/deploy (also security)\n')
    expect(r.out).toContain('security: 3 findings (delete 2, issue 1)\n  deletes: .claude/skills/deploy (also agent-config), .env\n')
  })

  test('a report of findings the run works through promises nothing beyond its lines', async () => {
    // files and security are never scaffolded and never configure, so nothing beyond their lines happens.
    const r = await reported(
      'finding: files | NOTES.md | delete | agent resume notes | medium\nfinding: security | SECURITY.md | create | a public repository without a policy | high\nfinding: security | api/db.py:12 | issue | SQL built by string concatenation | high\n',
    )
    expect(r.code, r.out).toBe(0)
    expect(r.out).toContain('    create SECURITY.md: a public repository without a policy (high)\n')
    expect(r.out).not.toContain('decides these')
    for (const c of ['files', 'security']) {
      expect(r.out).not.toContain(`approving ${c}`)
      expect(r.out).not.toContain(`rejecting ${c}`)
    }
  })

  test('a scaffolded category without findings is asked about like any other', async () => {
    // The apply creates its missing baseline files, so rejecting it is the only way to keep it out.
    const r = await reported('finding: files | NOTES.md | delete | agent resume notes | medium\n')
    expect(r.code, r.out).toBe(0)
    expect(r.out).toContain(
      '\nagent-config: no findings\n' +
        '  approving agent-config creates every baseline file of the category that is missing\n' +
        '  approving agent-config also brings .claude/settings.json to the template: the workflow plugins enabled, every other project plugin disabled, the template permissions and env merged\n' +
        '  rejecting agent-config leaves it alone: the apply phase creates none of them and leaves .claude/settings.json as it is\n' +
        '  leaving agent-config unanswered scaffolds it: only a rejection keeps the apply phase out\n',
    )
    for (const c of ['docs', 'tests-ci', 'workspace']) {
      expect(r.out).toContain(
        `\n${c}: no findings\n` +
          `  approving ${c} creates every baseline file of the category that is missing\n` +
          `  rejecting ${c} leaves it alone: the apply phase creates none of them\n` +
          `  leaving ${c} unanswered scaffolds it: only a rejection keeps the apply phase out\n`,
      )
    }
    expect(r.out).not.toContain('also:')
    expect(r.out).not.toContain('regardless')
    expect((await approved()).out).toBe('approved: none\nrejected: none\npending: files\nunanswered: agent-config, docs, tests-ci, workspace\n' + NOTE)
    const full = await reported(AUDIT + 'finding: docs | README.md | create | missing | high\nfinding: tests-ci | Makefile | create | missing | high\n')
    expect(full.out, 'every scaffolded category has findings here').not.toContain(': no findings\n')
  })

  test('a report of create findings deletes nothing and opens no issues', async () => {
    const audit = (
      [
        ['agent-config', 'AGENTS.md'],
        ['agent-config', 'CLAUDE.md'],
        ['docs', 'docs/architecture.md'],
        ['tests-ci', 'Makefile'],
        ['tests-ci', '.github/workflows/check.yml'],
      ] as const
    )
      .map(([c, t]) => `finding: ${c} | ${t} | create | missing | high`)
      .join('\n')
    const r = await reported(audit + '\nno findings\n')
    expect(r.code, r.out).toBe(0)
    expect(r.out.startsWith('findings: 5 in 3 categories; 5 for the run, 0 as issues\n'), r.out).toBe(true)
    expect(r.out.split('  deletes: nothing\n')).toHaveLength(4)
    expect(r.out.split('  become issues: none\n')).toHaveLength(4)
    for (const word of ['delete ', 'replace ', 'configure ', 'issue ']) expect(r.out).not.toContain(`    ${word}`)
    expect(r.out).not.toContain('decides these')
    for (const c of ['agent-config', 'docs', 'tests-ci']) expect(r.out).toContain(`  approving ${c} also creates every baseline file of the category that is missing, whether a finding above lists it or not\n`)
  })

  test('an audit without findings still asks about the scaffolded categories', async () => {
    // The apply runs on such a report too, and it scaffolds, so the maintainer is asked.
    let r = await reported('no findings\nno findings\n')
    expect(r.code, r.out).toBe(0)
    expect(r.out.startsWith('findings: 0; the repository matches the standard\n'), r.out).toBe(true)
    expect(r.out).toContain('\ndocs: no findings\n')
    for (const c of ['files', 'security']) expect(r.out, 'a category that is never scaffolded has nothing to answer').not.toContain(`\n${c}:`)
    r = await approved('docs=reject')
    expect(r.code, r.out).toBe(0)
    expect(r.out).toBe('approved: none\nrejected: docs\npending: none\nunanswered: agent-config, tests-ci, workspace\n' + NOTE)
    r = await approved('security=approve')
    expect(r.code, r.out).toBe(1)
    expect(r.out, 'a category the apply never scaffolds stays unanswerable without findings').toContain(
      'error: security is not in the last report and is not scaffolded, so there is nothing to answer for it; the report asks about: agent-config docs tests-ci workspace',
    )
  })

  test('a malformed finding fails the report and keeps the stored one', async () => {
    expect((await reported(AUDIT)).code).toBe(0)
    const stored = state('findings')
    const bad = [
      'finding: docs | README.md | rewrite | too long | high',
      'finding: slop | x | delete | y | high',
      'finding: docs | README.md | create | missing',
      'finding: docs | README.md | create | missing | sure',
      'finding: docs |  | create | missing | high',
      'finding: files | /etc | delete | outside | high',
      'finding: files | docs/../../x | delete | outside | high',
      'finding: security | ~/.ssh/id_rsa | issue | outside | high',
      'finding: files | /etc | configure | outside | high',
      'finding: files | -rf | delete | option | high',
    ]
    const r = await reported(bad.join('\n') + '\n')
    expect(r.code).toBe(1)
    expect(r.lines).toEqual([
      'error: unknown action rewrite; use delete, replace, create, configure or issue: finding: docs | README.md | rewrite | too long | high',
      'error: unknown category slop; use one of files agent-config docs tests-ci workspace security: finding: slop | x | delete | y | high',
      'error: has 4 fields, needs 5: category | target | action | reason | confidence: finding: docs | README.md | create | missing',
      'error: unknown confidence sure; use high, medium or low: finding: docs | README.md | create | missing | sure',
      'error: empty target: finding: docs |  | create | missing | high',
      'error: target /etc leaves the repository; use a path relative to its root: finding: files | /etc | delete | outside | high',
      'error: target docs/../../x leaves the repository; use a path relative to its root: finding: files | docs/../../x | delete | outside | high',
      'error: target ~/.ssh/id_rsa leaves the repository; use a path relative to its root: finding: security | ~/.ssh/id_rsa | issue | outside | high',
      'error: configure is for GitHub settings, which only the workspace category proposes: finding: files | /etc | configure | outside | high',
      'error: target -rf starts with -; name the path without a leading dash: finding: files | -rf | delete | option | high',
      'error: malformed findings, nothing stored; correct those lines and run report.sh again',
    ])
    expect(state('findings')).toBe(stored)
  })

  test('approval is recorded per category and the last answer wins', async () => {
    expect((await reported(AUDIT)).code).toBe(0)
    let r = await approved()
    expect(r.out).toBe('approved: none\nrejected: none\npending: files, agent-config, workspace, security\nunanswered: docs, tests-ci\n' + NOTE)
    r = await approved('agent-config=approve', 'security=reject')
    expect(r.code, r.out).toBe(0)
    expect(r.out).toBe('approved: agent-config\nrejected: security\npending: files, workspace\nunanswered: docs, tests-ci\n' + NOTE)
    r = await approved('security=approve', 'files=reject', 'workspace=approve', 'docs=reject', 'tests-ci=approve')
    expect(r.out).toBe('approved: agent-config, tests-ci, workspace, security\nrejected: files, docs\npending: none\nunanswered: none\n')
    expect(
      state('approvals')
        ?.split('\n')
        .filter((l) => l !== '')
        .sort(),
    ).toEqual(['agent-config\tapprove', 'docs\treject', 'files\treject', 'security\tapprove', 'tests-ci\tapprove', 'workspace\tapprove'])
    expect(repo().git('status', '--porcelain', '--ignored'), 'the approval changed the working tree').toBe('')
  })

  test('a bad answer records nothing', async () => {
    expect((await reported(AUDIT)).code).toBe(0)
    const asks = 'the report asks about: files agent-config docs tests-ci workspace security'
    for (const [args, message] of [
      [['files=approve', 'doc=approve'], `doc is not in the last report and is not scaffolded, so there is nothing to answer for it; ${asks}`],
      [['files agent-config=approve'], `files agent-config is not in the last report and is not scaffolded, so there is nothing to answer for it; ${asks}`],
      [['files=approve', 'security=maybe'], 'security=maybe: the answer is approve or reject'],
      [['files'], 'files: use <category>=approve or <category>=reject'],
    ] as const) {
      const r = await approved(...args)
      expect(r.code, args.join(' ')).toBe(1)
      expect(r.out).toContain(`error: ${message}`)
      expect(state('approvals'), args.join(' ')).toBeUndefined()
    }
  })

  test('a new report clears the answers to the old one', async () => {
    expect((await reported(AUDIT)).code).toBe(0)
    expect((await approved('files=approve')).code).toBe(0)
    expect((await reported(AUDIT)).code).toBe(0)
    expect((await approved()).out).toContain('pending: files, agent-config, workspace, security\nunanswered: docs, tests-ci\n')
  })

  test('the approval needs a report first', async () => {
    const r = await approved('files=approve')
    expect(r.code).toBe(1)
    expect(r.out).toContain('error: no findings recorded; run the audit and report.sh first')
  })

  test('a worktree shares the state of its repository', async () => {
    const f = repo()
    const wt = join(f.base, 'wt-standardize')
    f.git('worktree', 'add', '-q', '-b', 'chore/standardize', wt)
    expect((await reported(AUDIT)).code).toBe(0)
    expect((await approved('files=approve')).code).toBe(0)
    const r = await f.run((c) => approve(c, []), { cwd: wt, github: false })
    expect(r.code, r.out).toBe(0)
    expect(r.out.startsWith('approved: files\n'), r.out).toBe(true)
  })
})

test('the scaffolded categories are the ones scaffold.sh writes files for', async () => {
  // The report promises what scaffoldCategories names; scaffold.sh of the plugin is what writes files. One run per
  // category, every other one skipped, so a template added or moved shows up here.
  const lib = readFileSync(join(root, 'plugins/repo-standards/scripts/lib.sh'), 'utf8')
  expect(/^WF_CATEGORIES="([^"]*)"$/m.exec(lib)?.[1]?.split(' '), 'the plugin and the controller name other categories').toEqual([...categories])
  const f = repo()
  for (const cat of categories) {
    const target = join(f.base, `scaffold-${cat}`)
    mkdirSync(target)
    f.gitIn(target, 'init', '-q', '-b', 'main')
    const skips = categories.filter((c) => c !== cat).flatMap((c) => ['--skip', c])
    const r = await f.run(async (c) => (await plugin(c, 'scaffold.sh', [...skips, target], target)).code)
    expect(r.code, r.out).toBe(0)
    const written = f.gitIn(target, 'ls-files', '--others').split('\n').filter((l) => l !== '')
    expect(written.length > 0, `${cat} alone wrote ${written.join(', ')}`).toBe((scaffoldCategories as readonly string[]).includes(cat))
    // The settings file is the agent-config part of the scaffold, which the report names on its own.
    expect(written.includes('.claude/settings.json'), `${cat} alone wrote ${written.join(', ')}`).toBe(cat === 'agent-config')
    rmSync(target, { recursive: true, force: true })
  }
  expect(existsSync(join(root, 'controller', 'standardize')), 'the steps are controller code').toBe(false)
})
