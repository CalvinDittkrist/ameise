import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { expect, test } from '@playwright/test'
import { configuration, paused, working } from './where.js'

// The dashboard read the way the maintainer reads it: in a browser, against the real binary in fake
// mode. The canned queue is worked before the tests start (tests/factory.js), so the runs below are
// the scripted ones. The canned spec run goes first: 1, 2 and 3 are its tickets, each merged into the
// spec branch, 2 validated twice, and 4 its spec pull request, ready. Then 5 ready, 6 blocked, 7
// failed, 8 failed, 9 ready with a warning, 10 the follow-up run a review of 9 asked for, ready, 11 the
// follow-up run of a bot's review after 10, ready, 12 still running.

const SPEC_RUN = 1 // the id of the spec run, which spec runs count apart from runs
const FIRST_TICKET_RUN = 1
const REVALIDATED_RUN = 2
const READY_RUN = 5
const BLOCKED_RUN = 6
const WARNED_RUN = 9
const FOLLOW_UP_RUN = 10
const BOT_REVIEW_RUN = 11
const RUNNING_RUN = 12

const detail = (page) => page.locator('.detail')
// The runs that are done, in their own section of the line: the rows of a spec run are buttons too.
const doneRows = (page) => page.locator('#done-runs button.row')

test('the three areas render from the canned data', async ({ page }) => {
  await page.goto(working('/'))

  const repositories = page.locator('.repos li')
  await expect(repositories).toHaveCount(3)
  await expect(repositories.first()).toContainText('acme/edge-sensors')
  await expect(repositories.nth(1)).toContainText('acme/backtest')
  await expect(repositories.last()).toContainText('acme/firmware')

  const now = page.locator('.row.now')
  await expect(now).toContainText('#118')
  await expect(now).toContainText('Document the calibration procedure')
  await expect(now).toContainText('acme/backtest')

  await expect(page.locator('.line')).toContainText('Queue0')
  await expect(page.locator('.line .none')).toHaveText('empty')

  const done = doneRows(page)
  await expect(done).toHaveCount(11)
  // Newest first, each with how it ended: the two follow-up runs of #121 before the run they answered,
  // and the runs of the spec run before everything else.
  await expect(done.first()).toContainText('#121')
  await expect(done.first()).toContainText('ready')
  await expect(done.nth(1)).toContainText('#121')
  await expect(done.nth(2)).toContainText('#121')
  await expect(done.nth(6)).toContainText('#104')
  await expect(done.nth(6)).toContainText('ready')
  await expect(done.nth(5)).toContainText('blocked')
  await expect(done.last()).toContainText('#131')
  await expect(done.last()).toContainText('merged')
})

test('the whole queue is shown in its order while the factory is paused', async ({ page }) => {
  await page.goto(paused('/'))

  await expect(page.locator('.mode')).toHaveText('paused')
  // What waits per repository, which is the only number on that line.
  await expect(page.locator('.repos li').first().locator('b')).toHaveText('4')
  await expect(page.locator('.repos li').nth(1).locator('b')).toHaveText('2')
  // A spec is claimed and not queued, and a paused factory claims none.
  await expect(page.locator('.repos li').last().locator('b')).toHaveText('0')
  await expect(page.locator('.specs')).toHaveCount(0)

  const queue = page.locator('.line ol .row')
  await expect(queue).toHaveCount(6)
  // Oldest routing label first, whichever repository it is in.
  const order = ['#104', '#109', '#112', '#115', '#121', '#118']
  for (const [position, issue] of order.entries()) {
    await expect(queue.nth(position)).toContainText(`${position + 1}`)
    await expect(queue.nth(position)).toContainText(issue)
  }
  // #104 was interrupted and is held, so it stands there as work that is resumed rather than
  // claimed, and it says so; nothing the factory has not worked yet carries a signal.
  await expect(queue.first()).toContainText('interruption')
  await expect(queue.nth(1)).not.toContainText('interruption')
  await expect(page.locator('.line .none').first()).toHaveText('paused')
})

