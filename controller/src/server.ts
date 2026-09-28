// The server: the local API every client talks to, the dashboard and the CLI alike. It is the one
// writer of the configuration file.
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { isAbsolute, join, resolve } from 'node:path'
import { address, readConfig, writeConfig } from './config.js'
import { checkout, derive, type Listed, Refusal } from './project.js'

export interface Options {
  // listen is the address the server listens on; the projects are read from the file on each request.
  listen: string
  configPath: string
  stateDir: string
  gh: string
  fake: boolean
}

export function serve(o: Options): Server {
  mkdirSync(o.stateDir, { recursive: true })
  const log = (event: Record<string, unknown>) =>
    appendFileSync(join(o.stateDir, 'events.jsonl'), JSON.stringify({ at: new Date().toISOString(), ...event }) + '\n')

  // The list reads the file as add and remove do, so a project added or removed by hand shows at once.
  const list = (): Promise<Listed[]> =>
    Promise.all(
      readConfig(o.configPath).projects.map((path) =>
        derive(path, o.gh).catch((err: Error): Listed => ({ path, error: err.message })),
      ),
    )

  async function add(req: IncomingMessage, res: ServerResponse) {
    const path = await bodyPath(req, res)
    if (!path) return
    const project = await derive(resolve(path), o.gh)
    // The file is read again before each write, so a change made to it by hand while the server
    // runs is kept. The server takes over only the projects: it stays on the address it listens on.
    const config = readConfig(o.configPath)
    if (config.projects.includes(project.path)) return send(res, 409, { error: `${project.path} is already a project` })
    config.projects.push(project.path)
    writeConfig(o.configPath, config)
    send(res, 201, project)
  }

  async function remove(req: IncomingMessage, res: ServerResponse) {
    const path = await bodyPath(req, res)
    if (!path) return
    // A checkout names itself by its top, so a path inside one removes the project it belongs to.
    // The top is asked before the file is read, so no other change lands between the read and the
    // write.
    const absolute = resolve(path)
    const top = await checkout(absolute).catch(() => absolute)
    const config = readConfig(o.configPath)
    const known = config.projects.includes(absolute) ? absolute : top
    const i = config.projects.indexOf(known)
    if (i < 0) return send(res, 404, { error: `${absolute} is not a project; workflows projects lists them` })
    config.projects.splice(i, 1)
    writeConfig(o.configPath, config)
    send(res, 200, { path: known })
  }

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const route = `${req.method} ${url.pathname}`
    // A page on another site can make a browser send requests here. A Host that is not this server's
    // own name turns away a rebound DNS name. A write must say it is JSON, which a page can only do
    // after a preflight this server never grants.
    if (!loopbackHost(req.headers.host, o.listen)) return send(res, 403, { error: 'the Host header does not name this server' })
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
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', [identity]: '1' })
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
  // The address the server listens on stays until it stops, whatever the file says meanwhile, so
  // the CLI reads it from the state directory rather than from the configuration.
  const record = join(o.stateDir, 'listen')
  server.on('listening', () => {
    writeFileSync(record, o.listen + '\n')
    log({ event: 'started', fake: o.fake })
  })
  server.on('close', () => rmSync(record, { force: true }))
  return server
}

function loopbackHost(host: string | undefined, listen: string): boolean {
  if (!host) return false
  const { port } = address(listen)
  const names = [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`, listen]
  // A client leaves the default port of http out of the Host it sends.
  if (port === 80) names.push('127.0.0.1', 'localhost', '[::1]', listen.replace(/:80$/, ''))
  return names.includes(host)
}

// identity is the header every answer carries, so the CLI tells this server from another service
// that took its port after it stopped.
export const identity = 'x-workflows'

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json', [identity]: '1' })
  res.end(JSON.stringify(body) + '\n')
}

// bodyPath is the absolute path the body names, or undefined once the refusal is sent.
async function bodyPath(req: IncomingMessage, res: ServerResponse): Promise<string | undefined> {
  const body = await readJSON(req)
  const path = typeof body?.path === 'string' ? body.path : ''
  if (path && isAbsolute(path)) return path
  send(res, 400, { error: 'path is not an absolute path; name the checkout as an absolute path' })
  return undefined
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
