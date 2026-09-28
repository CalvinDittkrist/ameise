// The server: the local API every client talks to, the dashboard and the CLI alike. It is the one
// writer of the configuration file.
import { appendFileSync, mkdirSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { join, resolve } from 'node:path'
import { type Config, writeConfig } from './config.js'
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
    if (!path || !path.startsWith('/')) return send(res, 400, { error: 'path is not an absolute path; name the checkout as an absolute path' })
    const project = await derive(resolve(path), o.gh)
    if (o.config.projects.includes(project.path)) return send(res, 409, { error: `${project.path} is already a project` })
    o.config.projects.push(project.path)
    writeConfig(o.configPath, o.config)
    send(res, 201, project)
  }

  async function remove(req: IncomingMessage, res: ServerResponse) {
    const body = await readJSON(req)
    const path = typeof body?.path === 'string' ? resolve(body.path) : ''
    // A checkout names itself by its top, so a path inside one removes the project it belongs to.
    const known = o.config.projects.includes(path) ? path : await checkout(path).catch(() => path)
    const i = o.config.projects.indexOf(known)
    if (i < 0) return send(res, 404, { error: `${path} is not a project; workflows projects lists them` })
    o.config.projects.splice(i, 1)
    writeConfig(o.configPath, o.config)
    send(res, 200, { path: known })
  }

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const route = `${req.method} ${url.pathname}`
    // A page on another site can make a browser send requests here. A Host that is not this server's
    // own name turns away a rebound DNS name, and a write must say it is JSON, which a page can only
    // do after a preflight this server never grants.
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
      if (err instanceof Refusal || err instanceof SyntaxError) send(res, 400, { error: err.message })
      else send(res, 500, { error: err.message })
    })
  })
  server.on('listening', () => log({ event: 'started', fake: o.fake }))
  return server
}

function loopbackHost(host: string | undefined, listen: string): boolean {
  if (!host) return false
  const port = listen.slice(listen.lastIndexOf(':') + 1)
  return [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`, listen].includes(host)
}

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body) + '\n')
}

async function readJSON(req: IncomingMessage): Promise<Record<string, unknown> | undefined> {
  let raw = ''
  for await (const chunk of req) raw += chunk
  if (!raw) return undefined
  try {
    return JSON.parse(raw) as Record<string, unknown>
  } catch {
    throw new SyntaxError('the body is not JSON; send {"path": "<checkout>"}')
  }
}
