// The facts of the repository the auditors share, as compact `key: value` lines: the profile (visibility,
// plan, branch model), languages and manifests, detected test and lint commands, CI jobs, every agent
// configuration location, the baseline files and file statistics. Reads only; changes nothing. GitHub is
// optional: without it visibility and plan are `unknown` and the branch model comes from git.
import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { attempt } from '../exec.js'
import { byteOrder, type Ctx, gh, git, isDir, last, licenseNames, lines, plugin, readmeNames, say, scriptTimeout, Stop, tryGit, unique } from './lib.js'

// join is the items joined with ", ", or the fallback when there are none.
const joined = (items: string[], none = 'none') => (items.length > 0 ? items.join(', ') : none)
const sorted = (xs: string[]) => [...xs].sort(byteOrder)

const languageOf: Record<string, string> = {
  py: 'Python',
  sh: 'Shell',
  bash: 'Shell',
  zsh: 'Shell',
  ts: 'TypeScript',
  tsx: 'TypeScript',
  mts: 'TypeScript',
  cts: 'TypeScript',
  js: 'JavaScript',
  jsx: 'JavaScript',
  mjs: 'JavaScript',
  cjs: 'JavaScript',
  go: 'Go',
  rs: 'Rust',
  rb: 'Ruby',
  java: 'Java',
  kt: 'Kotlin',
  kts: 'Kotlin',
  swift: 'Swift',
  c: 'C',
  h: 'C',
  cc: 'C++',
  cpp: 'C++',
  cxx: 'C++',
  hpp: 'C++',
  cs: 'C#',
  php: 'PHP',
  ex: 'Elixir',
  exs: 'Elixir',
  dart: 'Dart',
  scala: 'Scala',
  lua: 'Lua',
  sql: 'SQL',
  html: 'HTML',
  htm: 'HTML',
  css: 'CSS',
  scss: 'CSS',
  vue: 'Vue',
  svelte: 'Svelte',
  tf: 'Terraform',
  nix: 'Nix',
  md: 'Markdown',
  mdx: 'Markdown',
}

const manifestName =
  /^(package\.json|pyproject\.toml|setup\.py|setup\.cfg|Pipfile|Cargo\.toml|go\.mod|Gemfile|pom\.xml|build\.gradle(\.kts)?|composer\.json|mix\.exs|Package\.swift|pubspec\.yaml|deno\.jsonc?|CMakeLists\.txt|flake\.nix|justfile|Justfile|Makefile|GNUmakefile|makefile|Dockerfile|tox\.ini|noxfile\.py)$/

