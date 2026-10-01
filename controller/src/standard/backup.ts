// The first step of the apply: secure the state before anything changes (ADR 0010).
// 0. An empty repository (no branch on origin, no commit in the checkout) gets an empty first commit on the
//    default branch, so the cleanup pull request has a base; the checkout itself stays without a commit.
// 1. Tag pre-standard on the head of the default branch on GitHub and push it. An existing tag, on GitHub or
//    local, is kept and never moved.
// 2. Protect it with the tag ruleset of the standard (the one the workspace step sets), unless one exists.
// 3. Open the catalogue issue (label skill-candidate) with one row per skill the approved deletions remove:
//    name, description, origin, files and size, restore command. A second run updates the same issue.
// Needs every category of the last report answered. Changes nothing in the working tree.
import { basename, dirname } from 'node:path'
import { pages } from '../board.js'
import {
  approvedFindings,
  catalogueIssue,
  catalogueTitle,
  type Ctx,
  decisions,
  ensureLabel,
  gh,
  git,
  githubRepo,
  last,
  lines,
  remoteRef,
  say,
  Stop,
  tag,
  tagRuleset,
  tryGit,
} from './lib.js'

// must runs a git command and fails with the reason and git's last line when it fails.
async function must(c: Ctx, args: string[], why: string, input?: string): Promise<string> {
  try {
    return await git(c, args, c.root, input)
  } catch (err) {
    throw new Stop(why.replace('%s', last((err as Error).message)))
  }
}

const human = (b: number) => (b >= 1048576 ? `${(b / 1048576).toFixed(1)} MB` : b >= 1024 ? `${(b / 1024).toFixed(1)} KB` : `${b} B`)

// cell is a value as one cell of a Markdown table: one line, no pipe, at most 200 characters.
const cell = (s: string) =>
  s
    .replace(/[\n|]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^ | $/g, '')
    .slice(0, 200)

