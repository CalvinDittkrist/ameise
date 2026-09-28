// Open in terminal: the session of a process opened in a terminal window of this machine, with the
// runtime's resume by the session's id, in the process's worktree, with the bundled worker plugin and
// the session's settings. The maintainer so goes on in Claude Code itself wherever the process page
// lacks something.
import { execFile } from 'node:child_process'
import { chmodSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { WorkRecord } from './claim.js'
import { Refusal } from './project.js'
import { settings } from './session.js'

// quote makes a word the shell reads back as it is.
const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`

// script is the shell script the terminal runs: into the worktree, then claude resuming the session
// with the plugin, the agent and the settings the headless session ran with.
export function script(record: WorkRecord, claude: string, worker: string): string {
  const args = [claude, '--resume', record.session_id ?? '', '--plugin-dir', worker, '--agent', 'worker', '--settings', JSON.stringify(settings(record))]
  return ['#!/bin/sh', `cd ${quote(record.worktree)} || exit 1`, `exec ${args.map(quote).join(' ')}`, ''].join('\n')
}

// native is the platform's own terminal as a command and its arguments that runs the script, or
// undefined where there is none. Terminal runs a file named .command as a shell script in a window.
function native(file: string): [string, string[]] | undefined {
  if (process.platform === 'darwin') return ['open', ['-a', 'Terminal', file]]
  if (process.platform === 'linux') return ['x-terminal-emulator', ['-e', file]]
  return undefined
}

// open writes the script of the process's session into the state directory and has the terminal run
// it: the configured command, called as <terminal> <script>, or the platform's own when none is
// configured. It answers once the command has exited, which a terminal does as soon as its window is
// open, and refuses a process without a session or a terminal that fails.
export async function open(record: WorkRecord, stateDir: string, terminal: string, claude: string, worker: string): Promise<string> {
  if (!record.session_id) throw new Refusal('the process has no session yet; wait until its session has started', 409)
  // A session id is a word of letters, digits and hyphens; any other would reach no session.
  if (!/^[A-Za-z0-9-]+$/.test(record.session_id)) throw new Refusal(`the session id ${JSON.stringify(record.session_id)} is not the id of a session`, 409)
  const file = join(stateDir, 'processes', `${record.id}.command`)
  writeFileSync(file, script(record, claude, worker), { mode: 0o700 })
  chmodSync(file, 0o700)
  const cmd = terminal === '' ? native(file) : ([terminal, [file]] as [string, string[]])
  if (!cmd) throw new Refusal(`this platform has no terminal the controller knows; set terminal in the configuration to a command that runs ${file}`, 501)
  await new Promise<void>((resolve, reject) => {
    try {
      execFile(cmd[0], cmd[1], { timeout: 10000 }, (err, _out, stderr) => {
        if (err) reject(new Refusal(`the terminal did not open: ${cmd[0]}: ${(stderr || err.message).trim()}`, 502))
        else resolve()
      })
    } catch (err) {
      reject(new Refusal(`the terminal did not open: ${cmd[0]}: ${(err as Error).message}`, 502))
    }
  })
  return file
}
