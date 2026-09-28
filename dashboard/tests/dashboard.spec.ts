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
  await expect(sidebar(page).getByText("Quota")).toBeVisible()
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
  for (const action of ["Plan", "Standardize", "Hunt tests"]) {
    await expect(page.getByRole("button", { name: action, exact: true }).first()).toBeDisabled()
  }
  await expect(page.getByRole("button", { name: "Release", exact: true })).toBeEnabled()
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
    await dialog.getByLabel("Knobs").fill("WF_NOPE=1")
    await dialog.getByRole("button", { name: "Claim" }).click()
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
    await dialog.getByRole("button", { name: "Claim" }).click()
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
  const project = process.env.WORKFLOWS_SENSORS!
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

  // Accept on a spec ready for acceptance opens a plan process.
  await section(page, "Needs you").locator('[aria-label="#100"]').getByRole("button", { name: "Accept" }).click()
  const acceptance = page.getByRole("dialog", { name: "Accept #100" })
  await expect(acceptance).toContainText("Opens a plan process on Offline mode with the acceptance route.")
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

test("the sidebar collapses to its icons and hides the quota", async ({ page }) => {
  await page.goto(url())
  await expect(projects(page).getByRole("link")).toHaveCount(3)
  await page.getByRole("button", { name: "Toggle Sidebar" }).first().click()
  await expect(page.locator("[data-slot=sidebar][data-state=collapsed]")).toHaveCount(1)
  await expect(sidebar(page).getByText("Quota")).toBeHidden()
  await expect(projects(page).getByText("edge-sensors")).toBeHidden()
  const icon = await projects(page).getByRole("link", { name: "edge-sensors" }).boundingBox()
  expect(icon?.width).toBe(32)
})

for (const scheme of ["light", "dark"] as const) {
  test.describe(`in ${scheme}`, () => {
    test.use({ colorScheme: scheme })

    for (const name of ["orchestrator", "project"] as const) {
      test(`the ${name} page holds its layout`, async ({ page }) => {
        // Tall enough for every section of the board the fake mode serves.
        await page.setViewportSize({ width: 1440, height: 1040 })
        await page.goto(url())
        await expect(projects(page).getByRole("link")).toHaveCount(3)
        if (name === "project") await projects(page).getByRole("link", { name: "edge-sensors" }).click()
        await expect(sections(page).first()).toBeVisible()
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
