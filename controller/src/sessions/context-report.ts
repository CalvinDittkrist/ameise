// Context report: a maintainer diagnostic over finished planning and worker sessions.
//
// It reads Claude Code's session transcripts (JSONL) and prints one line per planning or worker session:
// its kind, the Claude Code version, the turns, the maintainer's answers, the peak context, the input
// tokens read from cache and not, the output tokens, the resume share, the share of tool output read from
// files through the shell, the read, edit, write and shell calls, and the sleep calls.
//
// The transcript format is internal to Claude Code and undocumented. This report is written against the
// version in knownVersion and fails with an `error:` line when it meets a format it does not understand.
// It is a diagnostic only and never an input to a process, so it reads the files itself and needs no
// running server.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'

export const knownVersion = '2.1.278'

// Tool names, grouped the way the report counts them.
const readTools = new Set(['Read', 'NotebookRead'])
const editTools = new Set(['Edit', 'MultiEdit', 'NotebookEdit'])
const writeTools = new Set(['Write'])
const shellTools = new Set(['Bash', 'BashOutput'])

// The white space, word characters and digits a transcript may hold, Unicode included.
const space = '[\\t\\n\\v\\f\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000]'
const word = '[\\p{L}\\p{N}_]'
const wordEnd = `(?!${word})`
// A shell segment that prints file content instead of using the read tool.
const fileReaders = new RegExp(`^(cat|bat|head|tail|less|more|sed${space}+-n)${wordEnd}`, 'u')
// `<<TAG`, `<<-TAG`, `<<'TAG'`: a here-string (`<<<`) and a shift (`1 << 2`) are neither.
const heredoc = new RegExp(`<<(?!<)-?${space}*(["']?)([A-Za-z_]${word}*)\\1`, 'u')
const sleep = new RegExp(`^sleep${wordEnd}`, 'u')
// `> file` and `&> file` send the output away; `2> file` and `2>&1` only move stderr.
const stdoutRedirect = /(?<![0-9])>/
// What a shell keyword puts in front of the command it runs, and the wrappers that pass it on.
const segmentPrefix = new RegExp(
  `^(do|then|else|elif|if|while|until|!|time|nohup|command|exec|eval|timeout${space}+[\\p{Nd}.]+[smhd]?)${space}+`,
  'u',
)
const skills = { work: new RegExp(`(?<!${word})worker:[a-z]`, 'u'), plan: new RegExp(`(?<!${word})planner:[a-z]`, 'u') }
const commandName = /<command-name>([^\n]*?)<\/command-name>/g
const edges = new RegExp(`^${space}+|${space}+$`, 'gu')

function strip(s: string): string {
  return s.replace(edges, '')
}

// FormatError: the transcript is not in a format this report understands. unreadable separates a
// truncated or half-written file, which says nothing about the format, from a transcript whose shape
// has changed, which asks for a change to this report.
class FormatError extends Error {
  constructor(
    readonly detail: string,
    readonly version: unknown = null,
    readonly unreadable = false,
  ) {
    super(detail)
  }
}

// ShapeError: a record holds a value of a type the report cannot read where it reads one.
class ShapeError extends Error {}

type Json = null | boolean | number | string | Json[] | { [key: string]: Json }
type Obj = { [key: string]: Json }

function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

// truthy is the truth of a JSON value: null, false, 0, '', [] and {} are false.
function truthy(v: unknown): boolean {
  if (Array.isArray(v)) return v.length > 0
  if (isObj(v)) return Object.keys(v).length > 0
  return Boolean(v)
}

// obj is a value read as an object, an empty one when the value is false.
function obj(v: unknown, what: string): Obj {
  if (!truthy(v)) return {}
  if (!isObj(v)) throw new ShapeError(`${what} is not an object`)
  return v
}

// key is a value as a key of a set or a map; an object or a list is none.
function key(v: unknown, what: string): string {
  if (v === null || v === undefined) return 'none'
  if (typeof v === 'string') return 's:' + v
  if (typeof v === 'number' || typeof v === 'boolean') return 'n:' + Number(v)
  throw new ShapeError(`${what} is not a name`)
}

