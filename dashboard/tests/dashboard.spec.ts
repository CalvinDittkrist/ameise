import { execFileSync } from "node:child_process"
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { test as base, expect, type Locator, type Page } from "@playwright/test"

// The dashboard read the way the maintainer reads it: in a browser, against the real controller in fake
// mode (tests/controller.ts). Its projects are edge-sensors (base main) and backtest (base dev), both
// clones of a GitHub repository with processes, frontier and a spec ready for acceptance, and notes, a
// directory that is no checkout.

const url = (path = "/") => process.env.AMEISE_URL + path
const sidebar = (page: Page) => page.locator("[data-slot=sidebar]")
const projects = (page: Page) => page.getByRole("list", { name: "Projects" })
const main = (page: Page) => page.getByRole("main")
const sections = (page: Page) => main(page).locator("[data-slot=card]")

// A page whose own files are refused by its content security policy, or whose script throws, says so
// on the console; every test fails on that once it is done. An API call the controller refuses is
// logged there too, and the page shows its reason, so it is left to the test that makes one.
const test = base.extend<{ quiet: void }>({
  quiet: [
    async ({ page }, use) => {
      const errors: string[] = []
      page.on("console", (m) => {
        if (m.type() === "error" && !new URL(m.location().url || "about:blank").pathname.startsWith("/api/")) errors.push(m.text())
      })
      page.on("pageerror", (e) => errors.push(e.message))
      await use()
      expect(errors).toEqual([])
    },
    { auto: true },
  ],
})

test("the sidebar lists the projects of the API under the Orchestrator entry", async ({ page }) => {
  await page.goto(url())
  await expect(page).toHaveTitle("ameise controller")
  const listed = await (await fetch(url("/api/projects"))).json()
  expect(listed.map((p: { name?: string }) => p.name)).toEqual(["edge-sensors", "backtest", undefined])

  await expect(projects(page).getByRole("link")).toHaveText(["edge-sensors", "backtest", "notes"])
  await expect(projects(page).getByRole("button")).toHaveText(["Add project"])
  const links = sidebar(page).getByRole("link")
  await expect(links).toHaveText(["ameise controllerthis machine", "Orchestrator", "edge-sensors", "backtest", "notes"])
  await expect(sidebar(page).getByRole("link", { name: "Orchestrator" })).toHaveAttribute("data-active", "true")
  // The footer carries no label: the list of the quota names itself.
  await expect(sidebar(page).getByText("Quota", { exact: true })).toHaveCount(0)
  await expect(sidebar(page).getByRole("list", { name: "Quota" })).toBeVisible()
})

test("the sidebar names each runtime, and marks one below the minimum", async ({ page }) => {
  await page.goto(url())
  const list = sidebar(page).getByRole("list", { name: "Quota" })
  const claude = list.getByRole("listitem", { name: "Claude", exact: true })
  await expect(claude).toHaveText(/^Claudebelow 12%5-hour/)
  await expect(claude).toHaveAttribute("data-below", "true")
  const codex = list.getByRole("listitem", { name: "Codex", exact: true })
  await expect(codex).toHaveText(/^Codex5-hour/)
  await expect(codex).toHaveAttribute("data-below", "false")
  await expect(list.locator(":scope > li")).toHaveText([/^Claude/, /^Codex/])
  const quota = await (await fetch(url("/api/quota"))).json()
  expect(quota).toMatchObject({ minimum: 12, runtimes: [{ runtime: "claude", known: true, remaining: 8, below: true }, { runtime: "codex", known: true, remaining: 64, below: false }] })
})

test("under each runtime the sidebar shows a bar of its five-hour and weekly windows, and under Claude of the Fable scope", async ({ page }) => {
  await page.goto(url())
  const claude = sidebar(page).getByRole("list", { name: "Claude windows" }).getByRole("listitem")
  await expect(claude).toHaveText(["5-hour8% · resets in 2h", "Weekly60% · resets in 5d", "Fable30% · resets in 4d"])
  const codex = sidebar(page).getByRole("list", { name: "Codex windows" }).getByRole("listitem")
  await expect(codex).toHaveText(["5-hour64% · resets in 3d", "Weekly60% · resets in 5d"])
  // Each bar is as wide as what is left of its window, and a runtime below the minimum has red bars.
  const fill = (row: Locator) => row.getByRole("meter").locator("div")
  await expect(fill(claude.first())).toHaveAttribute("style", "width: 8%;")
  await expect(fill(claude.last())).toHaveAttribute("style", "width: 30%;")
  await expect(fill(codex.first())).toHaveAttribute("style", "width: 64%;")
  await expect(fill(claude.first())).toHaveClass(/bg-destructive/)
  await expect(fill(codex.first())).toHaveClass(/bg-primary/)
  // Every number shows once: no headline repeats the window that limits the runtime.
  await expect(sidebar(page).getByRole("listitem", { name: "Claude", exact: true }).getByText("8%")).toHaveCount(1)
})

test("a report without Fable shows no Fable row, one whose Fable is unknown says so with the reason, and a window without a percentage shows its reset", async ({ page }) => {
  const reset = new Date(Date.now() + 3.5 * 3_600_000).toISOString()
  const reason = "quota-axi does not know how much of Fable is left (status unknown)"
  const windows = [{ id: "five_hour", remaining: 40, reset }, { id: "seven_day", remaining: null, reset }]
  const report: { fable?: object } = {}
  await page.route("**/api/quota", (r) => r.fulfill({ json: { minimum: 12, runtimes: [
    { runtime: "claude", known: true, remaining: 40, reset, below: false, windows, ...report },
  ] } }))
  await page.goto(url())
  const rows = sidebar(page).getByRole("list", { name: "Claude windows" }).getByRole("listitem")
  await expect(rows).toHaveText(["5-hour40% · resets in 3h", "Weeklyresets in 3h"])
  // A window with a percentage of its own carries the runtime's, so no bar of all models repeats it.
  await expect(rows.first().getByRole("meter")).toHaveCount(1)
  await expect(rows.last().getByRole("meter")).toHaveCount(0)

  report.fable = { known: false, reason }
  await page.reload()
  await expect(rows).toHaveText(["5-hour40% · resets in 3h", "Weeklyresets in 3h", "Fableunknown"])
  await expect(rows.last().getByText("unknown")).toHaveAttribute("title", reason)
  await expect(rows.last().getByRole("meter")).toHaveCount(0)
})

test("a quota check switched off says off in the sidebar and warns no claim", async ({ page }) => {
  await page.route("**/api/quota", (r) => r.fulfill({ json: { minimum: 12, off: true, runtimes: [] } }))
  await page.goto(url())
  await expect(sidebar(page).getByText("Off: no quota_axi is configured")).toBeVisible()
  await expect(sidebar(page).getByRole("list", { name: "Quota" })).toHaveCount(0)
  await section(page, "Ready to start").locator('[aria-label="#144"]').getByRole("button", { name: "Claim" }).click()
  const dialog = page.getByRole("dialog", { name: "Claim #144" })
  await expect(dialog.getByRole("button", { name: "Claim", exact: true })).toBeVisible()
  await expect(dialog.getByRole("status", { name: "Quota" })).toHaveCount(0)
})

test("a quota the controller does not answer says so in the sidebar, naming the quota", async ({ page }) => {
  await page.route("**/api/quota", (r) => r.abort())
  await page.goto(url())
  await expect(sidebar(page).getByText("The quota could not be read: the controller does not answer; start it with ameise")).toBeVisible()
  await expect(sidebar(page).getByRole("list", { name: "Quota" })).toHaveCount(0)
})

test("a Codex below the minimum is marked in the sidebar and warns no claim", async ({ page }) => {
  const reset = new Date(Date.now() + 3.5 * 3_600_000).toISOString()
  await page.route("**/api/quota", (r) => r.fulfill({ json: { minimum: 12, runtimes: [
    { runtime: "claude", known: true, remaining: 40, reset, below: false, windows: [] },
    { runtime: "codex", known: true, remaining: 5, reset, below: true, windows: [] },
  ] } }))
  await page.goto(url())
  const codex = sidebar(page).getByRole("listitem", { name: "Codex" })
  await expect(codex).toHaveText("Codexbelow 12%All models5% · resets in 3h")
  await expect(codex).toHaveAttribute("data-below", "true")
  // Without a window of its own percentage, the bar of all models carries what is left of the runtime.
  await expect(codex.getByRole("meter", { name: "All models left" }).locator("div")).toHaveAttribute("style", "width: 5%;")
  await section(page, "Ready to start").locator('[aria-label="#144"]').getByRole("button", { name: "Claim" }).click()
  const dialog = page.getByRole("dialog", { name: "Claim #144" })
  await expect(dialog.getByRole("status", { name: "Quota" })).toHaveCount(0)
  await expect(dialog.getByRole("button", { name: "Claim", exact: true })).toBeVisible()
})

test("a quota the controller cannot read shows as unknown with the reason", async ({ page }) => {
  const reason = "quota-axi is not installed"
  await page.route("**/api/quota", (r) => r.fulfill({ json: { minimum: 12, runtimes: [{ runtime: "claude", known: false, reason, below: false }] } }))
  await page.goto(url())
  const claude = sidebar(page).getByRole("listitem", { name: "Claude" })
  await expect(claude).toHaveText("Claudeunknown")
  await expect(claude.getByText("unknown")).toHaveAttribute("title", reason)
  // An unknown quota warns of nothing on a claim.
  await section(page, "Ready to start").locator('[aria-label="#144"]').getByRole("button", { name: "Claim" }).click()
  const dialog = page.getByRole("dialog", { name: "Claim #144" })
  await expect(dialog.getByRole("status", { name: "Quota" })).toHaveCount(0)
  await expect(dialog.getByRole("button", { name: "Claim", exact: true })).toBeVisible()
  // A claim whose answer finds the quota below the minimum, which the dialog did not warn of, says so after.
  const line = "claude has 8% of its quota left, below the minimum of 12%"
  await page.route("**/api/processes", (r) => r.fulfill({ status: 201, json: { record: {}, warnings: [], quota: [line] } }))
  await dialog.getByRole("button", { name: "Claim", exact: true }).click()
  await expect(page.getByRole("dialog", { name: "Claim #144" }).getByRole("status", { name: "Warnings" })).toHaveText(line)
})

