// The maintainer's diagnostic over planning and worker transcripts: fixture in, one line per session out.
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, test } from 'vitest'
import { cleanup, cli, type Exit, machine, type Machine } from './controller.js'

afterEach(cleanup)

const fixtures = fileURLToPath(new URL('./fixtures/context-report', import.meta.url))
const workerSession = join(fixtures, 'f1a7e3aa-0000-4000-8000-000000000001.jsonl')
const unknownFormat = join(fixtures, 'deadbeef-0000-4000-8000-000000000002.jsonl')
const planningSession = join(fixtures, '5a1e0000-0000-4000-8000-00000000000d.jsonl')

type Rec = Record<string, unknown>

function report(m: Machine, args: string[], env: NodeJS.ProcessEnv = {}): Exit {
  return cli({ ...m, env: { ...m.env, ...env } }, ['context-report', ...args])
}

// rows is every session line, split into fields by column on the two-space separator, not on white
// space: a label is free text and may hold a space.
function rows(stdout: string): Record<string, string>[] {
  const lines = stdout.split('\n').filter((l) => l !== '' && !l.startsWith('#'))
  const heads = lines[0]?.split(/ {2,}/) ?? []
  return lines.slice(1).map((l) => Object.fromEntries(l.split(/ {2,}/).map((v, i) => [heads[i], v])))
}

function row(stdout: string): Record<string, string> {
  const r = rows(stdout)
  expect(r, stdout).toHaveLength(1)
  return r[0] as Record<string, string>
}

function write(dir: string, name: string, records: Rec[]): string {
  const path = join(dir, name)
  writeFileSync(path, records.map((r) => JSON.stringify(r) + '\n').join(''))
  return path
}

function records(path: string): Rec[] {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((l) => l !== '')
    .map((l) => JSON.parse(l) as Rec)
}

// withoutSkill drops the records whose message calls the Skill tool.
function withoutSkill(rs: Rec[]): Rec[] {
  return rs.filter((r) => !JSON.stringify(r.message ?? {}).includes('Skill'))
}

// shellSession is a transcript of one worker turn per command, each answering with 100 characters.
function shellSession(
  dir: string,
  commands: string[],
  { extra = [], timestamp = '2026-09-20T12:00:00.000Z', name = '0badc0de-0000-4000-8000-000000000005.jsonl' }: { extra?: Rec[]; timestamp?: string; name?: string } = {},
): string {
  const base = { version: '2.1.278', isSidechain: false, gitBranch: 'feat/42-file-tools', timestamp }
  const rs: Rec[] = extra.map((r) => ({ ...base, ...r }))
  commands.forEach((command, i) => {
    const n = i + 1
    rs.push({
      ...base,
      type: 'assistant',
      uuid: `a${n}`,
      requestId: `r${n}`,
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id: `t${n}`, name: 'Bash', input: { command } }],
        usage: { input_tokens: 1000, cache_read_input_tokens: 9000 },
      },
    })
    rs.push({
      ...base,
      type: 'user',
      uuid: `u${n}`,
      toolUseResult: { stdout: 'x'.repeat(100), stderr: '' },
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `t${n}`, content: 'x'.repeat(100) }] },
    })
  })
  rs.push({
    ...base,
    type: 'assistant',
    uuid: 'az',
    requestId: 'rz',
    message: {
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'tz', name: 'Skill', input: { skill: 'worker:docs' } }],
      usage: { input_tokens: 0, cache_read_input_tokens: 10000 },
    },
  })
  return write(dir, name, rs)
}

test('it reports one line per session with the peak context and the tool mix', async () => {
  const m = await machine()
  const r = report(m, [workerSession])
  expect(r.code, r.stderr).toBe(0)
  expect(row(r.stdout)).toMatchObject({
    session: 'f1a7e3aa',
    kind: 'work',
    version: '2.1.278',
    turns: '9',
    // The peak is the session maximum; the subagent turn in the fixture carries 900k and must not count
    // as the worker's context.
    peak: '90.0k',
    // 90 of 180 result characters came from `cat` and `sed -n`; `git log | cat` reads no file.
    shellread: '50%',
    // Five shell calls: cat, the piped git log, grep, sed and sleep. `grep -rn "sleep"` is not a sleep.
    read: '1',
    edit: '1',
    write: '1',
    shell: '5',
    sleep: '1',
    label: '#42',
  })
})

