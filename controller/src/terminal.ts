// Open in terminal: the session of a process opened in a terminal window of this machine.
// The runtime resumes it by its id in the process's worktree, with the bundled plugin of its kind, the
// worker or the planner, and the session's settings.
import { spawn } from 'node:child_process'
import { chmodSync, writeFileSync } from 'node:fs'
import { Refusal } from './project.js'
import { commandFile, type SessionRecord, settings } from './session.js'

const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`

// script is the shell script the terminal runs: into the worktree, then claude resuming the session
// with the plugin, the agent and the settings the headless session ran with.
export function script(record: SessionRecord, claude: string, plugins: { worker: string; planner: string }): string {
  const agent = record.kind === 'plan' ? 'planner' : 'worker'
  const args = [claude, '--resume', record.session_id ?? '', '--plugin-dir', plugins[agent], '--agent', agent, '--settings', JSON.stringify(settings(record))]
  return ['#!/bin/sh', `cd ${quote(record.worktree)} || exit 1`, `exec ${args.map(quote).join(' ')}`, ''].join('\n')
}

// native is the platform's own terminal as a command and its arguments that runs the script, or
// undefined where there is none. Terminal runs a file named .command as a shell script in a window.
function native(file: string): [string, string[]] | undefined {
  if (process.platform === 'darwin') return ['open', ['-a', 'Terminal', file]]
  if (process.platform === 'linux') return ['x-terminal-emulator', ['-e', file]]
  return undefined
}

// started is how long a terminal command runs before it counts as open. A command that exits in that
// time has opened its window or failed; one that runs on holds its window, and is left running.
const started = 2000

// open writes the script of the process's session into the state directory and has the terminal run
// it: the configured command, called as <terminal> <script>, or the platform's own when none is
// configured. It answers once the command has exited, or once it has run a while and stays with its
// window, and refuses a process without a session or a terminal that fails.
export async function open(record: SessionRecord, stateDir: string, terminal: string, runtime: { claude: string; worker: string; planner: string }): Promise<string> {
  if (!record.session_id) throw new Refusal('the process has no session yet; wait until its session has started', 409)
  // A session id is a word of letters, digits and hyphens; any other would reach no session.
  if (!/^[A-Za-z0-9-]+$/.test(record.session_id)) throw new Refusal(`the session id ${JSON.stringify(record.session_id)} is not the id of a session`, 409)
  const file = commandFile(stateDir, record.id)
  writeFileSync(file, script(record, runtime.claude, runtime), { mode: 0o700 })
  chmodSync(file, 0o700)
  const cmd = terminal === '' ? native(file) : ([terminal, [file]] as [string, string[]])
  if (!cmd) throw new Refusal(`this platform has no terminal the controller knows; set terminal in the configuration to a command that runs ${file}`, 501)
  await new Promise<void>((resolve, reject) => {
    const failed = (why: string) => reject(new Refusal(`the terminal did not open: ${cmd[0]}: ${why.trim()}`, 502))
    let stderr = ''
    try {
      // The command runs in a group of its own, so it outlives the controller and its window stays.
      const child = spawn(cmd[0], cmd[1], { detached: true, stdio: ['ignore', 'ignore', 'pipe'] })
      child.stderr.on('data', (d: Buffer) => (stderr = (stderr + d.toString()).slice(-2000)))
      const running = setTimeout(() => {
        child.removeAllListeners()
        child.stderr.destroy()
        child.unref()
        resolve()
      }, started)
      child.once('error', (err) => {
        clearTimeout(running)
        failed(err.message)
      })
      child.once('close', (code, signal) => {
        clearTimeout(running)
        if (code === 0) resolve()
        else failed(stderr || `it exited with ${code ?? signal}`)
      })
    } catch (err) {
      failed((err as Error).message)
    }
  })
  return file
}
