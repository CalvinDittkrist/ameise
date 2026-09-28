import { defineConfig, devices } from "@playwright/test"

// The browser test reads the dashboard the way the maintainer reads it: over HTTP from the real
// controller in fake mode, which tests/controller.ts starts on a machine of its own with a free port.
export default defineConfig({
  testDir: "./tests",
  // One controller with one configuration: a test that adds a project changes what the next one reads.
  workers: 1,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : [["list"]],
  globalSetup: "./tests/controller.ts",
  // One approved screenshot per operating system: the layout is the same everywhere, the way glyphs
  // are rasterised is not, and a baseline that has to absorb that would hold nothing.
  snapshotPathTemplate: "{testDir}/screenshots/{arg}-{platform}{ext}",
  use: {
    ...devices["Desktop Chrome"],
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
    colorScheme: "light",
    trace: "retain-on-failure",
  },
})