test('a planning session is a row of kind plan with what its cost is made of', async () => {
  const m = await machine()
  const r = report(m, [planningSession])
  expect(r.code, r.stderr).toBe(0)
  expect(row(r.stdout)).toMatchObject({
    session: '5a1e0000',
    kind: 'plan',
    // Four model messages, two of them written as two records, one per content block.
    turns: '4',
    // Two maintainer messages after the first turn; the opening prompt and the tool result are none.
    answers: '2',
    peak: '24.0k',
    cached: '64.6k',
    uncached: '22.4k',
    output: '1.5k',
    // 220 of 22 000 and 1 200 of 24 000 re-cached after the answers: 1.0 and 5.0 percent.
    resume: '3.0%',
    read: '1',
    label: 'plan/small-idea',
  })
})

test('a model message repeated over its content blocks counts one turn', async () => {
  const m = await machine()
  const rs = records(shellSession(m.root, ['ls']))
  const turn = rs.find((r) => r.type === 'assistant') as Rec
  const text = { ...turn, uuid: 'a1b', message: { ...(turn.message as Rec), content: [{ type: 'text', text: 'done' }] } }
  rs.splice(rs.indexOf(turn) + 1, 0, text)
  const r = report(m, [write(m.root, '0badc0de-0000-4000-8000-00000000000e.jsonl', rs)])
  expect(r.code, r.stderr).toBe(0)
  const got = row(r.stdout)
  expect(got.turns).toBe('2')
  expect(got.cached).toBe('19.0k') // 9 000 and 10 000, the repeated usage counted once
})

test('a directory with a planning and a worker session lists both', async () => {
  const m = await machine()
  const dir = join(m.root, 'transcripts')
  mkdirSync(dir)
  copyFileSync(workerSession, join(dir, 'f1a7e3aa-0000-4000-8000-000000000001.jsonl'))
  copyFileSync(planningSession, join(dir, '5a1e0000-0000-4000-8000-00000000000d.jsonl'))
  const r = report(m, [dir])
  expect(r.code, r.stderr).toBe(0)
  expect(rows(r.stdout).map((x) => x.kind)).toEqual(['work', 'plan'])
  expect(r.stdout).not.toContain('session found')
})

test('its header says it is a diagnostic over an internal format', async () => {
  const m = await machine()
  const header = report(m, [workerSession])
    .stdout.split('\n')
    .filter((l) => l.startsWith('#'))
    .join('\n')
  expect(header).toContain('internal')
  expect(header).toContain('never an input to the pipeline')
})

test('a transcript of an unknown format fails naming the version that wrote it', async () => {
  const m = await machine()
  const r = report(m, [unknownFormat])
  expect(r.code).toBe(1)
  expect(r.stderr).toMatch(/^error:/)
  expect(r.stderr).toContain('9.9.9')
  expect(r.stderr).toContain('internal')
  expect(r.stderr).toContain('changed')
  expect(rows(r.stdout)).toEqual([])
})

test('one unreadable transcript does not hide the other sessions', async () => {
  // A directory argument reads every transcript in it; a half-written one is named and skipped, the run
  // still exits non-zero, and the sessions that parsed are still reported.
  const m = await machine()
  const dir = join(m.root, 'transcripts')
  mkdirSync(dir)
  copyFileSync(workerSession, join(dir, 'f1a7e3aa-0000-4000-8000-000000000001.jsonl'))
  writeFileSync(join(dir, 'beef0000-0000-4000-8000-000000000006.jsonl'), '{"type": "assis')
  const r = report(m, [dir])
  expect(r.code).toBe(1)
  expect(r.stderr).toContain('unreadable transcript')
  expect(r.stderr).not.toContain('has changed') // a truncated file is no format change
  expect(row(r.stdout).session).toBe('f1a7e3aa')
})

test('it counts a sleep in a loop and ignores a heredoc body', async () => {
  const m = await machine()
  const path = shellSession(m.root, [
    'while true; do sleep 5; done', // the polling loop ADR 0017 forbids
    "python3 - <<'PY'\ncat /etc/hosts\nPY", // a heredoc body is not a shell read
    "grep -c '<<EOF' setup.sh\ncat AGENTS.md", // a quoted `<<` must not swallow the cat
    'grep x <<< "foo"; cat README.md', // a here-string is not a heredoc either
    'git commit -m "one\nsleep calls; cat is mentioned"', // a quoted separator is text
    'cat notes.md 2>/dev/null', // a stderr redirect still reads the file
    'cat a.txt > b.txt', // a stdout redirect writes, it reads nothing in
    'timeout 5 head -5 CHANGELOG.md', // a wrapper does not hide the reader
  ])
  const r = report(m, [path])
  expect(r.code, r.stderr).toBe(0)
  const got = row(r.stdout)
  expect(got.sleep).toBe('1')
  expect(got.shell).toBe('8')
  expect(got.shellread).toBe('50%') // four reading calls, 400 of 800 characters
  expect(got.label).toBe('feat/42-file-tools') // no agent name: the branch names the session
})

