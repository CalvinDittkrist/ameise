import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { api, canApi, canIssue, canPages, canPulls, checkout, cleanup, cli, type Machine, machine, read, script, start } from './controller.js'

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

// configure rewrites the configuration the running server reads on each request.
function configure(fields: Record<string, unknown>) {
  writeFileSync(m.config, JSON.stringify({ ...JSON.parse(read(m.config)), ...fields }, null, 2) + '\n')
}

interface Report {
  schemaVersion: number
  providers: {
    provider: string
    state: { stale: boolean; error: string }
    windows: { id: string; resetsAt: string }[]
    quotaSemantics: { effectiveAvailability: { scope: string; status: string; effectivePercentRemaining: number | null; limitingWindowIds: string[] }[] }
  }[]
}

// quotaAxi installs a scripted quota-axi that answers the report of Claude with the percentage left and
// the reset of its session window, and writes down what it was called with. change alters the report
// before it is written, so a case can break one part of it.
function quotaAxi(remaining: number, reset: string, change: (report: Report) => void = () => undefined): string {
  const report: Report = {
    schemaVersion: 5,
    providers: [
      {
        provider: 'claude',
        state: { stale: false, error: '' },
        windows: [
          { id: 'five_hour', resetsAt: reset },
          { id: 'seven_day', resetsAt: '2026-09-30T08:00:00Z' },
        ],
        quotaSemantics: {
          effectiveAvailability: [
            { scope: 'all_models', status: 'known', effectivePercentRemaining: remaining, limitingWindowIds: ['five_hour'] },
            { scope: 'model:opus', status: 'known', effectivePercentRemaining: 90, limitingWindowIds: ['seven_day'] },
          ],
        },
      },
    ],
  }
  change(report)
  const file = join(m.root, 'quota.json')
  writeFileSync(file, JSON.stringify(report))
  const path = join(m.root, 'quota-axi')
  script(path, `printf '%s\\n' "$*" >> '${m.root}/quota.log'\ncat '${file}'`)
  return path
}

const quota = async () => (await api(m, 'GET', '/api/quota')).body

test('the quota of every runtime a process spends is served with its reset, and a runtime below the minimum is marked', async () => {
  configure({ quota_axi: quotaAxi(40, '2026-09-28T14:30:00Z'), quota_minimum: 12 })
  expect(await quota()).toEqual({ minimum: 12, runtimes: [{ runtime: 'claude', known: true, remaining: 40, reset: '2026-09-28T14:30:00.000Z', below: false }] })
  expect(read(join(m.root, 'quota.log'))).toBe('--provider claude --json\n')

  configure({ quota_minimum: 50 })
  expect(await quota()).toMatchObject({ minimum: 50, runtimes: [{ runtime: 'claude', remaining: 40, below: true }] })
})

test('a claim below the minimum goes through at once and says so, and the CLI prints it as a warning', async () => {
  configure({ quota_axi: quotaAxi(8, '2026-09-28T14:30:00Z') })
  const r = await api(m, 'POST', '/api/processes', { project: dir, issue: 144 })
  expect(r.status, JSON.stringify(r.body)).toBe(201)
  expect((r.body as { quota: string[]; warnings: string[] }).quota).toEqual([
    'claude has 8% of its quota left, below the minimum of 12%; it resets at 2026-09-28T14:30:00.000Z',
  ])
  expect((r.body as { warnings: string[] }).warnings).toEqual([])

  canIssue(m, 'owner/repo', 145, 'Claim from the frontier', ['ready-for-agent'])
  const c = cli(m, ['claim', '145', '--project', dir])
  expect(c.code, c.stderr).toBe(0)
  expect(c.stderr).toBe('warning: claude has 8% of its quota left, below the minimum of 12%; it resets at 2026-09-28T14:30:00.000Z\n')
})

// Each case installs its command and answers it with the reason the quota is unknown for.
test.each([
  ['no quota_axi is configured', (): [string, string] => ['', 'no quota_axi is configured']],
  ['a quota_axi that is not installed', (): [string, string] => [join(m.root, 'missing'), `${join(m.root, 'missing')} is not installed`]],
  ['a quota_axi that fails', (): [string, string] => (script(join(m.root, 'failing'), 'echo "no credential" >&2; exit 3'), [join(m.root, 'failing'), 'no credential'])],
  ['a stale reading', (): [string, string] => [quotaAxi(40, '2026-09-28T14:30:00Z', (r) => (r.providers[0]!.state.stale = true)), 'reading of claude is stale']],
  [
    'a report without the all_models scope',
    (): [string, string] => [
      quotaAxi(40, '2026-09-28T14:30:00Z', (r) => {
        const p = r.providers[0]!
        p.state.error = 'rate limited'
        p.quotaSemantics.effectiveAvailability = p.quotaSemantics.effectiveAvailability.filter((x) => x.scope !== 'all_models')
      }),
      'no all_models scope for claude: rate limited',
    ],
  ],
  [
    'an all_models scope of unknown status',
    (): [string, string] => [quotaAxi(40, '2026-09-28T14:30:00Z', (r) => (r.providers[0]!.quotaSemantics.effectiveAvailability[0]!.status = 'unknown')), 'does not know how much of claude is left'],
  ],
  ['a report that is not JSON', (): [string, string] => (script(join(m.root, 'garbled'), 'echo "Claude: 40% left"'), [join(m.root, 'garbled'), 'not its JSON report'])],
  ['a report of another schema', (): [string, string] => (script(join(m.root, 'old'), 'echo \'{"schemaVersion": 4}\''), [join(m.root, 'old'), 'schema version 4'])],
])('with %s the quota is unknown with the reason and a claim goes through without a warning', async (_, install) => {
  const [command, reason] = install()
  configure({ quota_axi: command })
  const q = (await quota()) as { runtimes: { runtime: string; known: boolean; reason: string; below: boolean }[] }
  expect(q.runtimes).toHaveLength(1)
  expect(q.runtimes[0]).toMatchObject({ runtime: 'claude', known: false, below: false })
  expect(q.runtimes[0]?.reason).toContain(reason)

  const r = await api(m, 'POST', '/api/processes', { project: dir, issue: 144 })
  expect(r.status, JSON.stringify(r.body)).toBe(201)
  expect((r.body as { quota: string[] }).quota).toEqual([])
})

test('a quota_axi that hangs holds neither the claim nor its session', async () => {
  script(join(m.root, 'hanging'), 'exec /bin/sleep 25')
  configure({ quota_axi: join(m.root, 'hanging') })
  const began = Date.now()
  const r = await api(m, 'POST', '/api/processes', { project: dir, issue: 144 })
  expect(r.status, JSON.stringify(r.body)).toBe(201)
  expect(Date.now() - began).toBeLessThan(10000)
  expect(r.body).toMatchObject({ record: { state: 'running', stage: 'implement' }, quota: [] })
})
