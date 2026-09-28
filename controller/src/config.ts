// The configuration of this machine: one file in the user's configuration directory. It holds what
// only the maintainer can say (where the server listens, the quota check, notifications, the
// checkouts that are projects) and nothing that git or GitHub can say instead.
import { chmodSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { isIP } from 'node:net'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'

export interface Config {
  listen: string
  quota_axi: string
  quota_minimum: number
  notifications: boolean
  projects: string[]
}

export const defaults: Config = {
  listen: '127.0.0.1:7420',
  quota_axi: '',
  quota_minimum: 12,
  notifications: true,
  projects: [],
}

const fields = Object.keys(defaults)

// The directories follow the XDG base directory rule on every platform, so one variable moves each.
export function configPath(env: NodeJS.ProcessEnv = process.env): string {
  const base = env.XDG_CONFIG_HOME || join(homedir(), '.config')
  return join(base, 'workflows', 'config.json')
}

export function stateDir(env: NodeJS.ProcessEnv = process.env): string {
  const base = env.XDG_DATA_HOME || join(homedir(), '.local', 'share')
  return join(base, 'workflows')
}

export class ConfigError extends Error {}

// readConfig reads the file, or the defaults when there is none yet. Anything it cannot hold to the
// shape above is a ConfigError whose message names the file, the fault and the fix.
export function readConfig(path: string): Config {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { ...defaults, projects: [] }
    throw new ConfigError(`${path} cannot be read: ${(err as Error).message}; make it readable by this user`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    throw new ConfigError(`${path} is not JSON (${(err as Error).message}); correct it or remove it to start from the defaults`)
  }
  return validate(path, parsed)
}

function validate(path: string, parsed: unknown): Config {
  const bad = (what: string) => new ConfigError(`${path}: ${what}`)
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw bad('the configuration is not a JSON object; write it as {"listen": "127.0.0.1:7420", "projects": []}')
  }
  const c = parsed as Record<string, unknown>
  for (const key of Object.keys(c)) {
    if (!fields.includes(key)) throw bad(`unknown field "${key}"; the fields are ${fields.join(', ')}`)
  }
  const config: Config = { ...defaults, projects: [] }
  if ('listen' in c) {
    if (typeof c.listen !== 'string' || !loopback(c.listen)) {
      throw bad(`listen ${JSON.stringify(c.listen)} is not a loopback address; write it as "127.0.0.1:<port>"`)
    }
    config.listen = c.listen
  }
  if ('quota_axi' in c) {
    if (typeof c.quota_axi !== 'string') throw bad('quota_axi is not a string; name the quota-axi command, or "" to switch the quota check off')
    config.quota_axi = c.quota_axi
  }
  if ('quota_minimum' in c) {
    const m = c.quota_minimum
    if (typeof m !== 'number' || !Number.isInteger(m) || m < 0 || m > 100) {
      throw bad(`quota_minimum ${JSON.stringify(m)} is not a percentage; write it as a whole number from 0 to 100, such as ${defaults.quota_minimum}`)
    }
    config.quota_minimum = m
  }
  if ('notifications' in c) {
    if (typeof c.notifications !== 'boolean') throw bad('notifications is not true or false; write it as true or false')
    config.notifications = c.notifications
  }
  if ('projects' in c) {
    const p = c.projects
    if (!Array.isArray(p) || p.some((x) => typeof x !== 'string' || !isAbsolute(x))) {
      throw bad('projects is not a list of absolute paths; write each project as the path of its checkout, such as "/home/me/src/repo"')
    }
    const twice = (p as string[]).find((x, i) => p.indexOf(x) !== i)
    if (twice !== undefined) throw bad(`projects names ${twice} twice; keep one of them`)
    config.projects = [...(p as string[])]
  }
  return config
}

// loopback says whether host:port names this machine alone: the controller is never reachable from
// elsewhere.
export function loopback(listen: string): boolean {
  const m = /^(?:\[([^\]]+)\]|([^:]+)):(\d{1,5})$/.exec(listen)
  if (!m) return false
  const host = m[1] ?? m[2] ?? ''
  const port = Number(m[3])
  if (port < 1 || port > 65535) return false
  return host === 'localhost' || host === '::1' || (isIP(host) === 4 && host.startsWith('127.'))
}

// writeConfig replaces the file whole, through a rename, so a crash leaves the old file or the new
// one and never half of either. The new file keeps the permissions of the old one, and a first file
// is private to this user, because it names the checkouts of this machine.
export function writeConfig(path: string, config: Config): void {
  mkdirSync(dirname(path), { recursive: true })
  let mode = 0o600
  try {
    mode = statSync(path).mode & 0o777
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
  }
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(config, null, 2) + '\n', { mode })
  chmodSync(tmp, mode)
  renameSync(tmp, path)
}

// host and port of the listen address, as node's server and a URL take them.
export function address(listen: string): { host: string; port: number; url: string } {
  const i = listen.lastIndexOf(':')
  const host = listen.slice(0, i).replace(/^\[|\]$/g, '')
  const port = Number(listen.slice(i + 1))
  return { host, port, url: `http://${listen}` }
}
