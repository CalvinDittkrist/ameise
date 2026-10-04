// The repo-standards plugin's scripts: the scaffold, the standard check and the ADR helper, each run as the real
// script in a sandbox, the claude shim standing in for Claude Code's plugin commands.
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { hostEnv, type Result, type Sandbox, sandbox, standards } from './sandbox.js'

const box = sandbox()

const scaffold = (s: Sandbox, args: string[] = [], env: Record<string, string> = {}): Result => {
  const r = s.run(join(standards, 'scaffold.sh'), args, { env })
  expect(r.code, r.stderr).toBe(0)
  return r
}
const check = (s: Sandbox, at?: string, env: Record<string, string> = {}): Result => s.run(join(standards, 'check.sh'), at ? [at] : [], { env })
const settings = (s: Sandbox) => JSON.parse(s.read('.claude/settings.json'))
const words = (n: number, word = 'word') => Array(n).fill(word).join(' ')
// paragraphs is n words as paragraphs of at most per words each.
const paragraphs = (n: number, per = 50) => {
  const out: string[] = []
  for (let i = 0; i < n; i += per) out.push(words(Math.min(per, n - i)))
  return out.join('\n\n') + '\n'
}

test('scaffold then check passes, and the scaffold never overwrites', () => {
  const s = box()
  let r = check(s)
  expect(r.code).toBe(1)
  expect(r.stdout).toContain('fail: docs/architecture.md missing')
  r = scaffold(s)
  for (const f of ['AGENTS.md', 'CLAUDE.md', 'Makefile', 'docs/architecture.md', '.claude/settings.json']) expect(r.stdout).toContain(`created: ${f}`)
  expect(settings(s).enabledPlugins['worker@ameise']).toBe(true)
  expect(settings(s).attribution.commit).toBe('')
  s.write('CLAUDE.md', '# mine\n@AGENTS.md\n')
  r = scaffold(s)
  expect(r.stdout).toContain('kept: CLAUDE.md')
  expect(s.read('CLAUDE.md')).toBe('# mine\n@AGENTS.md\n')
  r = check(s)
  expect(r.code, r.stdout).toBe(0)
  expect(r.stdout).toContain('result: pass')
  expect(r.stdout).toContain('warn: Makefile still has <fill in> placeholders')
})

test('the scaffold enables the workflow plugins through the plugin commands and disables the rest', () => {
  const s = box()
  s.write(
    '.claude/settings.json',
    JSON.stringify({ enabledPlugins: { 'foo@bar': true, 'old@bar': false }, env: { WF_REVIEW_ROUNDS: '5' }, permissions: { allow: ['Bash(make *)', 'Bash(git diff *)'] } }),
  )
  const r = scaffold(s)
  expect(r.stdout).toContain('updated: .claude/settings.json')
  expect(s.calls()).toContain('claude plugin marketplace add CalvinDittkrist/ameise --scope project')
  expect(s.calls()).toContain('claude plugin install worker@ameise --scope project')
  expect(s.calls()).toContain('claude plugin disable foo@bar --scope project')
  expect(s.calls()).not.toContain('claude plugin disable old@bar --scope project')
  const after = settings(s)
  expect(
    Object.entries(after.enabledPlugins)
      .filter(([, on]) => on)
      .map(([p]) => p)
      .sort(),
  ).toEqual(['planner@ameise', 'repo-standards@ameise', 'worker@ameise'])
  expect(after.env.WF_REVIEW_ROUNDS, 'a value the repository set is kept').toBe('5')
  expect(after.env.WF_PROJECT_TEMPLATE, 'the project template has a place to be set in').toBe('')
  expect(after.permissions.allow.slice(0, 3)).toEqual(['Bash(make *)', 'Bash(git diff *)', 'Bash(git status *)'])
  expect(after.permissions.allow.filter((a: string) => a === 'Bash(git diff *)')).toHaveLength(1)
  s.resetCalls()
  expect(scaffold(s).stdout).toContain('kept: .claude/settings.json')
  expect(s.calls().filter((c) => !c.startsWith('claude plugin marketplace add'))).toEqual([])
})

// The scaffold once piped printf into `grep -q` to test membership. Under pipefail a SIGPIPE of the printf read
// as a miss, and a workflow plugin was disabled. This grep fails every `-q` that reads a pipe, so the plugins stay
// enabled only if the check needs no pipe.
test('a pipeline that dies of SIGPIPE never disables a workflow plugin', () => {
  const s = box()
  const real = spawnSync('bash', ['-c', 'command -v grep'], { encoding: 'utf8' }).stdout.trim()
  const bin = join(s.base, 'sigpipe-bin')
  mkdirSync(bin)
  writeFileSync(join(bin, 'grep'), `#!/usr/bin/env bash\ncase "$1" in -q*) [ ! -p /dev/stdin ] || exit 141 ;; esac\nexec ${real} "$@"\n`)
  chmodSync(join(bin, 'grep'), 0o755)
  s.write('.claude/settings.json', JSON.stringify({ enabledPlugins: { 'foo@bar': true } }))
  scaffold(s, [], { PATH: `${bin}:${s.env().PATH}` })
  expect(settings(s).enabledPlugins).toEqual({ 'foo@bar': false, 'planner@ameise': true, 'repo-standards@ameise': true, 'worker@ameise': true })
})