test("a process that turned blocked carries a badge on its row and on the Orchestrator entry until its page is opened", async ({ page }) => {
  const file = join(process.env.AMEISE_RECORDS!, "p78.json")
  writeFileSync(file, JSON.stringify({
    project: process.env.AMEISE_BACKTEST!, kind: "work", branch: "fix/78-keep-the-order-book", issue: 78,
    stage: "implement", state: "blocked", note: "Which exchange first?", unseen: true, updated_at: new Date().toISOString(),
  }))
  try {
    await page.goto(url())
    const row = section(page, "Needs you").locator("[data-slot=item][aria-label='fix/78-keep-the-order-book']")
    await expect(row.getByText("new", { exact: true })).toBeVisible()
    const orchestrator = sidebar(page).locator("li", { has: page.getByRole("link", { name: "Orchestrator" }) })
    await expect(orchestrator.locator("[data-slot=sidebar-menu-badge]")).toHaveText("1")

    await row.getByRole("link", { name: "fix/78-keep-the-order-book" }).click()
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("#78 fix/78-keep-the-order-book")
    await expect(main(page).getByLabel("Note")).toHaveText("Which exchange first?")
    await expect(orchestrator.locator("[data-slot=sidebar-menu-badge]")).toHaveCount(0)
    const board = await (await fetch(url("/api/board"))).json()
    const p = board.projects.flatMap((b: { processes?: { id: string; unseen: boolean }[] }) => b.processes ?? []).find((x: { id: string }) => x.id === "p78")
    expect(p).toMatchObject({ unseen: false })

    await sidebar(page).getByRole("link", { name: "Orchestrator" }).click()
    await expect(section(page, "Needs you").locator("[aria-label='fix/78-keep-the-order-book']").getByText("new", { exact: true })).toHaveCount(0)
  } finally {
    rmSync(file, { force: true })
  }
})

test("a process page whose mark fails tries it again until the badge clears", async ({ page }) => {
  const file = join(process.env.AMEISE_RECORDS!, "p79.json")
  writeFileSync(file, JSON.stringify({
    project: process.env.AMEISE_BACKTEST!, kind: "work", branch: "fix/79-retry-the-mark", issue: 79,
    stage: "implement", state: "ready", note: "Done", unseen: true, updated_at: new Date().toISOString(),
  }))
  try {
    // The first mark is lost, as while the controller restarts; the next one reaches it.
    let marks = 0
    await page.route("**/api/processes/seen", (r) => (++marks === 1 ? r.abort() : r.continue()))
    await page.goto(url())
    const orchestrator = sidebar(page).locator("li", { has: page.getByRole("link", { name: "Orchestrator" }) })
    await expect(orchestrator.locator("[data-slot=sidebar-menu-badge]")).toHaveText("1")
    await section(page, "Needs you").getByRole("link", { name: "fix/79-retry-the-mark" }).click()
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("#79 fix/79-retry-the-mark")
    await expect.poll(() => marks).toBe(1)
    await expect(orchestrator.locator("[data-slot=sidebar-menu-badge]")).toHaveText("1")
    await expect(orchestrator.locator("[data-slot=sidebar-menu-badge]")).toHaveCount(0, { timeout: 10_000 })
    expect(marks).toBe(2)
  } finally {
    rmSync(file, { force: true })
  }
})

