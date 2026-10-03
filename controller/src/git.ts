// The git helpers of the controller: git in a checkout, whether a ref exists, a fetch from origin and a
// push to it, and the worktree of a branch inside the checkout. They hold no process and no lock: the
// stages and the claim call them with the checkout and the branch they act on.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { run } from './exec.js'
import { Refusal } from './project.js'

export async function git(top: string, ...args: string[]): Promise<string> {
  return run('git', ['-C', top, ...args])
}

export async function exists(top: string, ref: string): Promise<boolean> {
  return git(top, 'rev-parse', '-q', '--verify', ref + '^{commit}').then(
    () => true,
    () => false,
  )
}

// fetch updates a remote-tracking branch from origin. It may fail, as offline: the caller decides what
// the ref it has left is worth.
export async function fetch(top: string, branch: string, fake: boolean): Promise<boolean> {
  if (fake) return true
  return git(top, 'fetch', '-q', 'origin', `+refs/heads/${branch}:refs/remotes/origin/${branch}`).then(
    () => true,
    () => false,
  )
}

// push pushes the head of a worktree to its branch on origin, never forced. In fake mode it pushes
// nothing, as there is no origin behind the checkout.
export async function push(wt: string, branch: string, fake: boolean): Promise<void> {
  if (fake) return
  await git(wt, 'push', '-q', '-u', 'origin', `HEAD:refs/heads/${branch}`)
}

// addWorktree creates the worktree of a branch inside the checkout, where the local workflow keeps them
// and git ignores them. It creates the branch from start unless it exists, and says whether it did.
export async function addWorktree(top: string, branch: string, start: string): Promise<{ path: string; created: boolean }> {
  const dir = join(top, '.claude', 'worktrees')
  const path = join(dir, branch.replace(/\//g, '-'))
  if (existsSync(path)) throw new Refusal(`${path} exists already; remove it and try again`, 409)
  mkdirSync(dir, { recursive: true })
  const common = resolve(top, await git(top, 'rev-parse', '--git-common-dir'))
  const exclude = join(common, 'info', 'exclude')
  const excluded = existsSync(exclude) ? readFileSync(exclude, 'utf8') : ''
  if (!excluded.split('\n').includes('.claude/worktrees/')) {
    mkdirSync(join(common, 'info'), { recursive: true })
    appendFileSync(exclude, (excluded && !excluded.endsWith('\n') ? '\n' : '') + '.claude/worktrees/\n')
  }
  const created = !(await exists(top, `refs/heads/${branch}`))
  try {
    if (created) await git(top, 'worktree', 'add', '-q', '--no-track', '-b', branch, path, start)
    else await git(top, 'worktree', 'add', '-q', path, branch)
  } catch (err) {
    throw new Refusal(`could not create the worktree ${path}: ${(err as Error).message}`, 500)
  }
  return { path, created }
}
