// The settings of a session: the plan and work settings over the repository's, the environment its
// runtime runs in, the compact pin with the context size the process page measures against, the knobs
// of a process as its claim and the repository's settings set them, the rules an allowance of the
// maintainer grants, and the hook of Bash that allows the read commands the briefs name and keeps a
// session with the controller's GitHub tools from writing GitHub past them. It imports neither the session module nor a
// stage module.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { HookCallback, PermissionUpdate } from '@anthropic-ai/claude-agent-sdk'
import { directWrite } from '../github/github.js'
import type { PlanRecord, SessionRecord, StageRecord, StandardizeRecord } from '../records/records.js'
import { event } from '../records/store.js'

// The local workflow's compact pin (docs/token-budget.md): the session compacts at 80% of a window of
// 312 500 tokens, which is 250 000. Implement has no hand-over, so compaction is its safety net.
const compactWindow = 312500
const compactPercentage = '80'
// compactAt is the context size at which the session compacts, which the process page measures against.
export const compactAt = (compactWindow * Number(compactPercentage)) / 100

// The marketplace the workflow's plugins are installed from. Its copies are switched off, so the
// bundled plugins are the ones the session loads and the orchestrator stays out of its context.
const marketplace = 'ameise'

// Settings are a session's own settings, over the repository's.
export type Settings = {
  env: Record<string, string>
  enabledPlugins: Record<string, boolean>
  autoCompactWindow?: number
  language?: string
}

// settings are the session's own settings: the worker's for a work process, the planner's for a plan.
export const settings = (record: SessionRecord): Settings => (record.kind === 'plan' ? planSettings(record) : workSettings(record))

// planSettings are a planner session's own settings: the base, the foreground subagents, whose report is
// the tool result rather than a wait in sleep turns, and WF_CONTROLLER, the mark that the controller runs
// the session. The brief carries the plan's context.
// The marketplace copies of the plugins are switched off, so the bundled planner is the one the session
// loads. The repository's WF_PLANNER_LANGUAGE is the runtime's language setting, the language the
// planner talks in.
export function planSettings(record: PlanRecord): Settings {
  return {
    ...(record.language !== undefined ? { language: record.language } : {}),
    env: {
      WF_CONTROLLER: '1',
      WF_BASE_BRANCH: record.base.replace(/^origin\//, ''),
      CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1',
    },
    enabledPlugins: {
      [`worker@${marketplace}`]: false,
      [`planner@${marketplace}`]: false,
      [`orchestrator@${marketplace}`]: false,
      [`repo-standards@${marketplace}`]: false,
    },
  }
}

// workSettings are the session's own settings, over the repository's: the mode, the issue, which a hunt
// has none of, the base and the knob overrides of the claim, the mark that the controller runs the session, which a worker skill that
// needs the controller reads (ADR 0057), the foreground subagents and the compact pin.
export function workSettings(record: StageRecord | StandardizeRecord): Settings {
  return {
    env: {
      ...record.env,
      WF_MODE: record.mode,
      ...(record.kind === 'work' ? { WF_ISSUE: String(record.issue) } : {}),
      WF_BASE_BRANCH: record.base.replace(/^origin\//, ''),
      WF_CONTROLLER: '1',
      CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1',
      CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: compactPercentage,
    },
    enabledPlugins: { [`worker@${marketplace}`]: false, [`planner@${marketplace}`]: false, [`orchestrator@${marketplace}`]: false, [`repo-standards@${marketplace}`]: false },
    autoCompactWindow: compactWindow,
  }
}

// runtimeEnv is the environment the runtime runs in: the controller's own without the workflow's
// variables and Herdr's. A WF_MODE left in the shell that started the controller so reaches no session.
export function runtimeEnv(): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [name, value] of Object.entries(process.env)) {
    if (value === undefined || name.startsWith('WF_') || name.startsWith('HERDR_')) continue
    out[name] = value
  }
  return out
}


// setting reads a knob of the process: the claim's override, else the env block of the repository's
// .claude/settings.json, else undefined.
export const setting = (record: StageRecord, name: string): unknown => settingOf(record.env, record.project, name)

// settingOf reads a knob from the overrides, else from the env block of the checkout's settings.
export function settingOf(env: Record<string, string>, checkout: string, name: string): unknown {
  const value: unknown = env[name]
  if (value !== undefined) return value
  try {
    return (JSON.parse(readFileSync(join(checkout, '.claude', 'settings.json'), 'utf8')) as { env?: Record<string, unknown> }).env?.[name]
  } catch {
    // a repository without settings sets no knob
    return undefined
  }
}

// knob reads a whole-number knob of the process, or the default where it is not set. A value that is no
// whole number of at least min is refused with the reason. A record without overrides, as a plan's,
// reads it from the repository's settings alone.
export function knob(record: { env?: Record<string, string>; project: string }, name: string, fallback: number, min = 0): number {
  const value = settingOf(record.env ?? {}, record.project, name)
  if (value === undefined || value === '') return fallback
  const n = Number(value)
  if (typeof value === 'boolean' || !Number.isInteger(n) || n < min) throw new Error(`${name}=${String(value)} is not a whole number of at least ${min}; set it as such, or leave it out for ${fallback}`)
  return n
}

// allowance is what an answer "allow for this process" allows: the rules the runtime suggests for the
// call, or the call itself when it suggests none.
export function allowance(tool: string, input: Record<string, unknown>, suggestions: PermissionUpdate[] | undefined): string[] {
  const keys = (suggestions ?? []).flatMap((u) => {
    if (u.type === 'addRules' && u.behavior === 'allow') return u.rules.map((r) => `rule ${r.toolName}(${r.ruleContent ?? ''})`)
    if (u.type === 'addDirectories') return u.directories.map((d) => `directory ${d}`)
    return []
  })
  return keys.length > 0 ? keys : [`call ${tool} ${JSON.stringify(input)}`]
}