// section is the card of that title, its rows each the item the row names.
const section = (page: Page, title: string) => main(page).locator(`[data-slot=card][aria-label="${title}"]`)
const rows = (page: Page, title: string) => section(page, title).locator("[data-slot=item]")
// actions are the primary actions of rows: every button but the one that abandons a work process.
const actions = (page: Page, title: string) => rows(page, title).getByRole("button", { name: /^(?!Abandon #)/ })

test("the Orchestrator page sorts the processes of every project into needs you and running, beside the frontier", async ({ page }) => {
  await page.goto(url())
  await expect(page.locator("header")).toHaveText(/Orchestrator3 projects$/)
  await expect(sections(page).locator("[data-slot=card-title]")).toHaveText(["Needs you4", "Running3", "Ready to start3"])
  expect(await rows(page, "Needs you").evaluateAll((r) => r.map((x) => x.getAttribute("aria-label")))).toEqual([
    "feat/118-refuse-a-project-without-origin",
    "fix/131-log-the-sensor-drift",
    "plan/open-20260928-0011",
    "#100",
  ])
  await expect(actions(page, "Needs you")).toHaveText(["Approve", "Merge", "Continue", "Accept"])
  await expect(rows(page, "Needs you").first()).toContainText(
    "edge-sensors#118feat/118-refuse-a-project-without-originBash wants to run: git remote set-url origin git@github.com:acme/edge-sensors.gitimplement2h",
  )
  expect(await rows(page, "Running").evaluateAll((r) => r.map((x) => x.getAttribute("aria-label")))).toEqual([
    "feat/142-read-the-configuration",
    "feat/88-reconnect-the-broker-stream",
    "hunt/tests-2026-09-27",
  ])
  await expect(actions(page, "Running")).toHaveText(["Open", "Open", "Open"])
  // A work process can be abandoned from its row, a hunt cannot.
  await expect(rows(page, "Running").getByRole("button", { name: /^Abandon #/ })).toHaveCount(2)
  await expect(rows(page, "Running").nth(1)).toContainText("PR #251, checks pendingci1h")
  await expect(rows(page, "Ready to start")).toHaveText([
    /^edge-sensors#144Board lists every project with its processesv0\.12\.0ClaimPlan$/,
    /^edge-sensors#145Claim from the frontier by one actionv0\.12\.0ClaimPlan$/,
    /^backtest#91Backfill candles after a gapv2\.4\.0ClaimPlan$/,
  ])

  // The page shows what the API answers, derived again on every request.
  const board = await (await fetch(url("/api/board"))).json()
  expect(board.projects.map((p: { frontier?: { number: number }[] }) => p.frontier?.map((i) => i.number))).toEqual([[144, 145], [91], undefined])
})

test("a process whose session failed waits under needs you with its reason, a dark red dot and Open", async ({ page }) => {
  const file = join(process.env.AMEISE_RECORDS!, "p77.json")
  writeFileSync(file, JSON.stringify({
    project: process.env.AMEISE_BACKTEST!, kind: "work", branch: "fix/77-drop-stale-ticks", issue: 77,
    stage: "implement", state: "failed", note: "the implement session exited without a result", updated_at: new Date().toISOString(),
  }))
  try {
    await page.goto(url())
    const row = section(page, "Needs you").locator("[data-slot=item][aria-label='fix/77-drop-stale-ticks']")
    await expect(row).toHaveCount(1)
    await expect(row).toContainText("backtest#77fix/77-drop-stale-ticksthe implement session exited without a resultimplement")
    await expect(row.locator("[title=failed]")).toHaveClass(/bg-red-700/)
    await expect(row.getByRole("button", { name: /^(?!Abandon #)/ })).toHaveText(["Open"])
    await expect(section(page, "Running").locator("[aria-label='fix/77-drop-stale-ticks']")).toHaveCount(0)
  } finally {
    rmSync(file, { force: true })
  }
})

test("the age of an idle process advances while its page and the board stay open", async ({ page }) => {
  // An idle process sends no event, so only the page's own clock can move its age.
  const file = join(process.env.AMEISE_RECORDS!, "p73.json")
  const at = new Date(Date.now() - 3_000).toISOString()
  writeFileSync(file, JSON.stringify({
    project: process.env.AMEISE_BACKTEST!, kind: "work", branch: "fix/73-keep-the-clock", issue: 73,
    stage: "implement", state: "blocked", note: "Which clock?", updated_at: at,
  }))
  const advances = async (span: Locator) => {
    await expect(span).toHaveText(/^\d+s$/)
    const first = await span.textContent()
    await expect(span).not.toHaveText(first!, { timeout: 2_500 })
  }
  try {
    await page.goto(url("/#process=p73"))
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("#73 fix/73-keep-the-clock")
    // A mark on the window survives only while the page is not reloaded.
    await page.evaluate(() => Object.assign(window, { kept: true }))
    await advances(main(page).locator(`[title="${at}"]`))
    await sidebar(page).getByRole("link", { name: "Orchestrator" }).click()
    await advances(section(page, "Needs you").locator("[aria-label='fix/73-keep-the-clock'] [data-slot=age]"))
    expect(await page.evaluate(() => "kept" in window)).toBe(true)
  } finally {
    rmSync(file, { force: true })
  }
})

test("a process page links the pull request of its branch with its checks", async ({ page }) => {
  // The ready process of the fixture turns running for this test and is ready again after it.
  const file = join(process.env.AMEISE_RECORDS!, "p131.json")
  const fixture = readFileSync(file, "utf8")
  writeFileSync(file, JSON.stringify({
    project: process.env.AMEISE_SENSORS!, kind: "work", branch: "fix/131-log-the-sensor-drift", issue: 131, mode: "manual",
    stage: "ci", state: "running", note: "Waiting for the checks", updated_at: new Date().toISOString(),
  }))
  try {
    await page.goto(url("/#process=p131"))
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("#131 fix/131-log-the-sensor-drift")
    const pr = main(page).getByLabel("Pull request")
    await expect(pr).toHaveText("#250 checks pass")
    await expect(pr.getByRole("link", { name: "#250" })).toHaveAttribute("href", "https://github.com/acme/pull/250")
  } finally {
    writeFileSync(file, fixture)
  }
})

test("a process page shows the rounds of the review with each reviewer's verdict and the findings with their fixes", async ({ page }) => {
  // The ready process of the fixture has been reviewed in two rounds for this test, and is as it was after it.
  const file = join(process.env.AMEISE_RECORDS!, "p131.json")
  const fixture = readFileSync(file, "utf8")
  const at = new Date().toISOString()
  const finding = { id: "code-1-1", severity: "S2", where: "src/drift.ts:12", claim: "The drift is logged before it is clamped.", fix: "Clamp first." }
  writeFileSync(file, JSON.stringify({
    project: process.env.AMEISE_SENSORS!, kind: "work", branch: "fix/131-log-the-sensor-drift", issue: 131, mode: "manual",
    stage: "review", state: "ready", note: "the review passed in round 2", panel: "pass", updated_at: at,
    history: [
      { stage: "implement", kind: "session", result: "complete", at, commits: ["a1b2c3d fix: log the drift"] },
      { stage: "gate", kind: "run", result: "pass", at, commit: "a1b2c3d4", gate: "make check" },
      { stage: "review", kind: "round", result: "fix", at, round: 1, verdicts: [{ reviewer: "code", verdict: "fix", findings: [finding] }, { reviewer: "docs", verdict: "pass", findings: [] }] },
      { stage: "review", kind: "session", result: "complete", at, commits: ["e5f6a7b fix: clamp the drift first"], fixes: [{ finding: "code-1-1", outcome: "fixed", note: "Clamped before the log." }] },
      { stage: "gate", kind: "run", result: "skipped", at, commit: "e5f6a7b8", gate: "none" },
      { stage: "review", kind: "round", result: "pass", at, round: 2, verdicts: [{ reviewer: "code", verdict: "pass", findings: [] }] },
    ],
  }))
  try {
    await page.goto(url("/#process=p131"))
    // Each run of the gate names the gate form that ran.
    await expect(main(page).getByRole("list", { name: "Records of gate" }).getByRole("listitem")).toContainText(["make check pass at a1b2c3d", "none: no gate ran"])
    await expect(main(page).getByRole("list", { name: "Records of review" }).getByRole("listitem")).toContainText(["round 1 fix", "session complete, 1 commit", "round 2 pass"])
    const rounds = main(page).getByRole("list", { name: "Review rounds" })
    await expect(rounds.getByRole("listitem", { name: /^Round \d$/ })).toHaveCount(2)
    const first = rounds.getByRole("listitem", { name: "Round 1" })
    await expect(first.getByLabel(/^Verdict of /)).toContainText(["code fix", "docs pass"])
    await expect(first.getByRole("list", { name: "Findings of code" })).toHaveText("code-1-1 S2 src/drift.ts:12: The drift is logged before it is clamped.fixed: Clamped before the log.")
    await expect(rounds.getByRole("listitem", { name: "Round 2" }).getByLabel(/^Verdict of /)).toHaveText(["code pass"])
  } finally {
    writeFileSync(file, fixture)
  }
})

test("a process page in ci shows its pull request, what it waits for, the checks and the records of pr and ci", async ({ page }) => {
  // The ready process of the fixture waits on its pull request for this test, and is as it was after it.
  const file = join(process.env.AMEISE_RECORDS!, "p131.json")
  const fixture = readFileSync(file, "utf8")
  const at = new Date().toISOString()
  const failing = { name: "gate", url: "https://github.com/acme/edge-sensors/actions/runs/7", state: "fail" }
  writeFileSync(file, JSON.stringify({
    project: process.env.AMEISE_SENSORS!, kind: "work", branch: "fix/131-log-the-sensor-drift", issue: 131, mode: "manual",
    stage: "ci", state: "waiting", note: "PR #250: waiting for the checks: 1 of 2 pending", updated_at: at,
    pull: { number: 250, url: "https://github.com/acme/pull/250" },
    wait: "the checks: 1 of 2 pending",
    checks: [{ name: "gate", url: failing.url, state: "pending" }, { name: "lint", state: "pass" }],
    history: [
      { stage: "pr", kind: "open", result: "opened", at, pr: 250, url: "https://github.com/acme/pull/250" },
      { stage: "ci", kind: "wait", result: "checks-failed", at, pr: 250, checks: [failing] },
      { stage: "ci", kind: "session", result: "complete", at, commits: ["e5f6a7b fix: clamp the drift"] },
    ],
  }))
  try {
    await page.goto(url("/#process=p131"))
    await expect(main(page).getByLabel("Pull request").getByRole("link", { name: "#250" })).toHaveAttribute("href", "https://github.com/acme/pull/250")
    await expect(main(page).getByLabel("Wait")).toHaveText("waiting for the checks: 1 of 2 pending")
    await expect(main(page).getByRole("list", { name: "Checks" }).getByRole("listitem")).toHaveText(["gate pending", "lint pass"])
    await expect(main(page).getByRole("link", { name: "gate" })).toHaveAttribute("href", failing.url)
    await expect(main(page).getByRole("list", { name: "Records of pr" }).getByRole("listitem")).toContainText(["PR #250 opened"])
    await expect(main(page).getByRole("list", { name: "Records of ci" }).getByRole("listitem")).toContainText(["checks-failed", "session complete, 1 commit"])
  } finally {
    writeFileSync(file, fixture)
  }
})

test("a process page that answered a review shows the repair rounds, the address-reviews stage and the follow-up", async ({ page }) => {
  // The ready process of the fixture answered a review for this test, and is as it was after it.
  const file = join(process.env.AMEISE_RECORDS!, "p131.json")
  const fixture = readFileSync(file, "utf8")
  const at = new Date().toISOString()
  writeFileSync(file, JSON.stringify({
    project: process.env.AMEISE_SENSORS!, kind: "work", branch: "fix/131-log-the-sensor-drift", issue: 131, mode: "manual",
    stage: "ci", state: "waiting", note: "PR #250: waiting for the checks: 1 of 1 pending", updated_at: at,
    pull: { number: 250, url: "https://github.com/acme/pull/250" },
    wait: "the checks: 1 of 1 pending",
    repairs: { spent: 1, of: 3 },
    history: [
      { stage: "pr", kind: "open", result: "opened", at, pr: 250, url: "https://github.com/acme/pull/250" },
      { stage: "ci", kind: "wait", result: "review-comments", at, pr: 250, reviews: ["1 review thread(s) not resolved"] },
      { stage: "address-reviews", kind: "session", result: "complete", at, mandate: "bot", fixed: ["T1 Moved the bound"], declined: ["T2 The limit is the spec's"] },
      { stage: "address-reviews", kind: "answer", result: "posted", at, pr: 250, answered: [], replied: ["T1", "T2"] },
    ],
  }))
  try {
    await page.goto(url("/#process=p131"))
    await expect(main(page).getByLabel("Repair rounds")).toHaveText("repair rounds 1 of 3")
    await expect(main(page).getByRole("list", { name: "Records of address-reviews" }).getByRole("listitem")).toContainText([
      "session complete on a bot's review, fixed 1, declined 1",
      "replied to 2 threads",
    ])
    const followUp = main(page).getByRole("listitem", { name: "Follow-up 1" })
    await expect(followUp).toContainText("a bot's review · complete")
    await expect(followUp.getByRole("listitem")).toHaveText(["fixed: T1 Moved the bound", "declined: T2 The limit is the spec's"])
  } finally {
    writeFileSync(file, fixture)
  }
})

test("a process page in the gate on CI shows the gate's draft, what it waits for, the checks and the records of each gate run", async ({ page }) => {
  // The ready process of the fixture waits on the gate's draft for this test, and is as it was after it.
  const file = join(process.env.AMEISE_RECORDS!, "p131.json")
  const fixture = readFileSync(file, "utf8")
  const at = new Date().toISOString()
  const pending = { name: "gate", url: "https://github.com/acme/edge-sensors/actions/runs/8", state: "pending" }
  writeFileSync(file, JSON.stringify({
    project: process.env.AMEISE_SENSORS!, kind: "work", branch: "fix/131-log-the-sensor-drift", issue: 131, mode: "manual",
    stage: "gate", state: "waiting", note: "PR #250: waiting for a second reading", updated_at: at,
    pull: { number: 250, url: "https://github.com/acme/pull/250" },
    draft: true,
    wait: "a second reading a poll later that shows the same checks",
    checks: [pending, { name: "lint", state: "pass" }],
    history: [
      { stage: "implement", kind: "session", result: "complete", at, commits: ["a1b2c3d fix: log the drift"] },
      { stage: "gate", kind: "run", result: "fail", at, gate: "ci", pr: 250, commit: "a1b2c3d4e5", checks: [{ name: "gate", url: "https://github.com/acme/edge-sensors/actions/runs/7", state: "fail" }] },
      { stage: "gate", kind: "session", result: "complete", at, commits: ["e5f6a7b fix: clamp the drift"] },
    ],
  }))
  try {
    await page.goto(url("/#process=p131"))
    // The draft comes from the record, the checks from the board's pull request once the board has loaded.
    const pr = main(page).getByLabel("Pull request")
    await expect(pr).toHaveText("#250 the gate's draft checks pass")
    await expect(pr.getByRole("link", { name: "#250" })).toHaveAttribute("href", "https://github.com/acme/pull/250")
    await expect(main(page).getByLabel("Wait")).toHaveText("waiting for a second reading a poll later that shows the same checks")
    await expect(main(page).getByRole("list", { name: "Checks" }).getByRole("listitem")).toHaveText(["gate pending", "lint pass"])
    await expect(main(page).getByRole("list", { name: "Checks" }).getByRole("link", { name: "gate" })).toHaveAttribute("href", pending.url)
    await expect(main(page).getByRole("list", { name: "Records of gate" }).getByRole("listitem")).toContainText(["ci fail at a1b2c3d on PR #250: gate fail", "session complete, 1 commit"])
    const stages = main(page).getByRole("list", { name: "Stages" })
    await expect(stages.locator("[aria-current='step']")).toHaveText("gate")
    await expect(stages.getByText("ci", { exact: true })).not.toHaveAttribute("aria-current", "step")
  } finally {
    writeFileSync(file, fixture)
  }
})

test("a process page shows the facts, the stages and the session as a conversation with its cards", async ({ page }) => {
  await page.goto(url())
  await section(page, "Needs you").locator("[aria-label='feat/118-refuse-a-project-without-origin']").getByRole("button", { name: "Approve" }).click()
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("#118 feat/118-refuse-a-project-without-origin")
  await expect(main(page).getByLabel("Facts")).toHaveText("acme/edge-sensorsfeat/118-refuse-a-project-without-originmanual2hcontext84k")
  await expect(main(page).getByLabel("Context", { exact: true })).toHaveAttribute("title", "84,213 of 250,000 tokens before it compacts")
  await expect(main(page).getByRole("list", { name: "Stages" }).getByRole("listitem")).toHaveText(["implement", "gate", "review", "pr", "ci"])

  const turns = main(page).getByLabel("Conversation").getByRole("article")
  expect(await turns.evaluateAll((t) => t.map((x) => x.getAttribute("aria-label")))).toEqual(["Session", "Question", "Session", "You", "Session", "Permission"])
  // The tool calls are chips under the text, paths inside the worktree relative to it.
  await expect(turns.nth(0).getByRole("list", { name: "Tool calls" }).getByRole("listitem")).toHaveText([
    "Readsrc/config.ts",
    "Edittest/config.test.ts",
    "Bashnpx vitest run test/config.test.ts",
  ])
  // A call the maintainer allowed for the process is marked on its chip.
  await expect(turns.nth(2).getByRole("listitem").nth(1).locator("[title]")).toHaveAttribute("title", "Bash npx vitest run: allowed for this process")
  // A question that was answered keeps its answer and offers no options.
  await expect(turns.nth(1).getByRole("status")).toHaveText("You answered: Keep it, marked unusable, and say why on the board.")
  await expect(turns.nth(1).getByRole("button")).toHaveCount(0)
  await expect(turns.nth(3)).toHaveText("Read the URL, never change it. An ssh URL and an https URL name the same repository.")
  // The session, the maintainer and a question write markdown, which reads as written.
  await expect(turns.nth(3).locator("strong")).toHaveText("never")
  await expect(turns.nth(1).locator("code")).toHaveText("origin")
  await expect(turns.nth(1).locator("strong")).toHaveText("keep")
  const markdown = turns.nth(4)
  await expect(markdown.locator(".typeset.typeset-chat")).toHaveCount(1)
  await expect(markdown.locator("strong")).toHaveText("both forms")
  await expect(markdown.locator(".typeset-scroll > table")).toHaveCount(1)
  await expect(markdown.getByRole("table").getByRole("row")).toHaveText(["FormRemote", "sshgit@github.com:acme/edge-sensors.git", "httpshttps://github.com/acme/edge-sensors.git"])
  await expect(markdown.getByRole("list").getByRole("listitem")).toHaveText(["Owner and name come from the path", "A trailing .git is dropped"])
  await expect(markdown.locator("pre code")).toHaveText("const { owner, name } = parseRemote(url)")
  for (const code of [markdown.locator("pre"), markdown.locator("li code")]) expect(await code.evaluate((e) => getComputedStyle(e).fontFamily)).toMatch(/monospace/)
  const link = markdown.getByRole("link", { name: "issue 118" })
  await expect(link).toHaveAttribute("href", "https://github.com/acme/edge-sensors/issues/118")
  await expect(link).toHaveAttribute("target", "_blank")
  await expect(link).toHaveAttribute("rel", "noopener noreferrer")
  // The permission waits with its three answers. Its session is not running here, so the controller refuses the answer with the reason.
  const permission = turns.nth(5)
  await expect(permission).toContainText("Bash wants to run")
  await expect(permission.locator("code")).toHaveText("git remote set-url origin git@github.com:acme/edge-sensors.git")
  await expect(permission.getByRole("button")).toHaveText(["Allow once", "Allow for this process", "Deny"])
  await permission.getByRole("button", { name: "Allow once" }).click()
  await expect(permission.getByRole("alert")).toHaveText(/^no permission request toolu-remote waits in p118; it was answered, or its session has ended$/)
  await expect(main(page).getByRole("textbox", { name: "Message" })).toHaveAttribute("placeholder", "Write to the session…")
})

test("a session's raw HTML and links of other schemes read as text, and the lines between turns stay plain", async ({ page }) => {
  const record = join(process.env.AMEISE_RECORDS!, "p80.json")
  const log = join(process.env.AMEISE_RECORDS!, "p80.events.jsonl")
  writeFileSync(record, JSON.stringify({
    project: process.env.AMEISE_BACKTEST!, kind: "work", branch: "fix/80-quote-the-feed", issue: 80,
    stage: "implement", state: "blocked", note: "Which **feed** first?", updated_at: new Date().toISOString(),
  }))
  const text = "Quoting <b>the feed</b> as <img src=x onerror=alert(1)> [run it](javascript:alert(1)), [write](mailto:ops@acme.dev) or [go](/#project=x) ![the diagram](https://acme.dev/feed.png)."
  writeFileSync(log, [
    { event: "session-start", stage: "implement" },
    { event: "stream", message: { type: "assistant", parent_tool_use_id: null, message: { content: [{ type: "text", text }] } } },
    { event: "session-end", stage: "implement", state: "blocked", note: "Which **feed** first?" },
  ].map((l) => JSON.stringify(l)).join("\n") + "\n")
  try {
    await page.goto(url("/#process=p80"))
    const conversation = main(page).getByLabel("Conversation")
    const said = conversation.getByRole("article", { name: "Session" })
    await expect(said).toHaveText("Quoting <b>the feed</b> as <img src=x onerror=alert(1)> run it, write or go the diagram.")
    await expect(said.locator("b, img, a")).toHaveCount(0)
    await expect(conversation.getByRole("note")).toHaveText("Reported blocked: Which **feed** first?")
    await expect(main(page).getByLabel("Note")).toHaveText("Which **feed** first?")
  } finally {
    rmSync(record, { force: true })
    rmSync(log, { force: true })
  }
})

test("open in terminal has the terminal resume the session by its id", async ({ page }) => {
  rmSync(process.env.AMEISE_TERMINAL_LOG!, { force: true })
  await page.goto(url("/#process=p118"))
  await page.getByRole("button", { name: "Open in terminal" }).click()
  await expect.poll(() => existsSync(process.env.AMEISE_TERMINAL_LOG!)).toBe(true)
  const script = readFileSync(process.env.AMEISE_TERMINAL_LOG!, "utf8").trim()
  expect(readFileSync(script, "utf8")).toMatch(/^exec '[^']+' '--resume' '7f3c9a2e-5b1d-4e8a-9c6f-2d4b8e1a0f37' /m)
  await expect(main(page).getByRole("alert")).toHaveCount(0)
})

test("a running session's permission, question and chat are answered on its page, which follows it live", async ({ page }) => {
  const project = process.env.AMEISE_SENSORS!
  const play = join(process.env.AMEISE_FAKE_CLAUDE!, "play")
  writeFileSync(play, "permit npm test\nask Keep the old flag, or drop it?\nchoose Which of the flags go?\nwait\nblocked Which name should the flag take?\n")
  try {
    const claimed = await fetch(url("/api/processes"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ project, issue: 144 }) })
    expect(claimed.status).toBe(201)
    const { record } = await claimed.json()
    await page.goto(url(`/#process=${record.id}`))
    const conversation = main(page).getByLabel("Conversation")
    const permission = conversation.getByRole("article", { name: "Permission" })
    await expect(permission.locator("code")).toHaveText("npm test")
    await expect(main(page).locator("[title=approval]")).toHaveCount(1)
    await permission.getByRole("button", { name: "Allow once" }).click()
    await expect(permission.getByRole("status")).toHaveText("Allowed once")
    await expect(conversation.getByRole("article", { name: "Session" }).filter({ hasText: "Ran npm test." })).toHaveCount(1)

    const question = conversation.getByRole("article", { name: "Question" }).first()
    await expect(question).toContainText("Keep the old flag, or drop it?")
    await expect(main(page).getByRole("textbox", { name: "Message" })).toHaveAttribute("placeholder", "Answer the question…")
    await question.getByRole("button", { name: "Drop" }).click()
    await expect(question.getByRole("status")).toHaveText("You answered: Drop")
    await expect(conversation.getByRole("article", { name: "Session" }).filter({ hasText: "You answered: Drop." })).toHaveCount(1)

    // A question that takes several options sends the ones chosen together, in the order it offers them.
    const choice = conversation.getByRole("article", { name: "Question" }).filter({ hasText: "Which of the flags go?" })
    const send = choice.getByRole("button", { name: "Send" })
    await expect(send).toBeDisabled()
    await choice.getByRole("button", { name: "Drop" }).click()
    await choice.getByRole("button", { name: "Keep" }).click()
    await expect(choice.getByRole("button", { name: "Keep" })).toHaveAttribute("aria-pressed", "true")
    await expect(choice.getByRole("status")).toHaveText("Answer below")
    await send.click()
    await expect(choice.getByRole("status")).toHaveText("You answered: Keep, Drop")

    const message = main(page).getByRole("textbox", { name: "Message" })
    await message.fill("Name it --keep")
    await message.press("Enter")
    await expect(message).toHaveValue("")
    await expect(conversation.getByRole("article", { name: "You" })).toHaveText("Name it --keep")
    await expect(conversation.getByRole("article", { name: "Session" }).filter({ hasText: "You wrote: Name it --keep." })).toHaveCount(1)
    await expect(conversation.getByRole("note")).toHaveText("Reported blocked: Which name should the flag take?")
    await expect(main(page).locator("[title=blocked]")).toHaveCount(1)
    await expect(message).toHaveAttribute("placeholder", "Write to resume the session…")
    // The stage rail lists the session's end as a record of implement, and a hold waits for its next complete.
    await expect(main(page).getByRole("list", { name: "Records of implement" }).getByRole("listitem")).toContainText(["session blocked"])
    const hold = main(page).getByRole("button", { name: "Hold" })
    await expect(hold).toHaveAttribute("aria-pressed", "false")
    await hold.click()
    await expect(main(page).getByRole("button", { name: "Held" })).toHaveAttribute("aria-pressed", "true")
  } finally {
    rmSync(play, { force: true })
    await fetch(url("/api/processes"), { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ project, issue: 144 }) })
  }
})

test("the conversation follows its end while the session writes, keeps the place once scrolled up, and offers the way back", async ({ page }) => {
  const project = process.env.AMEISE_SENSORS!
  const play = join(process.env.AMEISE_FAKE_CLAUDE!, "play")
  // Enough text to fill more than the window, then two turns that each answer a message of the page.
  const said = Array.from({ length: 20 }, (_, i) => `say Step ${i + 1}: ${"the reader parses the remote, keeps the owner and the name, and drops a trailing .git. ".repeat(4)}`)
  writeFileSync(play, [...said, "wait", "wait"].join("\n") + "\n")
  try {
    const claimed = await fetch(url("/api/processes"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ project, issue: 144 }) })
    expect(claimed.status).toBe(201)
    const { record } = await claimed.json()
    await page.goto(url(`/#process=${record.id}`))
    const viewport = main(page).getByRole("region", { name: "Process" })
    const conversation = main(page).getByLabel("Conversation")
    const back = main(page).getByRole("button", { name: "Back to the end" })
    const message = main(page).getByRole("textbox", { name: "Message" })
    const top = () => viewport.evaluate((e) => e.scrollTop)
    const atEnd = () => viewport.evaluate((e) => e.scrollHeight - e.scrollTop - e.clientHeight <= 1)

    // At the end, each new turn comes into view and no way back is offered.
    const last = conversation.getByRole("article", { name: "Session" }).filter({ hasText: "Step 20:" })
    await expect(last).toBeInViewport()
    expect(await viewport.evaluate((e) => e.scrollHeight > 2 * e.clientHeight)).toBe(true)
    await expect(back).toBeHidden()
    await message.fill("First")
    await message.press("Enter")
    const first = conversation.getByRole("article", { name: "Session" }).filter({ hasText: "You wrote: First." })
    await expect(first).toBeInViewport()
    await expect.poll(atEnd).toBe(true)
    await expect(back).toBeHidden()

    // Scrolled up, the place holds while the session writes on, and the way back appears.
    await viewport.hover()
    await page.mouse.wheel(0, -800)
    await expect(back).toBeVisible()
    await expect(first).not.toBeInViewport()
    let place = -1
    await expect.poll(async () => place === (place = await top())).toBe(true)
    await message.fill("Second")
    await message.press("Enter")
    const second = conversation.getByRole("article", { name: "Session" }).filter({ hasText: "You wrote: Second." })
    await expect(second).toHaveCount(1)
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))
    expect(await top()).toBe(place)
    await expect(second).not.toBeInViewport()
    await expect(back).toBeVisible()

    // The button scrolls back to the end and leaves.
    await back.click()
    await expect(second).toBeInViewport()
    await expect.poll(atEnd).toBe(true)
    await expect(back).toBeHidden()

    // A fresh page opens at the end.
    await page.reload()
    await expect(viewport).toBeVisible()
    await expect(viewport).not.toHaveAttribute("data-pending-scroll")
    await expect(second).toBeInViewport()
    await expect.poll(atEnd).toBe(true)
    await expect(back).toBeHidden()
  } finally {
    rmSync(play, { force: true })
    await fetch(url("/api/processes"), { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ project, issue: 144 }) })
  }
})