function num(v: unknown, what: string): number {
  if (typeof v === 'number' || typeof v === 'boolean') return Number(v)
  throw new ShapeError(`${what} is not a number`)
}

function length(v: unknown, what: string): number {
  if (typeof v === 'string') return Array.from(v).length
  if (Array.isArray(v)) return v.length
  if (isObj(v)) return Object.keys(v).length
  throw new ShapeError(`${what} has no length`)
}

// text is a value as Python's str writes it, which is the size the report counts for a block that is
// no object.
function text(v: unknown): string {
  if (v === null || v === undefined) return 'None'
  if (v === true) return 'True'
  if (v === false) return 'False'
  if (typeof v === 'string') return v
  if (typeof v === 'number') return String(v)
  if (Array.isArray(v)) return '[' + v.map(repr).join(', ') + ']'
  return '{' + Object.entries(v as Obj).map(([k, x]) => `${repr(k)}: ${repr(x)}`).join(', ') + '}'
}

function repr(v: unknown): string {
  return typeof v === 'string' ? `'${v.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'` : text(v)
}

// stripHeredocs drops heredoc bodies, so a script passed to python or jq cannot look like a shell read.
// A `<<TAG` whose terminator never comes is not a heredoc (it is a quoted `<<` somewhere in the
// command), and the lines after it are kept: dropping them would hide real shell reads.
function stripHeredocs(command: string): string {
  const out: string[] = []
  const lines = command.split('\n')
  let i = 0
  while (i < lines.length) {
    const line = lines[i] as string
    out.push(line)
    const match = heredoc.exec(line)
    i++
    if (!match) continue
    let end = -1
    for (let j = i; j < lines.length; j++) {
      if (strip(lines[j] as string) === match[2]) {
        end = j
        break
      }
    }
    if (end >= 0) i = end + 1 // skip the body and the delimiter line
  }
  return out.join('\n')
}

// split is every shell segment with the separator that ended it, ignoring quoted separators: a `;` or a
// newline inside `git commit -m "... sleep ..."` is text, not a separator.
function split(t: string): [string, string][] {
  const parts: [string, string][] = []
  let current = ''
  let quote: string | null = null
  let i = 0
  while (i < t.length) {
    const c = t[i] as string
    const pair = t.slice(i, i + 2)
    if (c === '\\' && i + 1 < t.length && quote !== "'") {
      current += pair
      i += 2
      continue
    }
    if (quote) {
      current += c
      if (c === quote) quote = null
    } else if (c === "'" || c === '"') {
      current += c
      quote = c
    } else if (pair === '&&' || pair === '||') {
      parts.push([current, pair])
      current = ''
      i++
    } else if ('|;&\n'.includes(c)) {
      parts.push([current, c])
      current = ''
    } else current += c
    i++
  }
  parts.push([current, ''])
  return parts
}

