import { test as base, expect, type Page } from "@playwright/test"

// The dashboard read the way the maintainer reads it: in a browser, against the real controller in fake
// mode (tests/controller.ts). Its projects are edge-sensors (base main) and backtest (base dev), both
// clones of a GitHub repository, and notes, a directory that is no checkout.

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

test("the Orchestrator page shows its three sections, each empty", async ({ page }) => {
  await page.goto(url())
  await expect(page.locator("header")).toHaveText(/Orchestrator3 projects$/)
  await expect(sections(page).locator("[data-slot=card-title]")).toHaveText(["Needs you0", "Running0", "Ready to start0"])
  await expect(sections(page).locator("[data-slot=empty]")).toHaveText(["Nothing waits for you", "Nothing running", "Frontier empty"])
})

test("a project opens its page from the sidebar, and the page survives a reload", async ({ page }) => {
  await page.goto(url())
  await projects(page).getByRole("link", { name: "backtest" }).click()
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("backtest")
  await expect(page.getByText("acme · base dev")).toBeVisible()
  await expect(sections(page).locator("[data-slot=card-title]")).toHaveText(["Processes0", "Ready to start0"])
  for (const action of ["Plan", "Standardize", "Hunt tests", "Release"]) {
    await expect(page.getByRole("button", { name: action })).toBeDisabled()
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

test("add project refuses a path with the controller's reason and adds a checkout", async ({ page }) => {
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
  } finally {
    await fetch(url("/api/projects"), {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: spare }),
    })
  }
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
