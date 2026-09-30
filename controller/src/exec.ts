// run starts a command and answers its output without the line ending it closes with, or an
// error that carries what it wrote on stderr. git never asks for credentials on a terminal it has none of.
// env adds variables to the controller's own environment for this command, and cwd is where it runs.
import { execFile } from 'node:child_process'
import { accessSync, constants } from 'node:fs'
import { delimiter, join } from 'node:path'

export function run(cmd: string, args: string[], env: Record<string, string> = {}, cwd?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { cwd, encoding: 'utf8', env: { ...process.env, ...env, GIT_TERMINAL_PROMPT: '0' }, timeout: 30000, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr || err.message).trim()))
      else resolve(stdout.replace(/\r?\n$/, ''))
    })
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