test('the scaffold skips the files of a category', () => {
  const s = box()
  const r = scaffold(s, ['--skip', 'agent-config', '--skip', 'docs'])
  expect(r.stdout.split('\n').filter((l) => l !== '' && !l.startsWith('next:'))).toEqual(['created: Makefile', 'created: .github/dependabot.yml', 'created: .github/workflows/check.yml'])
  expect(s.exists('.claude')).toBe(false)
  expect(s.calls()).toEqual([])
  const bad = s.run(join(standards, 'scaffold.sh'), ['--skip', 'nonsense'])
  expect(bad.code).toBe(1)
  expect(bad.stderr).toContain('error: unknown category nonsense')
})

test('the scaffold names the repository and runs the CI check on the branches of the model', () => {
  const s = box()
  scaffold(s, ['--name', 'shop & co', '--default', 'dev'])
  expect(s.read('AGENTS.md').startsWith('# shop & co\n')).toBe(true)
  expect(s.read('.github/workflows/check.yml')).toContain('    branches: [main, dev]\n')
})

test('the scaffold adds the CI job check only when no workflow has one', () => {
  const s = box()
  s.write('.github/workflows/ci.yml', 'on: push\njobs:\n  gate:\n    name: check\n    runs-on: ubuntu-latest\n')
  expect(scaffold(s).stdout).toContain('kept: .github/workflows/ci.yml (has the job check)')
  expect(s.exists('.github/workflows/check.yml')).toBe(false)
})

test('the scaffolded gate fails until it is filled in', () => {
  const s = box()
  scaffold(s)
  const r = spawnSync('make', ['check'], { cwd: s.repo, env: hostEnv(), encoding: 'utf8' })
  expect(r.status).not.toBe(0)
  expect(r.stderr).toContain('error: the check target is a placeholder')
})

test('the scaffold keeps the Makefile and the pull request template under their other names', () => {
  const s = box()
  s.write('makefile', 'check:\n\ttrue\n')
  s.write('.github/pull_request_template.md', 'mine\n')
  const r = scaffold(s)
  expect(r.stdout).toContain('kept: makefile')
  expect(r.stdout).toContain('kept: .github/pull_request_template.md')
  const names = [...readdirSync(s.repo), ...readdirSync(join(s.repo, '.github'))]
  expect(names).not.toContain('Makefile')
  expect(names).not.toContain('PULL_REQUEST_TEMPLATE.md')
  const c = check(s)
  expect(c.code, c.stdout).toBe(0)
  expect(c.stdout).toContain('ok: makefile has a check target')
  expect(c.stdout).toContain('ok: .github/pull_request_template.md')
})

test('the check fails without AGENTS.md', () => {
  const s = box()
  scaffold(s)
  s.remove('AGENTS.md')
  const r = check(s)
  expect(r.code).toBe(1)
  expect(r.stdout).toContain('fail: AGENTS.md missing')
})

test('the check fails when CLAUDE.md is missing or does not import AGENTS.md', () => {
  const s = box()
  scaffold(s)
  s.write('CLAUDE.md', '# rules\nsee AGENTS.md\n')
  let r = check(s)
  expect(r.code).toBe(1)
  expect(r.stdout).toContain('fail: CLAUDE.md does not import AGENTS.md')
  s.remove('CLAUDE.md')
  r = check(s)
  expect(r.code).toBe(1)
  expect(r.stdout).toContain('fail: CLAUDE.md missing')
  s.write('CLAUDE.md', '@./AGENTS.md\n\n## Claude only\n- one line\n')
  expect(check(s).code).toBe(0)
})

test('the check holds every area pair in a monorepo', () => {
  const s = box()
  scaffold(s)
  s.write('services/api/CLAUDE.md', '# api\n')
  s.write('docs/.hidden/CLAUDE.md', 'not an area\n')
  let r = check(s)
  expect(r.code).toBe(1)
  expect(r.stdout).toContain('fail: services/api/AGENTS.md missing')
  expect(r.stdout).toContain('fail: services/api/CLAUDE.md does not import AGENTS.md')
  expect(r.stdout).not.toContain('docs/.hidden/AGENTS.md')
  s.write('services/api/AGENTS.md', '# api\n')
  s.write('services/api/CLAUDE.md', '@AGENTS.md\n')
  r = check(s)
  expect(r.code, r.stdout).toBe(0)
  expect(r.stdout).toContain('ok: services/api/CLAUDE.md imports AGENTS.md')
})

test('the check fails without a check target', () => {
  const s = box()
  scaffold(s)
  for (const text of ['lint:\n\ttrue\n', '.PHONY: check\ncheck-docs:\n\ttrue\ncheck := 1\n']) {
    s.write('Makefile', text)
    const r = check(s)
    expect(r.code, text).toBe(1)
    expect(r.stdout).toContain('fail: no check target in a Makefile')
  }
  s.write('Makefile', 'lint check: deps\n\ttrue\n')
  expect(check(s).code).toBe(0)
  s.remove('Makefile')
  expect(check(s).stdout).toContain('fail: no check target in a Makefile')
})

