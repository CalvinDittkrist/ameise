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

// quotaAxi installs a scripted quota-axi that answers, per provider it is asked for, quota-axi's report
// of that provider with the percentage left and the reset of its session window, and writes down what
// it was called with. A codex of null is a quota-axi that knows no codex provider: it answers a report
// without one. change alters the report of a provider before it is written, so a case can break one
// part of it.
function quotaAxi(claude: number, codex: number | null, change: (report: Report, provider: string) => void = () => undefined): string {
  const resets: Record<string, string> = { claude: '2026-09-28T14:30:00Z', codex: '2026-09-29T09:00:00Z' }
  for (const provider of ['claude', 'codex']) {
    const remaining = provider === 'claude' ? claude : codex
    const report: Report = { schemaVersion: 5, providers: [] }
    if (remaining !== null) {
      report.providers.push({
        provider,
        state: { stale: false, error: '' },
        windows: [
          { id: 'five_hour', resetsAt: resets[provider]! },
          { id: 'seven_day', resetsAt: '2026-09-30T08:00:00Z' },
        ],
        quotaSemantics: {
          effectiveAvailability: [
            { scope: 'all_models', status: 'known', effectivePercentRemaining: remaining, limitingWindowIds: ['five_hour'] },
            { scope: 'model:opus', status: 'known', effectivePercentRemaining: 90, limitingWindowIds: ['seven_day'] },
          ],
        },
      })
      change(report, provider)
    }
    writeFileSync(join(m.root, `quota-${provider}.json`), JSON.stringify(report))
  }
  const path = join(m.root, 'quota-axi')
  script(path, `printf '%s\\n' "$*" >> '${m.root}/quota.log'\ncat '${m.root}/quota-'"$2"'.json'`)
  return path
}

const quota = async () => (await api(m, 'GET', '/api/quota')).body

test('the quota reads Claude then Codex, each with its reset, and marks a runtime below the minimum', async () => {
  configure({ quota_axi: quotaAxi(40, 70), quota_minimum: 12 })
  expect(await quota()).toEqual({
    minimum: 12,
    runtimes: [
      { runtime: 'claude', known: true, remaining: 40, reset: '2026-09-28T14:30:00.000Z', below: false },
      { runtime: 'codex', known: true, remaining: 70, reset: '2026-09-29T09:00:00.000Z', below: false },
    ],
  })
  expect(read(join(m.root, 'quota.log')).split('\n').filter(Boolean).sort()).toEqual(['--provider claude --json', '--provider codex --json'])

  configure({ quota_minimum: 50 })
  expect(await quota()).toMatchObject({ minimum: 50, runtimes: [{ runtime: 'claude', remaining: 40, below: true }, { runtime: 'codex', remaining: 70, below: false }] })
  configure({ quota_minimum: 80 })
  expect(await quota()).toMatchObject({ minimum: 80, runtimes: [{ runtime: 'claude', below: true }, { runtime: 'codex', below: true }] })
})

test('a quota-axi that knows no codex provider reads Codex unknown with the reason and Claude as it is', async () => {
  configure({ quota_axi: quotaAxi(40, null) })
  expect(await quota()).toEqual({
    minimum: 12,
    runtimes: [
      { runtime: 'claude', known: true, remaining: 40, reset: '2026-09-28T14:30:00.000Z', below: false },
      { runtime: 'codex', known: false, reason: 'quota-axi reports no provider codex', below: false },
    ],
  })
})

test('with no quota_axi the quota says it is off and reads no runtime, and with one it does not say off', async () => {
  configure({ quota_axi: '' })
  expect(await quota()).toEqual({ minimum: 12, off: true, runtimes: [] })
  expect((await api(m, 'POST', '/api/processes', { project: dir, issue: 144 })).body).toMatchObject({ quota: [] })

  configure({ quota_axi: quotaAxi(40, 70) })
  expect(await quota()).not.toHaveProperty('off')
})

test('a quota_axi with whitespace written while the server runs is refused with the install and path procedure', async () => {
  configure({ quota_axi: 'npx quota-axi' })
  const r = await api(m, 'GET', '/api/projects')
  expect(r.status).toBe(500)
  const error = (r.body as { error: string }).error
  expect(error).toContain('quota_axi "npx quota-axi" has whitespace in it')
  expect(error).toContain('npm install -g quota-axi')
  expect(error).toContain('the absolute path that command -v quota-axi prints')
  expect(error).toContain('npx does not work')

  const q = (await quota()) as { runtimes: { known: boolean; reason: string }[] }
  expect(q.runtimes).toHaveLength(2)
  for (const r of q.runtimes) expect(r).toMatchObject({ known: false, reason: expect.stringContaining('has whitespace in it') })
})