test("while the board is derived the sections wait, and never say they are empty", async ({ page }) => {
  let release = () => {}
  const held = new Promise<void>((r) => (release = r))
  await page.route("**/api/board", async (r) => {
    await held
    await r.continue()
  })
  await page.goto(url())
  await expect(sections(page).locator("[data-slot=card-title]")).toHaveText(["Needs you", "Running", "Ready to start"])
  await expect(main(page).locator("[aria-busy=true]")).toHaveCount(3)
  await expect(main(page)).not.toContainText("Nothing waits for you")
  await expect(main(page)).not.toContainText("Frontier empty")
  release()
  await expect(sections(page).locator("[data-slot=card-title]")).toHaveText(["Needs you4", "Running3", "Ready to start3"])
})

test("a project opens its page from the sidebar, and the page survives a reload", async ({ page }) => {
  await page.goto(url())
  await projects(page).getByRole("link", { name: "backtest" }).click()
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("backtest")
  await expect(page.getByText("acme · base dev")).toBeVisible()
  await expect(sections(page).locator("[data-slot=card-title]")).toHaveText(["Processes2", "Ready to start1"])
  await expect(actions(page, "Processes")).toHaveText(["Open", "Open"])
  await expect(rows(page, "Processes").first()).not.toContainText("backtest")
  await expect(rows(page, "Ready to start")).toHaveText([/^#91Backfill candles after a gapv2\.4\.0ClaimPlan$/])
  for (const action of ["Plan", "Standardize", "Hunt tests", "Release"]) await expect(page.getByRole("button", { name: action, exact: true }).first()).toBeEnabled()
  await expect(projects(page).getByRole("link", { name: "backtest" })).toHaveAttribute("data-active", "true")

  await page.reload()
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("backtest")
  await sidebar(page).getByRole("link", { name: "Orchestrator" }).click()
  await expect(page.locator("header")).toHaveText(/Orchestrator3 projects$/)
})

test("on a phone the sidebar closes on the page it opens, and the project page fits the width", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(url())
  const sheet = page.getByRole("dialog")
  await page.getByRole("button", { name: "Toggle Sidebar" }).click()
  await sheet.getByRole("link", { name: "backtest" }).click()
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("backtest")
  await expect(sheet).toBeHidden()
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
})

test("a project page shows its specs ready for acceptance", async ({ page }) => {
  await page.goto(url())
  await projects(page).getByRole("link", { name: "edge-sensors" }).click()
  await expect(sections(page).locator("[data-slot=card-title]")).toHaveText(["Processes4", "Ready to start2", "Ready for acceptance1"])
  await expect(rows(page, "Ready for acceptance")).toHaveText([/^#100Offline modeEvery ticket is closedv0\.12\.0Accept$/])
})

test("a project whose checkout no longer derives shows the controller's reason", async ({ page }) => {
  const path = process.env.AMEISE_NOT_A_CHECKOUT!
  await page.goto(url())
  await projects(page).getByRole("link", { name: "notes" }).click()
  await expect(main(page)).toContainText(path)
  await expect(main(page)).toContainText(`${path} is not a git checkout; name the directory of a clone of a GitHub repository`)
})

test("a project that is not on this machine says so", async ({ page }) => {
  await page.goto(url("/#project=%2Fnowhere"))
  await expect(main(page)).toContainText("No such project/nowhere is not a project of this machine.")
})

test("a project page whose projects cannot be read says why, not that the project is missing", async ({ page }) => {
  await page.route("**/api/projects", (r) => r.abort())
  await page.goto(url("/#project=%2Fnowhere"))
  await expect(main(page)).toContainText("The projects could not be readthe controller does not answer; start it with ameise")
  await expect(main(page)).not.toContainText("No such project")
})

test("add project refuses a path with the controller's reason and adds a checkout, whose notes both pages show", async ({ page }) => {
  const spare = process.env.AMEISE_SPARE!
  await page.goto(url())
  try {
    await projects(page).getByRole("button", { name: "Add project" }).click()
    const dialog = page.getByRole("dialog", { name: "Add project" })
    await dialog.getByLabel("Path").fill("relative/path")
    await dialog.getByRole("button", { name: "Add" }).click()
    await expect(dialog.getByRole("alert")).toHaveText("path is not an absolute path; name the checkout as an absolute path")

    await dialog.getByLabel("Path").fill(spare)
    await dialog.getByRole("button", { name: "Add" }).click()
    await expect(dialog).toBeHidden()
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("firmware")
    await expect(projects(page).getByRole("link")).toHaveText(["edge-sensors", "backtest", "notes", "firmware"])

    // GitHub does not answer the open specs of firmware, and both pages say so above the sections.
    const note = "firmware: could not read the open specs; ready for acceptance is empty, not idle"
    await expect(main(page).getByRole("list", { name: "Notes" })).toHaveText(note)
    await sidebar(page).getByRole("link", { name: "Orchestrator" }).click()
    await expect(main(page).getByRole("list", { name: "Notes" })).toHaveText(note)
  } finally {
    await fetch(url("/api/projects"), {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: spare }),
    })
  }
})

test("a ready-to-start row claims its issue with mode and knobs, and the process row abandons it", async ({ page }) => {
  const project = process.env.AMEISE_SENSORS!
  const branch = "feat/145-claim-from-the-frontier-by-one-action"
  await page.goto(url())
  try {
    await section(page, "Ready to start").locator('[aria-label="#145"]').getByRole("button", { name: "Claim" }).click()
    const dialog = page.getByRole("dialog", { name: "Claim #145" })
    await expect(dialog).toContainText("Claim from the frontier by one action")
    // Claude is below the minimum, so the dialog warns and asks to claim anyway; nothing waits.
    await expect(dialog.getByRole("status", { name: "Quota" })).toHaveText("Claude has 8% of its quota left, below the minimum of 12%; it resets in 2h. Claim anyway?")
    await dialog.getByLabel("Knobs").fill("WF_NOPE=1")
    await dialog.getByRole("button", { name: "Claim anyway" }).click()
    await expect(dialog.getByRole("alert")).toContainText("WF_NOPE is not a worker knob a claim can set")

    // The claim goes through with a warning, which a dialog shows until it is closed, whatever the
    // board's refresh does meanwhile.
    const warning = "could not read the branches of acme/edge-sensors; claimed #145 without checking whether it is claimed on origin"
    await page.route("**/api/processes", async (r) => {
      const res = await r.fetch()
      const body = await res.json()
      await r.fulfill({ response: res, json: { ...body, warnings: [warning] } })
    })
    await dialog.getByRole("radio", { name: "Yolo" }).click()
    await dialog.getByLabel("Knobs").fill("WF_REVIEWERS=2\nWF_PR_BOT_REVIEWERS=")
    await dialog.getByRole("button", { name: "Claim anyway" }).click()
    await expect(dialog.getByRole("status", { name: "Warnings" })).toHaveText(warning)
    await page.unroute("**/api/processes")
    // A refresh of the board, which no longer has #145 in its frontier, leaves the warning on screen.
    const refreshed = page.waitForResponse((r) => new URL(r.url()).pathname === "/api/board")
    await page.evaluate(() => dispatchEvent(new Event("focus")))
    await refreshed
    await expect(dialog.getByRole("status", { name: "Warnings" })).toHaveText(warning)
    await dialog.getByRole("button", { name: "Done" }).click()
    await expect(dialog).toBeHidden()
    const row = section(page, "Running").locator(`[aria-label="${branch}"]`)
    await expect(row).toContainText(`edge-sensors#145${branch}implement session runningimplement`)
    await expect(section(page, "Ready to start").locator('[aria-label="#145"]')).toHaveCount(0)
    const board = await (await fetch(url("/api/board?" + new URLSearchParams({ project })))).json()
    expect(board.processes.find((p: { issue: number }) => p.issue === 145)).toMatchObject({ branch, state: "running", stage: "implement" })

    await row.getByRole("button", { name: "Abandon #145" }).click()
    const abandon = page.getByRole("dialog", { name: "Abandon #145" })
    await expect(abandon).toContainText("The branch and the issue stay as they are.")
    await abandon.getByRole("button", { name: "Abandon" }).click()
    await expect(abandon).toBeHidden()
    await expect(section(page, "Running").locator(`[aria-label="${branch}"]`)).toHaveCount(0)
    await expect(section(page, "Ready to start").locator('[aria-label="#145"]')).toHaveCount(1)
  } finally {
    await fetch(url("/api/processes"), {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ project, issue: 145, force: true }),
    })
  }
})

