// The repository's own release tooling: scripts/release.sh, which tags a release of the factory or the
// controller, scripts/factory-binaries.sh, which builds what a factory host downloads, and the workflows a release
// tag starts.
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest'
import { hostEnv, isolation, type Result, result, root } from './sandbox.js'

const workflows = join(root, '.github', 'workflows')
const FACTORY_WORKFLOW = join(workflows, 'factory-release.yml')
const CONTROLLER_WORKFLOW = join(workflows, 'controller-release.yml')

const made: string[] = []
afterAll(() => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true })
})
function temp(prefix: string): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), prefix)))
  made.push(d)
  return d
}

// fnmatch matches a name against a shell pattern, as Python's fnmatch does: * and ? cross a slash.
function fnmatch(name: string, pattern: string): boolean {
  let re = ''
  for (const c of pattern) re += c === '*' ? '.*' : c === '?' ? '.' : c.replace(/[.+^${}()|\\/]/g, '\\$&')
  return new RegExp(`^${re}$`).test(name)
}

interface Unit {
  name: string
  workflow: string
  // version writes the version where the unit's release reads it.
  version: (repo: string, said: string) => void
}

const units: Unit[] = [
  { name: 'factory', workflow: FACTORY_WORKFLOW, version: (repo, said) => writeFileSync(join(repo, 'factory', 'VERSION'), `${said}\n`) },
  {
    name: 'controller',
    workflow: CONTROLLER_WORKFLOW,
    version: (repo, said) => writeFileSync(join(repo, 'controller', 'package.json'), JSON.stringify({ name: 'ameise', version: said }, null, 2) + '\n'),
  },
]

