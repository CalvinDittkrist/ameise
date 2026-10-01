// The cleanup pull request of the apply: the approved deletions and the missing baseline files on the branch
// chore/standardize, in a worktree inside the repository, so the checkout stays untouched.
// prepare  Needs the backup: the tag pre-standard on origin and the catalogue issue. Creates or resumes the
//          worktree, brings every path a rejected category or finding names back to the default branch (what an
//          earlier prepare applied under an answer since changed), removes the targets of approved delete
//          findings (tracked files only), runs scaffold.sh with --skip for each rejected category, and reports
//          `todo:` lines for what needs judgement: the approved replace and create findings and the <fill in>
//          placeholders.
// open     Refuses while a <fill in> placeholder is left on the branch. Commits the worktree, pushes the branch
//          without force and opens the pull request, or updates its description. Nothing to change: no PR.
import { appendFileSync, existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  answered,
  approvedFindings,
  branchPulls,
  catalogueIssue,
  categories,
  cleanupBranch,
  cleanupWorktree,
  type Ctx,
  decisions,
  ensureDir,
  gh,
  git,
  githubRepo,
  last,
  lines,
  plugin,
  type Repo,
  remoteRef,
  say,
  Stop,
  tag,
  tryGit,
  unique,
} from './lib.js'

// Where the cleanup runs: the worktree, the checkout it belongs to, and the git of each.
interface Place {
  repo: Repo
  wt: string
  root: string
  g: (args: string[]) => Promise<string>
}

async function place(c: Ctx): Promise<Place> {
  const repo = await githubRepo(c)
  const wt = await cleanupWorktree(c)
  return { repo, wt, root: dirname(dirname(dirname(wt))), g: (args) => git(c, ['-C', wt, '-c', 'core.quotePath=false', ...args]) }
}

// onBranch is whether the worktree is there and on the cleanup branch.
const onBranch = async (c: Ctx, wt: string) => {
  const r = await tryGit(c, ['-C', wt, 'rev-parse', '--abbrev-ref', 'HEAD'])
  return r.code === 0 && r.stdout.trim() === cleanupBranch
}

// fetch fetches a ref from origin, or fails with the reason and git's last line.
async function fetch(c: Ctx, ref: string, why: string) {
  await git(c, ['fetch', '-q', 'origin', ref]).catch((err: Error) => {
    throw new Stop(`${why}: ${last(err.message)}`)
  })
}

// base is the commit the branch forked from the default branch on origin, fresh, so the diff is what GitHub shows.
async function base(c: Ctx, p: Place): Promise<string> {
  await fetch(c, `refs/heads/${p.repo.defaultBranch}`, `cannot fetch ${p.repo.defaultBranch} from origin`)
  return git(c, ['merge-base', 'FETCH_HEAD', await p.g(['rev-parse', 'HEAD'])])
}

// placeholders is the files the branch adds or changes (staged) that still hold a <fill in> placeholder.
async function placeholders(p: Place, from: string): Promise<string[]> {
  return lines(await p.g(['diff', '--cached', '--name-only', '--diff-filter=AM', from])).filter((f) => {
    try {
      return statSync(join(p.wt, f)).isFile() && readFileSync(join(p.wt, f)).includes('<fill in>')
    } catch {
      return false
    }
  })
}

// scaffoldPaths is every file scaffold.sh may write, with its category.
async function scaffoldPaths(c: Ctx): Promise<[string, string][]> {
  const r = await plugin(c, 'scaffold.sh', ['--paths'])
  if (r.code !== 0) throw new Stop(`scaffold.sh --paths failed: ${last(r.stderr)}`)
  return lines(r.stdout).map((l) => {
    const [cat = '', path = ''] = l.split('\t')
    return [cat, path]
  })
}

// under is whether a path is the target or lies under it.
const under = (path: string, target: string) => target !== '' && (path === target || path.startsWith(`${target}/`))