test('the check warns on instruction files over 200 lines', () => {
  const s = box()
  scaffold(s)
  s.write('AGENTS.md', '- rule\n'.repeat(201))
  s.write('CLAUDE.md', '@AGENTS.md\n' + '- claude\n'.repeat(200))
  const r = check(s)
  expect(r.code, r.stdout).toBe(0)
  expect(r.stdout).toContain('warn: AGENTS.md has 201 lines (>200)')
  expect(r.stdout).toContain('warn: CLAUDE.md has 201 lines (>200)')
})

test('the check names each path of agent configuration the standard does not define', () => {
  const s = box()
  scaffold(s)
  for (const path of [
    '.claude/skills/tdd/SKILL.md',
    '.claude/skills/tdd/ref.md',
    '.claude/skills/grill/SKILL.md',
    '.claude/commands/ship.md',
    '.claude/agents/reviewer.md',
    '.claude/rules/api.md',
    '.cursor/rules/style.mdc',
    '.cursorrules',
    '.agents/skills/triage/SKILL.md',
    '.codex/config.toml',
    '.github/copilot-instructions.md',
    'GEMINI.md',
    'skills-lock.json',
    'web/.windsurf/rules.md',
    'CLAUDE.local.md',
    'api/AGENT.md',
    '.rules',
    '.worktreeinclude',
  ])
    s.write(path, 'x\n')
  s.write('.gitignore', 'ignored/\n')
  s.write('ignored/.claude/skills/x/SKILL.md', 'x\n')
  const r = check(s)
  expect(r.code).toBe(1)
  const named = r.stdout
    .split('\n')
    .filter((l) => l.includes('the standard does not define'))
    .map((l) => l.split(': ')[1])
    .sort()
  expect(named).toEqual(
    [
      '.claude/skills/tdd',
      '.claude/skills/grill',
      '.claude/commands/ship.md',
      '.claude/agents/reviewer.md',
      '.claude/rules/api.md',
      '.cursor/rules/style.mdc',
      '.cursorrules',
      '.agents/skills/triage',
      '.codex/config.toml',
      '.github/copilot-instructions.md',
      'GEMINI.md',
      'skills-lock.json',
      'web/.windsurf/rules.md',
      'CLAUDE.local.md',
      'api/AGENT.md',
      '.rules',
      '.worktreeinclude',
    ].sort(),
  )
})

test('the check fails without a README or a CI job named check', () => {
  const s = box()
  scaffold(s)
  s.remove('README.md')
  s.remove('.github/workflows/check.yml')
  s.write('.github/workflows/nested/ci.yml', 'jobs:\n  check:\n    runs-on: ubuntu-latest\n')
  s.write('.github/workflows/test.yml', 'jobs:\n  test:\n    runs-on: ubuntu-latest\n')
  let r = check(s)
  expect(r.code).toBe(1)
  expect(r.stdout).toContain('fail: README.md missing')
  expect(r.stdout).toContain('fail: no CI job named check in .github/workflows')
  s.write('README.rst', 'shop\n')
  s.write('.github/workflows/test.yml', 'jobs:\n  test:\n    name: check\n    runs-on: ubuntu-latest\n')
  r = check(s)
  expect(r.code, r.stdout).toBe(0)
  expect(r.stdout).toContain('ok: README.rst')
  expect(r.stdout).toContain('ok: .github/workflows/test.yml has the CI job check')
})

test('the scaffold creates a README only when none exists, and the check wants it filled in', () => {
  const s = box()
  s.remove('README.md')
  s.write('README.rst', 'shop\n')
  expect(scaffold(s).stdout).toContain('kept: README.rst')
  expect(s.exists('README.md')).toBe(false)
  s.remove('README.rst')
  expect(scaffold(s, ['--skip', 'docs']).stdout).not.toContain('README')
  expect(scaffold(s).stdout).toContain('created: README.md')
  expect(s.read('README.md').startsWith('# repo\n')).toBe(true)
  const r = check(s)
  expect(r.code, r.stdout).toBe(0)
  expect(r.stdout).toContain('warn: README.md still has <fill in> placeholders')
})

test('the check warns without a glossary or grouped version updates', () => {
  const s = box()
  scaffold(s)
  s.remove('docs/glossary.md')
  s.remove('.github/dependabot.yml')
  const r = check(s)
  expect(r.code, r.stdout).toBe(0)
  expect(r.stdout).toContain('warn: docs/glossary.md missing')
  expect(r.stdout).toContain('warn: .github/dependabot.yml missing')
})

