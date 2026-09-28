import { rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { test as base, expect, type Page } from "@playwright/test"

// The dashboard read the way the maintainer reads it: in a browser, against the real controller in fake
// mode (tests/controller.ts). Its projects are edge-sensors (base main) and backtest (base dev), both
// clones of a GitHub repository with processes, frontier and a spec ready for acceptance, and notes, a
// directory that is no checkout.

const url = (path = "/") => process.env.WORKFLOWS_URL + path
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
  const listed = await (await fetch(url("/api/projects"))).json()
  expect(listed.map((p: { name?: string }) => p.name)).toEqual(["edge-sensors", "backtest", undefined])

  await expect(projects(page).getByRole("link")).toHaveText(["edge-sensors", "backtest", "notes"])
  await expect(projects(page).getByRole("button")).toHaveText(["Add project"])
  const links = sidebar(page).getByRole("link")
  await expect(links).toHaveText(["workflowsthis machine", "Orchestrator", "edge-sensors", "backtest", "notes"])
  await expect(sidebar(page).getByRole("link", { name: "Orchestrator" })).toHaveAttribute("data-active", "true")
  await expect(sidebar(page).getByText("Quota", { exact: true })).toBeVisible()
})

test("the sidebar shows the quota of each runtime with its reset, and marks one below the minimum", async ({ page }) => {
  await page.goto(url())
  const claude = sidebar(page).getByRole("list", { name: "Quota" }).getByRole("listitem", { name: "Claude" })
  await expect(claude).toHaveText("Claude8%below 12% · resets in 2h")
  await expect(claude).toHaveAttribute("data-below", "true")
  const quota = await (await fetch(url("/api/quota"))).json()
  expect(quota).toMatchObject({ minimum: 12, runtimes: [{ runtime: "claude", known: true, remaining: 8, below: true }] })
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
  const file = join(process.env.WORKFLOWS_RECORDS!, "p78.json")
  writeFileSync(file, JSON.stringify({
    project: process.env.WORKFLOWS_BACKTEST!, kind: "work", branch: "fix/78-keep-the-order-book", issue: 78,
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
    await expect(page.getByRole("definition").filter({ hasText: "Which exchange first?" })).toBeVisible()
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
  const file = join(process.env.WORKFLOWS_RECORDS!, "p79.json")
  writeFileSync(file, JSON.stringify({
    project: process.env.WORKFLOWS_BACKTEST!, kind: "work", branch: "fix/79-retry-the-mark", issue: 79,
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
  await expect(actions(page, "Needs you")).toHaveText(["Answer", "Merge", "Continue", "Accept"])
  await expect(rows(page, "Needs you").first()).toContainText("edge-sensors#118feat/118-refuse-a-project-without-originAsks: keep the project in the file, or drop it?implement2h")
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
  const file = join(process.env.WORKFLOWS_RECORDS!, "p77.json")
  writeFileSync(file, JSON.stringify({
    project: process.env.WORKFLOWS_BACKTEST!, kind: "work", branch: "fix/77-drop-stale-ticks", issue: 77,
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
  for (const action of ["Plan", "Standardize", "Hunt tests", "Release"]) {
    await expect(page.getByRole("button", { name: action, exact: true }).first()).toBeDisabled()
  }
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
  const path = process.env.WORKFLOWS_NOT_A_CHECKOUT!
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
  await expect(main(page)).toContainText("The projects could not be readthe controller does not answer; start it with workflows")
  await expect(main(page)).not.toContainText("No such project")
})

test("add project refuses a path with the controller's reason and adds a checkout, whose notes both pages show", async ({ page }) => {
  const spare = process.env.WORKFLOWS_SPARE!
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
  const project = process.env.WORKFLOWS_SENSORS!
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

test("the sidebar collapses to its icons and hides the quota", async ({ page }) => {
  await page.goto(url())
  await expect(projects(page).getByRole("link")).toHaveCount(3)
  await page.getByRole("button", { name: "Toggle Sidebar" }).first().click()
  await expect(page.locator("[data-slot=sidebar][data-state=collapsed]")).toHaveCount(1)
  await expect(sidebar(page).getByText("Quota", { exact: true })).toBeHidden()
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
  })
}
