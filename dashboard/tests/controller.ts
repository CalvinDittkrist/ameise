import { execFileSync, spawn } from "node:child_process"
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { delimiter, join } from "node:path"
import { fileURLToPath } from "node:url"

// The browser test watches the real thing: the built controller, started in fake mode on a machine of
// its own. That machine is a temporary directory with the configuration, the state, a claude that only
// answers its version, a browser that opens nothing and a canned GitHub. Its projects are two
// checkouts whose origin is on GitHub and one directory that is no checkout, so the sidebar shows both
// kinds. The controller serves the dashboard build it finds in its own build, which make dashboard
// writes before this runs.

const controller = fileURLToPath(new URL("../../controller/dist/main.js", import.meta.url))
const READY = 30_000

export default async function start() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "workflows-dashboard-")))
  const bin = join(root, "bin")
  mkdirSync(bin)
  script(join(bin, "claude"), 'echo "2.0.0 (Claude Code, scripted)"')
  script(join(bin, "browser"), "exit 0")

  const github = join(root, "github")
  const sources = join(root, "src")
  const projects = [
    checkout(sources, "edge-sensors", "acme/edge-sensors", "main"),
    checkout(sources, "backtest", "acme/backtest", "dev"),
    join(sources, "notes"),
  ]
  mkdirSync(projects[2], { recursive: true })
  // A checkout the add-project test adds and removes again.
  process.env.WORKFLOWS_SPARE = checkout(sources, "firmware", "acme/firmware", "main")
  process.env.WORKFLOWS_NOT_A_CHECKOUT = projects[2]
  mkdirSync(github)

  const port = await freePort()
  const config = join(root, "config", "workflows", "config.json")
  mkdirSync(join(root, "config", "workflows"), { recursive: true })
  writeFileSync(config, JSON.stringify({ listen: `127.0.0.1:${port}`, projects }, null, 2) + "\n")

  const server = spawn(process.execPath, [controller, "--fake"], {
    env: {
      HOME: root,
      PATH: [bin, process.env.PATH].join(delimiter),
      XDG_CONFIG_HOME: join(root, "config"),
      XDG_DATA_HOME: join(root, "data"),
      BROWSER: join(bin, "browser"),
      WORKFLOWS_FAKE_GH: github,
    },
    stdio: ["ignore", "pipe", "inherit"],
  })
  // The exit is awaited from spawn on, so a controller that dies before teardown ends teardown too.
  const ended = new Promise((done) => server.once("exit", done))
  const stop = () => {
    if (server.exitCode === null) server.kill("SIGTERM")
  }
  process.on("exit", stop)
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`the controller did not start within ${READY / 1000}s`)), READY)
      let out = ""
      server.stdout.on("data", (d: Buffer) => {
        out += d
        if (!out.includes("workflows on ")) return
        clearTimeout(timer)
        resolve()
      })
      server.once("exit", (code) => {
        clearTimeout(timer)
        reject(new Error(`the controller exited with ${code} before it listened; npm --prefix controller run build builds it`))
      })
    })
  } catch (error) {
    stop()
    throw error
  }
  // The tests run in processes of their own, which inherit this environment.
  process.env.WORKFLOWS_URL = `http://127.0.0.1:${port}`
  return async () => {
    stop()
    await ended
    rmSync(root, { recursive: true, force: true })
  }
}

function script(path: string, body: string) {
  writeFileSync(path, `#!/bin/sh\n${body}\n`)
  chmodSync(path, 0o755)
}

// checkout makes a git checkout whose origin is the repository on GitHub, and whose origin names the
// base as its head, so the controller derives every fact from the checkout and asks GitHub nothing.
function checkout(sources: string, name: string, repository: string, base: string): string {
  const dir = join(sources, name)
  mkdirSync(dir, { recursive: true })
  const git = (...args: string[]) => execFileSync("git", ["-C", dir, ...args], { stdio: "pipe" })
  git("init", "-q", "-b", base)
  git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init")
  git("remote", "add", "origin", `https://github.com/${repository}.git`)
  git("update-ref", `refs/remotes/origin/${base}`, "HEAD")
  git("symbolic-ref", "refs/remotes/origin/HEAD", `refs/remotes/origin/${base}`)
  return dir
}

// freePort asks the operating system for a port nobody holds, so two worktrees can run the gate at once.
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer()
    s.on("error", reject)
    s.listen(0, "127.0.0.1", () => {
      const a = s.address()
      s.close(() => resolve(typeof a === "object" && a ? a.port : 0))
    })
  })
}