export async function cleanupPrepare(c: Ctx) {
  const { findings, answers } = await decisions(c)
  const p = await place(c)
  const { repo, wt, root, g } = p
  const rejected = answered(answers, 'reject')
  if ((await remoteRef(c, `refs/tags/${tag}`)) === '') throw new Stop(`the tag ${tag} is not on origin; run backup.sh first, nothing is deleted before the backup`)
  if ((await tryGit(c, ['rev-parse', '-q', '--verify', `refs/tags/${tag}`])).code !== 0) await fetch(c, `refs/tags/${tag}:refs/tags/${tag}`, `cannot fetch the tag ${tag}`)
  if ((await catalogueIssue(c, repo)) === undefined) throw new Stop('the catalogue issue is missing; run backup.sh first, nothing is deleted before the backup')

  ensureDir(join(root, '.claude', 'worktrees'))
  const exclude = join(await git(c, ['rev-parse', '--path-format=absolute', '--git-common-dir']), 'info', 'exclude')
  if (!(existsSync(exclude) && lines(readFileSync(exclude, 'utf8')).includes('.claude/worktrees/'))) {
    ensureDir(dirname(exclude))
    appendFileSync(exclude, '.claude/worktrees/\n')
  }
  if (await onBranch(c, wt)) say(c, `worktree: ${wt} (resumed)`)
  else {
    if (existsSync(wt)) throw new Stop(`${wt} exists but is not a worktree on ${cleanupBranch}; move it away, then run cleanup.sh prepare again`)
    let from: string
    if ((await remoteRef(c, `refs/heads/${cleanupBranch}`)) !== '') {
      if ((await branchPulls(c, repo))[0]?.state === 'merged')
        throw new Stop(`${cleanupBranch} on origin belongs to a merged pull request; run finalize.sh, which deletes it, or delete it with git push origin --delete ${cleanupBranch}`)
      await fetch(c, `refs/heads/${cleanupBranch}`, `cannot fetch ${cleanupBranch}`)
      from = `the pushed ${cleanupBranch}`
    } else {
      await fetch(c, `refs/heads/${repo.defaultBranch}`, `cannot fetch ${repo.defaultBranch} from origin`)
      from = repo.defaultBranch
    }
    await git(c, ['worktree', 'add', '-q', '-B', cleanupBranch, wt, 'FETCH_HEAD']).catch((err: Error) => {
      throw new Stop(`cannot create the worktree ${wt}: ${last(err.message)}`)
    })
    say(c, `worktree: ${wt} (new, from ${from})`)
  }

  // Reconcile what an earlier prepare put on the branch with the answers now, since a later answer replaces an
  // earlier one: every file scaffold.sh writes for a rejected category and every target of a rejected finding goes
  // back to how the default branch has it where the branch forked, file by file. A file stays as it is when it is,
  // or lies under, the target of an approved finding or a file scaffold.sh writes for a category not rejected, so a
  // rejected directory target never takes back what an approved or unanswered category put inside it. On a new
  // worktree from the default branch this finds nothing.
  const fork = await base(c, p)
  await g(['add', '-A'])
  const scaffolded = await scaffoldPaths(c)
  const kept = [
    ...['delete', 'replace', 'create'].flatMap((a) => approvedFindings(findings, answers, a).map((f) => f.target)),
    ...scaffolded.filter(([cat]) => !rejected.includes(cat)).map(([, path]) => path),
  ]
  const back = unique(
    [...scaffolded, ...findings.filter((f) => ['delete', 'replace', 'create'].includes(f.action)).map((f): [string, string] => [f.category, f.target])]
      .filter(([cat]) => rejected.includes(cat))
      .map(([, path]) => path),
  )
  for (const t of back) {
    if (t === '') continue
    let restored = false
    for (const f of (await g(['diff', '--cached', '--name-only', '--no-renames', '-z', fork, '--', `:(literal)${t}`])).split('\0')) {
      if (f === '' || kept.some((k) => under(f, k))) continue
      await g(['rm', '-q', '-f', '--ignore-unmatch', '--', `:(literal)${f}`])
      if ((await g(['ls-tree', fork, '--', `:(literal)${f}`])) !== '') await g(['checkout', fork, '--', `:(literal)${f}`])
      restored = true
    }
    if (restored) say(c, `restored: ${t} (rejected)`)
  }

  // Deletions: the targets of approved delete findings. Only tracked files go through the pull request, and only
  // when the tag holds them as they are; a target changed since the tag was set (a tag from an earlier run is
  // kept, never moved) or an untracked one is left for the maintainer, since no backup has it.
  for (const t of unique(approvedFindings(findings, answers, 'delete').map((f) => f.target))) {
    if (t === '') continue
    if ((await g(['ls-files', '--', `:(literal)${t}`])) !== '') {
      if ((await git(c, ['ls-tree', '-r', tag, '--', `:(literal)${t}`])) !== (await g(['ls-tree', '-r', 'HEAD', '--', `:(literal)${t}`]))) {
        say(c, `skipped: ${t} changed since the tag ${tag} was set, so the tag cannot restore it; delete it by hand if it should go`)
        continue
      }
      await g(['rm', '-r', '-q', '--', `:(literal)${t}`])
      say(c, `deleted: ${t}`)
    } else if (existsSync(join(root, t)) && (await git(c, ['-C', root, 'ls-files', '--', `:(literal)${t}`])) === '') {
      say(c, `local: ${t} is not tracked, so the pull request cannot remove it and the tag does not keep it; delete it in the checkout yourself`)
    } else say(c, `gone: ${t}`)
  }

  const scaffold = await plugin(c, 'scaffold.sh', [...rejected.flatMap((cat) => ['--skip', cat]), '--name', repo.nwo.slice(repo.nwo.indexOf('/') + 1), '--default', repo.defaultBranch, wt])
  if (scaffold.code !== 0) {
    say(c, ...lines(scaffold.stdout), ...lines(scaffold.stderr))
    return 1
  }
  say(c, ...lines(scaffold.stdout).filter((l) => !l.startsWith('next:')))
  await g(['add', '-A'])

  // What needs judgement, for the agent to do in the worktree.
  for (const a of ['replace', 'create']) for (const f of approvedFindings(findings, answers, a)) say(c, `todo: ${f.category} ${f.action} ${f.target}: ${f.reason}`)
  for (const f of await placeholders(p, fork)) say(c, `todo: fill the <fill in> placeholders in ${f}`)
  if (rejected.length > 0) say(c, `untouched: ${rejected.join(', ')} (rejected)`)
  say(c, `next: do the todo lines in ${wt}, run make check there, then cleanup.sh open`)
}

