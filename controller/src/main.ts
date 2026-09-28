#!/usr/bin/env node
// workflows: with no command it starts the controller's server and opens the browser on it; every
// other command is a client of that running server.
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { address, type Config, ConfigError, configPath, readConfig, stateDir } from './config.js'
import { run } from './project.js'
import { serve } from './server.js'

const usage = `usage:
  workflows [--fake]                 start the server and open the browser
  workflows projects                 list the projects
  workflows projects add <path>      add the checkout at <path> as a project
  workflows projects remove <path>   remove the project at <path>

--fake answers GitHub with the scripted gh the tests use, so nothing reaches GitHub.`

function die(message: string): never {
  process.stderr.write(`error: ${message}\n`)
  process.exit(1)
}

function config(path: string): Config {
  try {
    return readConfig(path)
  } catch (err) {
    if (err instanceof ConfigError) die(err.message)
    throw err
  }
}

// The scripted gh ships beside the build: dist/main.js reaches fake/gh.
const fakeGh = fileURLToPath(new URL('../fake/gh', import.meta.url))

async function start(fake: boolean) {
  const path = configPath()
  const c = config(path)
  const gh = fake ? fakeGh : 'gh'
  try {
    await run(gh, ['--version'])
  } catch {
    die('gh is not installed; install the GitHub CLI (brew install gh, or https://cli.github.com) and log in with gh auth login')
  }
  try {
    await run(gh, ['auth', 'status'])
  } catch {
    die('gh is not logged in; run gh auth login')
  }
  try {
    await run('claude', ['--version'])
  } catch {
    die('claude is not installed; npm install -g @anthropic-ai/claude-code')
  }
  const { host, port, url } = address(c.listen)
  const server = serve({ config: c, configPath: path, stateDir: stateDir(), gh, fake })
  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') die(`${c.listen} is in use; stop what listens there, or set another loopback address as listen in ${path}`)
    die(err.message)
  })
  server.listen(port, host, () => {
    process.stdout.write(`workflows on ${url} (fake=${fake}, config ${path})\n`)
    browse(url)
  })
  const stop = () => server.close(() => process.exit(0))
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
}

// browse opens the dashboard in the browser the environment names in BROWSER, else in the platform's
// own. A browser that does not open costs nothing: the address is printed above.
function browse(url: string) {
  const [cmd, ...args] = process.env.BROWSER
    ? [process.env.BROWSER, url]
    : process.platform === 'darwin'
      ? ['open', url]
      : process.platform === 'win32'
        ? ['cmd', '/c', 'start', '', url]
        : ['xdg-open', url]
  if (!cmd) return
  const child = spawn(cmd, args, { stdio: 'ignore', detached: true })
  child.on('error', () => process.stderr.write(`warning: no browser opened; open ${url}\n`))
  child.unref()
}

// call sends one request to the running server and dies with the fix when none runs.
async function call(method: string, path: string, body?: unknown): Promise<unknown> {
  const file = configPath()
  const { url } = address(config(file).listen)
  let res: Response
  try {
    res = await fetch(url + path, {
      method,
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  } catch {
    die(`workflows is not running on ${url}; start it with workflows`)
  }
  const answer = (await res.json().catch(() => ({}))) as { error?: string }
  if (!res.ok) die(answer.error ?? `${method} ${path} answered ${res.status}`)
  return answer
}

interface Listed {
  path: string
  owner?: string
  name?: string
  base?: string
  error?: string
}

function line(p: Listed): string {
  return p.error ? `${p.path}  error: ${p.error}` : `${p.path}  ${p.owner}/${p.name}  base ${p.base}`
}

async function main(argv: string[]) {
  const [command, sub, arg, ...rest] = argv
  if (command === undefined || command === '--fake') {
    if (sub !== undefined) die(`unexpected argument ${sub}; workflows help lists the commands`)
    return start(command === '--fake')
  }
  if (command === 'help' || command === '--help' || command === '-h') {
    process.stdout.write(usage + '\n')
    return
  }
  if (command !== 'projects' || rest.length > 0) die(`unknown command ${argv.join(' ')}; workflows help lists the commands`)
  if (sub === undefined || sub === 'list') {
    if (arg !== undefined) die(`unexpected argument ${arg}; workflows help lists the commands`)
    for (const p of (await call('GET', '/api/projects')) as Listed[]) process.stdout.write(line(p) + '\n')
    return
  }
  if ((sub === 'add' || sub === 'remove') && arg !== undefined) {
    const path = resolve(arg)
    if (sub === 'add') process.stdout.write('added ' + line((await call('POST', '/api/projects', { path })) as Listed) + '\n')
    else process.stdout.write(`removed ${((await call('DELETE', '/api/projects', { path })) as Listed).path}\n`)
    return
  }
  die(`unknown command ${argv.join(' ')}; workflows help lists the commands`)
}

main(process.argv.slice(2)).catch((err: Error) => die(err.message))
