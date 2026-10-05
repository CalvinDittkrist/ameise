// The Evidence section the pr stage composes from what the record holds, for the cases a fake run does
// not reach: a gate output past the cap and with backtick fences, and commits after the last round.
import { expect, test } from 'vitest'
import { evidence } from '../src/stages/pr.js'
import type { StageRecord } from '../src/records/records.js'

const head = 'c0ffee0000000000000000000000000000000000'
const record = (tail: string, panel: 'passed' | 'failed', round: string) =>
  ({
    panel,
    history: [
      { stage: 'implement', kind: 'session', result: 'complete', at: '' },
      { stage: 'gate', kind: 'run', result: 'pass', at: '', gate: 'make check', commit: round, exit: 0, tail },
      {
        stage: 'review',
        kind: 'round',
        result: panel === 'passed' ? 'pass' : 'fix',
        at: '',
        round: 1,
        commit: round,
        verdicts: [{ reviewer: 'code', verdict: panel === 'passed' ? 'pass' : 'fix', findings: panel === 'passed' ? [] : [{ id: 'code-1-1', severity: 'S1', where: 'a.ts:1', claim: 'Nothing\ntests it' }] }],
      },
    ],
  }) as unknown as StageRecord

test('the evidence holds the end of the gate output in a fence no line of it closes, within the cap', () => {
  const out = [...Array.from({ length: 40 }, (_, i) => `line ${i + 1}`), '```', 'done'].join('\n')
  const text = evidence(record(out, 'passed', head), head)
  const block = /\n(`{4,})\n([^]*?)\n\1\n/.exec(text)
  expect(block?.[1]).toBe('````')
  const lines = (block?.[2] ?? '').split('\n')
  expect(lines).toHaveLength(20)
  expect(lines.at(-1)).toBe('done')
  expect(text).not.toContain('line 22\n')
})

test('the evidence holds at most 4000 characters of the gate output when its lines are long', () => {
  const out = Array.from({ length: 5 }, (_, i) => `${i}`.repeat(2000)).join('\n')
  const text = evidence(record(out, 'passed', head), head)
  const block = /\n(`{3,})\n([^]*?)\n\1\n/.exec(text)
  expect(block?.[2]?.length).toBe(4000)
  expect(block?.[2]?.endsWith('4'.repeat(2000))).toBe(true)
})

test('the evidence of a failed panel holds the open findings and the commits no reviewer read', () => {
  const text = evidence(record('ok', 'failed', 'abcdef1234'), head)
  expect(text).toContain('- code-1-1 S1 `a.ts:1`: Nothing tests it')
  expect(text).toContain('The branch has commits after abcdef1, where the last round read it, which no reviewer read.')
  expect(text).not.toContain('## ')
})
