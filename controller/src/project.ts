// A project is a checkout on this machine. The configuration stores its path and nothing else: the
// repository it belongs to and the branch it is worked from are read from git and GitHub each time,
// so no stored fact can go stale.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { run } from './exec.js'

export interface Project {
  path: string
  owner: string
  name: string
  base: string
}

export class Refusal extends Error {}

// checkout is the top of the git working tree at path, or a Refusal that says it is none.
export async function checkout(path: string): Promise<string> {
  try {
    return await run('git', ['-C', path, 'rev-parse', '--show-toplevel'])
  } catch {
    throw new Refusal(`${path} is not a git checkout; name the directory of a clone of a GitHub repository`)
  }
}

// github reads owner and name out of an origin URL on github.com, in any of the forms git clones
// from: https, ssh and scp-like.
export function github(url: string): { owner: string; name: string } | undefined {
  const m = /^(?:https?:\/\/(?:[^@/]+@)?github\.com\/|ssh:\/\/git@github\.com(?::\d+)?\/|git@github\.com:)([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?\/?$/.exec(url)
  if (!m || !m[1] || !m[2]) return undefined
  return { owner: m[1], name: m[2] }
}

// withoutCredentials is the origin with the user and password of a URL taken out, so a token kept
// in the remote never reaches an answer or a terminal.
function withoutCredentials(origin: string): string {
  try {
    const url = new URL(origin)
    if (!url.username && !url.password) return origin
    url.username = ''
    url.password = ''
    return url.toString()
  } catch {
    return origin
  }
}

// derive reads the facts of the checkout at path. A path that is no checkout, or whose origin is
// not on GitHub, is refused with the reason.
export async function derive(path: string, gh: string): Promise<Project> {
  const top = await checkout(path)
  let origin: string
  try {
    origin = await run('git', ['-C', top, 'remote', 'get-url', 'origin'])
  } catch {
    throw new Refusal(`${top} has no origin; add the GitHub repository as origin with git remote add origin <url>`)
  }
  const repo = github(origin)
  if (!repo) throw new Refusal(`the origin of ${top} is ${withoutCredentials(origin)}, which is not on GitHub; a project is a clone of a GitHub repository`)
  return { path: top, ...repo, base: await baseBranch(top, `${repo.owner}/${repo.name}`, gh) }
}

// baseBranch is the workflow's base branch rule, which the plugins' wf_base_branch and the factory's
// baseBranch follow too. Its steps, in order:
//   1. WF_BASE_BRANCH as the repository's settings declare it,
//   2. the head origin points at,
//   3. the default branch GitHub names,
//   4. main.
// contract/base-branch.json states its cases, and the controller's tests hold this function to them.
export async function baseBranch(top: string, repository: string, gh: string): Promise<string> {
  const declared = await declaredBase(top)
  if (declared) return declared
  try {
    const head = await run('git', ['-C', top, 'symbolic-ref', '-q', '--short', 'refs/remotes/origin/HEAD'])
    if (head) return head.replace(/^origin\//, '')
  } catch {
    // origin names no head: GitHub is asked next
  }
  try {
    const name = await run(gh, ['repo', 'view', repository, '--json', 'defaultBranchRef', '--jq', '.defaultBranchRef.name'])
    if (name) return name
  } catch {
    // GitHub does not answer: the rule ends at main
  }
  return 'main'
}

// declaredBase is WF_BASE_BRANCH in the env block of the checkout's .claude/settings.json, when it is
// a branch name git accepts; anything else reads as if the repository declared nothing.
async function declaredBase(top: string): Promise<string> {
  let declared: unknown
  try {
    const settings = JSON.parse(readFileSync(join(top, '.claude', 'settings.json'), 'utf8')) as { env?: Record<string, unknown> }
    declared = settings.env?.WF_BASE_BRANCH
  } catch {
    return ''
  }
  if (typeof declared !== 'string' || declared === '') return ''
  try {
    await run('git', ['check-ref-format', '--branch', declared])
    return declared
  } catch {
    return ''
  }
}
