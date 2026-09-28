// Notifications: when a process turns blocked, ready or failed, the controller sends one native
// notification through the configured notifier, so the maintainer need not watch the board. A
// notification that cannot be sent is told on the controller's stderr and changes nothing else.
import { execFile } from 'node:child_process'

// A notice is what a notification says: the title names the process, the body its state and note.
export interface Notice {
  title: string
  body: string
}

// native is the platform's own notifier as a command and its arguments, or undefined where there is none.
function native(n: Notice): [string, string[]] | undefined {
  if (process.platform === 'darwin') {
    // The texts go in as arguments, so no quote in a note reaches the script.
    return ['osascript', ['-e', 'on run argv', '-e', 'display notification (item 2 of argv) with title (item 1 of argv)', '-e', 'end run', n.title, n.body]]
  }
  // The -- ends the options, so a note that starts with a dash is shown and never read as one.
  if (process.platform === 'linux') return ['notify-send', ['--', n.title, n.body]]
  return undefined
}

// notify sends a notice through the notifier: the configured command, called as <notifier> <title>
// <body>, or the platform's own when none is configured. It answers once the notifier has exited.
export function notify(notifier: string, n: Notice): Promise<void> {
  const cmd: [string, string[]] | undefined = notifier === '' ? native(n) : [notifier, [n.title, n.body]]
  if (!cmd) return Promise.resolve()
  return new Promise((resolve) => {
    execFile(cmd[0], cmd[1], { timeout: 10000 }, (err, _out, stderr) => {
      if (err) process.stderr.write(`warning: the notification "${n.title}" was not sent: ${cmd[0]}: ${(stderr || err.message).trim()}\n`)
      resolve()
    })
  })
}