test('a pause written into the configuration is shown without a restart, and the run keeps going', async ({
  page,
}) => {
  // The working factory is paused and unpaused through its configuration file, the way an operator
  // does it on the host; the tests after this one read it working again.
  const file = configuration('working')
  const was = readFileSync(file, 'utf8')
  // Written beside the file and renamed over it, so a poll never reads half of it.
  const save = (body) => {
    writeFileSync(`${file}.next`, body)
    renameSync(`${file}.next`, file)
  }
  await page.goto(working('/'))
  await expect(page.locator('.mode')).toHaveText('working')
  try {
    save(JSON.stringify({ ...JSON.parse(was), paused: true }))
    await expect(page.locator('.mode')).toHaveText('paused')
    // A pause ends nothing: the run that was going still stands as the one running.
    await expect(page.locator('.row.now')).toContainText('#118')
  } finally {
    save(was)
  }
  await expect(page.locator('.mode')).toHaveText('working')
})

test('a run is selected through the URL and the selection survives a reload', async ({ page }) => {
  await page.goto(working(`/#run=${BLOCKED_RUN}`))
  await expect(detail(page).locator('h3')).toContainText('#109')

  await page.reload()
  await expect(detail(page).locator('h3')).toContainText('#109')

  // Selecting in the line puts the run in the URL, so the page can be linked as it is read.
  await page.locator('.line button.row', { hasText: '#104' }).click()
  await expect(page).toHaveURL(new RegExp(`#run=${READY_RUN}$`))
  await expect(detail(page).locator('h3')).toContainText('#104')
})

test('the done section folds to its heading, and the browser keeps it folded', async ({ page }) => {
  await page.goto(working('/'))
  const heading = page.getByRole('button', { name: /^Done/ })
  const done = doneRows(page)

  // A first visit finds it open, and the heading says how many runs are done in either state.
  await expect(heading).toHaveAttribute('aria-expanded', 'true')
  await expect(done).toHaveCount(11)
  await heading.click()
  await expect(heading).toHaveAttribute('aria-expanded', 'false')
  await expect(heading).toHaveText('Done11')
  for (const row of await done.all()) await expect(row).toBeHidden()

  await page.reload()
  await expect(heading).toHaveAttribute('aria-expanded', 'false')
  await expect(done.first()).toBeHidden()

  await heading.click()
  await expect(done.first()).toBeVisible()
  await page.reload()
  await expect(heading).toHaveAttribute('aria-expanded', 'true')
  await expect(done).toHaveCount(11)
  for (const row of await done.all()) await expect(row).toBeVisible()
})

test('folding the done section leaves the selected run and the URL as they are', async ({ page }) => {
  await page.goto(working(`/#run=${BLOCKED_RUN}`))
  await expect(detail(page).locator('h3')).toContainText('#109')
  const url = page.url()

  await page.getByRole('button', { name: /^Done/ }).click()
  await expect(page.locator('.line button.row', { hasText: '#109' })).toBeHidden()
  await expect(detail(page).locator('h3')).toContainText('#109')
  expect(page.url()).toBe(url)
})

test('the done section folds from the keyboard', async ({ page }) => {
  await page.goto(working('/'))
  const heading = page.getByRole('button', { name: /^Done/ })
  await expect(heading).toBeVisible()

  // Reached with Tab from the top of the page, the way a keyboard reaches it.
  for (let i = 0; i < 20 && !(await heading.evaluate((e) => e === document.activeElement)); i++) {
    await page.keyboard.press('Tab')
  }
  await expect(heading).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(heading).toHaveAttribute('aria-expanded', 'false')
  await page.keyboard.press('Space')
  await expect(heading).toHaveAttribute('aria-expanded', 'true')
})

test('a browser that stores nothing folds for the page and shows no error', async ({ page }) => {
  await page.addInitScript(() => {
    const refuse = () => {
      throw new DOMException('refused', 'SecurityError')
    }
    Object.defineProperty(window, 'localStorage', { get: refuse })
  })
  const failures = []
  page.on('pageerror', (e) => failures.push(e.message))
  await page.goto(working('/'))
  const heading = page.getByRole('button', { name: /^Done/ })

  await expect(heading).toHaveAttribute('aria-expanded', 'true')
  await heading.click()
  await expect(heading).toHaveAttribute('aria-expanded', 'false')
  await expect(doneRows(page).first()).toBeHidden()
  await expect(page.locator('.banner')).toHaveCount(0)
  expect(failures).toEqual([])
})

