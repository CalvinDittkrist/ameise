// run starts a command and answers its output without the line ending it closes with, or an
// error that carries what it wrote on stderr. git never asks for credentials on a terminal it has none of.
// env adds variables to the controller's own environment for this command, and cwd is where it runs.
// opts give it stdin (empty otherwise), a timeout other than 30 seconds, and a signal that stops it.
import { execFile } from 'node:child_process'
import { accessSync, constants } from 'node:fs'
import { delimiter, join } from 'node:path'

export interface RunOptions {
  input?: string
  timeout?: number
  signal?: AbortSignal
}

// Ran is how a command ended: its exit code, 1 when it could not start or was stopped, and what it wrote.
export interface Ran {
  code: number
  stdout: string
  stderr: string
}

export function run(cmd: string, args: string[], env: Record<string, string> = {}, cwd?: string, opts: RunOptions = {}): Promise<string> {
  return attempt(cmd, args, env, cwd, opts).then((r) => {
    if (r.code !== 0) throw new Error(r.stderr.trim() || `${cmd} exited with ${r.code}`)
    return r.stdout.replace(/\r?\n$/, '')
  })
}

// attempt runs a command as run does, and answers how it ended instead of failing.
export function attempt(cmd: string, args: string[], env: Record<string, string> = {}, cwd?: string, opts: RunOptions = {}): Promise<Ran> {
  return new Promise((resolve) => {
    const child = execFile(
      cmd,
      args,
      { cwd, encoding: 'utf8', env: { ...process.env, ...env, GIT_TERMINAL_PROMPT: '0' }, timeout: opts.timeout ?? 30000, maxBuffer: 64 * 1024 * 1024, signal: opts.signal },
      (err, stdout, stderr) => {
        if (!err) return resolve({ code: 0, stdout, stderr })
        const code = typeof err.code === 'number' && err.code !== 0 ? err.code : 1
        resolve({ code, stdout, stderr: stderr || err.message })
      },
    )
    // A command that ends before it read its input closes the pipe; that is its answer, not an error. Without
    // input, stdin is closed at once, so a command that reads it never waits for a terminal it has none of.
    child.stdin?.on('error', () => undefined)
    child.stdin?.end(opts.input ?? '')
  })
}

// which is the path of a command on PATH, as the shell finds it, or the name itself when none is found.
export function which(cmd: string): string {
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (dir === '') continue
    try {
      accessSync(join(dir, cmd), constants.X_OK)
      return join(dir, cmd)
    } catch {
      // not in this directory
    }
  }
  return cmd
}
