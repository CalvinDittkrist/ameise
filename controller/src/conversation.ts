// The conversation of a process: its event log read as the process page shows it.
// A line of the log yields any number of entries, each numbered by its line.
// The page so reads the whole log when it opens and each new line while the session runs.
// The session's text and tool calls come from the stream. The maintainer's messages, the requests,
// their answers and the end of each session come from the controller's own events.
// Tool results, subagents' messages and thinking stay in the log and out of the conversation.

// A question as the session asks it through AskUserQuestion, with the options it offers.
export interface Question {
  question: string
  header: string
  options: { label: string; description: string }[]
  multiSelect: boolean
}

// The answers a permission request takes: allow this call, allow calls like it for the rest of the
// process, or deny it.
export const answers = ['once', 'process', 'deny'] as const
export type Answer = (typeof answers)[number]

export type Entry = { seq: number } & (
  | { kind: 'text'; text: string }
  | { kind: 'tool'; name: string; detail: string }
  | { kind: 'you'; text: string }
  | { kind: 'permission'; request: string; tool: string; detail: string; title: string; reason: string }
  | { kind: 'question'; request: string; questions: Question[] }
  // An answer settles the request it names: a permission by one of the answers, a question by the text.
  | { kind: 'answer'; request: string; answer?: Answer; text?: string }
  // A call the maintainer had allowed for this process, which ran without a card.
  | { kind: 'allowed'; tool: string; detail: string }
  // A request whose session ended before it was answered.
  | { kind: 'closed'; request: string }
  | { kind: 'start'; resumed: boolean }
  | { kind: 'end'; state: string; note: string }
)

// The longest text an entry carries; the log keeps the whole.
const textLimit = 20000
const detailLimit = 300

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s)
const str = (v: unknown) => (typeof v === 'string' ? v : '')
// oneLine keeps a detail to one line: every run of white space is one space.
const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim()

// detail is the part of a tool call's input a chip shows: the command, the file, the pattern.
export function detail(tool: string, input: unknown, worktree = ''): string {
  const i = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>
  const path = (p: string) => (worktree && p.startsWith(worktree + '/') ? p.slice(worktree.length + 1) : p)
  let d: string
  switch (tool) {
    case 'Bash':
      d = str(i.command)
      break
    case 'Read':
    case 'Edit':
    case 'MultiEdit':
    case 'Write':
      d = path(str(i.file_path))
      break
    case 'NotebookEdit':
      d = path(str(i.notebook_path))
      break
    case 'Grep':
    case 'Glob':
      d = str(i.pattern)
      break
    case 'Agent':
    case 'Task':
      d = str(i.description) || str(i.subagent_type)
      break
    case 'Skill':
      d = str(i.skill) || str(i.command)
      break
    case 'WebFetch':
      d = str(i.url)
      break
    case 'WebSearch':
      d = str(i.query)
      break
    default:
      d = Object.values(i).find((v): v is string => typeof v === 'string') ?? ''
  }
  return clip(oneLine(d), detailLimit)
}

// questions reads the questions of an AskUserQuestion input, and drops what is not a question.
export function questions(input: unknown): Question[] {
  const list = (input as { questions?: unknown } | null)?.questions
  if (!Array.isArray(list)) return []
  return list.flatMap((q: unknown): Question[] => {
    const o = (q ?? {}) as Record<string, unknown>
    if (typeof o.question !== 'string') return []
    const options = Array.isArray(o.options)
      ? o.options.flatMap((x: unknown) => {
          const p = (x ?? {}) as Record<string, unknown>
          return typeof p.label === 'string' ? [{ label: p.label, description: str(p.description) }] : []
        })
      : []
    return [{ question: o.question, header: str(o.header), options, multiSelect: o.multiSelect === true }]
  })
}

interface Block {
  type?: string
  text?: string
  name?: string
  input?: unknown
}

// main is whether a stream message is the main session's own assistant message, not a subagent's.
function main(m: { type?: string; parent_tool_use_id?: unknown }): boolean {
  return m.type === 'assistant' && (m.parent_tool_use_id === null || m.parent_tool_use_id === undefined)
}

// entries are the entries of one event of the log, numbered seq.
export function entries(e: Record<string, unknown>, seq: number, worktree = ''): Entry[] {
  switch (e.event) {
    case 'stream': {
      const m = (e.message ?? {}) as { type?: string; parent_tool_use_id?: unknown; message?: { content?: unknown } }
      // A subagent's messages belong to its own conversation, which the tool chip of its call stands for.
      if (!main(m)) return []
      const content = Array.isArray(m.message?.content) ? (m.message.content as Block[]) : []
      return content.flatMap((b): Entry[] => {
        if (b.type === 'text' && typeof b.text === 'string' && b.text.trim() !== '') return [{ seq, kind: 'text', text: clip(b.text, textLimit) }]
        // A question is shown as its own card, so its call is no chip.
        if (b.type === 'tool_use' && typeof b.name === 'string' && b.name !== 'AskUserQuestion' && b.name !== 'StructuredOutput') {
          return [{ seq, kind: 'tool', name: b.name, detail: detail(b.name, b.input, worktree) }]
        }
        return []
      })
    }
    case 'message':
      return [{ seq, kind: 'you', text: clip(str(e.text), textLimit) }]
    case 'permission':
      return [{ seq, kind: 'permission', request: str(e.request), tool: str(e.tool), detail: str(e.detail), title: str(e.title), reason: str(e.reason) }]
    case 'question':
      return [{ seq, kind: 'question', request: str(e.request), questions: questions({ questions: e.questions }) }]
    case 'answer': {
      const answer = answers.find((a) => a === e.answer)
      return [{ seq, kind: 'answer', request: str(e.request), ...(answer ? { answer } : {}), ...(typeof e.text === 'string' ? { text: clip(e.text, textLimit) } : {}) }]
    }
    case 'allowed':
      return [{ seq, kind: 'allowed', tool: str(e.tool), detail: str(e.detail) }]
    case 'closed':
      return [{ seq, kind: 'closed', request: str(e.request) }]
    case 'session-start':
      return [{ seq, kind: 'start', resumed: e.resumed === true }]
    case 'session-end':
      return [{ seq, kind: 'end', state: str(e.state), note: str(e.note) }]
    default:
      return []
  }
}

// context is the size of the session's context after an event, from the usage of the main session's
// messages: everything the model read for its answer and the answer itself. It is undefined for an
// event that says nothing of it.
export function context(message: unknown): number | undefined {
  const m = (message ?? {}) as { type?: string; parent_tool_use_id?: unknown; message?: { usage?: Record<string, unknown> } }
  if (!main(m)) return undefined
  const u = m.message?.usage
  if (!u) return undefined
  const n = (k: string) => (typeof u[k] === 'number' ? u[k] : 0)
  const total = n('input_tokens') + n('cache_read_input_tokens') + n('cache_creation_input_tokens') + n('output_tokens')
  return total > 0 ? total : undefined
}