test('a public repository needs a licence and a security policy', () => {
  const s = box()
  scaffold(s)
  s.onGitHub()
  s.answer('repos/o/r', { visibility: 'public', default_branch: 'main' })
  let r = check(s)
  expect(r.code).toBe(1)
  expect(r.stdout).toContain('fail: LICENSE missing')
  expect(r.stdout).toContain('fail: SECURITY.md missing')
  s.write('LICENSE', 'MIT\n')
  s.write('.github/SECURITY.md', 'report privately\n')
  r = check(s)
  expect(r.code, r.stdout).toBe(0)
  expect(r.stdout).toContain('ok: .github/SECURITY.md')
  s.remove('LICENSE')
  s.answer('repos/o/r', { visibility: 'private', default_branch: 'main' })
  r = check(s)
  expect(r.code, r.stdout).toBe(0)
  expect(r.stdout).not.toContain('LICENSE')
  // Without an answer of GitHub the visibility is unknown.
  s.remove('repos', s.github)
  s.remove('api', s.github)
  r = check(s)
  expect(r.code, r.stdout).toBe(0)
  expect(r.stdout).toContain('skip: licence and security policy not checked (visibility unknown without GitHub)')
})

test('the check warns for plugins of another marketplace', () => {
  const s = box()
  scaffold(s)
  const plugins = ['planner', 'repo-standards', 'worker']
  let r = check(s)
  for (const p of plugins) expect(r.stdout).toContain(`ok: ${p}@ameise enabled`)
  expect(r.stdout).not.toContain('not enabled')
  expect(r.stdout).not.toContain('enabled at project scope')
  const changed = settings(s)
  changed.enabledPlugins = Object.fromEntries(plugins.map((p) => [`${p}@other`, true]))
  s.write('.claude/settings.json', JSON.stringify(changed))
  r = check(s)
  for (const p of plugins) {
    expect(r.stdout).toContain(`warn: ${p}@ameise not enabled in .claude/settings.json`)
    expect(r.stdout).toContain(`warn: ${p}@other enabled at project scope`)
  }
})

test('the check holds the settings to the workflow plugins without hooks', () => {
  const s = box()
  scaffold(s)
  const changed = settings(s)
  Object.assign(changed.enabledPlugins, { 'planner@ameise': false, 'foo@bar': true, 'old@bar': false, 'a *': true, 'worker@ameis': true })
  Object.assign(changed, { enabledMcpjsonServers: [], enableAllProjectMcpServers: false })
  s.write('.claude/settings.json', JSON.stringify(changed))
  expect(check(s).stdout).not.toContain('MCP')
  changed.enabledMcpjsonServers = ['db']
  s.write('.claude/settings.json', JSON.stringify(changed))
  let r = check(s)
  expect(r.code, r.stdout).toBe(0)
  expect(r.stdout).toContain('warn: planner@ameise not enabled in .claude/settings.json')
  expect(r.stdout).toContain('warn: foo@bar enabled at project scope; the standard enables only the workflow plugins')
  expect(r.stdout).not.toContain('old@bar')
  expect(r.stdout).toContain('warn: a * enabled at project scope')
  expect(r.stdout).toContain('warn: worker@ameis enabled at project scope')
  expect(r.stdout).toContain('warn: .claude/settings.json enables MCP servers')
  changed.hooks = { Stop: [] }
  s.write('.claude/settings.json', JSON.stringify(changed))
  r = check(s)
  expect(r.code).toBe(1)
  expect(r.stdout).toContain('fail: .claude/settings.json has hooks')
})

test('MCP configuration warns and an AI reviewer action fails', () => {
  const s = box()
  scaffold(s)
  s.write('.mcp.json', '{}\n')
  let r = check(s)
  expect(r.code, r.stdout).toBe(0)
  expect(r.stdout).toContain('warn: .mcp.json: MCP configuration; keep it only if something in the repository uses it')
  s.write(
    '.github/workflows/review.yml',
    'on: pull_request\njobs:\n  review:\n    runs-on: ubuntu-latest\n' +
      "    steps:\n      - uses: actions/checkout@v5\n      - uses: 'anthropics/claude-code-action@v1'\n" +
      '      - name: codex\n        uses: openai/codex-action@main\n      - uses: anthropics/claude-code-base-action@beta\n' +
      '      - uses: google-github-actions/run-gemini-cli@v0\n      - uses: coderabbitai/ai-pr-reviewer@latest\n',
  )
  // A file name is data: one that reads as a sed script (w writes a file) must not run.
  const evil = '.github/workflows/x#;w pwned#.yml'
  s.write(evil, 'jobs:\n  r:\n    steps:\n      - uses: coderabbitai/ai-pr-reviewer@latest\n')
  r = check(s)
  expect(r.code).toBe(1)
  const all = (readdirSync(s.repo, { recursive: true }) as string[]).map((p) => p.split('/').at(-1)!)
  expect(
    all.some((n) => n.startsWith('pwned')),
    'check.sh ran a file name as sed',
  ).toBe(false)
  expect(r.stdout).toContain(`fail: ${evil}: coderabbitai/ai-pr-reviewer runs an AI reviewer or agent in CI; remove it`)
  s.remove(evil)
  r = check(s)
  expect(r.code).toBe(1)
  const named = r.stdout
    .split('\n')
    .filter((l) => l.includes('AI reviewer'))
    .sort()
  expect(named).toEqual(
    ['anthropics/claude-code-action', 'anthropics/claude-code-base-action', 'coderabbitai/ai-pr-reviewer', 'google-github-actions/run-gemini-cli', 'openai/codex-action'].map(
      (a) => `fail: .github/workflows/review.yml: ${a} runs an AI reviewer or agent in CI; remove it`,
    ),
  )
})

