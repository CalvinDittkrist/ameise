// The controller's side of the contract fixture for the rules it spells without a claim: the spec branch a
// spec run integrates on and the issue a branch belongs to. The claim's branch, the base branch rule, the
// gate's draft and the frontier are held to the fixture where the controller acts on them.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'
import { issueFromBranch } from '../src/github/board.js'
import { slug } from '../src/github/claim.js'

const fixture = JSON.parse(readFileSync(fileURLToPath(new URL('../../contract/fixture.json', import.meta.url)), 'utf8')) as {
  spec_branch: { cases: { case: string; number: number; title: string; branch: string }[] }
  issue_from_branch: { cases: { branch: string; issue: string }[] }
}

test('the spec branch follows the contract fixture', () => {
  const cases = fixture.spec_branch.cases
  expect(cases.length).toBeGreaterThan(0)
  expect(Object.fromEntries(cases.map((c) => [c.case, `spec/${c.number}-${slug(c.title)}`]))).toEqual(Object.fromEntries(cases.map((c) => [c.case, c.branch])))
})

test('the issue a branch belongs to follows the contract fixture', () => {
  const cases = fixture.issue_from_branch.cases
  expect(cases.length).toBeGreaterThan(0)
  expect(Object.fromEntries(cases.map((c) => [c.branch, issueFromBranch(c.branch)]))).toEqual(Object.fromEntries(cases.map((c) => [c.branch, c.issue])))
})