test('output that cannot be attributed to a command is left out of the share', async () => {
  const m = await machine()
  const poll = {
    type: 'assistant',
    uuid: 'ap',
    requestId: 'rp',
    message: {
      role: 'assistant',
      usage: { input_tokens: 0, cache_read_input_tokens: 10000 },
      content: [{ type: 'tool_use', id: 'tp', name: 'BashOutput', input: { bash_id: 'b1' } }],
    },
  }
  const polled = {
    type: 'user',
    uuid: 'up',
    toolUseResult: { stdout: 'y'.repeat(500) },
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tp', content: 'y'.repeat(500) }] },
  }
  const orphan = { type: 'user', uuid: 'uo', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'gone', content: 'z'.repeat(500) }] } }
  const r = report(m, [shellSession(m.root, ['cat AGENTS.md'], { extra: [poll, polled, orphan] })])
  expect(r.code, r.stderr).toBe(0)
  const got = row(r.stdout)
  // The polled output belongs to a background call whose command is elsewhere, and the orphan result has
  // no call in this transcript: neither says anything about how the worker reads.
  expect(got.shellread).toBe('100%')
  expect(got.shell).toBe('2')
})

test('a worker session that ran no tool is reported, not called a format change', async () => {
  // A worker aborted after its first answer is a short session, not a changed format.
  const m = await machine()
  const start = { type: 'user', uuid: 'u0', message: { role: 'user', content: '<command-name>/worker:work</command-name>' } }
  const answer = {
    type: 'assistant',
    uuid: 'a0',
    requestId: 'r0',
    attributionPlugin: 'worker',
    message: { role: 'assistant', content: [{ type: 'text', text: 'Which repository?' }], usage: { input_tokens: 500, cache_read_input_tokens: 9500 } },
  }
  const base = { version: '2.1.278', isSidechain: false, gitBranch: 'feat/42-x', timestamp: '2026-09-20T12:00:00.000Z' }
  const path = write(m.root, '0badc0de-0000-4000-8000-00000000000c.jsonl', [start, answer].map((r) => ({ ...base, ...r })))
  const r = report(m, [path])
  expect(r.code, r.stderr).toBe(0)
  expect(row(r.stdout).shell).toBe('0')
})

test('a control character in a label cannot repaint the terminal', async () => {
  const m = await machine()
  const name = { type: 'agent-name', agentName: '#42\x1b[2K\x1b[31mFAKE' }
  const r = report(m, [shellSession(m.root, ['ls'], { extra: [name] })])
  expect(r.stdout).not.toContain('\x1b')
  expect(row(r.stdout).label).toBe('#42?[2K?[31mFAKE')
})

test('with no argument it scans the worktree projects and skips the sessions that are not workers', async () => {
  const m = await machine()
  const projects = join(m.root, 'claude', 'projects')
  const worktrees = join(projects, '-repo--claude-worktrees-feat-42-x')
  mkdirSync(worktrees, { recursive: true })
  copyFileSync(workerSession, join(worktrees, 'f1a7e3aa-0000-4000-8000-000000000001.jsonl'))
  // A session in the same directory that never ran a worker skill: no line of its own.
  const plain = {
    type: 'assistant',
    version: '2.1.278',
    uuid: 'a1',
    requestId: 'r1',
    isSidechain: false,
    timestamp: '2026-09-20T11:00:00.000Z',
    message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }], usage: { input_tokens: 10, cache_read_input_tokens: 90 } },
  }
  write(worktrees, 'cafe0000-0000-4000-8000-000000000003.jsonl', [plain])
  // A session outside a worktree project is not a worker session either.
  mkdirSync(join(projects, '-repo'))
  copyFileSync(workerSession, join(projects, '-repo', 'beef0000-0000-4000-8000-000000000004.jsonl'))
  const r = report(m, [], { CLAUDE_CONFIG_DIR: join(m.root, 'claude') })
  expect(r.code, r.stderr).toBe(0)
  expect(row(r.stdout).session).toBe('f1a7e3aa')
})

test('with no configuration directory it scans ~/.claude/projects', async () => {
  const m = await machine()
  const worktrees = join(m.root, '.claude', 'projects', '-repo--claude-worktrees-feat-42-x')
  mkdirSync(worktrees, { recursive: true })
  copyFileSync(workerSession, join(worktrees, 'f1a7e3aa-0000-4000-8000-000000000001.jsonl'))
  const r = report(m, [])
  expect(r.code, r.stderr).toBe(0)
  expect(row(r.stdout).session).toBe('f1a7e3aa')
})