// front is the value of a key of the YAML frontmatter of a file, a folded block joined into one line.
export function front(key: string, text: string): string {
  let v = ''
  let block = false
  const rows = text.split('\n')
  if (text.endsWith('\n')) rows.pop()
  for (const [i, line] of rows.entries()) {
    if (i === 0 && line !== '---') break
    if (i > 0 && line === '---') break
    if (block) {
      if (/^\s/.test(line)) {
        v = v + (v === '' ? '' : ' ') + line.trim()
        continue
      }
      break
    }
    if (i > 0 && line.startsWith(`${key}:`)) {
      v = line.slice(key.length + 1).trim()
      if (/^[>|][-+]?$/.test(v)) {
        v = ''
        block = true
        continue
      }
      v = v.replace(/^["']|["']$/g, '')
      break
    }
  }
  return v
}

// The value of a jq alternative: null and false count as missing.
const some = (v: unknown) => (v === null || v === undefined || v === false ? undefined : v)

// source is the origin a skills lock file records for a skill, by its name or its directory.
function source(lock: string, name: string, dir: string): string {
  try {
    const parsed = JSON.parse(lock) as unknown
    const skills = some((parsed as Record<string, unknown> | null)?.skills) ?? parsed
    if (typeof skills !== 'object' || skills === null || Array.isArray(skills)) return ''
    const entry = some((skills as Record<string, unknown>)[name]) ?? some((skills as Record<string, unknown>)[dir])
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return ''
    const e = entry as Record<string, unknown>
    const s = some(e.source) ?? some(e.sourceUrl) ?? some(e.url)
    return s === undefined ? '' : typeof s === 'string' ? s : JSON.stringify(s)
  } catch {
    return ''
  }
}

export async function backup(c: Ctx) {
  const { findings, answers } = await decisions(c)
  const { nwo, defaultBranch } = await githubRepo(c)
  const show = async (spec: string) => {
    const r = await tryGit(c, ['show', spec])
    return r.code === 0 ? r.stdout : ''
  }

  // 0. The first commit of an empty repository. Local commits that were never pushed are not replaced: the
  //    maintainer pushes them, and they are backed up like any other state.
  const heads = await must(c, ['ls-remote', '--heads', 'origin'], 'cannot reach origin: %s')
  if (heads === '' && (await tryGit(c, ['rev-parse', '-q', '--verify', 'HEAD'])).code !== 0) {
    const tree = await git(c, ['hash-object', '-w', '-t', 'tree', '--stdin'], c.root, '')
    const first = await must(c, ['commit-tree', tree, '-m', 'chore: start the repository'], 'cannot create the first commit: %s', '')
    await must(c, ['push', '-q', 'origin', `${first}:refs/heads/${defaultBranch}`], `cannot push the first commit to ${defaultBranch}: %s`)
    say(c, `root: ${await git(c, ['rev-parse', '--short', first])} pushed as the first commit of ${defaultBranch} (the repository was empty)`)
  }

  // 1. The tag.
  const remote = await remoteRef(c, `refs/tags/${tag}`)
  if (remote !== '') {
    const local = await tryGit(c, ['rev-parse', '-q', '--verify', `refs/tags/${tag}^{commit}`])
    if (local.code === 0) {
      await must(c, ['fetch', '-q', 'origin', `refs/tags/${tag}`], `cannot fetch the tag ${tag} from origin: %s`)
      if (local.stdout.trim() !== (await git(c, ['rev-parse', 'FETCH_HEAD^{commit}'])))
        throw new Stop(`the local tag ${tag} differs from the one on origin; the one on origin is the backup, so delete the local one (git tag -d ${tag}) and run backup.sh again`)
    } else await must(c, ['fetch', '-q', 'origin', `refs/tags/${tag}:refs/tags/${tag}`], `cannot fetch the tag ${tag}: %s`)
    say(c, `tag: ${tag} kept at ${await git(c, ['rev-parse', '--short', `${tag}^{commit}`])} (pushed before)`)
  } else {
    await must(c, ['fetch', '-q', 'origin', `refs/heads/${defaultBranch}`], `origin has no branch ${defaultBranch}: %s; push a first commit (git push -u origin HEAD), then run backup.sh again`)
    let how: string
    if ((await tryGit(c, ['rev-parse', '-q', '--verify', `refs/tags/${tag}`])).code === 0) {
      // A local tag from a run that stopped before the push; it only backs up what the default branch has.
      if ((await tryGit(c, ['merge-base', '--is-ancestor', `${tag}^{commit}`, 'FETCH_HEAD'])).code !== 0)
        throw new Stop(`the local tag ${tag} is not on ${defaultBranch}, so it backs up something else; delete it (git tag -d ${tag}) and run backup.sh again`)
      how = 'kept at the local tag'
    } else {
      await git(c, ['tag', tag, 'FETCH_HEAD'])
      how = `the head of ${defaultBranch}`
    }
    await must(c, ['push', '-q', 'origin', `refs/tags/${tag}`], `cannot push the tag ${tag}: %s`)
    say(c, `tag: ${tag} pushed at ${await git(c, ['rev-parse', '--short', `${tag}^{commit}`])} (${how})`)
  }

  // 2. The protection. Without it the tag still exists; the reason becomes a manual step.
  const want = tagRuleset()
  const rulesets = await gh(c, ['api', '--paginate', `repos/${nwo}/rulesets?includes_parents=false&per_page=100`])
  if (rulesets.code !== 0) say(c, `manual: protect the tag ${tag}: rulesets cannot be read (${last(rulesets.stderr)}); workspace.sh --apply creates it later`)
  else if (pages<{ name: string }>(rulesets.stdout).some((r) => r.name === want.name)) say(c, `protection: ruleset ${want.name} kept`)
  else {
    const made = await gh(c, ['api', '--method', 'POST', `repos/${nwo}/rulesets`, '--input', '-'], want)
    if (made.code === 0) say(c, `protection: ruleset ${want.name} created (no deletion, no moving)`)
    else say(c, `manual: protect the tag ${tag}: creating the ruleset failed (${last(made.stderr)}); workspace.sh --apply creates it later`)
  }

  // 3. The catalogue. A skill is a directory with a SKILL.md, or a command file (commands are skills too); rows
  // come from the tag, so they describe exactly what the restore command brings back.
  // A target the default branch has in another state than the tag is skipped, as the cleanup skips it; one the
  // default branch no longer has was removed by an earlier run and stays listed.
  await must(c, ['fetch', '-q', 'origin', `refs/heads/${defaultBranch}`], `cannot fetch ${defaultBranch} from origin: %s`)
  const tip = await git(c, ['rev-parse', 'FETCH_HEAD'])
  const locks = lines(await git(c, ['ls-tree', '-r', '--name-only', tag])).filter((l) => /(^|\/)\.?skills?-lock\.json$/.test(l))
  const rows: string[] = []
  const seen = new Set<string>()
  for (const f of approvedFindings(findings, answers, 'delete')) {
    if (f.target === '') continue
    const now = await git(c, ['ls-tree', '-r', tip, '--', `:(literal)${f.target}`])
    if (now !== '' && now !== (await git(c, ['ls-tree', '-r', tag, '--', `:(literal)${f.target}`]))) continue
    for (const file of lines(await git(c, ['ls-tree', '-r', '--name-only', tag, '--', `:(literal)${f.target}`]))) {
      let path: string
      if (file === 'SKILL.md' || file.endsWith('/SKILL.md')) path = dirname(file)
      else if (/^(.*\/)?commands\/.*\.md$/.test(file)) path = file
      else continue
      if (seen.has(path)) continue
      seen.add(path)
      const fallback = basename(path).replace(/\.md$/, '')
      const md = await show(`${tag}:${file}`)
      const nm = front('name', md) || fallback
      const desc = front('description', md)
      let origin = ''
      for (const l of locks) {
        const src = source(await show(`${tag}:${l}`), nm, fallback)
        if (src !== '') {
          origin = `upstream: ${src} (from ${l})`
          break
        }
      }
      if (origin === '' && path !== file) {
        const lic = lines(await git(c, ['ls-tree', '--name-only', tag, '--', `${path}/`]))
          .map((p) => p.split('/').at(-1) ?? '')
          .find((n) => /^(LICEN[CS]E|COPYING)/.test(n.toUpperCase()))
        if (lic) origin = `upstream (carries ${lic})`
      }
      if (origin === '') origin = `audit: ${f.reason}`
      const listed = lines(await git(c, ['ls-tree', '-r', '-l', tag, '--', path]))
      const size = listed.reduce((s, l) => s + (Number(l.split(/\s+/)[3]) || 0), 0)
      const n = listed.length
      rows.push(`| ${cell(nm)} | ${cell(desc || 'none')} | ${cell(origin)} | ${n}${n === 1 ? ' file' : ' files'}, ${human(size)} | \`git checkout ${tag} -- ${path}\` |\n`)
    }
  }
  const body =
    `The standardisation run (the standardize process of the controller) removes these skills from \`${defaultBranch}\`; they may move into a plugin marketplace later. The tag \`${tag}\` keeps the state before the run: fetch it with \`git fetch origin tag ${tag}\`, then run a restore command in a checkout.\n\n` +
    (rows.length === 0 ? 'No skills are removed.\n' : `| Skill | Description | Origin | Files | Restore |\n| --- | --- | --- | --- | --- |\n${rows.join('')}`) +
    '\nWhen the run configures the GitHub workspace, it adds the previous settings as a comment here.\n'

  const repo = { nwo, defaultBranch }
  await ensureLabel(c, repo, 'skill-candidate')
  let issue = await catalogueIssue(c, repo)
  let how: string
  if (issue === undefined) {
    const r = await gh(c, ['api', '--method', 'POST', `repos/${nwo}/issues`, '--input', '-'], { title: catalogueTitle, body, labels: ['skill-candidate'] })
    if (r.code !== 0) throw new Stop(`cannot open the catalogue issue: ${last(r.stderr)}`)
    issue = (JSON.parse(r.stdout) as { number: number }).number
    how = 'opened'
  } else {
    const r = await gh(c, ['api', `repos/${nwo}/issues/${issue}`])
    if (r.code !== 0) throw new Stop(`cannot read the catalogue issue #${issue}: ${last(r.stderr)}`)
    const current = (JSON.parse(r.stdout) as { body?: string | null }).body ?? ''
    if (current.replace(/\n+$/, '') === body.replace(/\n+$/, '')) how = 'unchanged'
    else {
      const p = await gh(c, ['api', '--method', 'PATCH', `repos/${nwo}/issues/${issue}`, '--input', '-'], { body })
      if (p.code !== 0) throw new Stop(`cannot update the catalogue issue #${issue}: ${last(p.stderr)}`)
      how = 'updated'
    }
  }
  say(c, `catalogue: #${issue} ${how}, ${rows.length} skill${rows.length === 1 ? '' : 's'}`, 'next: cleanup.sh prepare')
}