// workflowJobs is the jobs of a GitHub Actions workflow as `id` or `id ("name")`, comma separated, the name only
// when it differs from the id (GitHub shows the name as the check).
export function workflowJobs(text: string): string {
  let inJobs = false
  let ind = 0
  const ids: string[] = []
  const sd: number[] = []
  const nm: string[] = []
  for (const line of text.split('\n')) {
    if (/^jobs:\s*$/.test(line)) {
      inJobs = true
      ind = 0
      continue
    }
    if (inJobs && /^[^\s#]/.test(line)) inJobs = false
    if (!inJobs || /^\s*(#|$)/.test(line)) continue
    const d = /^ */.exec(line)?.[0].length ?? 0
    if (ind === 0) ind = d
    if (d === ind && /^ *[A-Za-z0-9_-]+:/.test(line)) {
      ids.push(line.trimStart().replace(/:.*/, ''))
      continue
    }
    const n = ids.length - 1
    if (n >= 0 && d > ind && sd[n] === undefined) sd[n] = d
    if (n >= 0 && d === sd[n] && /^ *name:/.test(line)) {
      nm[n] = line
        .replace(/^ *name:\s*/, '')
        .replace(/\s+$/, '')
        .replace(/^["']|["']$/g, '')
    }
  }
  return ids.map((id, i) => (nm[i] && nm[i] !== id ? `${id} ("${nm[i]}")` : id)).join(', ')
}

// isCheckJob is whether the jobs of workflowJobs have one GitHub reports as the check `check`.
export const isCheckJob = (jobs: string) =>
  jobs
    .split(',')
    .map((j) => j.replace(/^ +/, ''))
    .some((j) => j === 'check' || j.endsWith('("check")'))

// human is a size as a person reads it.
const human = (b: number) => (b >= 1048576 ? `${(b / 1048576).toFixed(1)} MB` : b >= 1024 ? `${(b / 1024).toFixed(0)} KB` : `${b} B`)

// The directories the walk for agent configuration never enters, and never lists when they are files.
const pruned = new Set(['.git', 'node_modules', '.venv', 'venv', 'vendor', 'target', '__pycache__'])

// walk lists every file and link below the root, as find does, without following a link.
function walk(root: string, rel = ''): string[] {
  let entries
  try {
    entries = readdirSync(join(root, rel), { withFileTypes: true })
  } catch {
    return []
  }
  const out: string[] = []
  for (const e of entries) {
    const p = rel === '' ? e.name : `${rel}/${e.name}`
    if (pruned.has(e.name) || p === '.claude/worktrees') continue
    if (e.isDirectory()) out.push(...walk(root, p))
    else if (e.isFile() || e.isSymbolicLink()) out.push(p)
  }
  return out
}

const otherTools =
  /^(\.agents|\.amazonq|\.augment|\.clinerules|\.codex|\.continue|\.cursor|\.cursorignore|\.cursorindexingignore|\.cursorrules|\.gemini|\.goose|\.goosehints|\.junie|\.kilocode|\.kiro|\.opencode|\.qwen|\.roo|\.roomodes|\.roorules|\.trae|\.windsurf|\.windsurfrules|GEMINI\.md|opencode\.json|skills-lock\.json|\.skill-lock\.json)$/

// agentLocation is the location of agent configuration a path belongs to and whether the standard defines it,
// or undefined when it is none.
function agentLocation(path: string): [string, string] | undefined {
  const f = path.split('/')
  const nf = f.length
  const loc = (i: number) => f.slice(0, Math.min(i + 3, nf)).join('/')
  for (let i = 0; i < nf; i++) {
    const c = f[i] ?? ''
    const end = i === nf - 1
    if (c === '.claude' && end) return [path, 'outside the standard (a symlinked .claude)']
    if (c === '.claude') {
      const s = f[i + 1]
      return [loc(i), i === 0 && (s === 'settings.json' || s === 'settings.local.json') ? 'standard' : 'outside the standard']
    }
    if (end && (c === 'CLAUDE.md' || c === 'AGENTS.md')) return [path, 'standard']
    if (c === '.claude-plugin') return [loc(i), 'plugin source, not loaded as configuration']
    if (end && ['CLAUDE.local.md', 'AGENT.md', '.worktreeinclude', '.rules'].includes(c)) return [path, 'outside the standard']
    if (end && c === '.mcp.json') return [path, 'needs judgement (stays when something in the repository uses it)']
    if (/^\.aider/.test(c) || otherTools.test(c)) return [loc(i), 'outside the standard']
    if (i === 0 && c === '.github' && nf > 1 && /^(copilot-instructions\.md|instructions|prompts|chatmodes|agents)$/.test(f[1] ?? '')) return [loc(i), 'outside the standard']
  }
  return undefined
}

// has is whether a file or directory of exactly this name is in dir. macOS file systems ignore case, so an
// existence check would accept claude.md for CLAUDE.md.
function has(dir: string, name: string): boolean {
  try {
    return readdirSync(dir).includes(name)
  } catch {
    return false
  }
}

// facts prints the facts of the repository at root, the checkout when none is given.
export async function facts(c: Ctx, root?: string) {
  if (root === undefined) {
    const top = await tryGit(c, ['rev-parse', '--show-toplevel'])
    root = top.code === 0 ? top.stdout.trim() : c.root
  }
  if (!isDir(root)) throw new Stop(`cannot enter ${root}; pass an existing repository directory`)
  if ((await tryGit(c, ['rev-parse', '--is-inside-work-tree'], root)).code !== 0) throw new Stop(`${root} is not a git repository; run git init first`)
  const at = root
  const kv = (k: string, v: string) => say(c, `${k}: ${v}`)
  const g = (args: string[], input?: string) => git(c, ['-c', 'core.quotePath=false', ...args], at, input)
  const tg = (args: string[]) => tryGit(c, ['-c', 'core.quotePath=false', ...args], at)

  // Files: tracked plus untracked-but-not-ignored, the same set check.sh judges.
  const tracked = unique(sorted(lines(await g(['ls-files']))))
  const untracked = unique(sorted(lines(await g(['ls-files', '--others', '--exclude-standard']))))
  const all = unique(sorted([...tracked, ...untracked]))

  // Profile. The branch model follows ADR 0009: dev plus main when the default branch is dev.
  let visibility = 'unknown'
  let plan = 'unknown'
  let defaultBranch = ''
  let github: string
  const view = await gh(c, ['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner'])
  const nwo = view.stdout.trim()
  const read = view.code === 0 ? await gh(c, ['api', `repos/${nwo}`]) : view
  if (read.code === 0) {
    const repo = JSON.parse(read.stdout) as { visibility?: string | null; default_branch?: string | null; owner?: { login?: string; type?: string } }
    visibility = repo.visibility ?? 'unknown'
    defaultBranch = repo.default_branch ?? ''
    const owner = repo.owner?.login ?? nwo.split('/')[0] ?? ''
    // GitHub shows a plan only to the account itself or to an organisation's owners.
    if (repo.owner?.type === 'Organization') {
      const org = await gh(c, ['api', `orgs/${owner}`])
      let name: string
      try {
        name = org.code === 0 ? ((JSON.parse(org.stdout) as { plan?: { name?: string } }).plan?.name ?? '') : ''
      } catch {
        name = ''
      }
      plan = name || 'unknown (visible to organisation owners only)'
    } else {
      const me = await gh(c, ['api', 'user'])
      const user = me.code === 0 && me.stdout.trim() !== '' ? (JSON.parse(me.stdout) as { login?: string; plan?: { name?: string } }) : undefined
      plan = user && user.login === owner ? (user.plan?.name ?? 'unknown') : `unknown (owned by ${owner}, not the gh user)`
    }
    github = `${nwo}, owner ${owner}`
  } else if (/ENOENT/.test(read.stderr)) github = 'unreachable (gh not installed)'
  else github = `unreachable (${last(read.stderr)})`
  if (defaultBranch === '') {
    const remote = await tg(['symbolic-ref', '--short', '-q', 'refs/remotes/origin/HEAD'])
    defaultBranch = remote.code === 0 ? remote.stdout.trim().replace(/^origin\//, '') : ''
    if (defaultBranch === '') {
      const local = await tg(['symbolic-ref', '--short', '-q', 'HEAD'])
      defaultBranch = local.code === 0 ? local.stdout.trim() : ''
    }
  }
  const model = defaultBranch === 'dev' ? 'dev+main' : defaultBranch === 'main' ? 'main' : `none (default branch ${defaultBranch || 'unknown'} is neither main nor dev)`
  const short = await tg(['rev-parse', '--short', '-q', '--verify', 'HEAD'])
  let head = 'none (no commits yet)'
  if (short.code === 0) {
    const branch = await tg(['symbolic-ref', '--short', '-q', 'HEAD'])
    const count = (await g(['rev-list', '--count', 'HEAD'])).trim()
    head = `${short.stdout.trim()} on ${branch.code === 0 ? branch.stdout.trim() : 'detached HEAD'}, ${count} commits`
  }
  kv('github', github)
  kv('visibility', visibility)
  kv('plan', plan)
  kv('default-branch', defaultBranch || 'unknown')
  kv('branch-model', model)
  kv('head', head)

  // Languages by file extension, most files first.
  const counts = new Map<string, number>()
  for (const p of all) {
    const f = basename(p)
    const e = f.includes('.') ? f.toLowerCase().replace(/.*\./, '') : ''
    const l = languageOf[e]
    if (l) counts.set(l, (counts.get(l) ?? 0) + 1)
  }
  const languages = [...counts].sort((a, b) => b[1] - a[1] || byteOrder(a[0], b[0])).slice(0, 10)
  kv('languages', joined(languages.map(([l, n]) => `${l} ${n}`)))

  // Manifests: build and package files at any depth, shallowest first.
  const manifests = all
    .filter((p) => {
      const parts = p.split('/')
      const name = parts.at(-1) ?? ''
      return parts.length <= 4 && (manifestName.test(name) || /^requirements.*\.txt$/.test(name) || /\.(csproj|sln)$/.test(name))
    })
    .sort((a, b) => a.split('/').length - b.split('/').length || byteOrder(a, b))
  kv('manifests', joined(manifests.slice(0, 15)) + (manifests.length > 15 ? ` (+${manifests.length - 15} more)` : ''))

  // Test and lint commands, each with the file it comes from. Detection only; nothing is run.
  const tests: string[] = []
  const lints: string[] = []
  let gate = ''
  const addTest = (cmd: string, from: string) => tests.push(`${cmd} (${from})`)
  const addLint = (cmd: string, from: string) => lints.push(`${cmd} (${from})`)
  const fileAt = (p: string) => {
    try {
      return statSync(join(at, p)).isFile()
    } catch {
      return false
    }
  }
  for (const m of manifests) {
    if (!fileAt(m)) continue // tracked but deleted from the working tree
    const d = dirname(m)
    const f = basename(m)
    const dirFlag = d === '.' ? '' : ` -C ${d}`
    const text = readFileSync(join(at, m), 'utf8')
    switch (f) {
      case 'Makefile':
      case 'GNUmakefile':
      case 'makefile': {
        // Targets of the form `name:` (not `name :=`), one line each.
        const targets = unique(sorted(text.split('\n').flatMap((l) => /^([A-Za-z0-9_.-]+)\s*::?([^=]|$)/.exec(l)?.[1] ?? [])))
        for (const t of targets) {
          if (t === 'check') {
            if (gate === '') gate = `make${dirFlag} check (${m})`
          } else if (['test', 'tests', 'unit', 'integration', 'e2e'].includes(t) || t.startsWith('test-')) addTest(`make${dirFlag} ${t}`, m)
          else if (['lint', 'fmt', 'format', 'format-check', 'typecheck', 'vet'].includes(t) || t.startsWith('lint-')) addLint(`make${dirFlag} ${t}`, m)
        }
        break
      }
      case 'package.json': {
        let pm = 'npm'
        for (const [lock, name] of [
          ['pnpm-lock.yaml', 'pnpm'],
          ['yarn.lock', 'yarn'],
          ['bun.lockb', 'bun'],
          ['bun.lock', 'bun'],
        ] as const) {
          if (existsSync(join(at, d, lock))) {
            pm = name
            break
          }
        }
        let scripts: string[]
        try {
          scripts = Object.keys((JSON.parse(text) as { scripts?: Record<string, unknown> | null }).scripts ?? {})
            .sort()
            .filter((s) => /^[A-Za-z0-9:_.-]+$/.test(s))
        } catch {
          scripts = []
        }
        for (const s of scripts) {
          if (s === 'test') addTest(`${pm} test`, m)
          else if (s.startsWith('test:') || s === 'e2e' || s.startsWith('e2e:')) addTest(`${pm} run ${s}`, m)
          else if (['lint', 'typecheck', 'type-check', 'tsc', 'format:check', 'fmt:check', 'check'].includes(s) || s.startsWith('lint:')) addLint(`${pm} run ${s}`, m)
        }
        break
      }
      case 'pyproject.toml':
      case 'setup.cfg':
      case 'tox.ini':
        if (/^\[tool\.pytest|^\[tool:pytest\]|^\[pytest\]/m.test(text)) addTest('pytest', m)
        if (/^\[tool\.ruff/m.test(text)) addLint('ruff check', m)
        if (/^\[tool\.mypy\]|^\[mypy\]/m.test(text)) addLint('mypy', m)
        if (f === 'tox.ini') addTest('tox', m)
        break
      case 'Cargo.toml':
        addTest('cargo test', m)
        addLint('cargo clippy', m)
        break
      case 'go.mod':
        addTest('go test ./...', m)
        addLint('go vet ./...', m)
        break
      case 'Gemfile':
        if (text.includes('rspec')) addTest('bundle exec rspec', m)
        if (text.includes('rubocop')) addLint('bundle exec rubocop', m)
        break
      case 'pom.xml':
        addTest('mvn test', m)
        break
      case 'build.gradle':
      case 'build.gradle.kts':
        addTest('gradle test', m)
        break
      case 'justfile':
      case 'Justfile':
        for (const t of unique(sorted(text.split('\n').flatMap((l) => /^([A-Za-z0-9_-]+)[^:=]*:([^=]|$)/.exec(l)?.[1] ?? [])))) {
          if (t === 'test' || t === 'tests') addTest(`just ${t}`, m)
          else if (t === 'lint' || t === 'fmt' || t === 'check') addLint(`just ${t}`, m)
        }
        break
    }
  }
  for (const cfg of all.filter((p) => /^(pytest\.ini|\.?ruff\.toml|\.pre-commit-config\.yaml|\.golangci\.ya?ml|\.shellcheckrc|\.rubocop\.yml|eslint\.config\.[a-z]+|\.eslintrc(\.[a-z]+)?)$/.test(p))) {
    if (cfg === 'pytest.ini') addTest('pytest', cfg)
    else if (cfg === 'ruff.toml' || cfg === '.ruff.toml') addLint('ruff check', cfg)
    else if (cfg === '.pre-commit-config.yaml') addLint('pre-commit run --all-files', cfg)
    else if (cfg === '.golangci.yml' || cfg === '.golangci.yaml') addLint('golangci-lint run', cfg)
    else if (cfg === '.shellcheckrc') addLint('shellcheck', cfg)
    else if (cfg === '.rubocop.yml') addLint('rubocop', cfg)
    else addLint('eslint', cfg)
  }
  kv('gate', gate || 'none (no check target in a Makefile)')
  kv('test', joined(unique(tests)))
  kv('lint', joined(unique(lints)))

  // CI: jobs of each GitHub Actions workflow (id, and the name GitHub shows as the check when it differs), plus
  // the configuration files of other CI systems.
  const ci: string[] = []
  let hasCheck = false
  for (const w of all.filter((p) => /^\.github\/workflows\/[^/]+\.ya?ml$/.test(p))) {
    if (!fileAt(w)) continue
    const jobs = workflowJobs(readFileSync(join(at, w), 'utf8'))
    ci.push(`${w}: ${jobs || 'no jobs found'}`)
    if (isCheckJob(jobs)) hasCheck = true
  }
  for (const o of all.filter((p) => /^(\.gitlab-ci\.yml|\.circleci\/config\.yml|Jenkinsfile|azure-pipelines\.yml|\.travis\.yml|bitbucket-pipelines\.yml|\.buildkite\/pipeline\.yml)$/.test(p))) {
    ci.push(`${o}: not GitHub Actions`)
  }
  if (ci.length > 0) say(c, 'ci:', ...ci.map((l) => `  ${l}`))
  else kv('ci', 'none')
  kv('ci-check-job', hasCheck ? 'yes' : 'no')

  // Agent configuration: every location Claude Code reads plus those of other agent tools, ignored files
  // included, one line per location with its file count, git status and whether the standard defines it.
  // Symlinks count too: CLAUDE.md -> AGENTS.md is common, and a linked skill directory is configuration all the same.
  const agent = walk(at)
    .flatMap((p) => {
      const l = agentLocation(p)
      return l ? [[l[0], l[1], p].join('\t')] : []
    })
    .sort(byteOrder)
  if (agent.length === 0) kv('agent-config', 'none')
  else {
    const paths = agent.map((l) => l.split('\t')[2] ?? '')
    const known = new Set(tracked)
    // Through stdin: the paths of a large tree exceed the argument limit.
    const ignored = new Set(lines((await tryGitInput(c, at, ['check-ignore', '--stdin'], paths.join('\n') + '\n')).stdout))
    const order: string[] = []
    const files = new Map<string, number>()
    const std = new Map<string, string>()
    const sts = new Map<string, string[]>()
    for (const l of agent) {
      const [loc = '', s = '', p = ''] = l.split('\t')
      const st = known.has(p) ? 'tracked' : ignored.has(p) ? 'ignored' : 'untracked'
      if (!files.has(loc)) order.push(loc)
      files.set(loc, (files.get(loc) ?? 0) + 1)
      std.set(loc, s)
      const seen = sts.get(loc) ?? []
      if (!seen.includes(st)) seen.push(st)
      sts.set(loc, seen)
    }
    say(c, 'agent-config:')
    for (const p of order) {
      const n = files.get(p) ?? 0
      say(c, `  ${p}: ${n} file${n === 1 ? '' : 's'}, ${(sts.get(p) ?? []).join('+')}, ${std.get(p)}`)
    }
  }

  // Baseline files of the standard (docs/repo-standard.md), present or missing. Alternative names count.
  const present: string[] = []
  const missing: string[] = []
  const base = (label: string, ...names: string[]) => {
    for (const n of names) {
      if (isDir(join(at, dirname(n))) && has(join(at, dirname(n)), basename(n))) {
        present.push(n)
        return
      }
    }
    missing.push(label)
  }
  base('README.md', ...readmeNames)
  base('AGENTS.md', 'AGENTS.md')
  base('CLAUDE.md', 'CLAUDE.md')
  base('Makefile', 'Makefile', 'GNUmakefile', 'makefile')
  base('docs/architecture.md', 'docs/architecture.md')
  base('docs/adr/README.md', 'docs/adr/README.md')
  base('docs/glossary.md', 'docs/glossary.md')
  base('.github/PULL_REQUEST_TEMPLATE.md', '.github/PULL_REQUEST_TEMPLATE.md', '.github/pull_request_template.md')
  base('.github/dependabot.yml', '.github/dependabot.yml', '.github/dependabot.yaml')
  base('.claude/settings.json', '.claude/settings.json')
  if (visibility === 'public') {
    base('LICENSE', ...licenseNames)
    base('SECURITY.md', 'SECURITY.md', '.github/SECURITY.md')
  }
  kv('baseline-present', joined(present))
  kv('baseline-missing', joined(missing))

  // The writing rules, counted by writing.sh as check.sh counts them, so the docs auditor proposes the rewrite
  // from the findings instead of counting words itself. The first 20 are listed; a rewrite issue needs no more.
  const w = await plugin(c, 'writing.sh', ['.'], at, { input: all.join('\n') + '\n' })
  if (w.code !== 0) {
    say(c, ...lines(w.stderr))
    throw new Stop('cannot count the writing rules; fix the error above')
  }
  const writing = lines(w.stdout).map((l) => (l.includes('\t') ? l.slice(l.indexOf('\t') + 1) : l))
  if (writing.length === 0) kv('writing-findings', 'none')
  else {
    say(c, 'writing-findings:', ...writing.slice(0, 20).map((l) => `  ${l}`))
    if (writing.length > 20) say(c, `  (+${writing.length - 20} more)`)
  }

  // File statistics over the tracked and untracked files: count, size, top directories, the largest files.
  const sizes: [number, string][] = []
  for (const p of all) {
    try {
      if (statSync(join(at, p)).isFile()) sizes.push([lstatSync(join(at, p)).size, p])
    } catch {
      // gone from the working tree
    }
  }
  kv('files', `${tracked.length} tracked, ${untracked.length} untracked, ${human(sizes.reduce((s, [b]) => s + b, 0))}`)
  const top = new Map<string, number>()
  for (const p of all) if (p.includes('/')) top.set(p.split('/')[0] ?? '', (top.get(p.split('/')[0] ?? '') ?? 0) + 1)
  kv(
    'top-dirs',
    joined(
      [...top]
        .sort((a, b) => b[1] - a[1] || byteOrder(a[0], b[0]))
        .slice(0, 8)
        .map(([d, n]) => `${d}/ ${n}`),
    ),
  )
  kv(
    'largest',
    joined(
      [...sizes]
        .sort((a, b) => b[0] - a[0] || byteOrder(a[1], b[1]))
        .slice(0, 5)
        .map(([s, p]) => `${p} (${human(s)})`),
    ),
  )
}

// tryGitInput runs git with input on its stdin and answers how it ended.
const tryGitInput = (c: Ctx, dir: string, args: string[], input: string) => attempt('git', ['-c', 'core.quotePath=false', ...args], c.env, dir, { signal: c.signal, timeout: scriptTimeout, input })