test('the stage line and the outcome box show the scripted states', async ({ page }) => {
  await page.goto(working(`/#run=${READY_RUN}`))
  const stages = detail(page).locator('.steps li')
  // The ready run went through every stage: its gate passed, its panel took two rounds, in ci the
  // reviewers asked for changes, an address-reviews session answered them, and the run ended back in
  // ci. Its change was of the class docs until a fix moved it to the class upload.
  await expect(stages).toHaveText([
    'implement',
    'gate',
    'review, round 2, class docs › upload',
    'pr',
    'ci',
    'address-reviews',
  ])
  await expect(stages.nth(0)).toHaveClass('done')
  await expect(stages.nth(4)).toHaveClass(/at/)
  await expect(stages.nth(5)).toHaveClass('done')
  await expect(detail(page).locator('.outcome')).toContainText('ready')
  await expect(detail(page).getByRole('link')).toHaveAttribute(
    'href',
    'https://github.com/acme/edge-sensors/pull/204',
  )

  await page.goto(working(`/#run=${BLOCKED_RUN}`))
  // The blocked run stopped in its implement session and never reached the gate after it.
  await expect(detail(page).locator('.steps .at')).toHaveText('implement')
  await expect(detail(page).locator('.steps li').nth(1)).toHaveClass('')
  await expect(detail(page).locator('.outcome')).toContainText('blocked')
  await expect(detail(page).locator('.outcome')).toContainText('supersede ADR 0012')

  await page.goto(working(`/#run=${FOLLOW_UP_RUN}`))
  // The follow-up run started at address-reviews and ended in ci, and never did the work before them.
  await expect(detail(page).locator('.facts').first()).toContainText('follow-up run')
  await expect(detail(page).locator('.facts').first()).toContainText('changes-requested')
  await expect(detail(page).locator('.steps .at')).toHaveText('ci')
  await expect(detail(page).locator('.steps li').nth(5)).toHaveClass('done')
  await expect(detail(page).locator('.steps li').nth(0)).toHaveClass('')

  // The follow-up run of the bot's review says which signal queued it, and went the same way.
  await page.goto(working(`/#run=${BOT_REVIEW_RUN}`))
  await expect(detail(page).locator('.facts').first()).toContainText('follow-up run')
  await expect(detail(page).locator('.facts').first()).toContainText('bot-review')
  await expect(detail(page).locator('.steps .at')).toHaveText('ci')
  await expect(detail(page).locator('.steps li').nth(5)).toHaveClass('done')
  await expect(detail(page).locator('.outcome')).toContainText('ready')

  // The run whose change the fix of its merge took out of every class shows the class full.
  await page.goto(working(`/#run=${WARNED_RUN}`))
  await expect(detail(page).locator('.steps li').nth(2)).toHaveText('review, round 3, class full')

  await page.goto(working(`/#run=${RUNNING_RUN}`))
  // The run that is still going has no outcome box at all.
  await expect(detail(page).locator('.state')).toHaveText('running')
  await expect(detail(page).locator('.steps .at')).toHaveText('implement')
  await expect(detail(page).locator('.outcome')).toHaveCount(0)
})

test('a spec run stands in the line with its ticket runs and their outcomes', async ({ page }) => {
  await page.goto(working('/'))

  const spec = page.locator('.specs > li')
  await expect(page.locator('.line')).toContainText('Specs1')
  await expect(spec).toHaveCount(1)
  // The spec run holds its spec with nothing going: its tickets are merged and its spec pull request
  // is open, waiting for a person.
  const head = spec.locator('> button.row')
  await expect(head).toContainText('#130')
  await expect(head).toContainText('Remote firmware updates')
  await expect(head).toContainText('spec pull request open')
  await expect(head).toContainText('acme/firmware')

  // Its tickets beneath it in the order it took them, each with its runs and how the last one ended,
  // and the run of its spec pull request after them.
  const tickets = spec.locator('.tickets li')
  await expect(tickets).toHaveCount(4)
  for (const [i, [issue, outcome, run]] of [
    ['#131', 'merged', 'run 1'],
    ['#132', 'merged', 'run 2'],
    ['#133', 'merged', 'run 3'],
    ['#130', 'ready', 'run 4'],
  ].entries()) {
    await expect(tickets.nth(i)).toContainText(issue)
    await expect(tickets.nth(i).locator('.outcome-word')).toHaveText(outcome)
    await expect(tickets.nth(i)).toContainText(run)
  }
  await expect(tickets.last()).toContainText('spec pull request')

  // A ticket selects its run.
  await tickets.nth(1).getByRole('button').click()
  await expect(page).toHaveURL(new RegExp(`#run=${REVALIDATED_RUN}$`))
  await expect(detail(page).locator('h3')).toContainText('#132')
})

