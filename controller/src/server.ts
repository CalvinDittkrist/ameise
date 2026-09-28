// The server: the local API every client talks to, the dashboard and the CLI alike. It is the one
// writer of the configuration file.
import { appendFileSync, mkdirSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { isAbsolute, join, resolve } from 'node:path'
import { address, type Config, readConfig, writeConfig } from './config.js'
import { checkout, derive, Refusal } from './project.js'

export interface Options {
  config: Config
  configPath: string
  stateDir: string
  gh: string
  fake: boolean
}

type ProjectView = Awaited<ReturnType<typeof derive>> | { path: string; error: string }

export function serve(o: Options): Server {
  mkdirSync(o.stateDir, { recursive: true })
  const log = (event: Record<string, unknown>) =>
    appendFileSync(join(o.stateDir, 'events.jsonl'), JSON.stringify({ at: new Date().toISOString(), ...event }) + '\n')

  const list = (): Promise<ProjectView[]> =>
    Promise.all(
      o.config.projects.map((path) =>
        derive(path, o.gh).catch((err: Error): ProjectView => ({ path, error: err.message })),
      ),
    )

  async function add(req: IncomingMessage, res: ServerResponse) {
    const body = await readJSON(req)
    const path = typeof body?.path === 'string' ? body.path : ''
    if (!path || !isAbsolute(path)) return send(res, 400, { error: 'path is not an absolute path; name the checkout as an absolute path' })
    const project = await derive(resolve(path), o.gh)
    // The file is read again before each write, so a change made to it by hand while the server
    // runs is kept. The server takes over only the projects: it stays on the address it listens on.
    const config = readConfig(o.configPath)
    if (config.projects.includes(project.path)) return send(res, 409, { error: `${project.path} is already a project` })
    config.projects.push(project.path)
    writeConfig(o.configPath, config)
    o.config.projects = config.projects
    send(res, 201, project)
  }

  async function remove(req: IncomingMessage, res: ServerResponse) {
    const body = await readJSON(req)
    const path = typeof body?.path === 'string' ? body.path : ''
    if (!path || !isAbsolute(path)) return send(res, 400, { error: 'path is not an absolute path; name the checkout as an absolute path' })
    // A checkout names itself by its top, so a path inside one removes the project it belongs to.
    const config = readConfig(o.configPath)
    const absolute = resolve(path)
    const known = config.projects.includes(absolute) ? absolute : await checkout(absolute).catch(() => absolute)
    const i = config.projects.indexOf(known)
    if (i < 0) return send(res, 404, { error: `${absolute} is not a project; workflows projects lists them` })
    config.projects.splice(i, 1)
    writeConfig(o.configPath, config)
    o.config.projects = config.projects
    send(res, 200, { path: known })
  }

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const route = `${req.method} ${url.pathname}`
    // A page on another site can make a browser send requests here. A Host that is not this server's
    // own name turns away a rebound DNS name. A write must say it is JSON, which a page can only do
    // after a preflight this server never grants.
    if (!loopbackHost(req.headers.host, o.config.listen)) return send(res, 403, { error: 'the Host header does not name this server' })
    if (req.method !== 'GET' && !(req.headers['content-type'] ?? '').startsWith('application/json')) {
      return send(res, 415, { error: 'a write is sent as application/json' })
    }
    const handle = async () => {
      switch (route) {
        case 'GET /api/projects':
          return send(res, 200, await list())
        case 'POST /api/projects':
          return add(req, res)
        case 'DELETE /api/projects':
          return remove(req, res)
        case 'GET /':
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
          return res.end('<!doctype html><title>workflows</title><p>workflows is running. The projects are at <a href="/api/projects">/api/projects</a>.</p>\n')
        default:
          return send(res, 404, { error: `no route ${route}` })
      }
    }
    handle().catch((err: Error) => {
      if (err instanceof TooLarge) send(res, 413, { error: err.message })
      else if (err instanceof Refusal || err instanceof SyntaxError) send(res, 400, { error: err.message })
      else send(res, 500, { error: err.message })
    })
  })
  server.on('listening', () => log({ event: 'started', fake: o.fake }))
  return server
}

function loopbackHost(host: string | undefined, listen: string): boolean {
  if (!host) return false
  const { port } = address(listen)
  return [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`, listen].includes(host)
}

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body) + '\n')
}

// A body is a path and nothing more, so one past this size is refused before it fills the memory.
const bodyLimit = 64 * 1024

class TooLarge extends Error {}

async function readJSON(req: IncomingMessage): Promise<Record<string, unknown> | undefined> {
  const raw = await new Promise<string>((resolve, reject) => {
    let body = ''
    req.setEncoding('utf8')
    const take = (chunk: string) => {
      body += chunk
      if (body.length <= bodyLimit) return
      // The rest of the body is read and dropped, so the answer still reaches the client.
      req.off('data', take)
      req.resume()
      reject(new TooLarge(`the body is larger than ${bodyLimit} bytes; send {"path": "<checkout>"}`))
    }
    req.on('data', take)
    req.on('end', () => resolve(body))
    req.on('error', reject)
  })
  if (!raw) return undefined
  try {
    return JSON.parse(raw) as Record<string, unknown>
  } catch {
    throw new SyntaxError('the body is not JSON; send {"path": "<checkout>"}')
  }
}
