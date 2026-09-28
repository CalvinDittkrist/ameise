import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { api, canApi, canIssue, canPages, canPulls, checkout, cleanup, type Machine, machine, play, read, record, script, start } from './controller.js'

afterEach(cleanup)

let m: Machine
let dir: string
beforeEach(async () => {
  m = await machine()
  const s = await start(m)
  expect(s.running, s.stderr).toBe(true)
  dir = checkout(m, 'repo', { origin: 'https://github.com/owner/repo.git', originHead: 'main' })
  canPulls(m, 'owner/repo', [])
  canApi(m, 'repos/owner/repo/issues?labels=ready-for-agent&state=open&per_page=100', [])
  canApi(m, 'repos/owner/repo/issues?labels=spec&state=open&per_page=100', [])
  canPages(m, 'repos/owner/repo/branches?per_page=100', [[]])
  expect((await api(m, 'POST', '/api/projects', { path: dir })).status).toBe(201)
  canIssue(m, 'owner/repo', 144, 'Board lists every project', ['ready-for-agent'])
})

interface Record {
  id: string
  state: string
  note: string
  worktree: string
  session_id?: string
  context?: number
  allowed?: string[]
  compact_at?: number
}

interface Entry {
  seq: number
  kind: string
  request?: string
  text?: string
  answer?: string
  tool?: string
  detail?: string
  questions?: { question: string; options: { label: string }[] }[]
  state?: string
}

const claim = async (): Promise<Record> => {
  const r = await api(m, 'POST', '/api/processes', { project: dir, issue: 144 })
  expect(r.status, JSON.stringify(r.body)).toBe(201)
  return (r.body as { record: Record }).record
}

const recordOf = (id: string) => JSON.parse(read(join(m.state, 'processes', `${id}.json`))) as Record

// until waits for what the check answers to be true, or fails with what it last saw.
async function until<T>(what: string, look: () => T, ok: (v: T) => boolean): Promise<T> {
  let v = look()
  for (let i = 0; i < 200 && !ok(v); i++) {
    await new Promise((done) => setTimeout(done, 50))
    v = look()
  }
  if (!ok(v)) throw new Error(`${what}: ${JSON.stringify(v)}`)
  return v
}

const inState = (id: string, state: string) => until(`the process to be ${state}`, () => recordOf(id), (r) => r.state === state)

// Page is a process page as the stream serves it: the record and the entries it has read so far.
interface Page {
  record: () => Record
  entries: () => Entry[]
  gone: () => boolean
  close: () => void
}

// follow reads the stream of a process's page as the dashboard's EventSource does.
async function follow(id: string): Promise<Page> {
  const abort = new AbortController()
  const res = await fetch(`${m.url}/api/processes/events?id=${id}`, { signal: abort.signal })
  expect(res.status).toBe(200)
  expect(res.headers.get('content-type')).toBe('text/event-stream')
  let record: Record | undefined
  const entries: Entry[] = []
  let gone = false
  let loaded = false
  const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader()
  void (async () => {
    let buffer = ''
    try {
      for (;;) {
        const { value, done } = await reader.read()
        if (done) return
        buffer += value
        let i: number
        while ((i = buffer.indexOf('\n\n')) >= 0) {
          const block = buffer.slice(0, i)
          buffer = buffer.slice(i + 2)
          const name = /^event: (.*)$/m.exec(block)?.[1]
          const data = /^data: (.*)$/m.exec(block)?.[1]
          if (!name || data === undefined) continue
          if (name === 'record') record = JSON.parse(data) as Record
          if (name === 'entries') entries.push(...(JSON.parse(data) as Entry[]))
          if (name === 'entries') loaded = true
          if (name === 'gone') gone = true
        }
      }
    } catch {
      // the page was closed
    }
  })()
  // The page is open once it has the record and the conversation so far.
  await until('the page to read the record and the log', () => loaded && record !== undefined, (ok) => ok)
  return { record: () => record!, entries: () => entries, gone: () => gone, close: () => abort.abort() }
}

const card = (page: Page, kind: string) => until(`a ${kind} card`, () => page.entries().find((e) => e.kind === kind), (e) => e !== undefined) as Promise<Entry>
const said = (page: Page, text: string) => until(`the session to say ${text}`, () => page.entries().filter((e) => e.kind === 'text').map((e) => e.text), (t) => t.includes(text))

