import { connect } from 'node:net'
import { join, resolve } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { api, cleanup, cli, dashboard, type Machine, machine, start } from './controller.js'
import { buildFile } from '../src/server.js'

afterEach(cleanup)

// A build as Vite writes it: an index.html that names its files by their hash under assets.
const build = {
  'index.html': '<!doctype html><title>workflows</title><script type="module" src="/assets/index-a1.js"></script>\n',
  'assets/index-a1.js': 'document.title = "workflows"\n',
  'assets/index-a1.css': 'body { margin: 0 }\n',
  'assets/geist-a1.woff2': 'wOF2',
  'assets/notes.txt': 'not a kind of file the build holds',
}

async function running(files?: Record<string, string>): Promise<Machine> {
  const m = await machine()
  dashboard(m, files)
  const s = await start(m)
  expect(s.running, s.stderr).toBe(true)
  return m
}

// raw sends a request target as it is written, which fetch and node's client would normalise first. It
// writes without ending its side, since the server drops a half-closed connection before it answers
// from the disk; Connection: close has the server end it after the answer.
function raw(m: Machine, target: string): Promise<string> {
  const { hostname, port } = new URL(m.url)
  return new Promise((resolve, reject) => {
    const socket = connect(Number(port), hostname, () =>
      socket.write(`GET ${target} HTTP/1.1\r\nHost: ${m.listen}\r\nConnection: close\r\n\r\n`),
    )
    let data = ''
    socket.setEncoding('utf8')
    socket.on('data', (chunk: string) => (data += chunk))
    socket.on('end', () => resolve(data))
    socket.on('error', reject)
  })
}

test('the root serves the built dashboard and its files, each as its kind, and nothing else', async () => {
  const m = await running(build)
  const index = await fetch(m.url + '/')
  expect(index.status).toBe(200)
  expect(index.headers.get('content-type')).toBe('text/html; charset=utf-8')
  expect(index.headers.get('cache-control')).toBe('no-cache')
  expect(index.headers.get('content-security-policy')).toContain("frame-ancestors 'none'")
  expect(await index.text()).toBe(build['index.html'])
  // Asked for by its own name, the index is still asked for again, since the next build rewrites it.
  const named = await fetch(m.url + '/index.html')
  expect(named.status).toBe(200)
  expect(named.headers.get('cache-control')).toBe('no-cache')

  for (const [path, type] of [
    ['assets/index-a1.js', 'text/javascript; charset=utf-8'],
    ['assets/index-a1.css', 'text/css; charset=utf-8'],
    ['assets/geist-a1.woff2', 'font/woff2'],
  ] as const) {
    const res = await fetch(`${m.url}/${path}`)
    expect(res.status, path).toBe(200)
    expect(res.headers.get('content-type'), path).toBe(type)
    expect(res.headers.get('cache-control'), path).toBe('public, max-age=31536000, immutable')
    expect(await res.text(), path).toBe(build[path])
  }

  for (const path of ['/assets/notes.txt', '/assets/missing.js', '/assets', '/index.js']) {
    expect(await api(m, 'GET', path), path).toEqual({ status: 404, body: { error: `no route GET ${path}` } })
  }
  expect((await api(m, 'GET', '/api/processes')).status).toBe(404)
})

test('a request target that names a file above the build is answered 404, not with the controller’s own files', async () => {
  const m = await running(build)
  // main.js and config.js stand one directory above the build.
  for (const target of ['/../main.js', '/assets/../../config.js', '/%2e%2e/main.js', '/..%2fmain.js', '/assets/..%5c..%5cmain.js']) {
    const answer = await raw(m, target)
    expect(answer.split('\r\n')[0], target).toBe('HTTP/1.1 404 Not Found')
    expect(answer, target).not.toContain('import ')
  }
})

test('a path that leaves the build names no file of it, though the URL parser never passes one on', () => {
  const dir = resolve('/srv/dist/dashboard')
  expect(buildFile(dir, '/')).toBe(join(dir, 'index.html'))
  expect(buildFile(dir, '/assets/index-a1.js')).toBe(join(dir, 'assets', 'index-a1.js'))
  for (const path of ['/../main.js', '/assets/../../config.js', '/../dashboard-old/index.js', '/assets/notes.txt']) {
    expect(buildFile(dir, path), path).toBeUndefined()
  }
})

test('without a build the root answers 404 with the command that builds it, and the API and the CLI work', async () => {
  const m = await running()
  const res = await fetch(m.url + '/')
  expect(res.status).toBe(404)
  expect(await res.json()).toEqual({ error: 'the dashboard is not built; run npm --prefix dashboard run build' })
  expect(await api(m, 'GET', '/api/projects')).toEqual({ status: 200, body: [] })
  expect(cli(m, ['projects'])).toEqual({ code: 0, stdout: '', stderr: '' })
})

test('the CLI finds the server that serves a built dashboard', async () => {
  const m = await running(build)
  expect(cli(m, ['projects'])).toEqual({ code: 0, stdout: '', stderr: '' })
})
