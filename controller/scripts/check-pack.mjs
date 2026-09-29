// What a published package has to carry beside the controller's build: the dashboard it serves and the
// plugins its sessions load. npm pack runs this after the build, so a package without either is never
// written, which would start and answer 404 under / or fail every session.
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const dist = fileURLToPath(new URL('../dist/', import.meta.url))
const needed = [
  ['dashboard/index.html', 'npm --prefix dashboard ci && npm --prefix dashboard run build'],
  ['plugins/worker/.claude-plugin/plugin.json', 'npm --prefix controller run build'],
  ['plugins/planner/.claude-plugin/plugin.json', 'npm --prefix controller run build'],
  ['plugins/repo-standards/.claude-plugin/plugin.json', 'npm --prefix controller run build'],
]
const missing = needed.filter(([file]) => !existsSync(dist + file))
for (const [file, fix] of missing) process.stderr.write(`error: the package would lack dist/${file}; run ${fix} in the checkout first\n`)
if (missing.length > 0) process.exit(1)