test('a permission request is a card of the page that waits for its answer, and allow once lets the call run', async () => {
  play(m, 'permit git push origin HEAD\nready Pushed')
  const r = await claim()
  const page = await follow(r.id)
  const permission = await card(page, 'permission')
  expect(permission).toMatchObject({ tool: 'Bash', detail: 'git push origin HEAD', title: 'Bash wants to run', reason: 'The classifier did not settle it.' })

  // The session waits, and the process waits for the maintainer under needs you.
  await inState(r.id, 'approval')
  await new Promise((done) => setTimeout(done, 500))
  expect(recordOf(r.id).state).toBe('approval')
  const board = (await api(m, 'GET', '/api/board?' + new URLSearchParams({ project: dir }).toString())).body as { processes: { state: string; needs: boolean; action: string }[] }
  expect(board.processes).toMatchObject([{ state: 'approval', needs: true, action: 'Approve' }])
  expect(page.record().state).toBe('approval')

  const a = await api(m, 'POST', '/api/processes/answer', { id: r.id, request: permission.request, answer: 'once' })
  expect(a.status, JSON.stringify(a.body)).toBe(200)
  await said(page, 'Ran git push origin HEAD.')
  expect(await inState(r.id, 'ready')).toMatchObject({ note: 'Pushed' })
  expect(page.entries()).toContainEqual(expect.objectContaining({ kind: 'answer', request: permission.request, answer: 'once' }))
  expect(page.entries().at(-1)).toMatchObject({ kind: 'end', state: 'ready', note: 'Pushed' })
  // The answer is in the log, and the session was told to run the call as it asked.
  expect(read(join(m.state, 'processes', `${r.id}.events.jsonl`))).toContain(`"event":"answer","request":"${permission.request}","answer":"once"`)
  const response = read(m.claudeLog).split('\n').find((l) => l.includes('"type":"control_response"')) ?? ''
  expect(response).toContain('"behavior":"allow"')
  expect(response).not.toContain('updatedPermissions')
  page.close()
})

test('deny tells the session the call may not run', async () => {
  play(m, 'permit rm -rf build\nready done')
  const r = await claim()
  const page = await follow(r.id)
  const permission = await card(page, 'permission')
  expect((await api(m, 'POST', '/api/processes/answer', { id: r.id, request: permission.request, answer: 'deny' })).status).toBe(200)
  await said(page, 'Did not run rm -rf build.')
  await inState(r.id, 'ready')
  // A request that was answered takes no second answer.
  const again = await api(m, 'POST', '/api/processes/answer', { id: r.id, request: permission.request, answer: 'once' })
  expect(again.status).toBe(409)
  page.close()
})

test('allow for this process lets the same call run again without a card, and never reaches a settings file', async () => {
  play(m, 'permit npm test\npermit npm test\nready done')
  const r = await claim()
  const page = await follow(r.id)
  const permission = await card(page, 'permission')
  expect((await api(m, 'POST', '/api/processes/answer', { id: r.id, request: permission.request, answer: 'process' })).status).toBe(200)
  await inState(r.id, 'ready')
  expect(page.entries().filter((e) => e.kind === 'permission')).toHaveLength(1)
  expect(page.entries()).toContainEqual(expect.objectContaining({ kind: 'allowed', tool: 'Bash', detail: 'npm test' }))
  expect(page.entries().filter((e) => e.text === 'Ran npm test.')).toHaveLength(2)
  expect(recordOf(r.id).allowed).toEqual(['rule Bash(npm test)'])
  // The rule the runtime suggested for the local settings is held to the session.
  const responses = read(m.claudeLog).split('\n').filter((l) => l.includes('"type":"control_response"'))
  expect(responses[0]).toContain('"updatedPermissions":[{"type":"addRules","rules":[{"toolName":"Bash","ruleContent":"npm test"}],"behavior":"allow","destination":"session"}]')
  expect(existsSync(join(r.worktree, '.claude', 'settings.local.json'))).toBe(false)
  page.close()
})