test('a spec run is selected through the URL with its record and its events', async ({ page }) => {
  await page.goto(working(`/#spec=${SPEC_RUN}`))
  await expect(detail(page).locator('h3')).toContainText('#130')
  await expect(detail(page).locator('h3')).toContainText('Remote firmware updates')
  await expect(detail(page).locator('.head .state')).toHaveText('spec pull request open')
  const facts = detail(page).locator('.facts').first()
  await expect(facts).toContainText('acme/firmware')
  await expect(facts).toContainText('spec/130-remote-firmware-updates from main')
  await expect(facts).toContainText('3 tickets')
  await expect(detail(page).locator('.tickets li')).toHaveCount(4)
  await expect(detail(page).locator('.outcome').getByRole('link')).toHaveAttribute(
    'href',
    'https://github.com/acme/firmware/pull/230',
  )
  const log = detail(page).locator('.log')
  await expect(log).toContainText('claimed spec/130-remote-firmware-updates')
  await expect(log).toContainText('opened the spec pull request')
  // The spec run is the one lit in the line, and the selection survives a reload.
  await expect(page.locator('.specs > li > button.row')).toHaveClass(/\bon\b/)
  await page.reload()
  await expect(detail(page).locator('h3')).toContainText('#130')

  // A ticket of it selects its run from the detail as from the line.
  await detail(page).locator('.tickets li').first().getByRole('button').click()
  await expect(page).toHaveURL(new RegExp(`#run=${FIRST_TICKET_RUN}$`))
  await expect(detail(page).locator('h3')).toContainText('#131')

  await page.goto(working('/#spec=999'))
  await expect(detail(page).locator('.none')).toHaveText('spec run 999 is not on this factory')
})

test('a ticket run shows its validation and its merge, and links its spec run', async ({ page }) => {
  await page.goto(working(`/#run=${REVALIDATED_RUN}`))
  // A codex finding failed its first validation round; the fix passed the second, and the merge stage
  // squash-merged it into the spec branch.
  const stages = detail(page).locator('.steps li')
  await expect(stages).toHaveText([
    'implement',
    'gate',
    'review, round 1, class full',
    'pr',
    'ci',
    'address-reviews',
    'validate, round 2, codex pass, fable pass',
    'merge',
  ])
  await expect(stages.nth(5)).toHaveClass('')
  await expect(stages.nth(6)).toHaveClass('done')
  await expect(stages.nth(7)).toHaveClass(/at/)
  await expect(detail(page).locator('.head .state')).toHaveText('merged')
  await expect(detail(page).locator('.outcome')).toContainText('spec/130-remote-firmware-updates')
  // A run that has no validators shows neither stage.
  await page.goto(working(`/#run=${READY_RUN}`))
  await expect(detail(page).locator('.steps li')).toHaveCount(6)

  await page.goto(working(`/#run=${REVALIDATED_RUN}`))
  await detail(page).locator('.facts').first().getByRole('link', { name: 'spec #130' }).click()
  await expect(page).toHaveURL(new RegExp(`#spec=${SPEC_RUN}$`))
  await expect(detail(page).locator('h3')).toContainText('#130')
})

test('a spec run that waits for a person’s ticket says which', async ({ page }) => {
  // The canned spec has no ticket of a person, so the answer under test is put in front of the
  // dashboard here; the factory's Go tests serve the real one (specpull_test.go).
  await page.route(/\/api\/specs(\/\d+)?(\?.*)?$/, async (route) => {
    const answer = await (await route.fetch()).json()
    const waiting = (spec) => ({ ...spec, pullRequest: undefined, waiting: [134] })
    await route.fulfill({ json: Array.isArray(answer) ? answer.map(waiting) : waiting(answer) })
  })
  await page.goto(working(`/#spec=${SPEC_RUN}`))
  await expect(page.locator('.specs > li > button.row')).toContainText('waiting for #134')
  await expect(page.locator('.specs > li > button.row')).toHaveClass(/state-blocked/)
  await expect(detail(page).locator('.head .state')).toHaveText('waiting for #134')
})