test("a worktree the controller did not start is adopted from its row, and the interrupted process resumes", async ({ page }) => {
  const project = process.env.AMEISE_BACKTEST!
  const branch = "fix/93-by-hand"
  execFileSync("git", ["-C", project, "worktree", "add", "-q", "-b", branch, join(project, ".claude", "worktrees", "fix-93-by-hand")], { stdio: "pipe" })
  try {
    await page.goto(url())
    const waiting = section(page, "Needs you").locator(`[aria-label="${branch}"]`)
    await expect(waiting).toContainText(`backtest#93${branch}not started by this controller; adopt it or remove itimplement`)
    await expect(waiting.locator("[title=foreign]")).toHaveCount(1)
    await waiting.getByRole("button", { name: "Adopt" }).click()
    await expect(waiting).toContainText("adopted; resume it to start its implement session in the worktree")
    await expect(waiting.locator("[title=interrupted]")).toHaveCount(1)
    await waiting.getByRole("button", { name: "Resume" }).click()
    await expect(section(page, "Running").locator(`[aria-label="${branch}"]`)).toContainText(`backtest#93${branch}implement session runningimplement`)
    await expect(waiting).toHaveCount(0)
  } finally {
    await fetch(url("/api/processes"), {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ project, issue: 93, force: true }),
    })
  }
})