test('the check counts tracked files and works outside git', () => {
  const s = box()
  scaffold(s)
  s.write('.claude/commands/ship.md', 'x\n')
  s.git('add', '-A')
  s.git('commit', '-qm', 'baseline')
  const r = check(s)
  expect(r.code).toBe(1)
  expect(r.stdout).toContain('fail: .claude/commands/ship.md:')
  const plain = join(s.base, 'plain')
  scaffold(s, [plain])
  expect(check(s, plain).code).toBe(0)
  s.write('.claude/skills/x/SKILL.md', 'x\n', plain)
  expect(check(s, plain).stdout).toContain('fail: .claude/skills/x:')
})

// The writing rules: the check counts the em dash and the word caps, fails on each finding, and warns instead with
// WF_WRITING_LENIENT set.
const EM = '\u2014'
const WRITING_OK = ['ok: no em dash', 'ok: paragraphs, bullets and glossary entries within their word caps', 'ok: documents within their word caps']
const strict = (s: Sandbox, at?: string) => check(s, at, { WF_WRITING_LENIENT: '' })
const lenient = (s: Sandbox, at?: string) => check(s, at, { WF_WRITING_LENIENT: '1' })

// writing expects the findings to fail without the lenient variable and to warn with it; everything else is the same.
function writing(s: Sandbox, findings: string[]) {
  let r = strict(s)
  expect(r.code, r.stdout).toBe(1)
  for (const f of findings) expect(r.stdout).toContain(`fail: ${f}\n`)
  expect(r.stdout).not.toContain('warn: ' + findings[0])
  r = lenient(s)
  expect(r.code, r.stdout).toBe(0)
  expect(r.stdout).toContain('result: pass')
  for (const f of findings) expect(r.stdout).toContain(`warn: ${f}\n`)
  expect(r.stdout).not.toContain('fail: ')
}

test('the templates pass the writing rules', () => {
  const s = box()
  s.remove('README.md')
  scaffold(s)
  s.run(join(standards, 'new-adr.sh'), ['Use', 'Postgres'])
  s.write('plugins/tool/README.md', readFileSync(join(standards, '..', 'templates', 'plugin-README.md'), 'utf8'))
  const r = strict(s)
  expect(r.code, r.stdout).toBe(0)
  for (const line of WRITING_OK) expect(r.stdout).toContain(line)
  const headings = (path: string) =>
    s
      .read(path)
      .split('\n')
      .filter((l) => l.startsWith('## '))
  expect(headings('README.md')).toEqual(['## What it ships', '## Install', '## Daily use', '## Configuration', '## Design', '## Develop'])
  expect(headings('docs/architecture.md')).toEqual(['## Purpose', '## Components', '## Data flow', '## Boundaries', '## Decisions'])
  expect(headings('plugins/tool/README.md')).toEqual(['## Skills', '## Configuration', '## Develop'])
  expect(headings('docs/adr/0001-use-postgres.md')).toEqual(['## Context', '## Decision', '## Consequences'])
})

test('an em dash in any text file fails and names the file', () => {
  const s = box()
  scaffold(s)
  s.write('src/app.py', `x = 1  # one ${EM} two ${EM} three\n`)
  s.write('docs/notes.md', `A note ${EM} short.\n`)
  writeFileSync(join(s.repo, 'logo.png'), Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0]), Buffer.from(EM), Buffer.from([0])]))
  writing(s, ['docs/notes.md has 1 em dash; use a comma, a colon or two sentences', 'src/app.py has 2 em dashes; use a comma, a colon or two sentences'])
  expect(strict(s).stdout, 'a binary file is no text').not.toContain('logo.png')
})

test('a long paragraph or bullet fails unless it is code or a table', () => {
  const s = box()
  scaffold(s)
  const long = words(81)
  const cap = words(80)
  s.write('docs/notes.md', `# Notes\n\n${cap}\n\n\`\`\`\n${long}\n\`\`\`\n\n| a | b |\n| --- | --- |\n| ${long} | x |\n\n- ${words(30)}\n1. ${words(30)}\n`)
  const r = strict(s)
  expect(r.code, r.stdout).toBe(0)
  expect(r.stdout).toContain(WRITING_OK[1])
  const half = words(40)
  s.write('docs/notes.md', `# Notes\n\n${half}\n${half} more\n\n- ${words(30)}\n  more\n2. ${words(31)}\n`)
  writing(s, [
    'docs/notes.md:3: paragraph of 81 words (>80); split it or make it bullets',
    'docs/notes.md:6: bullet of 31 words (>30); shorten it or split it',
    'docs/notes.md:8: bullet of 31 words (>30); shorten it or split it',
  ])
  expect(strict(s).stdout).not.toContain(WRITING_OK[1])
})