test('the selected run shows what it cost, how full its context came and what it warned about', async ({
  page,
}) => {
  await page.goto(working(`/#run=${WARNED_RUN}`))
  // Its sixteen sessions are summed: the implement session, the fix sessions of its merge and its gate in the
  // gate stage, seven reviewers over three rounds, the fix sessions of those rounds and of its gate on
  // the final head, the author session of its pr stage and the fix session of its conflict.
  await expect(detail(page).locator('.facts').first()).toContainText('$66.88')
  await expect(detail(page).locator('.facts').first()).toContainText('368 turns')
  await expect(detail(page).locator('.facts').first()).not.toContainText('counted')
  await expect(detail(page).locator('.facts').first()).toContainText(/\d+\.\dk context peak/)
  await expect(detail(page).locator('.warnings li')).toContainText('left a process behind')
  // What the run ran with: the factory that recorded it writes its own version into every run.
  await expect(detail(page).locator('.versions')).toContainText(/factory \d+\.\d+\.\d+/)

  // A run whose worker printed no result line yet carries the totals the factory counted from its
  // stream, and says that they are counted.
  await page.goto(working(`/#run=${RUNNING_RUN}`))
  await expect(detail(page).locator('.facts').first()).toContainText(/\d+ turns/)
  await expect(detail(page).locator('.facts').first()).toContainText(/\$\d+\.\d\d · totals counted by the factory/)
})

test('the live log sets the events of the worker’s subagents in', async ({ page }) => {
  await page.goto(working(`/#run=${READY_RUN}`))
  const log = detail(page).locator('.log')
  // The ready run had twelve sessions, its implement session, seven reviewers over two rounds and the fix
  // session between them, the author session of its pr stage, the fix session of one repair round
  // and the address-reviews session of the other, and each ended in a result line.
  await expect(log.locator('.ev-result')).toHaveCount(12)
  await expect(log.locator('.ev-result').last()).toContainText('result: success')
  const subagent = log.locator('.ev-sub').first()
  await expect(subagent).toContainText('retry')
  // Set in: what a subagent did stands further right than what the worker itself did.
  await expect(subagent.locator('.what')).toHaveCSS('padding-left', '18px')
  await expect(log.locator('.ev:not(.ev-sub) .what').first()).toHaveCSS('padding-left', '0px')

  // An event with a body opens it where it stands; one without cannot be opened.
  const call = log.locator('.ev-tool').first()
  await expect(call.locator('pre')).toHaveCount(0)
  await call.getByRole('button').click()
  await expect(call.locator('pre')).toContainText('AGENTS.md')
})

test('the log of a running worker grows as it is written, and repeats nothing', async ({ page }) => {
  await page.goto(working(`/#run=${RUNNING_RUN}`))
  const lines = detail(page).locator('.log .ev')
  await expect(lines.first()).toBeVisible()
  const [started, first] = [await lines.count(), await lines.first().textContent()]

  // What the page asks for: the events after the last one it has, and never the log again.
  const after = []
  page.on('request', (request) => {
    const asked = request.url().match(new RegExp(`/api/runs/${RUNNING_RUN}\\?after=(\\d+)`))
    if (asked) after.push(Number(asked[1]))
  })

  // The scripted worker of this run says something new every second: the log has to grow by those
  // lines and keep the ones already read.
  await expect.poll(() => lines.count(), { timeout: 15_000 }).toBeGreaterThan(started)
  expect(await lines.first().textContent()).toBe(first)
  const read = await lines.allTextContents()
  expect(new Set(read).size).toBe(read.length) // an event that was read twice would stand twice
  // And what it asks for moves on: the next request starts after the last event it was given.
  await expect.poll(() => after.at(-1) > after[0], { timeout: 15_000 }).toBe(true)
})