test('a claim with Claude below the minimum goes through at once and says so, and the CLI prints it as a warning', async () => {
  configure({ quota_axi: quotaAxi(8, 70) })
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

test('a claim with Codex alone below the minimum warns of nothing, on the API and on the CLI', async () => {
  configure({ quota_axi: quotaAxi(40, 5) })
  expect(await quota()).toMatchObject({ runtimes: [{ runtime: 'claude', below: false }, { runtime: 'codex', remaining: 5, below: true }] })
  const r = await api(m, 'POST', '/api/processes', { project: dir, issue: 144 })
  expect(r.status, JSON.stringify(r.body)).toBe(201)
  expect((r.body as { quota: string[] }).quota).toEqual([])

  canIssue(m, 'owner/repo', 145, 'Claim from the frontier', ['ready-for-agent'])
  const c = cli(m, ['claim', '145', '--project', dir])
  expect(c.code, c.stderr).toBe(0)
  expect(c.stderr).toBe('')
})

// Each case installs its command and answers it with the reason the quota is unknown for.
test.each([
  ['a quota_axi that is not installed', (): [string, string] => [join(m.root, 'missing'), `${join(m.root, 'missing')} is not installed`]],
  ['a quota_axi that fails', (): [string, string] => (script(join(m.root, 'failing'), 'echo "no credential" >&2; exit 3'), [join(m.root, 'failing'), 'no credential'])],
  ['a stale reading', (): [string, string] => [quotaAxi(40, 70, (r, p) => p === 'claude' && (r.providers[0]!.state.stale = true)), 'reading of claude is stale']],
  [
    'a report without the all_models scope',
    (): [string, string] => [
      quotaAxi(40, 70, (r, provider) => {
        if (provider !== 'claude') return
        const p = r.providers[0]!
        p.state.error = 'rate limited'
        p.quotaSemantics.effectiveAvailability = p.quotaSemantics.effectiveAvailability.filter((x) => x.scope !== 'all_models')
      }),
      'no all_models scope for claude: rate limited',
    ],
  ],
  [
    'an all_models scope of unknown status',
    (): [string, string] => [quotaAxi(40, 70, (r, p) => p === 'claude' && (r.providers[0]!.quotaSemantics.effectiveAvailability[0]!.status = 'unknown')), 'does not know how much of claude is left'],
  ],
  ['a report that is not JSON', (): [string, string] => (script(join(m.root, 'garbled'), 'echo "Claude: 40% left"'), [join(m.root, 'garbled'), 'not its JSON report'])],
  ['a report of another schema', (): [string, string] => (script(join(m.root, 'old'), 'echo \'{"schemaVersion": 4}\''), [join(m.root, 'old'), 'schema version 4'])],
])('with %s the quota of Claude is unknown with the reason and a claim goes through without a warning', async (_, install) => {
  const [command, reason] = install()
  configure({ quota_axi: command })
  const q = (await quota()) as { runtimes: { runtime: string; known: boolean; reason: string; below: boolean }[] }
  expect(q.runtimes.map((r) => r.runtime)).toEqual(['claude', 'codex'])
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

test('a quota_axi whose children outlive its deadline is killed with them and the quota answers unknown', async () => {
  // The check of each runtime leaves a child behind that ignores the signal to stop and holds the check's
  // output open. Both checks run at once, so the answer comes within one deadline, not two.
  script(join(m.root, 'stubborn'), `trap '' TERM\n/bin/sleep 120 &\necho $! > '${m.root}/child-'"$2"'.pid'\nwait`)
  configure({ quota_axi: join(m.root, 'stubborn') })
  const began = Date.now()
  const q = (await quota()) as { runtimes: { known: boolean; reason: string }[] }
  expect(Date.now() - began).toBeLessThan(40000)
  const late = expect.objectContaining({ known: false, reason: expect.stringMatching(/gave no reading within 30 seconds/) })
  expect(q.runtimes).toEqual([late, late])
  for (const runtime of ['claude', 'codex']) {
    const child = Number(read(join(m.root, `child-${runtime}.pid`)).trim())
    let alive = true
    for (let i = 0; i < 40 && alive; i++) {
      try {
        process.kill(child, 0)
        await new Promise((done) => setTimeout(done, 50))
      } catch {
        alive = false
      }
    }
    expect(alive, runtime).toBe(false)
  }
}, 60000)