// `scripts/release.sh <unit>`: it tags the version of the unit's version file, and refuses everything that would
// tag something else. The real script runs in a repository of its own, because a release tags the checkout it
// stands in; a bare repository beside it is the origin it asks what main points at and which tags are taken.
describe.each(units)('release.sh $name', (unit) => {
  const U = unit.name
  let repo: string
  // A release runs outside make, so a make that runs the suite must not make it a sub-make of its own.
  const env = () => ({ ...hostEnv(), ...isolation })
  const git = (...args: string[]) => {
    const r = spawnSync('git', args, { cwd: repo, env: env(), encoding: 'utf8' })
    if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`)
    return r.stdout
  }
  const version = (said: string) => unit.version(repo, said)
  // gate writes a make check that says it ran, and passes or fails as asked.
  const gate = (green: boolean) =>
    writeFileSync(join(repo, 'Makefile'), `check:\n\t@${green ? 'echo "the gate ran"' : '(echo "the gate ran"; echo "make: FAIL" >&2; exit 2)'}\n`)
  // commit makes a commit a release can be tagged from, one that is on origin/main too unless push is false.
  const commit = (push = true) => {
    git('add', '-A')
    git('commit', '-qm', 'release fixture')
    if (push) git('push', '-q', 'origin', 'main')
  }
  const release = (...args: string[]): Result => result(spawnSync('bash', ['scripts/release.sh', ...args], { cwd: repo, env: env(), encoding: 'utf8' }))
  const tags = () => git('tag').split(/\s+/).filter(Boolean)
  // originTags are the tags origin carries; an annotated tag is listed twice, the second time dereferenced.
  const originTags = () =>
    git('ls-remote', '--tags', 'origin')
      .split('\n')
      .filter(Boolean)
      .map((l) => l.split('refs/tags/')[1]!)
      .filter((t) => !t.endsWith('^{}'))

  beforeEach(() => {
    const base = temp('ameise-release-')
    repo = join(base, 'repo')
    for (const d of ['scripts', 'factory', 'controller']) mkdirSync(join(repo, d), { recursive: true })
    copyFileSync(join(root, 'scripts', 'release.sh'), join(repo, 'scripts', 'release.sh'))
    version('0.1.0')
    gate(true)
    git('init', '-q', '-b', 'main')
    git('config', 'user.email', 't@example.com')
    git('config', 'user.name', 't')
    const origin = join(base, 'origin.git')
    git('init', '-q', '--bare', '-b', 'main', origin)
    git('remote', 'add', 'origin', origin)
    commit()
  })

  test('tags the unit from its version file after the gate', () => {
    const r = release(U)
    expect(r.code, r.stderr).toBe(0)
    expect(r.stdout).toContain('the gate ran')
    expect(tags()).toEqual([`${U}/v0.1.0`])
    // Annotated, and it says what it is.
    expect(git('tag', '-l', '-n1', `${U}/v0.1.0`)).toContain(`${U} v0.1.0`)
    // It names the commit that was reviewed, which is the whole of what stands behind a release.
    expect(git('rev-parse', `${U}/v0.1.0^{}`)).toBe(git('rev-parse', 'HEAD'))
    // Nothing pushed without --push, and the command that would is printed.
    expect(originTags()).toEqual([])
    expect(r.stdout).toContain(`git push origin ${U}/v0.1.0`)
  })

  // `release.sh <unit> --push` is the command the agent instructions name, and the tag on origin is the whole
  // trigger: nothing else makes CI build the release.
  test('puts the tag on origin with --push', () => {
    const r = release(U, '--push')
    expect(r.code, r.stderr).toBe(0)
    expect(originTags()).toEqual([`${U}/v0.1.0`])
  })

  // The namespace is what keeps the three kinds of tag apart, so it is read from a release of 1.2.3, a version
  // that would read as a milestone on its own.
  test('tags neither a plugin tag nor a milestone tag', () => {
    version('1.2.3')
    commit()
    expect(release(U).code).toBe(0)
    expect(tags()).toEqual([`${U}/v1.2.3`])
  })

  // Where a run without --push ends. Running it again must not say to bump the version: the tag already carries
  // this one, and the release is a push away.
  test('names a tag that is here and not on origin a release one push away', () => {
    expect(release(U).code).toBe(0)
    const r = release(U)
    expect(r.code).not.toBe(0)
    expect(r.stderr).toContain(`error: the tag ${U}/v0.1.0 exists here and not on origin; push it with: git push origin ${U}/v0.1.0`)
    expect(tags()).toEqual([`${U}/v0.1.0`])
  })

  // A checkout that has not fetched for a while knows nothing of a tag another release made: without asking
  // origin it would run the whole gate and only then fail on the push.
  test('refuses a tag that exists on origin before the gate runs', () => {
    git('tag', `${U}/v0.1.0`)
    git('push', '-q', 'origin', `${U}/v0.1.0`)
    git('tag', '-d', `${U}/v0.1.0`)
    const r = release(U)
    expect(r.code).not.toBe(0)
    expect(r.stderr).toContain(`error: the tag ${U}/v0.1.0 exists on origin`)
    expect(r.stdout).not.toContain('the gate ran')
    expect(tags()).toEqual([])
  })

  // A release is built from the tag and never gated again, so what stands behind it is that its commit went
  // through a pull request onto main (docs/repo-standard.md).
  test('refuses a commit that is not what origin/main points at', () => {
    version('0.2.0')
    commit(false)
    const r = release(U)
    expect(r.code).not.toBe(0)
    expect(r.stderr).toContain(`error: HEAD is ${git('rev-parse', 'HEAD').trim()} and origin/main is`)
    expect(r.stderr).toContain('releases are tagged on main')
    expect(r.stdout).not.toContain('the gate ran')
    expect(tags()).toEqual([])
  })

  test('tags nothing when the gate fails', () => {
    gate(false)
    commit()
    const r = release(U)
    expect(r.code).not.toBe(0)
    expect(r.stderr).toContain('error: the gate failed')
    expect(tags()).toEqual([])
  })

  test('refuses uncommitted changes', () => {
    writeFileSync(join(repo, 'factory', 'run.go'), '// not committed\n')
    const r = release(U)
    expect(r.code).not.toBe(0)
    expect(r.stderr).toContain('error: the working tree has uncommitted changes')
    expect(tags()).toEqual([])
  })

  test.each(['0.1', 'v0.1.0', '0.1.0-rc1', ''])('refuses the version %j, which is not X.Y.Z', (said) => {
    version(said)
    commit()
    const r = release(U)
    expect(r.code).not.toBe(0)
    expect(r.stderr).toContain('write the version as X.Y.Z')
    expect(tags()).toEqual([])
  })

  // factory/version.go trims the ends of VERSION and nothing else, so `0. 1.0` is the version the binary reports.
  // A release that quietly tagged v0.1.0 for it would name a version nothing ever says.
  test.each(['0. 1.0', '0.1\n.0', '0.1.0 '])('refuses the version %j, which has whitespace inside it', (said) => {
    version(said)
    commit()
    const r = release(U)
    expect(r.code).not.toBe(0)
    expect(r.stderr).toContain('write the version as X.Y.Z on one line')
    expect(tags()).toEqual([])
  })

  // CI asks whether the tagged commit is on main, not whether it is its tip, so a tag left over from an earlier
  // attempt would release an older commit under this version. It is refused here, where the tag can still go.
  test('does not take a local tag on an older commit for a release to push', () => {
    const old = git('rev-parse', 'HEAD').trim()
    git('tag', '-a', `${U}/v0.1.0`, '-m', `${U} v0.1.0`)
    writeFileSync(join(repo, 'factory', 'run.go'), '// a commit the tag does not carry\n')
    commit()
    const r = release(U)
    expect(r.code).not.toBe(0)
    expect(r.stderr).toContain(`error: the tag ${U}/v0.1.0 exists here and names ${old}`)
    expect(r.stderr).toContain(`git tag -d ${U}/v0.1.0`)
    expect(r.stderr).not.toContain(`git push origin ${U}/v0.1.0`)
    expect(r.stdout).not.toContain('the gate ran')
    expect(originTags()).toEqual([])
  })

  test('refuses an unknown option', () => {
    const r = release(U, '--force')
    expect(r.code).not.toBe(0)
    expect(r.stderr).toContain('error: unknown option --force')
    expect(tags()).toEqual([])
  })

  // The script and the workflow are two files; a tag only one of them knows is a release that never builds.
  test('creates the tag CI builds the release for', () => {
    expect(release(U).code).toBe(0)
    const trigger = /tags: \['([^']+)'\]/.exec(readFileSync(unit.workflow, 'utf8'))
    expect(trigger, 'the workflow names no tag pattern').not.toBeNull()
    expect(fnmatch(tags()[0]!, trigger![1]!), `${tags()[0]} does not match ${trigger![1]}`).toBe(true)
  })

  if (U === 'controller') {
    test('refuses a package.json that is no JSON', () => {
      writeFileSync(join(repo, 'controller', 'package.json'), '{ not json\n')
      commit()
      const r = release(U)
      expect(r.code).not.toBe(0)
      expect(r.stderr).toContain('error: controller/package.json is no JSON npm can read')
      expect(tags()).toEqual([])
    })

    test('refuses a version that is no string', () => {
      writeFileSync(join(repo, 'controller', 'package.json'), '{"version": [0, 1, 0]}\n')
      commit()
      const r = release(U)
      expect(r.code).not.toBe(0)
      expect(r.stderr).toContain('error: controller/package.json says ""; write the version as X.Y.Z')
      expect(tags()).toEqual([])
    })
  }
})

// elf reads what `file` would say of a binary: its class, its machine and whether it asks for an interpreter or
// a dynamic section, which a static binary does not.
function elf(path: string): { is64: boolean; machine: number; static: boolean } {
  const b = readFileSync(path)
  expect(b.subarray(0, 4).toString('latin1'), `${path} is no ELF file`).toBe('\x7fELF')
  expect(b[5], `${path} is not little-endian`).toBe(1)
  const phoff = Number(b.readBigUInt64LE(32))
  const phentsize = b.readUInt16LE(54)
  const phnum = b.readUInt16LE(56)
  let dynamic = false
  for (let i = 0; i < phnum; i++) {
    const type = b.readUInt32LE(phoff + i * phentsize)
    if (type === 2 || type === 3) dynamic = true // PT_DYNAMIC, PT_INTERP
  }
  return { is64: b[4] === 2, machine: b.readUInt16LE(18), static: !dynamic }
}

// `scripts/factory-binaries.sh`: what a factory host downloads. The flags that build a released binary are written
// there and nowhere else, so the test runs it and reads what came out. It embeds the dashboard, which make builds
// before the controller's tests run.
describe('factory-binaries.sh', () => {
  let out: string
  let built: Result
  beforeAll(() => {
    out = temp('ameise-binaries-')
    built = result(spawnSync('bash', ['scripts/factory-binaries.sh', out], { cwd: root, env: hostEnv(), encoding: 'utf8' }))
  }, 600000)

  // No cgo, so the host it lands on needs no libc of the right version.
  test.each([
    ['amd64', 62],
    ['arm64', 183],
  ])('builds one static 64-bit linux binary for %s', (arch, machine) => {
    expect(built.code, built.stderr).toBe(0)
    expect(elf(join(out, `factory-linux-${arch}`))).toEqual({ is64: true, machine, static: true })
  })

  // What a host verifies its download against. A checksum file that names something else, or that is written
  // before the build, is worth nothing.
  test('writes the checksums of those binaries', () => {
    expect(built.code, built.stderr).toBe(0)
    const said: Record<string, string> = {}
    for (const line of readFileSync(join(out, 'checksums.txt'), 'utf8').split('\n').filter(Boolean)) {
      const [digest, name] = line.split(/\s+/)
      said[name!.replace(/^\*/, '')] = digest!
    }
    expect(Object.keys(said).sort()).toEqual(['factory-linux-amd64', 'factory-linux-arm64'])
    for (const [name, digest] of Object.entries(said)) expect(createHash('sha256').update(readFileSync(join(out, name))).digest('hex'), name).toBe(digest)
  })

  // The embed pattern matches the committed placeholder, so a build without the dashboard in front of it comes
  // out as a binary that answers 404 under /. The script says what to run instead of writing that file. The
  // fixture is the script alone in an empty tree, which is what a checkout whose dashboard was never built looks
  // like to it.
  test('refuses to build binaries that have no dashboard in them', () => {
    const tree = temp('ameise-binaries-')
    mkdirSync(join(tree, 'scripts'))
    copyFileSync(join(root, 'scripts', 'factory-binaries.sh'), join(tree, 'scripts', 'factory-binaries.sh'))
    const dist = join(tree, 'dist')
    const r = spawnSync('bash', ['scripts/factory-binaries.sh', dist], { cwd: tree, env: hostEnv(), encoding: 'utf8' })
    expect(r.status, 'it built binaries without a dashboard in them').not.toBe(0)
    expect(r.stderr).toContain('error:')
    expect(r.stderr).toContain('make binaries')
    expect(existsSync(dist), 'it wrote an output directory before it refused').toBe(false)
  })
})

// stepScript is the shell of the step called name, as the runner hands it to bash: the block under its `run: |`,
// without the indentation the YAML carries.
function stepScript(workflow: string, name: string): string {
  const lines = readFileSync(workflow, 'utf8').split('\n')
  const start = lines.findIndex((l) => l.trim() === `- name: ${name}`)
  expect(start, `no step ${name} in ${workflow}`).toBeGreaterThan(-1)
  let run = start + 1
  while (run < lines.length && lines[run]!.trim() !== 'run: |') run++
  const indent = lines[run]!.length - lines[run]!.trimStart().length + 2
  const script: string[] = []
  for (const line of lines.slice(run + 1)) {
    if (line.trim() && !line.startsWith(' '.repeat(indent))) break
    script.push(line.slice(indent))
  }
  return script.join('\n')
}

// The step that attaches a release's files to its GitHub release, run as GitHub runs it: `bash -e` with a gh on
// PATH. It is shell in a workflow file, so the test reads that shell out of the file and runs it; a step rewritten
// some other way stops being found and fails here. The gh says what the release already carries and writes down
// what it was asked to do; it answers `release view` as gh does, an unknown release with an error.
const GH = `#!/usr/bin/env bash
echo "$*" >> "$GH_LOG"
case "$1 $2" in
  'release view') [ -n "\${GH_ASSETS:-}" ] || { echo "release not found" >&2; exit 1; }; echo "$GH_ASSETS" ;;
  'release create') [ -z "\${GH_ASSETS:-}" ] || { echo "a release with that tag already exists" >&2; exit 1; } ;;
esac
`

describe.each([
  {
    name: 'factory',
    workflow: FACTORY_WORKFLOW,
    tag: 'factory/v0.1.0',
    title: 'ameise factory v0.1.0',
    bundle: 'dist/factory-v0.1.0.sigstore.json',
    assets: ['dist/factory-linux-amd64', 'dist/factory-linux-arm64', 'dist/checksums.txt', 'dist/factory-v0.1.0.sigstore.json'],
  },
  {
    // The controller's release: the package, its checksums and its attestation, on a release titled after its
    // version that is not the latest.
    name: 'controller',
    workflow: CONTROLLER_WORKFLOW,
    tag: 'controller/v0.1.0',
    title: 'ameise controller v0.1.0',
    bundle: 'dist/controller-v0.1.0.sigstore.json',
    assets: ['dist/ameise-0.1.0.tgz', 'dist/checksums.txt', 'dist/controller-v0.1.0.sigstore.json'],
  },
])('the publish step of the $name release', (p) => {
  let base: string
  let log: string
  beforeEach(() => {
    base = temp('ameise-publish-')
    mkdirSync(join(base, 'bin'))
    writeFileSync(join(base, 'bin', 'gh'), GH)
    chmodSync(join(base, 'bin', 'gh'), 0o755)
    log = join(base, 'gh.log')
  })
  afterEach(() => rmSync(log, { force: true }))

  const runStep = (assets?: number): Result => {
    const env: Record<string, string> = {
      PATH: `${join(base, 'bin')}:${process.env.PATH ?? ''}`,
      GH_LOG: log,
      GITHUB_REF_NAME: p.tag,
      GH_TOKEN: 'x',
      GH_REPO: 'o/r',
      BUNDLE: p.bundle,
    }
    if (assets !== undefined) env.GH_ASSETS = String(assets)
    return result(spawnSync('bash', ['-e', '-c', stepScript(p.workflow, 'Attach them to the release')], { cwd: base, env, encoding: 'utf8' }))
  }
  const asked = () => (existsSync(log) ? readFileSync(log, 'utf8') : '')

  test('creates a release that is not there yet with its files on it', () => {
    const r = runStep()
    expect(r.code, r.stderr).toBe(0)
    expect(asked()).toContain(`release create ${p.tag} --verify-tag --latest=false --title ${p.title}`)
    for (const asset of p.assets) expect(asked()).toContain(asset)
  })

  // Why --clobber is there: a run whose upload died halfway is re-run, and the files it did write are written
  // again over themselves.
  test('finishes a half-written release', () => {
    const r = runStep(1)
    expect(r.code, r.stderr).toBe(0)
    expect(asked()).toContain(`release upload --clobber ${p.tag}`)
  })

  // What a host downloaded under a version stays what it downloaded. A re-run of a finished release would replace
  // those files with others, so the job fails instead and a person decides.
  test('never overwrites a release that already carries its files', () => {
    const r = runStep(p.assets.length)
    expect(r.code, 'it overwrote a published release').not.toBe(0)
    expect(r.stderr).toContain('error:')
    expect(asked()).not.toContain('release create')
    expect(asked()).not.toContain('release upload')
  })
})

const workflowFiles = () =>
  readdirSync(workflows)
    .filter((f) => f.endsWith('.yml'))
    .sort()
    .map((f) => join(workflows, f))

// The controller's package is private until the product is complete: no workflow publishes it to npm or reads an
// npm token, and no document tells a maintainer to set one.
describe('no npm publish', () => {
  test.each(workflowFiles())('%s publishes nothing to npm and reads no npm token', (workflow) => {
    const text = readFileSync(workflow, 'utf8')
    expect(text).not.toMatch(/npm\s+publish/)
    for (const s of ['NPM_TOKEN', 'NODE_AUTH_TOKEN', 'registry-url']) expect(text).not.toContain(s)
  })

  test('no document names an npm token', () => {
    const docs = [join(root, 'README.md'), join(root, 'AGENTS.md')]
    for (const f of readdirSync(join(root, 'controller'))) if (f.endsWith('.md')) docs.push(join(root, 'controller', f))
    for (const f of readdirSync(join(root, 'docs'), { recursive: true }) as string[]) if (f.endsWith('.md')) docs.push(join(root, 'docs', f))
    for (const doc of docs) expect(readFileSync(doc, 'utf8'), doc).not.toContain('NPM_TOKEN')
  })
})

// The lines of a workflow's `on:` block: everything indented under it.
function onBlock(workflow: string): string[] {
  const said = readFileSync(workflow, 'utf8').split('\non:\n')
  if (said.length < 2) throw new Error(`${workflow} writes its triggers in a way this test cannot read`)
  const lines: string[] = []
  for (const line of said.slice(1).join('\non:\n').split('\n')) {
    if (line && !line.startsWith(' ')) break
    lines.push(line)
  }
  return lines
}

// The branch or tag patterns a push has to match to start the workflow.
function patterns(workflow: string, kind: string): string[] {
  const found: string[] = []
  let under: string | undefined
  for (const line of onBlock(workflow)) {
    if (/^ {2}\w+:$/.test(line)) under = line.trim()
    else if (under === 'push:' && line.trim().startsWith(`${kind}: [`)) found.push(...(line.split(':').slice(1).join(':').match(/[^\s,'"[\]]+/g) ?? []))
  }
  return found
}

// starts says whether pushing ref starts the workflow. fnmatch stands in for GitHub's ref filter, which differs in
// one place: there `*` stops at a slash and `**` crosses it. No pattern here relies on that.
function starts(workflow: string, ref: string): boolean {
  const [kind, name] = ref.startsWith('refs/heads/') ? ['branches', ref.slice('refs/heads/'.length)] : ['tags', ref.slice('refs/tags/'.length)]
  return patterns(workflow, kind).some((p) => fnmatch(name, p))
}

const stem = (workflow: string) => workflow.split('/').at(-1)!.replace(/\.yml$/, '')

// Which push starts which workflow. The binaries are built by a factory version tag and the package released by
// a controller version tag, by nothing else, and a milestone tag of the controller's release action still starts
// nothing at all.
describe('the workflow triggers', () => {
  test.each([
    ['refs/tags/factory/v0.1.0', ['factory-release']], // what scripts/release.sh factory creates
    ['refs/tags/controller/v0.1.0', ['controller-release']], // and scripts/release.sh controller
    ['refs/tags/v1.2.3', []], // a milestone the controller releases
    ['refs/tags/worker--v1.2.3', []], // a plugin release of `claude plugin tag`
    ['refs/heads/main', ['ci']],
    ['refs/heads/feat/61-something', []],
  ])('a push of %s starts %j and no other workflow', (ref, expected) => {
    expect(
      workflowFiles()
        .filter((w) => starts(w, ref))
        .map(stem),
    ).toEqual(expected)
  })

  // The triggers are read as written, in brackets. A workflow that names its patterns some other way would pass
  // the test above by matching nothing, so it fails here instead.
  test.each(workflowFiles())('the push trigger of %s is one this test can read', (workflow) => {
    if (!onBlock(workflow).includes('  push:')) return
    expect(patterns(workflow, 'branches').length + patterns(workflow, 'tags').length, 'the push trigger names no branch or tag pattern in brackets').toBeGreaterThan(0)
  })

  // A pull_request, schedule or workflow_dispatch trigger would build release binaries, or publish a package,
  // from something that is not a release.
  test.each([FACTORY_WORKFLOW, CONTROLLER_WORKFLOW])('%s is started by a push and by no other event', (workflow) => {
    expect(
      onBlock(workflow)
        .filter((l) => /^ {2}\w+:$/.test(l))
        .map((l) => l.trim().replace(/:$/, '')),
    ).toEqual(['push'])
  })
})