test('the factory says when it waits for quota and until when', async ({ page }) => {
  // A fake factory has no quota tool to wait for, so the state is put into the answer here; the
  // factory's Go tests drive the real one (quota_test.go).
  await page.route('**/api/status', async (route) => {
    const answer = await route.fetch()
    const status = await answer.json()
    await route.fulfill({
      json: { ...status, state: 'waiting-for-quota', quotaUntil: '2026-09-21T16:45:00Z' },
    })
  })
  await page.goto(working('/'))
  await expect(page.locator('.mode')).toContainText('waiting for quota')
  await expect(page.locator('.mode')).toContainText('until')
})

test('the factory says when it is still cloning what it was connected to', async ({ page }) => {
  // The state a factory serves while it makes the clones of its connected repositories, which fake
  // mode never does: the line is empty then, and the header is what says why.
  await page.route('**/api/status', async (route) => {
    const answer = await route.fetch()
    await route.fulfill({ json: { ...(await answer.json()), state: 'connecting' } })
  })
  await page.goto(working('/'))
  await expect(page.locator('.mode')).toContainText('connecting')
})

test('a repository whose issues could not be read is said so, not shown as idle', async ({ page }) => {
  // The factory serves this from a repository its last poll could not read; in fake mode there is
  // none, so the answer under test is put in front of the dashboard here.
  await page.route('**/api/repositories', async (route) => {
    const answer = await route.fetch()
    const repositories = await answer.json()
    await route.fulfill({
      json: repositories.map((r, i) =>
        i === 0 ? { ...r, error: 'gh: HTTP 401: Bad credentials' } : r,
      ),
    })
  })
  await page.goto(working('/'))

  const unreadable = page.locator('.repos li').first()
  await expect(unreadable).toHaveClass(/unreadable/)
  await expect(unreadable.locator('small')).toContainText('Bad credentials')
  await expect(unreadable.locator('b')).toHaveText('\u2014') // no count: nobody knows
  await expect(page.locator('.repos li').last()).not.toHaveClass(/unreadable/)
})

test('a factory that stops answering is said so, and a run it does not have too', async ({ page }) => {
  // A run reached by editing the URL that this factory never ran.
  await page.goto(working('/#run=999'))
  await expect(detail(page).locator('.none')).toHaveText('run 999 is not on this factory')

  // The run that is still being followed, while the factory answers nothing but errors.
  await page.goto(working(`/#run=${RUNNING_RUN}`))
  await expect(detail(page).locator('h3')).toContainText('#118')
  await page.route('**/api/**', (route) => route.fulfill({ status: 500, body: 'no' }))

  // The banner stands under the header, where it is read, and the run says what stopped answering.
  await expect(page.locator('.banner')).toBeVisible()
  const [header, said, repositories] = await Promise.all(
    ['.top', '.banner', '.repos'].map((part) => page.locator(part).boundingBox()),
  )
  expect(said.y).toBe(header.y + header.height)
  expect(repositories.y).toBe(said.y + said.height)
  await expect(detail(page).locator('.trouble')).toContainText(`/api/runs/${RUNNING_RUN}`)
})

test('a run that is over is read once, and a run that is not there too', async ({ page }) => {
  // Both of these are written once and never again, so the page stops asking after the first answer.
  // Counting starts once that answer stands: what is counted here is what a poll would have added.
  for (const [run, shown] of [
    [READY_RUN, detail(page).locator('.ev-result').last()],
    [999, detail(page).locator('.none')],
  ]) {
    await page.goto(working(`/#run=${run}`))
    await expect(shown).toBeVisible()

    const asked = []
    const count = (request) => asked.push(request.url())
    page.on('request', count)
    await twice(page, '/api/line') // the slower poll of the line, so the run's would have asked four times
    page.off('request', count)
    expect(asked.filter((url) => url.includes(`/api/runs/${run}`))).toEqual([])
  }
})

