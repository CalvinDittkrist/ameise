// The last step of the apply, after the cleanup pull request is merged: configure the GitHub workspace, keep its
// snapshot on the catalogue issue, remove the cleanup worktree, and end with the check.
// Refuses while the pull request from chore/standardize is open or was closed without a merge, because the
// rulesets require the job check that the pull request brings. The workspace apply runs only when the workspace
// category was approved and had a `configure` finding; it applies the whole difference, recomputed now, so one
// line names where that differs from the audit. Its snapshot is posted as a comment on the catalogue issue. The
// check (check.sh) runs on the head of the default branch on origin. Ends with 1 when the check or the workspace
// fails.
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import {
  answered,
  branchPulls,
  catalogueIssue,
  cleanupBranch,
  cleanupWorktree,
  type Ctx,
  decisions,
  gh,
  git,
  githubRepo,
  hasFindings,
  last,
  lines,
  plugin,
  remoteRef,
  say,
  step,
  Stop,
  tryGit,
  unique,
} from './lib.js'
import { workspace } from './workspace.js'

// workspaceSettings is the setting of each `diff:` line of the workspace step: everything before the last `: `,
// which is the rule the workspace auditor follows when it writes the target of a `configure` finding
// (agents/workspace-auditor.md).
export const workspaceSettings = (out: string[]) => out.filter((l) => l.startsWith('diff: ')).map((l) => l.slice('diff: '.length).replace(/: [^:]*$/, ''))

// deviation is one line naming how the difference the workspace step applied differs from the `configure` findings
// the report recorded, in both directions, or undefined when the two sides name the same settings. The workspace
// step recomputes the difference when it runs, after the cleanup pull request is merged, so it can be another one
// than the audit saw (docs/repo-standard.md). A setting the apply of this run has already worked on counts as changed, so a
// second run does not claim the report asked for something that was never needed. Nothing is skipped or aborted
// because of a deviation; the line is there to be read.
function deviation(now: string[], before: string[], audited: string[]): string | undefined {
  const changed = new Set([...now, ...before])
  const extra = unique(now.filter((s) => s !== '' && !audited.includes(s)))
  const gone = unique(audited.filter((s) => s !== '' && !changed.has(s)))
  if (extra.length === 0 && gone.length === 0) return undefined
  let line = 'workspace: the applied difference is not the audited one'
  if (extra.length > 0) line += `; changed without a finding: ${extra.join(', ')}`
  if (gone.length > 0) line += `; in the report but already at the standard: ${gone.join(', ')}`
  return line
}

