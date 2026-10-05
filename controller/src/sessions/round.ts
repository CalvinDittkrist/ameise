// The controller tool ask: a question round to the maintainer. The controller registers it in a
// process's own session as the in-process MCP server controller, so the session calls
// mcp__controller__ask. A round holds 1 to 12 questions, each with a title and its text, and optionally
// up to 6 labels to choose from, a recommended answer with its reason, and whether several labels may be
// chosen. AskUserQuestion takes at most 4 questions of 2 to 4 options and has no field for a
// recommendation, which is why a round is a tool of its own.
//
// The call blocks until the process page answers the round, through the requests a question of the
// session waits on (session.ts). Its result is one line per question, Q<n> <title>: <answer>, which ends
// in (recommended) where the maintainer took the recommendation. A chat message while the round is open
// settles it instead, and the session reads it as the maintainer's reply.
//
// The schema gives the session the round's shape. The counts are checked here with a message that names
// the rule, because a refusal of the schema's own checks answers with the whole schema.
import { createSdkMcpServer, type McpSdkServerConfigWithInstance, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import type { RoundAnswer, RoundQuestion } from './conversation.js'
import { Refusal } from '../project.js'

// The server's name in a session, and the tool the session calls.
export const controllerServer = 'controller'
export const askTool = `mcp__${controllerServer}__ask`

const most = { questions: 12, options: 6 }

// How a round was settled: by one answer per question, by a chat message, or by the end of its session.
export type Settled = { answers: RoundAnswer[] } | { text: string } | 'closed'

// A Reply is the answer to one question as the process page sends it: the recommendation, or an answer
// of its own, a label or the text the maintainer wrote, or the labels chosen of a multi-select question.
export interface Reply {
  recommended?: boolean
  answer?: string | string[]
}

const question = z.object({
  title: z.string({ error: 'every question has a title' }).describe('a few words that name the question, as its tab shows them'),
  question: z.string({ error: 'every question has its text in question' }).describe('the question itself, in markdown'),
  options: z.array(z.string()).optional().describe(`0 to ${most.options} short labels to choose from; the maintainer may also write an answer of their own`),
  recommended: z.string().optional().describe('the answer you recommend; shown as the first option, and added as one when it is none of the options'),
  why: z.string().optional().describe('one line on why you recommend it'),
  multiSelect: z.boolean().optional().describe('true when several of the options may be chosen together'),
})

// rule is the rule a round breaks, or undefined for a round the tool asks.
function rule(questions: z.infer<typeof question>[]): string | undefined {
  if (questions.length < 1 || questions.length > most.questions) return `a round asks 1 to ${most.questions} questions; this one asks ${questions.length}`
  for (const [i, q] of questions.entries()) {
    const n = `Q${i + 1}`
    if (q.title.trim() === '') return `every question has a title; ${n} has an empty one`
    if (q.question.trim() === '') return `every question has its text in question; ${n} has an empty one`
    const options = q.options ?? []
    if (options.length > most.options) return `a question offers at most ${most.options} options; ${n} offers ${options.length}`
    if (options.some((o) => o.trim() === '')) return `every option is a label; ${n} has an empty one`
    if (new Set(options).size !== options.length) return `every option of a question is a label of its own; ${n} offers one twice`
  }
  return undefined
}

// asked is the round as the event log holds it and the process page shows it.
const asked = (questions: z.infer<typeof question>[]): RoundQuestion[] =>
  questions.map((q) => ({
    title: q.title.trim(),
    question: q.question,
    options: q.options ?? [],
    ...(q.recommended?.trim() ? { recommended: q.recommended.trim() } : {}),
    ...(q.why?.trim() ? { why: q.why.trim() } : {}),
    multiSelect: q.multiSelect === true,
  }))

// offered are the labels of a question in the order the card offers them: the recommendation first.
export const offered = (q: RoundQuestion): string[] => (q.recommended ? [q.recommended, ...q.options.filter((o) => o !== q.recommended)] : q.options)

// answered reads the replies to a round, one per question, into its answers. A reply that takes the
// recommendation answers with it; a multi-select reply joins its labels with ", " in the order offered.
// It throws a Refusal that names the question a reply does not answer.
export function answered(questions: RoundQuestion[], replies: unknown): RoundAnswer[] {
  if (!Array.isArray(replies) || replies.length !== questions.length) {
    throw new Refusal(`answers is not one answer per question; send ${questions.length}, in the order of the round`)
  }
  return questions.map((q, i) => {
    const n = `Q${i + 1}`
    const r = (replies[i] ?? {}) as Reply
    if (r.recommended === true) {
      if (!q.recommended) throw new Refusal(`${n} recommends nothing; send an answer of its own`)
      return { answer: q.recommended, recommended: true }
    }
    if (typeof r.answer === 'string' && r.answer.trim() !== '') return { answer: r.answer.trim(), recommended: false }
    if (Array.isArray(r.answer) && r.answer.length > 0) {
      const labels = offered(q)
      const stray = r.answer.find((a) => typeof a !== 'string' || !labels.includes(a))
      if (stray !== undefined) throw new Refusal(`${n} offers no option ${JSON.stringify(stray)}; choose among ${labels.join(', ')}`)
      if (!q.multiSelect && r.answer.length > 1) throw new Refusal(`${n} takes one option; choose one, or write an answer`)
      return { answer: labels.filter((l) => (r.answer as string[]).includes(l)).join(', '), recommended: false }
    }
    throw new Refusal(`${n} has no answer; take its recommendation, choose an option or write an answer`)
  })
}

// result is the text the session reads as the tool's result once the round is settled.
export function result(questions: RoundQuestion[], settled: Exclude<Settled, 'closed'>): string {
  if ('text' in settled) return `The maintainer replied: ${settled.text}`
  return questions.map((q, i) => `Q${i + 1} ${q.title}: ${settled.answers[i]?.answer ?? ''}${settled.answers[i]?.recommended ? ' (recommended)' : ''}`).join('\n')
}

// A Round asks the questions of one call and settles once the maintainer has answered them, or once the
// session has ended. signal aborts the call.
export type Round = (questions: RoundQuestion[], signal?: AbortSignal) => Promise<Settled>

// controllerTools is the server of the controller tool ask for one session, whose rounds round asks.
export function controllerTools(round: Round): McpSdkServerConfigWithInstance {
  const text = (t: string, isError = false) => ({ ...(isError ? { isError: true } : {}), content: [{ type: 'text' as const, text: t }] })
  return createSdkMcpServer({
    name: controllerServer,
    version: '1.0.0',
    tools: [
      tool(
        'ask',
        `Ask the maintainer a question round: 1 to ${most.questions} questions they answer together in the process view, each by its recommendation, one of its options or an answer of their own. The result is one line per question, Q<n> <title>: <answer>, with (recommended) where they took the recommendation. A reply in their own words answers the whole round instead: The maintainer replied: <text>.`,
        { questions: z.array(question, { error: 'questions is a list of questions' }).describe(`1 to ${most.questions} questions`) },
        async ({ questions }, extra) => {
          const broken = rule(questions)
          if (broken) return text(`error: ${broken}`, true)
          const shown = asked(questions)
          const settled = await round(shown, (extra as { signal?: AbortSignal } | undefined)?.signal)
          if (settled === 'closed') return text('The session ended before the maintainer answered.', true)
          return text(result(shown, settled))
        },
      ),
    ],
  })
}