test('a question is a card, and the chat answer lets the session go on', async () => {
  play(m, 'ask Keep the old flag, or drop it?\nready done')
  const r = await claim()
  const page = await follow(r.id)
  const question = await card(page, 'question')
  expect(question.questions).toMatchObject([{ question: 'Keep the old flag, or drop it?', options: [{ label: 'Keep' }, { label: 'Drop' }] }])
  expect(await inState(r.id, 'input')).toMatchObject({ note: 'Keep the old flag, or drop it?' })
  const board = (await api(m, 'GET', '/api/board?' + new URLSearchParams({ project: dir }).toString())).body as { processes: { needs: boolean; action: string }[] }
  expect(board.processes).toMatchObject([{ needs: true, action: 'Continue' }])

  const s = await api(m, 'POST', '/api/processes/message', { id: r.id, text: 'Drop' })
  expect(s.body).toMatchObject({ delivered: 'answered' })
  await said(page, 'You answered: Drop.')
  await inState(r.id, 'ready')
  expect(page.entries()).toContainEqual(expect.objectContaining({ kind: 'answer', request: question.request, text: 'Drop' }))
  page.close()
})

test('a message written while the session works arrives as its next turn', async () => {
  play(m, 'wait\nready done')
  const r = await claim()
  const page = await follow(r.id)
  await said(page, 'Working on it.')
  const s = await api(m, 'POST', '/api/processes/message', { id: r.id, text: 'Name it --keep' })
  expect(s.body).toMatchObject({ delivered: 'sent' })
  await said(page, 'You wrote: Name it --keep.')
  await inState(r.id, 'ready')
  expect(page.entries()).toContainEqual(expect.objectContaining({ kind: 'you', text: 'Name it --keep' }))
  page.close()
})

test('a message to a blocked process resumes its session by its id', async () => {
  play(m, 'blocked Keep the old flag, or drop it?')
  writeFileSync(join(m.claude, 'resume'), 'say Dropping it.\nready Dropped the flag\n')
  const r = await claim()
  const blocked = await inState(r.id, 'blocked')
  const s = await api(m, 'POST', '/api/processes/message', { id: r.id, text: 'Drop it' })
  expect(s.body).toMatchObject({ delivered: 'resumed' })
  expect(await inState(r.id, 'ready')).toMatchObject({ note: 'Dropped the flag', session_id: blocked.session_id })
  expect(read(m.claudeLog).split('\n')).toContain(`--resume=${blocked.session_id}`)
  const page = await follow(r.id)
  expect(page.entries().map((e) => e.kind)).toEqual(['start', 'text', 'end', 'you', 'start', 'text', 'text', 'end'])
  expect(page.entries().filter((e) => e.kind === 'text').map((e) => e.text)).toEqual(['Working on it.', 'Working on it.', 'Dropping it.'])
  page.close()
})

test('the context size follows the usage of the session', async () => {
  play(m, 'usage 84000\nsay Read the files.\nwait\nusage 120000\nsay Wrote the reader.\nready done')
  const r = await claim()
  const page = await follow(r.id)
  await until('the context of the first reading', () => page.record().context, (c) => c === 84001)
  expect(page.record().compact_at).toBe(250000)
  await api(m, 'POST', '/api/processes/message', { id: r.id, text: 'go on' })
  await until('the context of the second reading', () => page.record().context, (c) => c === 120001)
  expect((await inState(r.id, 'ready')).context).toBe(120001)
  page.close()
})

test('the page follows the log live and learns that its process is gone', async () => {
  const r = await claim()
  const page = await follow(r.id)
  await said(page, 'Working on it.')
  expect(page.entries()[0]).toMatchObject({ kind: 'start' })
  expect((await api(m, 'DELETE', '/api/processes', { project: dir, issue: 144 })).status).toBe(200)
  await until('the page to learn its process is gone', () => page.gone(), (g) => g)
})