test('a factory that answers slowly is not asked again while it is still answering', async ({ page }) => {
  // Every answer takes longer than the poll that asked for it. On a clock of its own the page would
  // have two readings of the same endpoint in flight, and the older of the two could come back last:
  // a run that has ended would stand as running again, and the log would be asked for events it has.
  const open = {}
  const most = {}
  await page.route('**/api/**', async (route) => {
    const where = new URL(route.request().url()).pathname
    open[where] = (open[where] ?? 0) + 1
    most[where] = Math.max(most[where] ?? 0, open[where])
    const answer = await route.fetch()
    await new Promise((done) => setTimeout(done, 2500)) // longer than either poll waits: 1s for a run, 2s for the line
    open[where] -= 1
    await route.fulfill({ response: answer })
  })

  await page.goto(working(`/#run=${RUNNING_RUN}`))
  // Every answer of the first reading is held back, so the page fills slower than the usual wait.
  await expect(detail(page).locator('h3')).toContainText('#118', { timeout: 20_000 })
  await Promise.all([twice(page, '/api/line'), twice(page, `/api/runs/${RUNNING_RUN}`)])

  // Every endpoint the page polls, each read one at a time.
  expect(most).toEqual({
    '/api/status': 1,
    '/api/repositories': 1,
    '/api/line': 1,
    '/api/specs': 1,
    [`/api/runs/${RUNNING_RUN}`]: 1,
  })
})

test('the dashboard sends no writing request', async ({ page }) => {
  const written = []
  page.on('request', (request) => {
    if (!['GET', 'HEAD'].includes(request.method())) written.push(`${request.method()} ${request.url()}`)
  })

  await page.goto(working('/'))
  // The run that is still going, because it is the one the page keeps asking about.
  await page.locator('.line button.row', { hasText: '#118' }).click()
  await expect(detail(page).locator('h3')).toContainText('#118')
  await detail(page).locator('.ev-tool').first().getByRole('button').click()
  // Two rounds of every poll the page makes, so a request it only sends later would be seen here.
  await Promise.all([twice(page, '/api/line'), twice(page, '/api/runs/'), twice(page, '/api/status')])

  expect(written).toEqual([])
})

const twice = (page, endpoint) => {
  const answered = (response) => response.url().includes(endpoint)
  return page.waitForResponse(answered).then(() => page.waitForResponse(answered))
}

test('the layout holds', async ({ page }) => {
  await page.goto(working(`/#run=${READY_RUN}`))
  await expect(detail(page).locator('.ev-result').last()).toBeVisible()

  // The three areas stand next to each other, each in its place, whatever the content is.
  const [repos, line, run] = await Promise.all(
    ['.repos', '.line', '.detail'].map((pane) => page.locator(pane).boundingBox()),
  )
  expect(repos.x).toBe(0)
  expect(repos.width).toBe(240)
  expect(line.x).toBe(240)
  expect(line.width).toBe(460)
  expect(run.x).toBe(700)
  expect(run.width).toBe(740)
  expect(repos.height).toBe(line.height)
  expect(line.height).toBe(run.height)

  // Everything that differs between two readings of the same state is a tick: the durations that
  // count up and the clock times in the log. The rest is compared to the screenshot approved for
  // this operating system, once the fonts it is written in have arrived.
  await page.evaluate(() => document.fonts.ready)
  // The log follows its end, and the ready run's is longer than the pane. It is read from its start:
  // a mask covers a tick where it lies, and the ticks scrolled up out of the log would cover the
  // header above it.
  await detail(page).locator('.log').evaluate((log) => {
    log.scrollTop = 0
  })

  // The tolerance leaves room for a machine that rasterises the same glyphs a little differently,
  // and for nothing more: one changed number on the page moves 291 pixels, measured. The per-pixel
  // threshold is what tells the two apart: the anti-aliased edges of the same glyph on another host
  // (Chromium on a Raspberry Pi 4, Debian trixie, against the Ubuntu baseline) differ by up to 0.25 in
  // YIQ, measured on 2026-09-23, while the faintest text on the page (#7e7e7e on #101010) differs from
  // its background by 0.42, so a glyph that changes still counts, pixel for pixel.
  await expect(page).toHaveScreenshot('dashboard.png', {
    // The tick is what counts up between two readings; the versions are what changes with a release,
    // and both would make a baseline that has to be approved again for nothing. Their text is
    // asserted where it is read, above.
    mask: [page.locator('.tick'), page.locator('.versions')],
    maskColor: '#101010', // the background, so the approved look can be read off the baseline
    animations: 'disabled',
    caret: 'hide',
    maxDiffPixels: 100,
    threshold: 0.3,
  })
})