test('indented code, a table without the leading pipe and a thematic break are no paragraphs', () => {
  const s = box()
  scaffold(s)
  const long = words(81)
  s.write('docs/notes.md', `---\n\nIntro.\n\n    ${long}\n\n\tcode ${long}\n\nText.\n\na | b\n:-- | --:\n${long} | x\n\n- item\n\n      ${long}\n`)
  const r = strict(s)
  expect(r.code, r.stdout).toBe(0)
  expect(r.stdout).toContain(WRITING_OK[1])
  // Four spaces under a list item are its paragraph, not code; a pipe in prose is no table.
  s.write('docs/notes.md', `- item\n\n    ${long}\n\nThe a | b case ${long}\n`)
  writing(s, ['docs/notes.md:3: paragraph of 81 words (>80); split it or make it bullets', 'docs/notes.md:5: paragraph of 85 words (>80); split it or make it bullets'])
})

test('front matter is skipped only with its closing line', () => {
  const s = box()
  scaffold(s)
  const long = words(81)
  s.write('docs/notes.md', `---\ntitle: ${long}\n---\n\nShort.\n`)
  expect(strict(s).code).toBe(0)
  s.write('docs/notes.md', `---\n\n${long}\n`)
  writing(s, ['docs/notes.md:3: paragraph of 81 words (>80); split it or make it bullets'])
})

test('every markdown extension is scanned, and a README in another format is counted whole', () => {
  const s = box()
  scaffold(s)
  s.remove('README.md')
  s.write('README.rst', `${words(1201)}\n`)
  s.write('docs/notes.markdown', `${words(81)}\n`)
  writing(s, ['docs/notes.markdown:1: paragraph of 81 words (>80); split it or make it bullets', 'README.rst has 1201 words (>1200 for the README); shorten it'])
  expect(strict(s).stdout, 'a README in another format has no paragraphs').not.toContain('README.rst:1')
})

test('each document fails over its word cap and is named with its count', () => {
  const s = box()
  scaffold(s)
  // Each document one word over its cap: the heading and the Status line count too, a code block does not.
  nextFree(s, 2)
  s.write('docs/adr/0001-big.md', '# 0001. Big\n\nStatus: accepted\n\n' + paragraphs(247) + '```\n' + words(60, 'code') + '\n```\n')
  s.write('docs/architecture.md', '# Architecture\n\n' + paragraphs(2000))
  s.write('README.md', '# shop\n\n' + paragraphs(1200))
  s.write('plugins/tool/README.md', '# tool\n\n' + paragraphs(800))
  s.write('docs/glossary.md', `# Glossary\n\n| Term | Meaning |\n| --- | --- |\n| short | ${words(39)} |\n| long | ${words(40)} |\n`)
  writing(s, [
    'docs/adr/0001-big.md has 251 words (>250 for an ADR); shorten it',
    'docs/architecture.md has 2001 words (>2000 for the architecture map); shorten it',
    'README.md has 1201 words (>1200 for the README); shorten it',
    'plugins/tool/README.md has 801 words (>800 for a plugin README); shorten it',
    'docs/glossary.md:6: glossary entry of 41 words (>40); shorten it',
  ])
  const r = strict(s)
  expect(r.stdout).not.toContain('docs/glossary.md:5')
  expect(r.stdout).not.toContain(WRITING_OK[2])
  s.write('docs/adr/0001-big.md', '# 0001. Big\n\nStatus: accepted\n\n' + paragraphs(246))
  expect(strict(s).stdout).not.toContain('0001-big.md')
})

test('the writing rules are counted outside git on the files found', () => {
  const s = box()
  const plain = join(s.base, 'plain')
  scaffold(s, [plain])
  expect(strict(s, plain).code).toBe(0)
  s.write('notes.md', `${words(81)}\n`, plain)
  s.write('run.sh', `echo ${EM}\n`, plain)
  let r = strict(s, plain)
  expect(r.code, r.stdout).toBe(1)
  expect(r.stdout).toContain('fail: notes.md:1: paragraph of 81 words (>80); split it or make it bullets\n')
  expect(r.stdout).toContain('fail: run.sh has 1 em dash; use a comma, a colon or two sentences\n')
  r = lenient(s, plain)
  expect(r.code, r.stdout).toBe(0)
  expect(r.stdout).toContain('warn: notes.md:1: paragraph of 81 words (>80)')
})

test('new-adr numbers sequentially and indexes', () => {
  const s = box()
  scaffold(s)
  const first = s.run(join(standards, 'new-adr.sh'), ['Use', 'Postgres'])
  const second = s.run(join(standards, 'new-adr.sh'), ['Drop Redis!'])
  expect(first.stdout).toContain('created: docs/adr/0001-use-postgres.md')
  expect(second.stdout).toContain('created: docs/adr/0002-drop-redis.md')
  const adr = s.read('docs/adr/0001-use-postgres.md')
  expect(adr).toContain('# 0001. Use Postgres')
  expect(adr).toContain('Status: proposed')
  expect(s.read('docs/adr/README.md')).toContain('| [0002](0002-drop-redis.md) | Drop Redis! | proposed |')
  expect(check(s).stdout).toContain('ok: ADRs: 2')
})