test('the conversation shows the session text and its tool calls as chips, and leaves out results, thinking and subagents', async () => {
  const tree = join(dir, '.claude', 'worktrees', 'feat-144-x')
  record(m, 'p144', { project: dir, kind: 'work', branch: 'feat/144-x', issue: 144, worktree: tree, stage: 'implement', state: 'running', note: '' })
  const assistant = (content: object[], parent: string | null = null) => ({ event: 'stream', message: { type: 'assistant', parent_tool_use_id: parent, message: { content } } })
  const log = [
    { event: 'claimed' },
    assistant([{ type: 'thinking', thinking: 'hm' }, { type: 'text', text: 'Reading the reader first.' }]),
    assistant([{ type: 'tool_use', name: 'Read', input: { file_path: `${tree}/src/config.ts` } }, { type: 'tool_use', name: 'Bash', input: { command: 'npx vitest run\n  test/config.test.ts' } }]),
    { event: 'stream', message: { type: 'user', message: { content: [{ type: 'tool_result', content: 'SECRET-FILE-TEXT' }] } } },
    assistant([{ type: 'text', text: 'SUBAGENT-TEXT' }], 'toolu-1'),
    assistant([{ type: 'tool_use', name: 'Agent', input: { description: 'Review the diff', subagent_type: 'code-reviewer' } }, { type: 'tool_use', name: 'mcp__x__y', input: { query: 'q' } }]),
    'not json',
    { event: 'session-end', state: 'blocked', note: 'Which name?' },
  ]
  writeFileSync(join(m.state, 'processes', 'p144.events.jsonl'), log.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n')
  const page = await follow('p144')
  expect(page.entries()).toEqual([
    { seq: 1, kind: 'text', text: 'Reading the reader first.' },
    { seq: 2, kind: 'tool', name: 'Read', detail: 'src/config.ts' },
    { seq: 2, kind: 'tool', name: 'Bash', detail: 'npx vitest run test/config.test.ts' },
    { seq: 5, kind: 'tool', name: 'Agent', detail: 'Review the diff' },
    { seq: 5, kind: 'tool', name: 'mcp__x__y', detail: 'q' },
    { seq: 7, kind: 'end', state: 'blocked', note: 'Which name?' },
  ])
  page.close()
})

// terminal configures the command that opens a terminal window with the script it is given.
function terminal(body: string): string {
  const path = join(m.root, 'terminal')
  script(path, body)
  writeFileSync(m.config, JSON.stringify({ ...(JSON.parse(read(m.config)) as object), terminal: path }))
  return path
}

test('open in terminal resumes the session by its id in the worktree, and tells a terminal that fails', async () => {
  play(m, 'blocked Which name?')
  const r = await claim()
  const done = await inState(r.id, 'blocked')

  terminal('echo "no display" >&2; exit 1')
  expect(await api(m, 'POST', '/api/processes/terminal', { id: r.id })).toMatchObject({ status: 502, body: { error: expect.stringMatching(/the terminal did not open: .*terminal: no display$/) } })

  const opened = join(m.root, 'terminal.log')
  terminal(`printf '%s\\n' "$1" >> '${opened}'`)
  const t = await api(m, 'POST', '/api/processes/terminal', { id: r.id })
  expect(t.status, JSON.stringify(t.body)).toBe(200)
  const file = read(opened).trim()
  expect(file).toBe((t.body as { script: string }).script)
  const body = readFileSync(file, 'utf8')
  expect(body).toContain(`cd '${done.worktree}' || exit 1`)
  expect(body).toMatch(new RegExp(`^exec '[^']+/fake/claude' '--resume' '${done.session_id}' '--plugin-dir' '[^']+/plugins/worker' '--agent' 'worker' '--settings' '\\{"env":\\{"WF_MODE":"manual","WF_ISSUE":"144"`, 'm'))
})

test('open in terminal refuses a process whose session never started', async () => {
  const opened = join(m.root, 'terminal.log')
  terminal(`printf '%s\\n' "$1" >> '${opened}'`)
  play(m, 'broken claude: not logged in')
  const r = await claim()
  await inState(r.id, 'failed')
  expect(await api(m, 'POST', '/api/processes/terminal', { id: r.id })).toMatchObject({ status: 409, body: { error: 'the process has no session yet; wait until its session has started' } })
  expect(existsSync(opened)).toBe(false)
})

test('the conversation routes refuse what names no process, no text and no answer', async () => {
  expect(await api(m, 'POST', '/api/processes/message', { id: '../config', text: 'hi' })).toMatchObject({ status: 400 })
  expect(await api(m, 'POST', '/api/processes/message', { id: 'work-1-none', text: 'hi' })).toMatchObject({ status: 404 })
  expect((await fetch(`${m.url}/api/processes/events?id=work-1-none`)).status).toBe(404)
  play(m, 'permit ls\nready done')
  const r = await claim()
  expect(await api(m, 'POST', '/api/processes/message', { id: r.id, text: '  ' })).toMatchObject({ status: 400, body: { error: 'text is empty; write the message to send' } })
  expect(await api(m, 'POST', '/api/processes/answer', { id: r.id, request: 'x', answer: 'always' })).toMatchObject({ status: 400 })
  expect(await api(m, 'POST', '/api/processes/answer', { id: r.id, request: 'x', answer: 'once' })).toMatchObject({ status: 409 })
})
