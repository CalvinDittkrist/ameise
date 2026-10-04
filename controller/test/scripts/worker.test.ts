// The worker plugin's scripts: the session facts, the pinned documentation lookup and the hunt record of a test
// hunt, each run as the real script in a sandbox.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, test } from 'vitest'
import { type Result, root, type Sandbox, sandbox, worker } from './sandbox.js'

const box = sandbox()

// brief is everything a skill's !`command` injections print, run as the real scripts, in order. That text is the
// brief a stage hands to a fresh context, so a test of the brief runs exactly this.
function brief(s: Sandbox, plugin: string, skill: string, env: Record<string, string> = {}): string {
  const body = readFileSync(join(root, 'plugins', plugin, 'skills', skill, 'SKILL.md'), 'utf8').split('---').slice(2).join('---')
  let out = ''
  for (const [, cmd] of body.matchAll(/!`([^`]+)`/g)) {
    const argv = cmd!.replaceAll('${CLAUDE_PLUGIN_ROOT}/', `${join(root, 'plugins', plugin)}/`).split(/\s+/)
    expect(argv.join(' '), `${skill}: ${cmd} carries a placeholder this helper cannot fill`).not.toContain('$')
    const r = s.run(argv[0]!, argv.slice(1), { env })
    expect(r.code, `${skill}: ${cmd}\n${r.stderr}`).toBe(0)
    out += r.stdout
  }
  return out
}

describe('the brief of the hunt skill', () => {
  // A test hunt's branch names no issue, so the facts say none, and the brief carries the hunt record in its
  // place.
  test('says none for the issue and carries the hunt record', () => {
    const s = box()
    s.git('checkout', '-qb', 'hunt/tests-2026-09-24')
    s.commit({ 'test_app.py': 'def test_app():\n    assert 1\n' }, 'test: app')
    s.run(join(worker, 'hunt.sh'), ['round'])
    s.run(join(worker, 'hunt.sh'), ['triage', '1'], { stdin: 'candidate: test_app.py | test_app | cannot-fail | asserts a constant | medium\n' })
    const out = brief(s, 'worker', 'hunt-tests', { WF_BASE_BRANCH: 'main' })
    expect(out).toContain('\nissue: none')
    expect(out).not.toContain('issue: #')
    expect(out).toContain('hunt_kept: 1')
    expect(out).toContain('\n  kept, round 1: test_app.py | test_app | cannot-fail | asserts a constant')
  })
})

describe('facts.sh', () => {
  const facts = (s: Sandbox, env: Record<string, string>) => s.run(join(worker, 'facts.sh'), [], { env })

  test('reports the mode, the issue and the base from the environment or the branch', () => {
    const s = box()
    s.git('checkout', '-qb', 'fix/7-y')
    let r = facts(s, { WF_BASE_BRANCH: 'main' })
    expect(r.code, r.stderr).toBe(0)
    expect(r.stdout.split('\n').slice(0, 4)).toEqual(['mode: manual', 'issue: #7', 'base: main', 'subagents: background'])
    r = facts(s, { WF_BASE_BRANCH: 'main', WF_MODE: 'yolo', WF_ISSUE: '12' })
    expect(r.stdout).toContain('mode: yolo\nissue: #12\n')
  })

  // A skill that needs the controller stops on this line in a plain session rather than failing later (ADR 0057);
  // a session the controller started reads present.
  test('tells a session without the controller what to start', () => {
    const s = box()
    let r = facts(s, { WF_BASE_BRANCH: 'main' })
    expect(r.code, r.stderr).toBe(0)
    const last = r.stdout.trimEnd().split('\n').at(-1)!
    expect(last.startsWith('controller: absent; this skill needs the ameise controller'), last).toBe(true)
    expect(last).toContain("start it with 'ameise'")
    r = facts(s, { WF_BASE_BRANCH: 'main', WF_CONTROLLER: '1' })
    expect(r.stdout.trimEnd().split('\n').at(-1)).toBe('controller: present')
  })

  // A claim disables background tasks, a hand-started session does not; the review stage waits by collecting the
  // tool results in the first case and by ending the turn in the second (issue #34).
  test.each([
    ['1', 'foreground'],
    ['  True ', 'foreground'],
    ['on', 'foreground'],
    ['0', 'background'],
    ['', 'background'],
  ])('names the waiting shape of the session for CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=%j', (value, shape) => {
    const s = box()
    s.git('checkout', '-qb', 'fix/7-y')
    const r = facts(s, { WF_BASE_BRANCH: 'main', CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: value })
    expect(r.code, r.stderr).toBe(0)
    expect(r.stdout).toContain(`subagents: ${shape}`)
  })
})

// The one network call a worker has is pinned to the documentation origin: nothing an argument carries may leave
// that path, and nothing from another host is printed (issue #44).
describe('claude-docs.sh', () => {
  const ORIGIN = 'https://code.claude.com/docs/'
  const docs = (s: Sandbox, args: string[] = [], env: Record<string, string> = {}) => s.run(join(worker, 'claude-docs.sh'), args, { env })
  const curls = (s: Sandbox) => s.argvCalls().filter((c) => c[0] === 'curl')
  const requested = (s: Sandbox) => curls(s).map((c) => c.at(-1))
  const after = (call: string[], flag: string) => call[call.indexOf(flag) + 1]
  const timeoutOf = (s: Sandbox, r: Result) => {
    expect(r.code, r.stderr).toBe(0)
    return after(curls(s).at(-1)!, '--max-time')
  }

  test('prints the index without an argument', () => {
    const s = box()
    const r = docs(s)
    expect(r.code, r.stderr).toBe(0)
    expect(r.stdout).toContain('# Claude Code Docs')
    expect(r.stdout).toContain(`url: ${ORIGIN}llms.txt`)
    expect(requested(s)).toEqual([`${ORIGIN}llms.txt`])
  })

  test('prints the page of a slug as markdown', () => {
    const s = box()
    const r = docs(s, ['sub-agents'])
    expect(r.code, r.stderr).toBe(0)
    expect(r.stdout).toContain('# Page sub-agents.md')
    // The url: line is what the lookup agent cites, so it names the page that actually answered.
    expect(r.stdout).toContain(`url: ${ORIGIN}en/sub-agents.md`)
    expect(requested(s)).toEqual([`${ORIGIN}en/sub-agents.md`])
  })

  // A quarter of the index is nested (agent-sdk/..., whats-new/...); those pages are reachable.
  test('reaches the nested page of a nested slug', () => {
    const s = box()
    const r = docs(s, ['agent-sdk/hooks'])
    expect(r.code, r.stderr).toBe(0)
    expect(r.stdout).toContain(`url: ${ORIGIN}en/agent-sdk/hooks.md`)
    expect(requested(s)).toEqual([`${ORIGIN}en/agent-sdk/hooks.md`])
  })

  test('bounds the request by a timeout and a size', () => {
    const s = box()
    expect(timeoutOf(s, docs(s, ['sub-agents']))).toBe('30')
    s.resetCalls()
    // An operator may raise or lower it; whatever they set is what curl is given.
    expect(timeoutOf(s, docs(s, ['sub-agents'], { WF_DOCS_TIMEOUT: '7' }))).toBe('7')
    expect(curls(s)[0], 'a page of any size would land in a context').toContain('--max-filesize')
  })

  // "0" is a number, and `curl --max-time 0` means no timeout at all, so it is refused with the rest.
  test.each(['soon', '0', '00', '-1', '1.5', ' 5'])('refuses the timeout %j with the fix', (value) => {
    const s = box()
    const r = docs(s, ['sub-agents'], { WF_DOCS_TIMEOUT: value })
    expect(r.code, r.stdout).toBe(1)
    expect(r.stderr).toContain(`error: WF_DOCS_TIMEOUT is '${value}'`)
    expect(requested(s)).toEqual([])
  })

  // Each of these would leave the pinned path, or is not a page at all. The message names the fix.
  test.each(['../x', '../../etc/passwd', 'https://evil.example/x', '//evil.example/x', '/a', 'a/', 'a//b', 'a.b', 'a b', 'A', 'a?b', 'a#b', 'a%2fb', 'a\nb', ''])(
    'refuses the argument %j before any request',
    (argument) => {
      const s = box()
      const r = docs(s, [argument])
      expect(r.code, r.stdout).toBe(1)
      expect(r.stderr).toContain('error: not a documentation page')
      expect(r.stderr).toContain('slug of lowercase letters, digits and hyphens')
      expect(requested(s), 'a refused argument still reached the network').toEqual([])
      expect(r.stdout).toBe('')
    },
  )

  test('refuses a second argument with the usage', () => {
    const s = box()
    const r = docs(s, ['sub-agents', 'hooks'])
    expect(r.code).toBe(1)
    expect(r.stderr).toContain('error: usage: claude-docs.sh')
    expect(requested(s)).toEqual([])
  })

  test('says a failed request is an error with the fix, not an empty page', () => {
    const s = box()
    const r = docs(s, ['no-such-page'], { SHIM_CURL_FAIL: '1' })
    expect(r.code).toBe(1)
    expect(r.stderr).toContain('error: could not read https://code.claude.com/docs/en/no-such-page.md')
    expect(r.stderr).toContain('claude-docs.sh with no argument')
    expect(r.stdout).toBe('')
  })

  // The URL is built here, so a redirect is the only way out of the origin; the body is discarded.
  test('prints nothing of an answer from another host', () => {
    const s = box()
    const r = docs(s, ['sub-agents'], { SHIM_CURL_REDIRECT: 'https://evil.example/collect' })
    expect(r.code).toBe(1)
    expect(r.stderr).toContain('outside https://code.claude.com/docs/')
    expect(r.stdout).toBe('')
  })

  // The documentation renames pages; the answer is printed and cited under the URL it came from.
  test('follows a redirect inside the origin and names the page that answered', () => {
    const s = box()
    const r = docs(s, ['sub-agents'], { SHIM_CURL_REDIRECT: `${ORIGIN}en/subagents.md` })
    expect(r.code, r.stderr).toBe(0)
    expect(r.stdout).toContain(`url: ${ORIGIN}en/subagents.md`)
    expect(r.stdout, 'the body of the page that answered is printed').toContain('# Page subagents.md')
  })

  test('requests only https to the pinned origin', () => {
    const s = box()
    for (const args of [[], ['sub-agents'], ['hooks'], ['cli-reference']]) docs(s, args)
    expect(requested(s).length).toBeGreaterThan(0)
    for (const url of requested(s)) expect(url!.startsWith(ORIGIN), url).toBe(true)
    for (const call of curls(s)) {
      expect(after(call, '--proto')).toBe('=https')
      expect(after(call, '--proto-redir')).toBe('=https')
      expect(call).toContain('--fail')
      expect(call, 'a documentation call without a timeout can hang a session').toContain('--max-time')
    }
  })
})

// The shares a test hunt sends its hunters to: the directories that carry test files by the fixed conventions,
// packed into shares of at most 1500 lines and a longer file split into parts by line.
describe('hunt.sh paths', () => {
  const shares = (s: Sandbox) => {
    const r = s.run(join(worker, 'hunt.sh'), ['paths'])
    expect(r.code, r.stderr).toBe(0)
    return r.stdout
  }

  test('finds every convention and no other file', () => {
    const s = box()
    s.commit({
      'tests/test_login.py': '',
      'tests/helpers.py': '',
      'tests/run.sh': '',
      'spec/models/user_spec.rb': '',
      'app/views_test.py': '',
      'pkg/server_test.go': '',
      'ui/src/app.test.tsx': '',
      'ui/src/api.spec.js': '',
      // Not tests: code, data beside the tests, fixtures and vendored packages.
      'pkg/server.go': '',
      'app/views.py': '',
      'ui/src/app.tsx': '',
      'tests/data.json': '',
      'tests/fixtures/test_sample.py': '',
      'vendor/lib/lib_test.go': '',
    })
    const out = shares(s)
    const files = out
      .split('\n')
      .filter((l) => l.startsWith('  file: '))
      .map((l) => l.slice('  file: '.length))
      .sort()
    expect(files).toEqual(
      ['tests/test_login.py', 'tests/helpers.py', 'tests/run.sh', 'spec/models/user_spec.rb', 'app/views_test.py', 'pkg/server_test.go', 'ui/src/app.test.tsx', 'ui/src/api.spec.js'].sort(),
    )
    expect(out).toContain('hunt_shares: 5,')
    expect(out).toContain(': ui/src, files: 2, lines: 0\n')
  })

  // Five files of 600 lines pack two to a share, and a file of 3200 lines is read in three parts, so no hunter
  // gets more than it can read to the end.
  test('packs a large directory by lines and splits a long file into parts', () => {
    const s = box()
    const files: Record<string, string> = {}
    for (let i = 0; i < 5; i++) files[`tests/test_${i}.py`] = 'x = 1\n'.repeat(600)
    files['tests/test_long.py'] = 'x = 1\n'.repeat(3200)
    s.commit(files)
    const out = shares(s)
    expect(out).toContain('hunt_shares: 6, at most 1500 lines each;')
    expect(out).toContain('share 1: tests, files: 2, lines: 1200\n  file: tests/test_0.py\n  file: tests/test_1.py\n')
    expect(out).toContain('share 3: tests, files: 1, lines: 600\n  file: tests/test_4.py\n')
    expect(out).toContain('share 4: tests, part 1 of 3 of tests/test_long.py, lines 1-1500 of 3200\n  file: tests/test_long.py\n')
    expect(out).toContain('share 6: tests, part 3 of 3 of tests/test_long.py, lines 3001-3200 of 3200\n')
  })

  test('refuses a repository without test files with the patterns', () => {
    const s = box()
    s.commit({ 'app.py': '', 'tests/fixtures/test_x.py': '' })
    const r = s.run(join(worker, 'hunt.sh'), ['paths'])
    expect(r.code).not.toBe(0)
    expect(r.stderr).toContain('error: no test file')
    expect(r.stderr).toContain('test_*.py')
    expect(r.stderr).toContain('*_test.go')
  })
})

const HUNT_SOURCE = `def test_constant():
    assert 1


def test_login():
    assert login("a") == "ok"
`

const REMOVED = `remove: tests/test_login.py | test_constant | cannot-fail | asserts the constant 1
why: it checks that the number 1 is true, which no change to the code can break
still_proven: no, it touched no behaviour
`

// The hunt record: rounds, removals recorded at their commits and kept candidates, and the block the briefs print,
// derived by the script and never restated by the worker.
describe('the hunt record', () => {
  let s: Sandbox
  beforeEach(() => {
    s = box()
    s.git('checkout', '-qb', 'hunt/tests-2026-09-24')
    s.commit(
      {
        'tests/test_login.py': HUNT_SOURCE,
        'tests/test_logout.py': 'def test_logout():\n    assert logout()\n',
        'app.py': "def login(u):\n    return 'ok'\n",
      },
      'tests',
    )
  })

  // hunt runs hunt.sh and expects it to pass unless ok is false.
  const hunt = (args: string[], stdin = '', ok = true): Result => {
    const r = s.run(join(worker, 'hunt.sh'), args, { stdin })
    if (ok) expect(r.code, r.stderr).toBe(0)
    return r
  }
  const removeConstantTest = () => {
    s.write('tests/test_login.py', HUNT_SOURCE.split('\n\n\n').slice(1).join('\n\n\n'))
    s.git('commit', '-qam', 'test: remove test_constant, which asserts a constant')
  }
  const head = () => s.git('rev-parse', '--short', 'HEAD').trim()

  test('names the removals and the checks of a triaged reply and refuses what does not fit', () => {
    hunt(['round'])
    const reply = [
      'candidate: tests/test_login.py | test_constant | cannot-fail | asserts the constant 1 | high',
      'candidate: tests/test_logout.py | test_logout | mocks-subject | logout may be stubbed | medium',
      'candidate: app.py | login | duplicate | the code itself | high',
      'Here are my findings:',
    ].join('\n')
    const out = hunt(['triage', '1'], reply).stdout
    expect(out).toContain('remove: tests/test_login.py | test_constant | cannot-fail | asserts the constant 1\n')
    expect(out).toContain('check: tests/test_logout.py | test_logout | mocks-subject | logout may be stubbed\n')
    expect(out).toContain("refused: 'candidate: app.py | login | duplicate | the code itself | high': app.py is no test file")
    expect(out).toContain("refused: 'Here are my findings:': not a candidate line")
    expect(out).toContain('hunt_triage: 1 to remove, 1 to check, 0 kept, 0 dropped, 2 refused')
  })

  test('refuses malformed candidates with their reason', () => {
    const cases: [string, string][] = [
      ['candidate: tests/test_login.py | test_constant | cannot-fail | a | b | high', 'it has 6 fields separated by |, not 5'],
      ['candidate: tests/test_login.py | test_constant | flaky | it sleeps | high', "'flaky' is none of the categories"],
      ['candidate: tests/test_login.py | test_constant | cannot-fail | a constant | sure', "'sure' is no confidence"],
      ['candidate: tests/test_login.py |  | cannot-fail | a constant | high', 'a field is empty'],
      ['candidate: tests/../app.py | login | cannot-fail | a constant | high', 'tests/../app.py is no test file this repository tracks'],
      ['candidate: /etc/tests/x.sh | x | cannot-fail | a constant | high', '/etc/tests/x.sh is no test file this repository tracks'],
      ['candidate: tests/test_gone.py | test_x | cannot-fail | a constant | high', 'tests/test_gone.py is no test file this repository tracks'],
      [`candidate: tests/test_login.py | test_constant | cannot-fail | ${'x'.repeat(301)} | high`, 'the reason is longer than 300 characters'],
    ]
    // One share for each case, since a share's reply is triaged once: a directory each, sorted before tests.
    const files: Record<string, string> = {}
    cases.forEach((_, i) => (files[`a${i}/tests/test_x.py`] = 'def test_x():\n    pass\n'))
    s.commit(files, 'shares')
    hunt(['round'])
    cases.forEach(([line, reason], i) => {
      const out = hunt(['triage', String(i + 1)], line + '\n').stdout
      expect(out, line).toContain(`refused: '${line}': ${reason}`)
      expect(out, line).toContain('1 refused')
    })
  })

  test('takes at most three candidates of a hunter', () => {
    hunt(['round'])
    const lines = [0, 1, 2, 3].map((i) => `candidate: tests/test_login.py | t${i} | incidental | log lines | low`)
    const out = hunt(['triage', '1'], lines.join('\n')).stdout
    expect(out).toContain('hunt_triage: 0 to remove, 0 to check, 0 kept, 3 dropped, 1 refused')
    expect(out).toContain('at most 3 candidates')
  })

  test('records a candidate proposed twice once', () => {
    hunt(['round'])
    const line = 'candidate: tests/test_logout.py | test_logout | mocks-subject | logout may be stubbed | medium\n'
    hunt(['triage', '1'], line)
    // One reply per share and round: the same share is not triaged twice.
    const again = hunt(['triage', '1'], line, false)
    expect(again.code).not.toBe(0)
    expect(again.stderr).toContain('triaged already')
    removeConstantTest()
    hunt(['removed'], REMOVED)
    hunt(['round'])
    const out = hunt(['triage', '1'], line).stdout
    expect(out).toContain('(checked already)')
    expect(out).not.toContain('check:')
    expect(hunt(['print']).stdout).toContain('hunt_kept: 1\n')
  })

  test('keeps a high candidate the worker leaves and does not name it for removal again', () => {
    hunt(['round'])
    const line = 'candidate: tests/test_login.py | test_login | cannot-fail | looks constant | high\n'
    expect(hunt(['triage', '1'], line).stdout).toContain('remove: tests/test_login.py | test_login')
    // The worker read it and found that it proves the login: nothing is removed, and the test stays kept.
    const printed = hunt(['print']).stdout
    expect(printed).toContain('hunt_kept: 1\n')
    expect(printed).toContain('\n  kept, round 1: tests/test_login.py | test_login | cannot-fail | looks constant\n')
    expect(hunt(['round']).stdout).toContain('  kept: tests/test_login.py | test_login | cannot-fail | looks constant\n')
    const out = hunt(['triage', '1'], line).stdout
    expect(out).not.toContain('remove:')
    expect(out).toContain('hunt_triage: 0 to remove, 0 to check, 1 kept, 0 dropped, 0 refused')
  })

  test('records a removal at its commit and prints it with its reason', () => {
    hunt(['round'])
    removeConstantTest()
    const out = hunt(['removed'], REMOVED).stdout
    expect(out).toContain(`hunt_removed: test_constant in tests/test_login.py at ${head()}, round 1`)
    const printed = hunt(['print']).stdout
    expect(printed).toContain('hunt_removed: 1\n')
    expect(printed).toContain(`\n  removed 1 at ${head()}, round 1: tests/test_login.py | test_constant | cannot-fail\n`)
    expect(printed).toContain('\n    why: it checks that the number 1 is true, which no change to the code can break\n')
    expect(printed).toContain('\n    still proven: no, it touched no behaviour\n')
    // One commit removes one test: the same commit cannot be recorded for a second removal.
    const again = hunt(['removed'], REMOVED.replace('test_constant', 'test_login'), false)
    expect(again.code).not.toBe(0)
    expect(again.stderr).toContain('recorded already')
  })

  test('refuses a removal until it is committed on its own', () => {
    hunt(['round'])
    let r = hunt(['removed'], REMOVED, false)
    expect(r.code).not.toBe(0)
    expect(r.stderr).toContain('removes nothing')
    s.write('tests/test_login.py', '')
    r = hunt(['removed'], REMOVED, false)
    expect(r.stderr).toContain('uncommitted changes')
    s.git('checkout', '--', 'tests/test_login.py')
    s.write('app.py', '')
    s.git('commit', '-qam', 'unrelated')
    r = hunt(['removed'], REMOVED, false)
    expect(r.stderr).toContain('does not touch tests/test_login.py')
    r = hunt(['removed'], REMOVED.replace('still_proven: no', 'still_proven: perhaps'), false)
    expect(r.stderr).toContain('starts with yes or no')
    expect(hunt(['print']).stdout).toContain('hunt_removed: 0\n')
  })

  test('runs rounds until one finds no new candidate', () => {
    expect(hunt(['round']).stdout).toContain('hunt_round: 1 of at most 3\n')
    hunt(['triage', '1'], 'candidate: tests/test_logout.py | test_logout | mocks-subject | stubbed | medium\n')
    removeConstantTest()
    hunt(['removed'], REMOVED)
    const second = hunt(['round']).stdout
    expect(second).toContain('hunt_round: 2 of at most 3\n')
    // The next round's hunter is told what was checked and kept in its share.
    expect(second).toContain('  kept: tests/test_logout.py | test_logout | mocks-subject | stubbed\n')
    hunt(['triage', '1'], 'no candidates\n')
    const ended = hunt(['round']).stdout
    expect(ended).toContain('hunt_round: none; the hunt has ended: round 2 found no new candidate')
    expect(ended).toContain("next: 1 test(s) removed in 2 round(s): report 'hunt: 1 removed'")
    expect(hunt(['print']).stdout).toContain('hunt_rounds: 2 of at most 3; the hunt has ended: round 2 found no new candidate')
    expect(hunt(['triage', '1'], 'no candidates\n', false).stderr).toContain('the hunt has ended')
  })

  test('holds the rounds, the removals and the kept candidates in the record as JSON', () => {
    expect(JSON.parse(hunt(['json']).stdout)).toEqual({ branch: 'hunt/tests-2026-09-24', rounds: 0, max_rounds: 3, ended: null, removed: [], kept: [], stale: 0 })
    hunt(['round'])
    hunt(['triage', '1'], 'candidate: tests/test_logout.py | test_logout | mocks-subject | a "stub"\\ only | medium\n')
    removeConstantTest()
    hunt(['removed'], REMOVED)
    const record = JSON.parse(hunt(['json']).stdout)
    expect(record.rounds).toBe(1)
    expect(record.ended).toBeNull()
    expect(record.removed).toEqual([
      {
        round: 1,
        commit: head(),
        path: 'tests/test_login.py',
        test: 'test_constant',
        category: 'cannot-fail',
        reason: 'asserts the constant 1',
        why: 'it checks that the number 1 is true, which no change to the code can break',
        still_proven: 'no, it touched no behaviour',
      },
    ])
    // A hunter's text reaches the controller as it stands, quotes and backslashes included.
    expect(record.kept).toEqual([{ round: 1, path: 'tests/test_logout.py', test: 'test_logout', category: 'mocks-subject', reason: 'a "stub"\\ only', confidence: 'medium' }])
    hunt(['round'])
    hunt(['triage', '1'], 'no candidates\n')
    hunt(['round'])
    expect(JSON.parse(hunt(['json']).stdout).ended).toBe('round 2 found no new candidate')
  })

  test('ends a hunt that finds nothing after its first round without a pull request', () => {
    hunt(['round'])
    hunt(['triage', '1'], 'no candidates\n')
    const ended = hunt(['round']).stdout
    expect(ended).toContain('round 1 found no new candidate')
    expect(ended).toContain("report 'hunt: nothing removed'")
    expect(ended).toContain('opens no pull request')
  })

  test('resumes a round left before every reply was triaged with the shares still out', () => {
    s.commit({ 'spec/test_api.py': 'def test_api():\n    assert api()\n' }, 'spec')
    const first = hunt(['round']).stdout
    expect(first).toContain('share 1: spec, files: 1, lines: 2\n')
    expect(first).toContain('share 2: tests, files: 2, lines: 8\n')
    hunt(['triage', '1'], 'no candidates\n')
    // A fresh context calls round again: the round is not closed, and only share 2 is handed out.
    const resumed = hunt(['round']).stdout
    expect(resumed).toContain('hunt_round: 1 of at most 3, resumed: 1 of 2 share(s) not triaged yet')
    expect(resumed).toContain('share 2: tests, files: 2, lines: 8\n  file: tests/test_login.py\n')
    expect(resumed).not.toContain('share 1:')
    hunt(['triage', '2'], 'no candidates\n')
    expect(hunt(['round']).stdout).toContain('round 1 found no new candidate')
  })

  test.each([
    [['triage'], 'name the share'],
    [['triage', 'x'], 'name the share'],
    [['triage', '2'], 'round 1 has no share 2'],
  ])('takes a triage only for a share of the running round: %j', (args, message) => {
    hunt(['round'])
    const r = hunt(args, 'no candidates\n', false)
    expect(r.code).not.toBe(0)
    expect(r.stderr).toContain(message)
  })

  test('no longer lists a removal a later commit restores', () => {
    hunt(['round'])
    removeConstantTest()
    hunt(['removed'], REMOVED)
    s.git('revert', '--no-edit', 'HEAD')
    const printed = hunt(['print']).stdout
    expect(printed).toContain('hunt_removed: 0\n')
    expect(printed).toContain('hunt_note: 1 recorded removal(s) no longer stand')
  })

  test('refuses a removal whose test is still in its file', () => {
    hunt(['round'])
    s.write('app.py', '')
    s.write('tests/test_login.py', HUNT_SOURCE + '\n# touched\n')
    s.git('commit', '-qam', 'test: touch the file, remove nothing')
    const r = hunt(['removed'], REMOVED, false)
    expect(r.code).not.toBe(0)
    expect(r.stderr).toContain('still names test_constant')
  })

  test('hunts in a later round only the files the round before found something in', () => {
    expect(hunt(['round']).stdout).toContain('share 1: tests, files: 2, lines: 8\n  file: tests/test_login.py\n  file: tests/test_logout.py\n')
    hunt(['triage', '1'], 'candidate: tests/test_logout.py | test_logout | mocks-subject | stubbed | medium\n')
    const second = hunt(['round']).stdout
    expect(second).toContain('hunt_shares: 1,')
    expect(second).toContain('share 1: tests, files: 1, lines: 2\n  file: tests/test_logout.py\n')
    expect(second).not.toContain('test_login.py')
  })

  test('ends a hunt when the files it found something in are gone', () => {
    hunt(['round'])
    hunt(['triage', '1'], 'candidate: tests/test_logout.py | test_logout | cannot-fail | asserts a stub | high\n')
    s.git('rm', '-q', 'tests/test_logout.py')
    s.git('commit', '-qm', 'test: remove test_logout')
    hunt(['removed'], 'remove: tests/test_logout.py | test_logout | cannot-fail | asserts a stub\nwhy: it asserts what a stub returns\nstill_proven: no, it proved nothing\n')
    const ended = hunt(['round']).stdout
    expect(ended).toContain('the hunt has ended: no file round 1 found a candidate in is a test file any more')
    expect(ended).toContain('next: 1 test(s) removed in 1 round(s)')
  })

  test('runs three rounds at most', () => {
    for (let n = 0; n < 3; n++) {
      expect(hunt(['round']).stdout).toContain(`hunt_round: ${n + 1} of at most 3`)
      hunt(['triage', '1'], `candidate: tests/test_logout.py | t${n} | incidental | log lines | medium\n`)
    }
    expect(hunt(['round']).stdout).toContain('the hunt has ended: 3 rounds ran')
  })
})

// The worker splits the test files among its hunters by the fixed conventions of a test hunt.
test('the test file rule finds the test files and skips the rest', () => {
  const s = box()
  const files: Record<string, string> = {}
  for (const name of [
    'tests/test_a.py',
    'tests/helpers.py',
    'tests/shim',
    'tests/fixtures/test_b.py',
    'spec/x_spec.rb',
    'a/b_test.go',
    'a/b.go',
    'c/d_test.py',
    'ui/e.test.ts',
    'ui/f.spec.jsx',
    'ui/g.ts',
    'vendor/h_test.go',
    'node_modules/i.test.js',
    'testdata/test_j.py',
    'k/__snapshots__/l.test.js',
  ])
    files[name] = ''
  s.commit(files)
  const r = s.run('-c', [`. "${join(worker, 'lib.sh')}"; git ls-files | wf_test_paths`])
  expect(r.code, r.stderr).toBe(0)
  expect(r.stdout.trimEnd().split('\n')).toEqual(['a/b_test.go', 'c/d_test.py', 'spec/x_spec.rb', 'tests/helpers.py', 'tests/test_a.py', 'ui/e.test.ts', 'ui/f.spec.jsx'])
})