test('new-adr cuts a long title without a trailing hyphen', () => {
  const s = box()
  scaffold(s)
  const r = s.run(join(standards, 'new-adr.sh'), ['make check is the single gate and check the single required status check'])
  expect(r.stdout).toContain('created: docs/adr/0001-make-check-is-the-single-gate-and-check-the-single-required.md')
})

test('new-adr takes the next free number after a deletion and raises it', () => {
  const s = box()
  scaffold(s)
  s.run(join(standards, 'new-adr.sh'), ['Use', 'Postgres'])
  s.run(join(standards, 'new-adr.sh'), ['Drop Redis'])
  s.remove('docs/adr/0002-drop-redis.md')
  const r = s.run(join(standards, 'new-adr.sh'), ['Use Kafka'])
  expect(r.code, r.stderr).toBe(0)
  expect(r.stdout).toContain('created: docs/adr/0003-use-kafka.md')
  expect(s.read('docs/adr/README.md')).toContain('\nNext free number: 0004\n')
  expect(r.stderr).toBe('')
})

test('new-adr warns on a full set and names the fix', () => {
  const s = box()
  scaffold(s)
  for (const t of ['One', 'Two']) expect(s.run(join(standards, 'new-adr.sh'), [t], { env: { WF_ADR_MAX: '2' } }).stderr).toBe('')
  const r = s.run(join(standards, 'new-adr.sh'), ['Three'], { env: { WF_ADR_MAX: '2' } })
  expect(r.code).toBe(0)
  expect(r.stdout).toContain('created: docs/adr/0003-three.md')
  expect(r.stderr).toContain('warn: 3 ADRs (>2); remove one, or move it as a rule with its reason into the document of its area')
})

// The ADR rule: the check fails on each finding, and warns instead with WF_ADR_LENIENT set. References to an ADR are
// built at run time, so this file never trips the check of this repository.
const num = (n: number) => String(n).padStart(4, '0')
const ADR = 'ADR'
// nextFree sets the index's next free number.
function nextFree(s: Sandbox, n: number) {
  s.write('docs/adr/README.md', s.read('docs/adr/README.md').replace(/^Next free number: \d{4}$/m, `Next free number: ${num(n)}`))
}
// decision writes ADR n with the given status and further lines.
function decision(s: Sandbox, n: number, status = 'Status: accepted', more = '') {
  s.write(`docs/adr/${num(n)}-d${n}.md`, `# ${num(n)}. D${n}\n\n${status}\n${more}\n## Decision\nA decision.\n`)
}
const adrCheck = (s: Sandbox, env: Record<string, string> = {}) => check(s, undefined, env)
// adrRule expects the findings to fail without the lenient variable and to warn with it.
function adrRule(s: Sandbox, findings: string[], env: Record<string, string> = {}) {
  let r = adrCheck(s, env)
  expect(r.code, r.stdout).toBe(1)
  for (const f of findings) expect(r.stdout).toContain(`fail: ${f}\n`)
  r = adrCheck(s, { ...env, WF_ADR_LENIENT: '1' })
  expect(r.code, r.stdout).toBe(0)
  for (const f of findings) expect(r.stdout).toContain(`warn: ${f}\n`)
  expect(r.stdout).not.toContain('fail: ')
}

test('an empty ADR set passes without a warning', () => {
  const s = box()
  scaffold(s)
  const r = adrCheck(s)
  expect(r.code, r.stdout).toBe(0)
  expect(r.stdout).toContain('ok: ADRs: 0 of at most 20\n')
  expect(r.stdout).toContain('ok: every ADR reference has its file\n')
  expect(r.stdout).not.toMatch(/^warn: .*ADR/im)
})

test('the ADRs may not outnumber WF_ADR_MAX, 20 by default, and an invalid value fails', () => {
  const s = box()
  scaffold(s)
  for (let n = 1; n <= 20; n++) decision(s, n)
  nextFree(s, 22)
  expect(adrCheck(s).stdout).toContain('ok: ADRs: 20 of at most 20\n')
  decision(s, 21)
  const full = '21 ADRs (>20); remove one, or move it as a rule with its reason into the document of its area'
  adrRule(s, [full])
  expect(adrCheck(s, { WF_ADR_MAX: '21' }).code).toBe(0)
  adrRule(s, ['21 ADRs (>5); remove one, or move it as a rule with its reason into the document of its area'], { WF_ADR_MAX: '5' })
  for (const bad of ['', 'abc', '0', '-3', '2x'])
    adrRule(s, [`WF_ADR_MAX=${bad} is not a positive integer; set it to the most ADRs the repository keeps, such as 20`], { WF_ADR_MAX: bad })
})

