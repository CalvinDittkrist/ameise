// run starts a command and answers its trimmed output, or an error that carries what it wrote on
// stderr.
import { execFile } from 'node:child_process'

export function run(cmd: string, args: string[], cwd?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { cwd, encoding: 'utf8', timeout: 30000 }, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr || err.message).trim()))
      else resolve(stdout.trim())
    })
  })
}
