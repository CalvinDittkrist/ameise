// The settings of a session: the plan and work settings over the repository's, its skill
// allowlist, the environment its runtime runs in, the compact pin with the context size the process
// page measures against, the knobs of a process as its claim and the repository's settings set
// them, the rules an allowance of the maintainer grants, and the hook that keeps a session with the
// controller's GitHub tools from writing GitHub past them. It imports neither the session module
// nor a stage module.
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { HookCallback, PermissionUpdate } from '@anthropic-ai/claude-agent-sdk'
import { directWrite } from '../github/github.js'
import type { PlanRecord, SessionRecord, StageRecord, StandardizeRecord } from '../records/records.js'
import { event } from '../records/store.js'

// The local workflow's compact pin (ADR 0031, ADR 0034): the session compacts at 80% of a window of
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

// The skill allowlist of a session (ADR 0072): the exact set of skills the Agent SDK lets the session see
// and invoke, by its process kind. The model sees no other skill, so the runtime's bundled skills and
// the maintainer's personal ones cost no context, and the Skill tool rejects them. A skill a brief
// dispatches by its slash command, as the hunt brief does, runs whether or not it is listed.
const workSkills = ['simplify', 'worker:docs', 'repo-standards:adr', 'repo-standards:docs-check']
const planSkills = ['accept', 'finish', 'grill', 'plan', 'prototype', 'research', 'spec', 'tickets', 'triage'].map((s) => `planner:${s}`)

// skills is the skill allowlist of a session of the record's process kind: a plan session the planner's
// skills, a hunt session the work list and the hunt skill, every other session the work list. A work
// list leaves simplify out where a personal or project skill of that name shadows the bundled one, which
// the runtime would run in its place: the session then has no /simplify and says so in its report.
export const skills = (record: SessionRecord): string[] => {
  if (record.kind === 'plan') return planSkills
  const work = shadowsSimplify(record.worktree) ? workSkills.filter((s) => s !== 'simplify') : workSkills
  return record.kind === 'hunt' ? [...work, 'worker:hunt-tests'] : work
}

// shadowsSimplify is whether a personal skill or a skill of the worktree is named simplify, which the
// runtime prefers to its bundled skill of that name.
const shadowsSimplify = (worktree: string): boolean =>
  [process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), join(worktree, '.claude')].some((dir) => existsSync(join(dir, 'skills', 'simplify')))

// planSettings are a planner session's own settings: the base, the foreground subagents (ADR 0017) and
// WF_CONTROLLER, the mark that the controller runs the session. The brief carries the plan's context.
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
// has none of, the base and the knob overrides of the claim with the WF_SIMPLIFY it pinned, the mark that the controller runs the session, which a worker skill that
// needs the controller reads (ADR 0063), the foreground subagents (ADR 0017) and the compact pin.
export function workSettings(record: StageRecord | StandardizeRecord): Settings {
  return {
    env: {
      ...record.env,
      ...(record.kind === 'work' && record.simplify !== undefined ? { WF_SIMPLIFY: record.simplify ? 'on' : 'off' } : {}),
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

// simplifyOn reads WF_SIMPLIFY, the switch of the simplify step of an implement session: on, the
// default where it is not set, or off. Any other value is refused with the values it accepts.
export function simplifyOn(value: unknown): boolean {
  if (value === undefined || value === 'on') return true
  if (value === 'off') return false
  throw new Error(`WF_SIMPLIFY=${JSON.stringify(value)} is neither on nor off; set on, off, or leave it out for on`)
}

// simplifyOrOn reads WF_SIMPLIFY as simplifyOn does, but answers the default on for a value it would
// refuse: the claim refused it, so only a later change of the settings sets one.
export function simplifyOrOn(value: unknown): boolean {
  return value !== 'off'
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


// guard is the hook of a session with the controller's GitHub tools, which writes GitHub through them
// alone: it denies every Bash call that writes GitHub with gh past them, before auto mode's classifier
// could allow it, in the session and its subagents, and writes the refusal into the process's event log.
export const guard =
  (stateDir: string, id: string): HookCallback =>
  (input) => {
    const command = input.hook_event_name === 'PreToolUse' ? (input.tool_input as { command?: unknown } | undefined)?.command : undefined
    const why = typeof command === 'string' ? directWrite(command) : undefined
    if (why === undefined) return Promise.resolve({})
    const reason = `${why}; write GitHub only through the github tools (create_issue, set_labels, block, comment, close, attach_milestone, create_milestone)`
    event(stateDir, id, { event: 'github-refused', tool: 'Bash', reason })
    return Promise.resolve({ hookSpecificOutput: { hookEventName: 'PreToolUse' as const, permissionDecision: 'deny' as const, permissionDecisionReason: reason } })
  }