export async function finalize(c: Ctx) {
  const { dir, findings, answers } = await decisions(c)
  // The settings the apply of this run has worked on: changed, or on the plan of a run that then failed. The
  // report clears the file with the approvals, because a new report starts a new run.
  const handled = join(dir, 'workspace-handled')
  const repo = await githubRepo(c)
  const { nwo, defaultBranch } = repo
  const catalogue = await catalogueIssue(c, repo)
  if (catalogue === undefined) throw new Stop('the catalogue issue is missing; run backup.sh and cleanup.sh first')

  const pr = (await branchPulls(c, repo))[0]
  const state = pr?.state ?? 'none'
  const sha = pr?.sha ?? ''
  await git(c, ['fetch', '-q', 'origin', `refs/heads/${defaultBranch}`]).catch((err: Error) => {
    throw new Stop(`cannot fetch ${defaultBranch} from origin: ${last(err.message)}`)
  })
  const tip = await git(c, ['rev-parse', 'FETCH_HEAD'])
  // Work in the cleanup worktree that no pull request carries yet: uncommitted changes, or a commit that is
  // neither on the default branch nor in the merged pull request (a push or an open that failed). The pull request
  // may have moved on after the last open (a review suggestion, "Update branch"), so its head is fetched from GitHub.
  const wt = await cleanupWorktree(c)
  const ancestor = async (a: string, b: string) => (await tryGit(c, ['merge-base', '--is-ancestor', a, b])).code === 0
  const carried = async (commit: string) => {
    if (commit === sha || (await ancestor(commit, tip))) return true
    return state === 'merged' && (await tryGit(c, ['fetch', '-q', 'origin', `refs/pull/${pr?.number}/head`])).code === 0 && (await ancestor(commit, 'FETCH_HEAD'))
  }
  let pending = ''
  const branch = await tryGit(c, ['-C', wt, 'rev-parse', '--abbrev-ref', 'HEAD'])
  if (branch.code === 0 && branch.stdout.trim() === cleanupBranch) {
    if ((await git(c, ['-C', wt, 'status', '--porcelain'])) !== '') pending = 'uncommitted changes'
    else if (!(await carried(await git(c, ['-C', wt, 'rev-parse', 'HEAD'])))) pending = 'a commit'
  }
  if (state === 'open') throw new Stop(`the cleanup pull request ${pr?.url} is not merged yet; merge it once check passes, then run finalize.sh again`)
  if (state === 'closed') throw new Stop(`the cleanup pull request ${pr?.url} was closed without a merge; reopen and merge it, or run cleanup.sh prepare and open again`)
  if (pending !== '') throw new Stop(`the cleanup worktree ${wt} has ${pending} that no pull request carries; run cleanup.sh open, merge the pull request, then run finalize.sh again`)
  if (state === 'merged') say(c, `pr: ${pr?.url} merged`)
  else say(c, 'pr: none (the default branch needed no cleanup)')

  // The workspace, only when the category was approved and the audit found a GitHub setting to change. What
  // approving `workspace` promises is what the report said it would do: a `configure` finding is the line that
  // says the whole difference between the workspace and the standard is applied, so an approval given for the
  // baseline file the category scaffolds never configures GitHub (docs/repo-standard.md). The snapshot goes to the catalogue
  // issue before anything else can fail.
  let status = 0
  if (answered(answers, 'approve').includes('workspace') && hasFindings(findings, 'workspace', 'configure')) {
    const snap = join(dir, `workspace-snapshot.${randomBytes(4).toString('hex')}`)
    writeFileSync(snap, '')
    const out = await step(c, (s) => workspace(s, { apply: true, snapshot: snap }))
    say(c, ...out.lines.map((l) => `workspace: ${l}`))
    if (out.lines.includes(`snapshot: ${snap}`)) {
      const changed = out.lines.filter((l) => l.startsWith('diff: '))
      const body =
        `Snapshot of the GitHub workspace before \`workspace.sh --apply\` on ${new Date().toISOString().slice(0, 10)}, for undoing a change by hand.\n\nChanged:\n\`\`\`\n${changed.join('\n')}\n\`\`\`\n\n<details><summary>Previous state</summary>\n\n\`\`\`json\n` +
        JSON.stringify(JSON.parse(readFileSync(snap, 'utf8')), null, 2) +
        '\n```\n\n</details>\n'
      const r = await gh(c, ['api', '--method', 'POST', `repos/${nwo}/issues/${catalogue}/comments`, '--input', '-'], { body })
      if (r.code !== 0) throw new Stop(`cannot post the snapshot to #${catalogue}: ${last(r.stderr)}; it is in ${snap}`)
      say(c, `snapshot: posted to #${catalogue}`)
    }
    if (statSync(snap).size === 0) rmSync(snap, { force: true })
    // After the snapshot is on the catalogue issue, because this only reads: the settings the workspace step
    // worked on, how they deviate from the audit, and the note for the next run. It never fails the run.
    const settings = workspaceSettings(out.lines)
    const before = existsSync(handled) ? lines(readFileSync(handled, 'utf8')) : []
    if (out.code === 0) {
      const audited = findings.filter((f) => f.category === 'workspace' && f.action === 'configure').map((f) => f.target)
      const line = deviation(settings, before, audited)
      if (line) say(c, line)
    }
    try {
      writeFileSync(`${handled}.tmp`, unique([...before, ...settings].filter((l) => l.trim() !== '')).map((l) => l + '\n').join(''))
      renameSync(`${handled}.tmp`, handled)
    } catch {
      // only a note for the next run
    }
    if (out.code !== 0) {
      say(c, 'workspace: failed; fix the error above and run finalize.sh again')
      status = 1
    }
  } else if (answered(answers, 'reject').includes('workspace')) say(c, 'workspace: rejected, left untouched')
  else say(c, 'workspace: no approved configure finding, left untouched')

  // The cleanup branch is done once its pull request is merged: the worktree, the local branch and the branch on
  // origin go, so the next run starts from the default branch. Only what the merged pull request carried goes.
  if (state === 'merged') {
    if (existsSync(wt)) {
      const removed = await tryGit(c, ['worktree', 'remove', wt])
      if (removed.code === 0) {
        await tryGit(c, ['branch', '-q', '-D', cleanupBranch])
        say(c, `worktree: ${wt} removed`)
      } else say(c, `worktree: ${wt} kept, it has changes the merged pull request does not (${last(removed.stderr)})`)
    }
    const pushed = await remoteRef(c, `refs/heads/${cleanupBranch}`)
    if (pushed !== '' && pushed !== sha) say(c, `branch: ${cleanupBranch} kept on origin, it has commits the merged pull request does not`)
    else if (pushed !== '') {
      const deleted = await tryGit(c, ['push', '-q', 'origin', '--delete', cleanupBranch])
      if (deleted.code === 0) say(c, `branch: ${cleanupBranch} deleted on origin`)
      else say(c, `branch: ${cleanupBranch} kept on origin, deleting it failed (${last(deleted.stderr)})`)
    }
  }

  // The check, on what is on GitHub now, in a temporary worktree so the checkout stays as it is. The writing rules
  // warn here: apply brings the structure, and rewriting the documents to the rules is work of its own.
  const parent = mkdtempSync(join(tmpdir(), 'ameise-check-'))
  const check = join(parent, 'check')
  try {
    await git(c, ['worktree', 'add', '-q', '--detach', check, tip]).catch((err: Error) => {
      throw new Stop(`cannot check out ${defaultBranch} for the check: ${last(err.message)}`)
    })
    const r = await plugin(c, 'check.sh', [check], c.root, { env: { WF_WRITING_LENIENT: '1' } })
    await tryGit(c, ['worktree', 'remove', '--force', check])
    say(c, ...lines(r.stdout + '\n' + r.stderr).filter((l) => /^(fail|warn|skip): /.test(l)).map((l) => `check: ${l}`))
    const rejected = answered(answers, 'reject')
    if (rejected.length > 0) say(c, `untouched: ${rejected.join(', ')} (rejected in the audit)`)
    // A repository that started empty: the checkout still has no commit, and pulling is the maintainer's step.
    if ((await tryGit(c, ['rev-parse', '-q', '--verify', 'HEAD'])).code !== 0) say(c, `next: the checkout has no commit yet; git pull origin ${defaultBranch} brings the standard into it`)
    if (r.code === 0 && status === 0) say(c, 'result: pass')
    else {
      say(c, 'result: fail')
      return 1
    }
  } finally {
    rmSync(parent, { recursive: true, force: true })
  }
}