export async function cleanupOpen(c: Ctx) {
  const { findings, answers } = await decisions(c)
  const p = await place(c)
  const { repo, wt, g } = p
  const rejected = answered(answers, 'reject')
  if (!(await onBranch(c, wt))) throw new Stop(`no worktree on ${cleanupBranch} at ${wt}; run cleanup.sh prepare first`)
  const main = await base(c, p)
  await g(['add', '-A'])
  const left = await placeholders(p, main)
  if (left.length > 0) throw new Stop(`<fill in> placeholders are left in ${left.join(' ')} in ${wt}; fill them in, then run cleanup.sh open again`)
  // The repository's own commit hooks run: they are its gates. A failing hook stops here with the worktree intact.
  if ((await tryGit(c, ['-C', wt, 'diff', '--cached', '--quiet'])).code !== 0) {
    const r = await tryGit(c, [
      '-C',
      wt,
      'commit',
      '-q',
      '-m',
      'chore: bring the repository to the standard',
      '-m',
      `Removes what the standardisation audit found outside the standard and adds the missing baseline files. The tag ${tag} keeps the previous state.`,
    ])
    if (r.code !== 0) {
      const why = r.stderr.trimEnd().split('\n').slice(-3).join(' ')
      throw new Stop(`cannot commit in ${wt}: ${why}; fix what the repository's commit hooks report there, then run cleanup.sh open again`)
    }
  }
  const head = await g(['rev-parse', 'HEAD'])
  if ((await git(c, ['rev-parse', `${main}^{tree}`])) === (await git(c, ['rev-parse', `${head}^{tree}`]))) {
    say(c, `pr: none needed, ${repo.defaultBranch} already has every change`)
    return
  }
  await g(['push', '-q', 'origin', `HEAD:refs/heads/${cleanupBranch}`]).catch((err: Error) => {
    throw new Stop(`cannot push ${cleanupBranch}: ${last(err.message)}; integrate origin/${cleanupBranch} in ${wt} without force, then run cleanup.sh open again`)
  })

  // The description: what goes, by category, with the restore command; what is added or changed; what stays.
  const deleted = lines(await git(c, ['diff', '--no-renames', '--diff-filter=D', '--name-only', main, head]))
  const catalogue = await catalogueIssue(c, repo)
  let body =
    '## What\nBrings the repository to the standard of the workflow plugins: removes what the audit found outside it and adds the missing baseline files. Nothing outside this pull request changes; the GitHub workspace is configured after the merge.\n\n' +
    `## Removed\nThe tag \`${tag}\` keeps the state before the run. Fetch it with \`git fetch origin tag ${tag}\`; each restore command brings a path back into a checkout.${catalogue === undefined ? '' : ` Removed skills are listed in #${catalogue}.`}\n`
  let any = false
  for (const cat of categories) {
    const rows = approvedFindings(findings, answers, 'delete')
      .filter((f) => f.category === cat && deleted.some((d) => under(d, f.target)))
      .map((f) => `- \`${f.target}\`: ${f.reason}. Restore: \`git checkout ${tag} -- ${f.target}\``)
    if (rows.length === 0) continue
    body += `\n### ${cat}\n${rows.join('\n')}\n`
    any = true
  }
  if (!any) body += '\nNothing.\n'
  const added = lines(await git(c, ['-c', 'core.quotePath=false', 'diff', '--no-renames', '--diff-filter=AM', '--name-status', main, head])).map((l) => {
    const [status, path] = l.split('\t')
    return `- ${status === 'A' ? 'added' : 'changed'} \`${path}\``
  })
  body += `\n## Added and changed\n${added.length > 0 ? added.join('\n') : 'Nothing.'}\n`
  body += `\n## Left alone\n${rejected.length > 0 ? `Rejected in the audit, untouched: ${rejected.join(', ')}.` : 'No category was rejected.'}\n`
  body += '\n## Verification\n- [ ] `make check` passes on this branch (CI job `check`).\n'

  const open = (await branchPulls(c, repo)).find((pr) => pr.state === 'open')
  if (!open) {
    const r = await gh(c, ['api', '--method', 'POST', `repos/${repo.nwo}/pulls`, '--input', '-'], {
      title: 'chore: bring the repository to the standard',
      head: cleanupBranch,
      base: repo.defaultBranch,
      body,
    })
    if (r.code !== 0) throw new Stop(`cannot open the pull request: ${last(r.stderr)}`)
    say(c, `pr: ${(JSON.parse(r.stdout) as { html_url: string }).html_url} opened`)
  } else if (open.body.replace(/\n+$/, '') === body.replace(/\n+$/, '')) say(c, `pr: ${open.url} unchanged`)
  else {
    const r = await gh(c, ['api', '--method', 'PATCH', `repos/${repo.nwo}/pulls/${open.number}`, '--input', '-'], { body })
    if (r.code !== 0) throw new Stop(`cannot update the pull request: ${last(r.stderr)}`)
    say(c, `pr: ${open.url} updated`)
  }
  say(c, 'next: merge the pull request once check passes, then run finalize.sh')
}