// commands are the commands a shell call runs, without the ones that only receive a pipe. `git log |
// cat` reads no file and `grep sleep x` is no sleep: only what stands at the head of a segment counts,
// after the shell keyword that may precede it (`do sleep 5`).
function commands(command: unknown): string[] {
  if (typeof command !== 'string') throw new ShapeError('a shell command is not text')
  const out: string[] = []
  let pipedInto = false
  for (const [part, separator] of split(stripHeredocs(command))) {
    if (!pipedInto) {
      let segment = strip(part).replace(/^[({ ]+/, '')
      while (segmentPrefix.test(segment)) segment = segment.replace(segmentPrefix, '')
      out.push(segment)
    }
    pipedInto = separator === '|'
  }
  return out
}

// readsFiles says whether the command prints file content into the context (cat, sed -n, head, ...). A
// segment that redirects its output to a file writes instead of reading: `cat <<'EOF' > new.py` and
// `cat a b > merged` add nothing to the context. A redirect of stderr does not count as one, so `cat
// missing.md 2>/dev/null` stays a read.
function readsFiles(command: unknown): boolean {
  return commands(command).some((s) => fileReaders.test(s) && !stdoutRedirect.test(s))
}

function sleeps(command: unknown): boolean {
  return commands(command).some((s) => sleep.test(s))
}

function contextTokens(usage: Obj): number {
  const of = (k: string) => (k in usage ? num(usage[k], `usage.${k}`) : 0)
  return of('input_tokens') + of('cache_read_input_tokens') + of('cache_creation_input_tokens')
}

// resultText is the characters a tool result added to the context.
function resultText(content: unknown): number {
  if (typeof content === 'string') return length(content, 'a result')
  if (Array.isArray(content)) {
    return content.reduce<number>((n, b) => n + (isObj(b) ? ('text' in b ? length(b.text, 'a result text') : 0) : Array.from(text(b)).length), 0)
  }
  return 0
}

// blocks are the content blocks of a message; a message whose content is plain text has none.
function blocks(message: Obj): Obj[] {
  const content = message.content
  return Array.isArray(content) ? content.filter(isObj) : []
}

function message(record: Obj): Obj {
  return obj(record.message, 'a message')
}

// promptText is the text of a user record, whether its content is a string or text blocks.
function promptText(record: Obj): string {
  const content = message(record).content
  if (typeof content === 'string') return content
  return blocks(message(record))
    .filter((b) => b.type === 'text')
    .map((b) => {
      const t = 'text' in b ? b.text : ''
      if (typeof t !== 'string') throw new ShapeError('a text block holds no text')
      return t
    })
    .join(' ')
}

// invokesSkill says whether this record invokes a skill the pattern names, `worker:` or `planner:`. A skill is invoked by the agent
// through the Skill tool, or by the maintainer as a slash command, which the transcript marks with
// `<command-name>`. Prose that merely names the skill does not invoke it.
function invokesSkill(record: Obj, skill: RegExp): boolean {
  const texts = blocks(message(record))
    .filter((b) => b.type === 'tool_use' && (b.name === 'Skill' || b.name === 'SlashCommand'))
    .map((b) => JSON.stringify(truthy(b.input) ? b.input : {}))
  if (record.type === 'user') for (const m of promptText(record).matchAll(commandName)) texts.push(m[1] as string)
  return texts.some((t) => skill.test(t))
}

// readRecords is every JSON record of a transcript, in order. It splits on \n alone: a record may carry
// \x0b, \x1e or U+2028 inside a string.
function readRecords(path: string): Obj[] {
  const records: Obj[] = []
  readFileSync(path, 'utf8')
    .split('\n')
    .forEach((line, i) => {
      if (!strip(line)) return
      let record: unknown
      try {
        record = JSON.parse(line)
      } catch {
        throw new FormatError(`line ${i + 1} is not JSON`, null, true)
      }
      if (!isObj(record)) throw new FormatError(`line ${i + 1} is not a JSON object`)
      records.push(record)
    })
  return records
}

// checkTranscript refuses a transcript whose records no longer carry what every measurement reads. It
// is false for a session that never got an answer: nothing to measure, and no format change.
function checkTranscript(records: Obj[], version: unknown): boolean {
  const assistants = records.filter((r) => r.type === 'assistant' && !truthy(r.isSidechain))
  if (assistants.length === 0) return false
  if (!assistants.some((r) => blocks(message(r)).length > 0)) throw new FormatError('no assistant record with a message content list', version)
  const carries = (u: unknown) => (typeof u === 'string' || Array.isArray(u) ? u.includes('input_tokens') : 'input_tokens' in obj(u, 'a usage'))
  if (!assistants.some((r) => carries(truthy(message(r).usage) ? message(r).usage : {})))
    throw new FormatError('no assistant record carries `message.usage.input_tokens`', version)
  return true
}

// checkToolCalls refuses a session whose tool calls stopped parsing, but not one that made none. A worker
// aborted after its first question ran no tool at all. The evidence that a call is there but unread is
// the `toolUseResult` field beside the message: every answered call carries it.
function checkToolCalls(records: Obj[], calls: number, answered: number, version: unknown) {
  if (!records.some((r) => !truthy(r.isSidechain) && r.toolUseResult !== undefined && r.toolUseResult !== null)) return
  if (!calls) throw new FormatError('records carry `toolUseResult` but no `tool_use` block was found', version)
  if (!answered) throw new FormatError('records carry `toolUseResult` but no `tool_result` block matches a `tool_use` id', version)
}

type Kind = 'plan' | 'work'

interface Row {
  session: string
  kind: Kind
  start: string
  label: string
  version: string
  read: number
  edit: number
  write: number
  shell: number
  sleep: number
  turns: number
  peak: number
  shellread: number
  answers: number
  cached: number
  uncached: number
  output: number
  resume: number | undefined
}

// stem is the file name without its last suffix.
function stem(path: string): string {
  const name = basename(path)
  const dot = name.lastIndexOf('.')
  return dot > 0 && dot < name.length - 1 ? name.slice(0, dot) : name
}

// load parses one transcript into a row, or undefined when it is neither a planning nor a worker session.
function load(path: string): Row | undefined {
  const records = readRecords(path)
  if (records.length === 0) return undefined // an empty file: a session that wrote nothing
  const version = records.find((r) => truthy(r.version))?.version
  if (version === undefined) throw new FormatError('no record carries a `version` field')
  try {
    if (!checkTranscript(records, version)) return undefined
    return measure(records, path, text(version))
  } catch (err) {
    if (err instanceof ShapeError || err instanceof TypeError) throw new FormatError(`a record has a shape this report cannot read (${err.message})`, version)
    throw err
  }
}

function first(records: Obj[], field: string, when: (r: Obj) => boolean = () => true): string | undefined {
  const r = records.find((r) => when(r) && truthy(r[field]))
  return r === undefined ? undefined : text(r[field])
}

// isAnswer says whether a user record is a message of the maintainer: text, not a tool result, and not a
// record Claude Code writes itself.
function isAnswer(record: Obj): boolean {
  if (record.type !== 'user' || truthy(record.isMeta) || truthy(record.isCompactSummary) || truthy(record.toolUseResult)) return false
  const content = message(record).content
  if (typeof content === 'string') return strip(content) !== ''
  const bs = blocks(message(record))
  return bs.some((b) => b.type === 'text') && !bs.some((b) => b.type === 'tool_result')
}

// median is the middle of the values, the mean of the two middles for an even count.
function median(values: number[]): number | undefined {
  if (values.length === 0) return undefined
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? (sorted[mid] as number) : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2
}

// kindOf is the kind of the session: the plugin its transcript is attributed to, else the plugin whose
// skills it invokes.
function kindOf(records: Obj[]): Kind | undefined {
  if (records.some((r) => r.attributionPlugin === 'worker')) return 'work'
  if (records.some((r) => r.attributionPlugin === 'planner')) return 'plan'
  const main = records.filter((r) => !truthy(r.isSidechain))
  if (main.some((r) => invokesSkill(r, skills.work))) return 'work'
  if (main.some((r) => invokesSkill(r, skills.plan))) return 'plan'
  return undefined
}

// measure is the row for a planning or worker session, or undefined when the session is neither.
function measure(records: Obj[], path: string, version: string): Row | undefined {
  const tools = { read: 0, edit: 0, write: 0, shell: 0, sleep: 0 }
  const pending = new Map<string, [unknown, unknown]>()
  // The usage of each turn by its id: the transcript repeats one model message on each of its content
  // blocks, so a turn is a message and its last record carries its usage.
  const turns = new Map<string, Obj>()
  const resumes: number[] = []
  let peak = 0
  let outputChars = 0
  let shellReadChars = 0
  let calls = 0
  let answered = 0
  let answers = 0
  let afterAnswer = false

  for (const record of records) {
    if (truthy(record.isSidechain)) continue
    const m = message(record)
    if (record.type === 'assistant') {
      const usage = truthy(m.usage) ? m.usage : {}
      const carries = typeof usage === 'string' || Array.isArray(usage) ? usage.includes('input_tokens') : 'input_tokens' in obj(usage, 'a usage')
      if (carries) {
        const u = obj(usage, 'a usage')
        const context = contextTokens(u)
        peak = Math.max(peak, context)
        const id = key(truthy(record.requestId) ? record.requestId : truthy(m.id) ? m.id : record.uuid, 'a turn id')
        if (afterAnswer && !turns.has(id)) {
          // The first model turn after a maintainer message: the share of its context written to the
          // cache anew, near zero when the cache survived the resume.
          const created = 'cache_creation_input_tokens' in u ? num(u.cache_creation_input_tokens, 'usage.cache_creation_input_tokens') : 0
          if (context > 0) resumes.push(created / context)
          afterAnswer = false
        }
        turns.set(id, u)
      }
      for (const block of blocks(m)) {
        if (block.type !== 'tool_use') continue
        calls++
        const name = block.name
        const args = isObj(block.input) ? block.input : {}
        const command = truthy(args.command) ? args.command : ''
        pending.set(key(block.id, 'a tool id'), [name, command])
        const tool = key(name, 'a tool name')
        const named = (set: Set<string>) => tool.startsWith('s:') && set.has(tool.slice(2))
        if (named(readTools)) tools.read++
        else if (named(editTools)) tools.edit++
        else if (named(writeTools)) tools.write++
        else if (named(shellTools)) {
          tools.shell++
          if (sleeps(command)) tools.sleep++
        }
      }
    } else if (turns.size > 0 && isAnswer(record)) {
      answers++
      afterAnswer = true
    }
    for (const block of blocks(m)) {
      if (block.type !== 'tool_result') continue
      const [name, command] = pending.get(key(block.tool_use_id, 'a tool id')) ?? [null, null]
      if (name === null || name === undefined) continue // a result whose call is not in this transcript says nothing about the mix
      answered++
      if (name === 'BashOutput') continue // polls a background call: its output cannot be attributed to a command
      const size = resultText(block.content)
      outputChars += size
      if (typeof name === 'string' && shellTools.has(name) && readsFiles(command)) shellReadChars += size
    }
  }

  const kind = kindOf(records)
  if (kind === undefined) return undefined
  checkToolCalls(records, calls, answered, version)
  const sum = (field: string) => [...turns.values()].reduce((n, u) => n + (field in u ? num(u[field], `usage.${field}`) : 0), 0)
  return {
    session: Array.from(stem(path)).slice(0, 8).join(''),
    kind,
    start: first(records, 'timestamp') ?? '',
    label: first(records, 'agentName', (r) => r.type === 'agent-name') ?? first(records, 'gitBranch') ?? '-',
    version,
    ...tools,
    turns: turns.size,
    peak,
    shellread: outputChars ? shellReadChars / outputChars : 0,
    answers,
    cached: sum('cache_read_input_tokens'),
    uncached: sum('input_tokens') + sum('cache_creation_input_tokens'),
    output: sum('output_tokens'),
    resume: median(resumes),
  }
}

function expandUser(p: string): string {
  return p === '~' || p.startsWith('~/') ? homedir() + p.slice(1) : p
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}

function jsonl(dir: string): string[] {
  try {
    return readdirSync(dir)
      .filter((n) => n.endsWith('.jsonl'))
      .sort()
      .map((n) => join(dir, n))
  } catch {
    return []
  }
}

// transcripts are the files the arguments name, or with none the transcripts of the worktree projects
// under ~/.claude/projects, or $CLAUDE_CONFIG_DIR/projects.
function transcripts(args: string[]): string[] {
  if (args.length > 0) return args.flatMap((a) => (isDir(expandUser(a)) ? jsonl(expandUser(a)) : [expandUser(a)]))
  const projects = join(expandUser(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude')), 'projects')
  let dirs: string[]
  try {
    dirs = readdirSync(projects).filter((n) => n.includes('worktrees')).sort()
  } catch {
    return []
  }
  return dirs.flatMap((d) => jsonl(join(projects, d)))
}

// fixed writes x with the given digits after the point, a tie rounded to the even digit as Python does.
function fixed(x: number, digits: 0 | 1): string {
  const scale = digits === 0 ? 2 : 4 // a tie is x = odd/2, or x = odd/4 for one digit
  const tie = Number.isInteger(x * scale) && (x * scale) % 2 !== 0
  if (!tie) return x.toFixed(digits)
  const lower = Math.floor(x * 10 ** digits)
  return ((lower % 2 === 0 ? lower : lower + 1) / 10 ** digits).toFixed(digits)
}

// thousands is a context size as the maintainer reads it: 96.2k.
function thousands(value: number): string {
  return `${fixed(value / 1000, 1)}k`
}

const columns: [string, (r: Row) => string][] = [
  ['session', (r) => r.session],
  ['kind', (r) => r.kind],
  ['version', (r) => r.version],
  ['turns', (r) => String(r.turns)],
  ['answers', (r) => String(r.answers)],
  ['peak', (r) => thousands(r.peak)],
  ['cached', (r) => thousands(r.cached)],
  ['uncached', (r) => thousands(r.uncached)],
  ['output', (r) => thousands(r.output)],
  ['resume', (r) => (r.resume === undefined ? '-' : `${fixed(r.resume * 100, 1)}%`)],
  ['shellread', (r) => `${fixed(r.shellread * 100, 0)}%`],
  ['read', (r) => String(r.read)],
  ['edit', (r) => String(r.edit)],
  ['write', (r) => String(r.write)],
  ['shell', (r) => String(r.shell)],
  ['sleep', (r) => String(r.sleep)],
  ['label', (r) => r.label],
]

// printable keeps every control character of a transcript off the maintainer's terminal.
function printable(cell: string): string {
  return cell.replace(/[^\x20-\x7e]/gu, '?')
}

function render(rows: Row[]): string[] {
  const heads = columns.map(([h]) => h)
  const table = rows.map((r) => columns.map(([, cell]) => printable(cell(r))))
  const widths = heads.map((h, i) => Math.max(h.length, ...table.map((l) => (l[i] as string).length)))
  return [heads, ...table].map((l) => l.map((c, i) => c.padEnd(widths[i] as number)).join('  ').trimEnd())
}

const reasons: Record<string, string> = {
  ENOENT: 'No such file or directory',
  EACCES: 'Permission denied',
  EISDIR: 'Is a directory',
  ENOTDIR: 'Not a directory',
  ELOOP: 'Too many levels of symbolic links',
}

// contextReport prints the report of the transcripts the arguments name and answers the exit code.
export function contextReport(args: string[], out: (s: string) => void, err: (s: string) => void): number {
  const rows: Row[] = []
  let failed = false
  for (const path of transcripts(args)) {
    let row: Row | undefined
    try {
      row = load(path)
    } catch (e) {
      failed = true
      if (e instanceof FormatError) {
        if (e.unreadable) err(`error: ${path}: unreadable transcript (${e.detail}); a truncated or half-written session file, skipped\n`)
        else
          err(
            `error: ${path}: transcript format not understood (${e.detail}); the Claude Code session transcript format is internal and has changed (transcript written by Claude Code ${truthy(e.version) ? text(e.version) : 'unknown'}, this report is written against ${knownVersion}); update controller/src/sessions/context-report.ts\n`,
          )
        continue
      }
      const code = (e as NodeJS.ErrnoException).code
      if (code === undefined) throw e
      err(`error: ${path}: cannot be read (${reasons[code] ?? code}); pass a transcript file or a directory of transcripts\n`)
      continue
    }
    if (row) rows.push(row)
  }
  out(`# context report: a diagnostic over Claude Code's internal session transcript format (written against ${knownVersion}), never an input to the pipeline.\n`)
  out('# kind: plan or work. answers: the maintainer\'s messages. peak: the session\'s maximum context tokens.\n')
  out('# cached, uncached, output: input tokens read from cache, input tokens not read from cache and output tokens, summed over the turns.\n')
  out('# resume: median share of the context re-cached at the first turn after an answer. shellread: share of tool output read from files through the shell.\n')
  if (rows.length === 0) {
    out('# no planning or worker session found\n')
    return failed ? 1 : 0
  }
  rows.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : a.session < b.session ? -1 : a.session > b.session ? 1 : 0))
  for (const line of render(rows)) out(line + '\n')
  return failed ? 1 : 0
}