test('a status is exactly proposed or accepted, and an ADR names no relation', () => {
  const s = box()
  scaffold(s)
  nextFree(s, 10)
  decision(s, 1, 'Status: proposed')
  decision(s, 2, 'Status: accepted  ')
  expect(adrCheck(s).code).toBe(0)
  decision(s, 3, 'Status: accepted, amended')
  decision(s, 4, 'Status: superseded')
  decision(s, 5, 'Date: today')
  decision(s, 6, 'Status: accepted', `Amended by: [${num(7)}](${num(7)}-d7.md)\nSupersedes: nothing\n`)
  decision(s, 7)
  adrRule(s, [
    `docs/adr/0003-d3.md has "Status: accepted, amended"; a status is exactly proposed or accepted`,
    `docs/adr/0004-d4.md has "Status: superseded"; a status is exactly proposed or accepted`,
    'docs/adr/0005-d5.md has no Status line; add Status: proposed or Status: accepted',
    'docs/adr/0006-d6.md:4: a relation line; an ADR names no relation to another, edit or delete the other ADR instead',
    'docs/adr/0006-d6.md:5: a relation line; an ADR names no relation to another, edit or delete the other ADR instead',
  ])
})

test('an ADR number lies below the index\'s next free number, and the index carries one', () => {
  const s = box()
  scaffold(s)
  decision(s, 1)
  decision(s, 2)
  nextFree(s, 3)
  expect(adrCheck(s).code).toBe(0)
  nextFree(s, 2)
  adrRule(s, ['docs/adr/0002-d2.md: number 0002 is at or above the next free number 0002; raise Next free number in docs/adr/README.md'])
  nextFree(s, 1)
  adrRule(s, [
    'docs/adr/0001-d1.md: number 0001 is at or above the next free number 0001; raise Next free number in docs/adr/README.md',
    'docs/adr/0002-d2.md: number 0002 is at or above the next free number 0001; raise Next free number in docs/adr/README.md',
  ])
  s.write('docs/adr/README.md', s.read('docs/adr/README.md').replace(/^Next free number: .*\n/m, ''))
  adrRule(s, ['docs/adr/README.md has no line Next free number: NNNN; add it above the table, one above the highest number ever used'])
})

test('a reference to an ADR with no file fails, and URLs with a scheme and changelogs are not read', () => {
  const s = box()
  scaffold(s)
  decision(s, 1)
  nextFree(s, 10)
  const live = `${num(1)}-d1.md`
  const gone = `${num(9)}-gone.md`
  // Live references in every form: a relative link, a link definition, a link inside docs/adr, the bare form.
  s.write('docs/notes.md', `See [the rule](adr/${live}#decision) and ${ADR} ${num(1)}.\n\n[rule]: ./adr/${live}\n`)
  s.write('src/main.go', `// See [${ADR} ${num(1)}].\n//\n// [${ADR} ${num(1)}]: ../docs/adr/${live}\npackage main\n`)
  s.write('docs/adr/0001-d1.md', s.read(`docs/adr/${live}`) + `\nSee [itself](${live}).\n`)
  // Not read: a URL with a scheme, a changelog, an ${ADR}-like word, a link to a numbered file outside docs/adr.
  s.write('docs/links.md', `[old](https://example.com/docs/adr/${gone}) https://example.com/${ADR}-${num(9)} x${ADR} ${num(9)} [n](notes/${gone}) mailto:${ADR}-${num(9)}@example.com urn:${ADR}-${num(9)}\n`)
  s.write('CHANGELOG.md', `- dropped ${ADR} ${num(9)}, see [it](docs/adr/${gone})\n`)
  s.write('pkg/CHANGELOG', `- ${ADR} ${num(8)}\n`)
  let r = adrCheck(s)
  expect(r.code, r.stdout).toBe(0)
  expect(r.stdout).toContain('ok: every ADR reference has its file\n')
  s.write('docs/dangling.md', `Read [this](adr/${gone}?plain=1).\n\n[def]: adr/${gone}\n\nAs ${ADR} ${num(9)} says.\n`)
  s.write('src/app.go', `// [${ADR} ${num(8)}]: ../docs/adr/${num(8)}-x.md\npackage main\n`)
  s.write('-notes.md', `As ${ADR} ${num(7)} says.\n`)
  adrRule(s, [
    `-notes.md:1: cites ${ADR} ${num(7)}, which has no file; cite an ADR that exists or state the reason`,
    `docs/dangling.md:1: links docs/adr/${gone}, an ADR with no file; link an ADR that exists or state the reason`,
    `docs/dangling.md:3: links docs/adr/${gone}, an ADR with no file; link an ADR that exists or state the reason`,
    `docs/dangling.md:5: cites ${ADR} ${num(9)}, which has no file; cite an ADR that exists or state the reason`,
    `src/app.go:1: links docs/adr/${num(8)}-x.md, an ADR with no file; link an ADR that exists or state the reason`,
    `src/app.go:1: cites ${ADR} ${num(8)}, which has no file; cite an ADR that exists or state the reason`,
  ])
  r = adrCheck(s)
  expect(r.stdout).not.toContain('docs/links.md')
  expect(r.stdout).not.toContain('CHANGELOG')
  expect(r.stdout).not.toContain('ok: every ADR reference has its file')
})
