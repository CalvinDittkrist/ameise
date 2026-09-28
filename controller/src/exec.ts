// run starts a command and answers its output without the line ending it closes with, or an
// error that carries what it wrote on stderr. git never asks for credentials on a terminal it has none of.
import { execFile } from 'node:child_process'

export function run(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }, timeout: 30000, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr || err.message).trim()))
      else resolve(stdout.replace(/\r?\n$/, ''))
    })
  })
}