test('no worker session is reported as such instead of as an empty table', async () => {
  const m = await machine()
  mkdirSync(join(m.root, 'claude', 'projects'), { recursive: true })
  const r = report(m, [], { CLAUDE_CONFIG_DIR: join(m.root, 'claude') })
  expect(r.code, r.stderr).toBe(0)
  expect(r.stdout).toContain('no planning or worker session found')
})

test('a worker skill the maintainer types as a slash command makes a worker session', async () => {
  // Claude Code writes a typed command as plain string content, with the command in a marker.
  const m = await machine()
  const typed = {
    type: 'user',
    uuid: 'ut',
    message: { role: 'user', content: '<command-message>worker:docs</command-message><command-name>/worker:docs</command-name>' },
  }
  const rs = withoutSkill(records(shellSession(m.root, ['ls'], { extra: [typed] })))
  const r = report(m, [write(m.root, '0badc0de-0000-4000-8000-000000000006.jsonl', rs)])
  expect(r.code, r.stderr).toBe(0)
  expect(row(r.stdout).turns).toBe('1')
})

test('prose that names a worker skill makes no worker session', async () => {
  const m = await machine()
  const prose = { type: 'user', uuid: 'up', message: { role: 'user', content: 'run /worker:docs when you need the documentation' } }
  const rs = withoutSkill(records(shellSession(m.root, ['ls'], { extra: [prose] })))
  const r = report(m, [write(m.root, '0badc0de-0000-4000-8000-000000000006.jsonl', rs)])
  expect(r.code, r.stderr).toBe(0)
  expect(rows(r.stdout)).toEqual([])
})

test('a session attributed to the worker plugin counts without a skill call', async () => {
  // A worker whose stages were all invoked before a handover still belongs in the report.
  const m = await machine()
  const rs = withoutSkill(records(shellSession(m.root, ['ls'])))
  ;(rs[0] as Rec).attributionPlugin = 'worker'
  const r = report(m, [write(m.root, '0badc0de-0000-4000-8000-000000000007.jsonl', rs)])
  expect(r.code, r.stderr).toBe(0)
  expect(row(r.stdout).turns).toBe('1') // no skill call, but a row
})

test('the sessions are reported oldest first', async () => {
  const m = await machine()
  const dir = join(m.root, 'transcripts')
  mkdirSync(dir)
  shellSession(dir, ['ls'], { timestamp: '2026-09-20T09:00:00.000Z', name: '0000aaaa-0000-4000-8000-000000000008.jsonl' })
  shellSession(dir, ['ls'], { timestamp: '2026-09-19T09:00:00.000Z', name: '1111bbbb-0000-4000-8000-000000000009.jsonl' })
  const r = report(m, [dir])
  expect(rows(r.stdout).map((x) => x.session)).toEqual(['1111bbbb', '0000aaaa'])
})

test('a record shape the report cannot read is an error line', async () => {
  const m = await machine()
  const rs = records(shellSession(m.root, ['cat AGENTS.md']))
  ;(rs[0] as Rec).message = 'a message that is no longer an object'
  const r = report(m, [write(m.root, '0badc0de-0000-4000-8000-00000000000a.jsonl', rs)])
  expect(r.code).toBe(1)
  expect(r.stderr).toMatch(/^error:/)
  expect(r.stderr).toContain('2.1.278')
  expect(r.stderr.split('\n').filter((l) => l !== '')).toHaveLength(1)
})

test('a renamed tool block is reported instead of a row of zeroes', async () => {
  // The numbers come from tool_use and tool_result; if either is renamed, the report must say so.
  const m = await machine()
  const text = readFileSync(shellSession(m.root, ['cat AGENTS.md']), 'utf8')
  const path = join(m.root, '0badc0de-0000-4000-8000-00000000000b.jsonl')
  writeFileSync(path, text.replaceAll('"tool_result"', '"toolResult"'))
  const r = report(m, [path])
  expect(r.code).toBe(1)
  expect(r.stderr).toContain('tool_result')
  expect(r.stderr).toContain('has changed')
  expect(rows(r.stdout)).toEqual([])
})

test('a missing transcript is an error line', async () => {
  const m = await machine()
  const r = report(m, [join(fixtures, 'does-not-exist.jsonl')])
  expect(r.code).toBe(1)
  expect(r.stderr).toMatch(/^error:.*cannot be read \(No such file or directory\)/)
  expect(r.stderr.split('\n').filter((l) => l !== '')).toHaveLength(1)
})

test('ameise help lists the command', async () => {
  const m = await machine()
  expect(cli(m, ['help']).stdout).toContain('ameise context-report')
})