// answer answers the next request to an API path with the status and body given, and keeps the body the
// dashboard sent, so a test reads what an action asked for without changing the fake's state.
async function answer(page: Page, path: string, status: number, body: unknown): Promise<() => unknown> {
  let sent: unknown
  await page.route(`**${path}`, async (r) => {
    sent = r.request().postDataJSON()
    await r.fulfill({ status, json: body })
  })
  return () => sent
}

test("merge, accept and release each ask once, show the controller's refusal, and send the action", async ({ page }) => {
  const project = process.env.AMEISE_SENSORS!
  await page.goto(url())

  // Merge on a ready process: the controller's refusal shows in the dialog, a merge closes it.
  const ready = section(page, "Needs you").locator('[aria-label="fix/131-log-the-sensor-drift"]')
  const pr = (await (await fetch(url("/api/board?" + new URLSearchParams({ project })))).json()).processes.find(
    (p: { branch: string }) => p.branch === "fix/131-log-the-sensor-drift",
  ).pr.number
  await ready.getByRole("button", { name: "Merge" }).click()
  const merge = page.getByRole("dialog", { name: `Merge PR #${pr}` })
  await expect(merge).toContainText("deletes fix/131-log-the-sensor-drift and removes its worktree and process")
  await answer(page, "/api/merges", 409, { error: `PR #${pr} has checks still pending; merge it once they pass` })
  await merge.getByRole("button", { name: "Merge" }).click()
  await expect(merge.getByRole("alert")).toHaveText(`PR #${pr} has checks still pending; merge it once they pass`)
  await page.unroute("**/api/merges")
  let sent = await answer(page, "/api/merges", 200, { branch: "fix/131-log-the-sensor-drift", base: "main", closed: null, warnings: [] })
  await merge.getByRole("button", { name: "Merge" }).click()
  await expect(merge).toBeHidden()
  expect(sent()).toEqual({ project, pr })

  // Accept on a spec ready for acceptance starts its acceptance in a plan process.
  await section(page, "Needs you").locator('[aria-label="#100"]').getByRole("button", { name: "Accept" }).click()
  const acceptance = page.getByRole("dialog", { name: "Accept #100" })
  await expect(acceptance).toContainText("Gathers the facts of Offline mode, runs the spec checker read-only and shows its items in a plan process.")
  sent = await answer(page, "/api/acceptances", 201, { record: { branch: "plan/offline-mode" } })
  await acceptance.getByRole("button", { name: "Start acceptance" }).click()
  await expect(acceptance).toBeHidden()
  expect(sent()).toEqual({ project, spec: 100 })

  // Release on the project page: a promotion that is not green says why it waits.
  await projects(page).getByRole("link", { name: "edge-sensors" }).click()
  await page.getByRole("button", { name: "Release", exact: true }).click()
  const release = page.getByRole("dialog", { name: "Release" })
  await release.getByLabel("Milestone").fill("v0.12.0")
  const reason = "PR #7 has checks still pending; merge it once they pass; release v0.12.0 again once it is green"
  sent = await answer(page, "/api/releases", 202, { status: "waiting", milestone: "v0.12.0", promotion: "https://github.com/acme/edge-sensors/pull/7", reason })
  await release.getByRole("button", { name: "Release" }).click()
  const waiting = page.getByRole("dialog", { name: "Release v0.12.0" })
  await expect(waiting.getByRole("status", { name: "Warnings" })).toHaveText(reason)
  expect(sent()).toEqual({ project, milestone: "v0.12.0" })
  await waiting.getByRole("button", { name: "Done" }).click()
  await expect(waiting).toBeHidden()
})

