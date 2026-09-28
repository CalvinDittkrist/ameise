import { execFileSync, spawn } from "node:child_process"
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { delimiter, dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

// The browser test watches the real thing: the built controller, started in fake mode on a machine of
// its own. That machine is a temporary directory with the configuration, the state, a claude that only
// answers its version, a browser that opens nothing, a terminal that writes down what it was asked to
// run and a canned GitHub. The sessions run on the controller's scripted claude, whose play a test
// writes into WORKFLOWS_FAKE_CLAUDE. Its projects are two
// checkouts whose origin is on GitHub and one directory that is no checkout, so the sidebar shows both
// kinds. The checkouts hold worktrees and process records. The canned GitHub holds their pull requests,
// agent-ready issues and specs. So the board has a row of every kind. A scripted quota-axi answers that
// Claude has 8% left, below the minimum of 12%, until a reset two and a half hours on. The controller serves the
// dashboard build it finds in its own build, which make dashboard writes before this runs.

const controller = fileURLToPath(new URL("../../controller/dist/main.js", import.meta.url))
const READY = 30_000

export default async function start() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "workflows-dashboard-")))
  const bin = join(root, "bin")
  mkdirSync(bin)
  script(join(bin, "claude"), 'echo "2.0.0 (Claude Code, scripted)"')
  script(join(bin, "browser"), "exit 0")
  const terminal = join(root, "terminal.log")
  script(join(bin, "terminal"), `printf '%s\\n' "$1" >> '${terminal}'`)
  process.env.WORKFLOWS_TERMINAL_LOG = terminal
  const claude = join(root, "claude")
  mkdirSync(claude)
  process.env.WORKFLOWS_FAKE_CLAUDE = claude
  const quota = join(root, "quota.json")
  writeFileSync(quota, JSON.stringify(report(8, new Date(Date.now() + 2.5 * 3_600_000).toISOString())))
  script(join(bin, "quota-axi"), `cat '${quota}'`)

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
  process.env.WORKFLOWS_SENSORS = projects[0]
  mkdirSync(github)
  board(root, github, projects[0]!, projects[1]!)
  // Its open specs are left uncanned, so GitHub does not answer them and its board carries a note.
  can(github, "acme/firmware", [], [])

  const port = await freePort()
  const config = join(root, "config", "workflows", "config.json")
  mkdirSync(join(root, "config", "workflows"), { recursive: true })
  writeFileSync(config, JSON.stringify({ listen: `127.0.0.1:${port}`, quota_axi: join(bin, "quota-axi"), quota_minimum: 12, notifications: false, terminal: join(bin, "terminal"), projects }, null, 2) + "\n")

  const server = spawn(process.execPath, [controller, "--fake"], {
    env: {
      HOME: root,
      PATH: [bin, process.env.PATH].join(delimiter),
      XDG_CONFIG_HOME: join(root, "config"),
      XDG_DATA_HOME: join(root, "data"),
      BROWSER: join(bin, "browser"),
      WORKFLOWS_FAKE_GH: github,
      WORKFLOWS_FAKE_CLAUDE: claude,
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

// report is quota-axi's JSON report of Claude with the percentage left and the reset of its session window.
function report(remaining: number, reset: string) {
  return {
    schemaVersion: 5,
    providers: [
      {
        provider: "claude",
        state: { stale: false, error: "" },
        windows: [{ id: "five_hour", resetsAt: reset }],
        quotaSemantics: { effectiveAvailability: [{ scope: "all_models", status: "known", effectivePercentRemaining: remaining, limitingWindowIds: ["five_hour"] }] },
      },
    ],
  }
}

// ago is an instant the given hours before now, half an hour later still, so the age the board shows
// stays the same while the tests run.
const ago = (hours: number) => new Date(Date.now() - (hours + 0.5) * 3_600_000).toISOString()

// board gives the two checkouts their processes and their GitHub. The processes hold every state the
// board sorts. The frontier holds an issue it leaves out. One spec is ready for acceptance, one is not.
function board(root: string, github: string, sensors: string, backtest: string) {
  const blocked = worktree(sensors, "feat/118-refuse-a-project-without-origin", 2)
  worktree(sensors, "fix/131-log-the-sensor-drift", 5)
  const running = worktree(sensors, "feat/142-read-the-configuration", 1)
  worktree(backtest, "feat/88-reconnect-the-broker-stream", 1)
  worktree(backtest, "hunt/tests-2026-09-27", 24)
  const records = join(root, "data", "workflows", "processes")
  mkdirSync(records, { recursive: true })
  // The failed-session test writes a record of its own here and removes it again.
  process.env.WORKFLOWS_RECORDS = records
  process.env.WORKFLOWS_BACKTEST = backtest
  process.env.WORKFLOWS_SENSORS = sensors
  const record = (id: string, r: Record<string, unknown>) => writeFileSync(join(records, `${id}.json`), JSON.stringify(r))
  record("p118", {
    project: sensors, kind: "work", branch: "feat/118-refuse-a-project-without-origin", issue: 118, worktree: blocked, base: "origin/main", mode: "manual", env: {},
    stage: "implement", state: "approval", note: "Bash wants to run: git remote set-url origin git@github.com:acme/edge-sensors.git",
    session_id: "7f3c9a2e-5b1d-4e8a-9c6f-2d4b8e1a0f37", context: 84213, updated_at: ago(2),
  })
  conversation(join(records, "p118.events.jsonl"), blocked)
  record("p142", {
    project: sensors, kind: "work", branch: "feat/142-read-the-configuration", issue: 142, worktree: running,
    stage: "implement", state: "running", note: "Writing the config reader, tests green", updated_at: ago(1),
  })
  record("plan1", {
    project: sensors, kind: "plan", branch: "plan/open-20260928-0011", stage: "plan", state: "input", note: "Waiting for you", updated_at: ago(3),
  })
  const pr = (number: number, branch: string, checks: object[]) =>
    ({ number, headRefName: branch, isDraft: false, url: `https://github.com/acme/pull/${number}`, statusCheckRollup: checks })
  const issue = (number: number, title: string, labels: string[], more: object = {}) =>
    ({ number, title, state: "open", assignees: [], labels: labels.map((name) => ({ name })), issue_dependencies_summary: { blocked_by: 0 }, ...more })
  const v = (title: string) => ({ milestone: { title } })
  can(
    github,
    "acme/edge-sensors",
    [pr(250, "fix/131-log-the-sensor-drift", [{ conclusion: "SUCCESS" }])],
    [
      issue(144, "Board lists every project with its processes", ["ready-for-agent"], v("v0.12.0")),
      issue(145, "Claim from the frontier by one action", ["ready-for-agent"], v("v0.12.0")),
      issue(146, "Routed to the factory", ["ready-for-agent", "factory"]),
      issue(147, "Somebody works on it", ["ready-for-agent"], { assignees: [{ login: "bob" }] }),
    ],
    [issue(100, "Offline mode", ["spec"], v("v0.12.0")), issue(101, "Notifications", ["spec"])],
  )
  // The issues the claim test and the session test claim, as gh issue view answers them, and the branches of origin.
  writeFileSync(
    join(github, "repos", "acme/edge-sensors", "issues", "144.json"),
    JSON.stringify({ number: 144, title: "Board lists every project with its processes", state: "OPEN", labels: [{ name: "ready-for-agent" }] }),
  )
  writeFileSync(
    join(github, "repos", "acme/edge-sensors", "issues", "145.json"),
    JSON.stringify({ number: 145, title: "Claim from the frontier by one action", state: "OPEN", labels: [{ name: "ready-for-agent" }] }),
  )
  api(github, "repos/acme/edge-sensors/branches?per_page=100", [{ name: "main" }])
  api(github, "repos/acme/edge-sensors/issues/100/sub_issues?per_page=100", [{ number: 1, state: "closed" }, { number: 2, state: "closed" }])
  api(github, "repos/acme/edge-sensors/issues/101/sub_issues?per_page=100", [{ number: 3, state: "closed" }, { number: 4, state: "open" }])
  can(
    github,
    "acme/backtest",
    [pr(251, "feat/88-reconnect-the-broker-stream", [{ conclusion: "SUCCESS" }, { status: "IN_PROGRESS" }])],
    [issue(91, "Backfill candles after a gap", ["ready-for-agent"], v("v2.4.0"))],
    [],
  )
}

// conversation writes the event log of a session that asked a question, was answered, went on and now
// waits for a permission, so the process page shows every kind of turn.
function conversation(file: string, tree: string) {
  const said = (text: string, ...tools: [string, object][]) => ({
    event: "stream",
    message: {
      type: "assistant",
      parent_tool_use_id: null,
      message: { content: [{ type: "text", text }, ...tools.map(([name, input]) => ({ type: "tool_use", name, input }))], usage: { input_tokens: 84000 } },
    },
  })
  const question = "A project without an origin is refused. Should the controller keep it in the file, marked unusable, or drop it from the file?"
  const log = [
    { event: "claimed", issue: 118 },
    { event: "session-start", stage: "implement" },
    said(
      "I read the issue and AGENTS.md. The reader needs the listen address, the quota command and the projects; owner and name come from origin. Starting with a failing test.",
      ["Read", { file_path: `${tree}/src/config.ts` }],
      ["Edit", { file_path: `${tree}/test/config.test.ts` }],
      ["Bash", { command: "npx vitest run test/config.test.ts" }],
    ),
    {
      event: "question",
      request: "toolu-ask",
      questions: [
        {
          question,
          header: "Origin",
          options: [{ label: "Keep, marked unusable", description: "The board shows why." }, { label: "Drop it", description: "The file loses the path." }],
          multiSelect: false,
        },
      ],
    },
    { event: "answer", request: "toolu-ask", text: "Keep it, marked unusable, and say why on the board." },
    said("Keeping it in the file and marking it unusable. Adding the case to the test.", ["Edit", { file_path: `${tree}/src/config.ts` }], ["Bash", { command: "npx vitest run" }]),
    { event: "allowed", tool: "Bash", detail: "npx vitest run" },
    { event: "message", text: "Read the URL, never change it. An ssh URL and an https URL name the same repository." },
    said("Understood: parsing both forms and changing nothing. The remote of this checkout still names the old repository, though."),
    {
      event: "permission",
      request: "toolu-remote",
      tool: "Bash",
      detail: "git remote set-url origin git@github.com:acme/edge-sensors.git",
      title: "Bash wants to run",
      reason: "The classifier did not settle it: the command rewrites the remote of the checkout.",
    },
  ]
  writeFileSync(file, log.map((l) => JSON.stringify(l)).join("\n") + "\n")
}

// can cans a repository's open pull requests, agent-ready issues and open specs on the fake GitHub.
// Specs left out stay uncanned, and the fake GitHub answers them with an error.
function can(github: string, repository: string, pulls: object[], ready: object[], specs?: object[]) {
  mkdirSync(join(github, "repos", repository, "issues"), { recursive: true })
  writeFileSync(join(github, "repos", repository, "pulls.json"), JSON.stringify(pulls))
  api(github, `repos/${repository}/issues?labels=ready-for-agent&state=open&per_page=100`, ready)
  if (specs) api(github, `repos/${repository}/issues?labels=spec&state=open&per_page=100`, specs)
}

function api(github: string, endpoint: string, answer: unknown) {
  const file = join(github, "api", endpoint)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(answer))
}

// worktree adds a worktree on a new branch whose last commit is the given hours old.
function worktree(dir: string, branch: string, hours: number): string {
  const path = join(dir, ".claude", "worktrees", branch.replace(/\//g, "-"))
  execFileSync("git", ["-C", dir, "worktree", "add", "-q", "-b", branch, path], { stdio: "pipe" })
  const date = ago(hours)
  execFileSync("git", ["-C", path, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "work"], {
    stdio: "pipe",
    env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
  })
  return path
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