// sessionScoped are the suggested updates that allow more, held to this session.
// An allowance so never reaches a settings file and never changes the permission mode.
export const sessionScoped = (suggestions: PermissionUpdate[] | undefined): PermissionUpdate[] =>
  (suggestions ?? []).flatMap((u): PermissionUpdate[] => {
    if (u.type === 'addRules' && u.behavior === 'allow') return [{ ...u, destination: 'session' }]
    if (u.type === 'addDirectories') return [{ ...u, destination: 'session' }]
    return []
  })


// readCommand says whether a Bash command is one of the read commands the briefs name, in a form that
// reads the repository or one issue and nothing else: gh issue view, git diff, git log, git status or git
// show. The briefs name these commands, so no card asks for them, and parallel reviewers, which keep no
// allowance of the process, do not each ask for the same read. A prefix rule such as Bash(git diff:*)
// would allow every argument after the subcommand, among them git diff --no-index, which reads any file
// of the host, and --output, which writes one. So the command is one call without a shell character,
// and each option is one of a known list; any other form is left to the permission layer.
export function readCommand(command: string): boolean {
  if (!/^[A-Za-z0-9 ._/@^~:=,+%-]+$/.test(command)) return false
  const words = command.trim().split(/ +/)
  // A word that opens with ~ would be expanded to a path of the home directory.
  if (words.some((w) => w.startsWith('~'))) return false
  const [tool, sub, ...rest] = words
  if (tool === 'gh' && sub === 'issue' && rest[0] === 'view') return issueView(rest.slice(1))
  if (tool === 'git' && sub !== undefined && gitReads.has(sub)) {
    const dashes = rest.indexOf('--')
    return (dashes === -1 ? rest : rest.slice(0, dashes)).every((w) => !w.startsWith('-') || gitOption.test(w))
  }
  return false
}

// gitReads are the git subcommands the briefs name, and gitOption the options they may carry: none of
// them reads a path outside the repository, writes a file or runs a program.
const gitReads = new Set(['diff', 'log', 'status', 'show'])
const gitOption = new RegExp(
  '^(' +
    [
      '--stat(=[0-9,]+)?', '--shortstat', '--numstat', '--name-only', '--name-status', '--summary', '--dirstat(=[a-z0-9,]+)?',
      '-p', '--patch', '-s', '--no-patch', '-U[0-9]+', '--unified=[0-9]+', '-w', '--ignore-all-space', '--word-diff',
      '--check', '--exit-code', '--quiet', '--cached', '--staged', '--merge-base', '-M', '--find-renames', '--diff-filter=[A-Za-z]+',
      '--oneline', '--graph', '--decorate', '--no-decorate', '--abbrev-commit', '--reverse', '--first-parent', '--merges',
      '--no-merges', '--all', '--follow', '-n', '-[0-9]+', '--max-count=[0-9]+', '--since=[A-Za-z0-9.:-]+', '--until=[A-Za-z0-9.:-]+',
      '--author=[A-Za-z0-9.@_-]+', '--format=[A-Za-z0-9%:,.-]+', '--pretty=[A-Za-z0-9%:,.-]+', '--no-color', '--color=never',
      '--short', '-b', '--branch', '--porcelain(=v[12])?', '--untracked-files(=(no|normal|all))?', '-u(no|normal|all)?',
    ].join('|') +
    ')$',
)

// issueView says whether the words after gh issue view read one issue: its number or URL, with --repo,
// --comments and --json alone. --web, which opens a browser, is none of them.
function issueView(words: string[]): boolean {
  const repo = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/
  const issue = /^([0-9]+|https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/issues\/[0-9]+)$/
  let issues = 0
  const rest = words.values()
  for (const w of rest) {
    if (w === '--repo' || w === '-R') {
      if (!repo.test(rest.next().value ?? '')) return false
    } else if (w === '--json') {
      if (!/^[A-Za-z,]+$/.test(rest.next().value ?? '')) return false
    } else if (w.startsWith('--repo=')) {
      if (!repo.test(w.slice('--repo='.length))) return false
    } else if (issue.test(w)) issues++
    else if (w !== '--comments' && w !== '-c') return false
  }
  return issues === 1
}

// bash is the PreToolUse hook of Bash in every session the controller starts. It allows the read
// commands the briefs name (readCommand) without a card. In a session with the controller's GitHub
// tools, which writes GitHub through them alone, it first denies every Bash call that writes GitHub with
// gh past them, before auto mode's classifier could allow it, in the session and its subagents, and
// writes the refusal into the process's event log. Any other call goes on to the permission layer.
export const bash =
  (stateDir: string, id: string, guarded: boolean): HookCallback =>
  (input) => {
    const command = input.hook_event_name === 'PreToolUse' ? (input.tool_input as { command?: unknown } | undefined)?.command : undefined
    if (typeof command !== 'string') return Promise.resolve({})
    const why = guarded ? directWrite(command) : undefined
    if (why !== undefined) {
      const reason = `${why}; write GitHub only through the github tools (create_issue, set_labels, block, comment, close, attach_milestone, create_milestone)`
      event(stateDir, id, { event: 'github-refused', tool: 'Bash', reason })
      return Promise.resolve({ hookSpecificOutput: { hookEventName: 'PreToolUse' as const, permissionDecision: 'deny' as const, permissionDecisionReason: reason } })
    }
    if (!readCommand(command)) return Promise.resolve({})
    return Promise.resolve({ hookSpecificOutput: { hookEventName: 'PreToolUse' as const, permissionDecision: 'allow' as const, permissionDecisionReason: 'a read command the brief names' } })
  }