test("plan opens a plan process from an idea, nothing or an issue, and a plan's page captures its prototype and finishes it", async ({ page }) => {
  const project = process.env.AMEISE_SENSORS!
  const id = "plan-0123456789ab"
  const record = {
    id, project, kind: "plan", route: "idea", topic: "Offline mode", branch: "plan/offline-mode", issue: null,
    stage: "plan", state: "input", note: "Which part first?", session_id: "s-1", compact_at: 250000, updated_at: new Date().toISOString(),
  }
  // The plan's page follows a stream the test cans: its record, and nothing said yet.
  await page.route(`**/api/processes/events?id=${id}`, (r) =>
    r.fulfill({ status: 200, headers: { "content-type": "text/event-stream" }, body: `event: record\ndata: ${JSON.stringify(record)}\n\nevent: entries\ndata: []\n\n` }),
  )
  await page.goto(url())
  await projects(page).getByRole("link", { name: "edge-sensors" }).click()

  // Plan on the project page: the controller's refusal shows in the dialog; a plan opens its page.
  await main(page).getByRole("button", { name: "Plan", exact: true }).first().click()
  let dialog = page.getByRole("dialog", { name: "Plan" })
  await dialog.getByLabel("Idea").fill("Offline mode")
  await answer(page, "/api/plans", 409, { error: "plan/offline-mode is open already" })
  await dialog.getByRole("button", { name: "Start planning" }).click()
  await expect(dialog.getByRole("alert")).toHaveText("plan/offline-mode is open already")
  await page.unroute("**/api/plans")
  let sent = await answer(page, "/api/plans", 201, { record: { id, branch: "plan/offline-mode" } })
  await dialog.getByRole("button", { name: "Start planning" }).click()
  await expect(page).toHaveURL(new RegExp(`#process=${id}$`))
  expect(sent()).toEqual({ project, idea: "Offline mode" })
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("plan/offline-mode")

  // Without an idea it is an open session.
  await page.goBack()
  await main(page).getByRole("button", { name: "Plan", exact: true }).first().click()
  dialog = page.getByRole("dialog", { name: "Plan" })
  await dialog.getByRole("button", { name: "Start planning" }).click()
  await expect(page).toHaveURL(new RegExp(`#process=${id}$`))
  expect(sent()).toEqual({ project })

  // Plan on a ready-to-start row plans its issue.
  await page.goBack()
  await section(page, "Ready to start").locator('[aria-label="#145"]').getByRole("button", { name: "Plan" }).click()
  dialog = page.getByRole("dialog", { name: "Plan #145" })
  await expect(dialog).toContainText("Claim from the frontier by one action")
  await dialog.getByRole("button", { name: "Start planning" }).click()
  await expect(page).toHaveURL(new RegExp(`#process=${id}$`))
  expect(sent()).toEqual({ project, issue: 145 })

  // Capture prototype names the branch and says where it went.
  await main(page).getByRole("button", { name: "Capture prototype" }).click()
  dialog = page.getByRole("dialog", { name: "Capture prototype" })
  await dialog.getByLabel("Name").fill("state machine")
  const url_ = "https://github.com/acme/edge-sensors/tree/prototype/offline-mode-state-machine"
  sent = await answer(page, "/api/processes/capture", 201, { id, branch: "prototype/offline-mode-state-machine", url: url_ })
  await dialog.getByRole("button", { name: "Capture" }).click()
  const captured = page.getByRole("dialog", { name: "Prototype captured" })
  await expect(captured.getByRole("status", { name: "Warnings" })).toHaveText(url_)
  expect(sent()).toEqual({ id, name: "state machine" })
  await captured.getByRole("button", { name: "Done" }).click()

  // Finish refuses what was not captured unless forced, then opens the project's page.
  await main(page).getByRole("button", { name: "Finish" }).click()
  dialog = page.getByRole("dialog", { name: "Finish" })
  await answer(page, "/api/processes/finish", 409, { error: "the worktree has changes not captured" })
  await dialog.getByRole("button", { name: "Finish" }).click()
  await expect(dialog.getByRole("alert")).toHaveText("the worktree has changes not captured")
  await page.unroute("**/api/processes/finish")
  sent = await answer(page, "/api/processes/finish", 200, { id, branch: "plan/offline-mode", worktree: null })
  await dialog.getByLabel(/^Force/).check()
  await dialog.getByRole("button", { name: "Finish" }).click()
  await expect(page).toHaveURL(new RegExp(`#${new URLSearchParams({ project })}$`))
  expect(sent()).toEqual({ id, force: true })
})

test("hunt tests opens a hunt process, whose page shows the hunt record, and a hunt that removed nothing finishes", async ({ page }) => {
  const project = process.env.AMEISE_SENSORS!
  const id = "hunt-0123456789ab"
  const record = {
    id, project, kind: "hunt", branch: "hunt/tests-2026-09-30", issue: null, mode: "manual",
    stage: "hunt", state: "done", note: "the hunt removed nothing in 1 round, so no pull request opens; 1 candidate were checked and kept. Finish it to remove its worktree and branch",
    session_id: "s-1", compact_at: 250000, updated_at: new Date().toISOString(),
    hunt: {
      rounds: 1, max_rounds: 3, ended: "round 1 found no new candidate", stale: 0,
      removed: [],
      kept: [{ round: 1, path: "tests/test_drift.py", test: "test_drift", category: "mocks-subject", reason: "the clock may be stubbed", confidence: "medium" }],
    },
  }
  await page.route(`**/api/processes/events?id=${id}`, (r) =>
    r.fulfill({ status: 200, headers: { "content-type": "text/event-stream" }, body: `event: record\ndata: ${JSON.stringify(record)}\n\nevent: entries\ndata: []\n\n` }),
  )
  await page.goto(url())
  await projects(page).getByRole("link", { name: "edge-sensors" }).click()

  // Hunt tests on the project page: the controller's refusal shows in the dialog; a hunt opens its page.
  await main(page).getByRole("button", { name: "Hunt tests", exact: true }).click()
  const dialog = page.getByRole("dialog", { name: "Hunt tests" })
  const refusal = "the hunt branch hunt/tests-2026-09-29 exists on origin; merge its pull request or delete it before the next hunt"
  await answer(page, "/api/hunts", 409, { error: refusal })
  await dialog.getByRole("button", { name: "Start the hunt" }).click()
  await expect(dialog.getByRole("alert")).toHaveText(refusal)
  await page.unroute("**/api/hunts")
  let sent = await answer(page, "/api/hunts", 201, { record: { id, branch: "hunt/tests-2026-09-30" }, warnings: [] })
  await dialog.getByRole("button", { name: "Start the hunt" }).click()
  await expect(page).toHaveURL(new RegExp(`#process=${id}$`))
  expect(sent()).toEqual({ project })

  // The page shows the hunt's stages, why it ended with no pull request, and the candidates it kept.
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("hunt/tests-2026-09-30")
  await expect(page.getByRole("list", { name: "Stages" }).locator("[data-slot=badge]")).toHaveText(["hunt", "gate", "review", "pr", "ci"])
  await expect(page.getByLabel("Note")).toContainText("so no pull request opens")
  const hunt = page.getByRole("region", { name: "Hunt record" })
  await expect(hunt).toContainText("round 1 of at most 3 · ended: round 1 found no new candidate")
  await expect(hunt.getByRole("list", { name: "Kept candidates" })).toHaveText("kept test_drift in tests/test_drift.py · mocks-subject, medium: the clock may be stubbed")

  // Finish removes it and opens the project's page.
  await main(page).getByRole("button", { name: "Finish" }).click()
  sent = await answer(page, "/api/processes/finish", 200, { id, branch: "hunt/tests-2026-09-30", worktree: null })
  await page.getByRole("dialog", { name: "Finish" }).getByRole("button", { name: "Finish" }).click()
  await expect(page).toHaveURL(new RegExp(`#${new URLSearchParams({ project })}$`))
  expect(sent()).toEqual({ id, force: false })
})

test("an acceptance's page shows every item with its verdict and sends one answer per item not met", async ({ page }) => {
  const project = process.env.AMEISE_SENSORS!
  const id = "plan-100-0123abcd"
  const item = (n: number, verdict: string, statement: string) => ({ id: `item-${n}`, section: "User stories", statement, verdict, evidence: `src/a.ts:${n}`, confidence: "high" })
  const record = {
    id, project, kind: "plan", route: "accept", branch: "plan/offline-mode", issue: 100, stage: "accept", state: "input",
    note: "3 item(s), 2 not met; answer each in the process view", updated_at: new Date().toISOString(),
    acceptance: {
      spec: { title: "Offline mode", milestone: "v0.12.0", labels: ["spec"] }, tickets: [{ number: 101, title: "Cache", prs: [12] }], files: 2,
      deviations: [], notes: [], repeated: 0,
      items: [item(1, "met", "Work offline"), item(2, "missing", "Sync on reconnect"), item(3, "deviates", "Cache for a day")],
    },
  }
  await page.route(`**/api/processes/events?id=${id}`, (r) =>
    r.fulfill({ status: 200, headers: { "content-type": "text/event-stream" }, body: `event: record\ndata: ${JSON.stringify(record)}\n\nevent: entries\ndata: []\n\n` }),
  )
  await page.goto(url(`/#process=${id}`))
  const items = page.getByRole("list", { name: "Items" })
  await expect(items.getByRole("listitem")).toHaveCount(3)
  await expect(items.locator('[aria-label="item-1"]')).toContainText("metUser stories · confidence highWork offlinesrc/a.ts:1")
  // A met item takes no answer, and the answers go once every item not met has one.
  await expect(items.locator('[aria-label="item-1"]').getByRole("button")).toHaveCount(0)
  const write = page.getByRole("button", { name: "Write the answers" })
  await expect(write).toBeDisabled()
  await items.locator('[aria-label="item-2"]').getByRole("button", { name: "Gap ticket" }).click()
  await expect(page.getByLabel("Title")).toHaveValue("Sync on reconnect")
  await items.locator('[aria-label="item-3"]').getByRole("button", { name: "Accepted deviation" }).click()
  await expect(write).toBeDisabled()
  await page.getByLabel("Why the code is right").fill("A day is what the devices hold.")
  const sent = await answer(page, "/api/acceptances/answers", 200, { record })
  await write.click()
  await expect.poll(sent).toEqual({
    id,
    answers: [
      { item: "item-2", answer: "gap", title: "Sync on reconnect" },
      { item: "item-3", answer: "deviation", reason: "A day is what the devices hold." },
    ],
  })
  // An acceptance runs no session of its own, so the chat is closed.
  await expect(page.getByRole("textbox", { name: "Message" })).toBeDisabled()
})

// A standardize process waiting for its answers, with findings in every category as the fake auditors
// report them.
const standardization = (project: string, id: string) => {
  const category = (name: string, action: string, target: string, reason: string, confidence: string, report: string[]) => ({
    name, findings: [{ target, action, reason, confidence }], report,
  })
  return {
    id, project, kind: "standardize", branch: "chore/standardize", issue: null, mode: "manual",
    stage: "audit", state: "input", note: "findings: 6 in 6 categories; 5 for the run, 1 as issues; approve or reject each category in the process view",
    updated_at: new Date().toISOString(),
    standardize: {
      facts: ["languages: typescript"], workspace: [],
      auditors: ["files", "agent-config", "docs", "tests-ci", "workspace", "security"].map((c) => ({ category: c, state: "complete", note: "", findings: 1 })),
      summary: "findings: 6 in 6 categories; 5 for the run, 1 as issues", dropped: [],
      categories: [
        category("files", "delete", "NOTES.md", "agent notes left in the repository", "high", ["  deletes: NOTES.md"]),
        category("agent-config", "delete", ".claude/commands/old.md", "a repository-local command", "medium", ["  deletes: .claude/commands/old.md", "  scaffolds: AGENTS.md, CLAUDE.md"]),
        category("docs", "create", "docs/glossary.md", "the glossary is missing", "high", ["  creates: docs/glossary.md"]),
        category("tests-ci", "replace", "Makefile", "the check target runs no test", "medium", ["  replaces: Makefile"]),
        category("workspace", "configure", "branch protection of main", "main takes force pushes", "high", ["  configures: branch protection of main"]),
        category("security", "issue", "config/deploy.env", "a token may be committed", "low", ["  opens an issue: config/deploy.env"]),
      ],
    },
  }
}

