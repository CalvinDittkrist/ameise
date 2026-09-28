// run starts a command and answers its output without the line ending it closes with, or an error that carries what it wrote on
// stderr.
import { execFile } from 'node:child_process'

export function run(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { encoding: 'utf8', timeout: 30000 }, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr || err.message).trim()))
      else resolve(stdout.replace(/\r?\n$/, ''))
    })
  })
}