test("standardize opens a standardize process, whose page takes one approval per category and applies them together", async ({ page }) => {
  const project = process.env.AMEISE_SENSORS!
  const id = "standardize-0123456789ab"
  const record = standardization(project, id)
  await page.route(`**/api/processes/events?id=${id}`, (r) =>
    r.fulfill({ status: 200, headers: { "content-type": "text/event-stream" }, body: `event: record\ndata: ${JSON.stringify(record)}\n\nevent: entries\ndata: []\n\n` }),
  )
  await page.goto(url())
  await projects(page).getByRole("link", { name: "edge-sensors" }).click()

  // Standardize on the project page: the controller's refusal shows in the dialog; a standardisation opens its page.
  await main(page).getByRole("button", { name: "Standardize", exact: true }).click()
  const dialog = page.getByRole("dialog", { name: "Standardize" })
  const refusal = "the branch chore/standardize exists on origin; merge or close its pull request and delete it before the next standardisation"
  await answer(page, "/api/standardize", 409, { error: refusal })
  await dialog.getByRole("button", { name: "Start the audit" }).click()
  await expect(dialog.getByRole("alert")).toHaveText(refusal)
  await page.unroute("**/api/standardize")
  let sent = await answer(page, "/api/standardize", 201, { record: { id, branch: "chore/standardize" } })
  await dialog.getByRole("button", { name: "Start the audit" }).click()
  await expect(page).toHaveURL(new RegExp(`#process=${id}$`))
  expect(sent()).toEqual({ project })

  // The page shows the stages and the findings per category, each with an approval of its own.
  await expect(page.getByRole("list", { name: "Stages" }).locator("[data-slot=badge]")).toHaveText(["audit", "apply", "finalize"])
  const categories = page.getByRole("list", { name: "Categories" })
  await expect(categories.getByRole("listitem").and(page.locator("[aria-label]"))).toHaveCount(6)
  await expect(categories.locator('[aria-label="files"]')).toContainText("deleteNOTES.md")
  await expect(categories.locator('[aria-label="files"]')).toContainText("agent notes left in the repository · confidence high")
  await expect(categories.locator('[aria-label="files"]')).toContainText("deletes: NOTES.md")
  // The answers go once every category has one, approved or rejected.
  const apply = page.getByRole("button", { name: "Apply the approved categories" })
  await expect(apply).toBeDisabled()
  for (const c of ["files", "agent-config"]) await categories.locator(`[aria-label="${c}"]`).getByRole("button", { name: "Approve" }).click()
  await expect(apply).toBeDisabled()
  for (const c of ["docs", "tests-ci", "workspace", "security"]) await categories.locator(`[aria-label="${c}"]`).getByRole("button", { name: "Reject" }).click()
  await expect(categories.locator('[aria-label="files"]').getByRole("button", { name: "Approve" })).toHaveAttribute("aria-pressed", "true")
  sent = await answer(page, "/api/standardize/apply", 200, { record })
  await apply.click()
  await expect.poll(sent).toEqual({
    id,
    answers: { files: "approve", "agent-config": "approve", docs: "reject", "tests-ci": "reject", workspace: "reject", security: "reject" },
  })
})

test("a standardisation's page shows the applied steps and the cleanup pull request, and finalizes once it is merged", async ({ page }) => {
  const project = process.env.AMEISE_SENSORS!
  const id = "standardize-0123456789ab"
  const audited = standardization(project, id)
  const answers: Record<string, string> = { files: "approve", "agent-config": "approve", docs: "reject", "tests-ci": "reject", workspace: "reject", security: "reject" }
  const record = {
    ...audited,
    stage: "apply", state: "ready",
    note: "the cleanup pull request https://github.com/acme/edge-sensors/pull/9 is open; merge it once its check passes, then finalize",
    standardize: {
      ...audited.standardize,
      categories: audited.standardize.categories.map((c) => ({ ...c, answer: answers[c.name] })),
      applied: ["approve", "backup", "prepare", "session", "open", "issues"].map((step) => ({ step, ok: true, lines: step === "open" ? ["pr: https://github.com/acme/edge-sensors/pull/9 opened"] : [], at: step })),
      pull: "https://github.com/acme/edge-sensors/pull/9", catalogue: 5,
    },
  }
  await page.route(`**/api/processes/events?id=${id}`, (r) =>
    r.fulfill({ status: 200, headers: { "content-type": "text/event-stream" }, body: `event: record\ndata: ${JSON.stringify(record)}\n\nevent: entries\ndata: []\n\n` }),
  )
  await page.goto(url(`/#process=${id}`))
  const categories = page.getByRole("list", { name: "Categories" })
  await expect(categories.locator('[aria-label="files"]')).toContainText("approved")
  await expect(categories.locator('[aria-label="docs"]')).toContainText("rejected")
  await expect(categories.getByRole("button")).toHaveCount(0)
  await expect(page.getByRole("list", { name: "Applied" }).getByRole("listitem")).toHaveText([/^okapprove/, /^okbackup/, /^okprepare/, /^oksession/, /^okopenpr: /, /^okissues/])
  await expect(page.getByRole("link", { name: "cleanup pull request" })).toHaveAttribute("href", "https://github.com/acme/edge-sensors/pull/9")
  await expect(main(page)).toContainText("catalogue issue #5")
  const sent = await answer(page, "/api/standardize/finalize", 200, { record })
  await page.getByRole("button", { name: "Finalize" }).click()
  await expect.poll(sent).toEqual({ id })
  // A standardisation runs no session to write to between its stages.
  await expect(page.getByRole("textbox", { name: "Message" })).toBeDisabled()
})

test("the sidebar collapses to its icons and hides the quota", async ({ page }) => {
  await page.goto(url())
  await expect(projects(page).getByRole("link")).toHaveCount(3)
  await page.getByRole("button", { name: "Toggle Sidebar" }).first().click()
  await expect(page.locator("[data-slot=sidebar][data-state=collapsed]")).toHaveCount(1)
  await expect(sidebar(page).getByRole("list", { name: "Quota" })).toBeHidden()
  await expect(projects(page).getByText("edge-sensors")).toBeHidden()
  const icon = await projects(page).getByRole("link", { name: "edge-sensors" }).boundingBox()
  expect(icon?.width).toBe(32)
})

for (const scheme of ["light", "dark"] as const) {
  test.describe(`in ${scheme}`, () => {
    test.use({ colorScheme: scheme })

    for (const name of ["orchestrator", "project", "process"] as const) {
      test(`the ${name} page holds its layout`, async ({ page }) => {
        // Tall enough for every section of the board the fake mode serves.
        await page.setViewportSize({ width: 1440, height: 1040 })
        await page.goto(url())
        await expect(projects(page).getByRole("link")).toHaveCount(3)
        if (name === "project") await projects(page).getByRole("link", { name: "edge-sensors" }).click()
        await expect(sections(page).first()).toBeVisible()
        if (name === "process") {
          await section(page, "Needs you").getByRole("link", { name: "feat/118-refuse-a-project-without-origin" }).click()
          await expect(page.getByRole("heading", { level: 1 })).toHaveText("#118 feat/118-refuse-a-project-without-origin")
          // The process page holds a question card and a permission card that waits for its answer.
          await expect(main(page).getByRole("article", { name: "Permission" }).getByRole("button")).toHaveCount(3)
          await expect(main(page).getByRole("article", { name: "Question" })).toHaveCount(1)
        }
        await page.evaluate(() => document.fonts.ready)
        await expect(page).toHaveScreenshot(`${name}-${scheme}.png`, {
          animations: "disabled",
          caret: "hide",
          maxDiffPixels: 100,
          threshold: 0.3,
        })
      })
    }

    // The approval view of a standardisation: the findings of every category, each waiting for its answer.
    test("the approval of a standardisation holds its layout", async ({ page }) => {
      const id = "standardize-0123456789ab"
      const record = standardization(process.env.AMEISE_SENSORS!, id)
      await page.route(`**/api/processes/events?id=${id}`, (r) =>
        r.fulfill({ status: 200, headers: { "content-type": "text/event-stream" }, body: `event: record\ndata: ${JSON.stringify(record)}\n\nevent: entries\ndata: []\n\n` }),
      )
      await page.setViewportSize({ width: 1440, height: 1040 })
      await page.goto(url(`/#process=${id}`))
      await expect(page.getByRole("list", { name: "Categories" }).locator("[aria-label]")).toHaveCount(6)
      await page.evaluate(() => document.fonts.ready)
      // The scroller follows the end within a tolerance, so on a slow runner it can rest a pixel short
      // of it; the screenshot is of the page scrolled to its very end.
      const pane = main(page).getByLabel("Process", { exact: true })
      await expect.poll(() => pane.evaluate((el) => {
        el.scrollTop = el.scrollHeight
        return el.scrollHeight - el.clientHeight - el.scrollTop
      })).toBeLessThan(1)
      await expect(page).toHaveScreenshot(`standardize-${scheme}.png`, {
        animations: "disabled",
        caret: "hide",
        maxDiffPixels: 100,
        threshold: 0.3,
      })
    })
  })
}
