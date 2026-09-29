// The plugins the controller ships (ADR 0060): the build copies the worker, planner and repo-standards
// plugins of the checkout into dist/plugins, where the sessions load them from. A copy of an earlier
// build goes first, so a file removed from a plugin is removed from the bundle too. The repository's
// licence goes beside them, since the package carries its code and the MIT terms travel with it.
import { cpSync, existsSync, rmSync } from 'node:fs'
import { basename } from 'node:path'
import { fileURLToPath } from 'node:url'

const bundled = ['worker', 'planner', 'repo-standards']
const source = fileURLToPath(new URL('../../plugins/', import.meta.url))
const target = fileURLToPath(new URL('../dist/plugins/', import.meta.url))
const licence = fileURLToPath(new URL('../../LICENSE', import.meta.url))

for (const name of bundled) {
  if (!existsSync(`${source}${name}/.claude-plugin/plugin.json`)) {
    process.stderr.write(`error: no plugin at ${source}${name}; the controller is built from a checkout of the workflows repository\n`)
    process.exit(1)
  }
}
rmSync(target, { recursive: true, force: true })
for (const name of bundled) {
  cpSync(`${source}${name}`, `${target}${name}`, { recursive: true, filter: (path) => basename(path) !== '__pycache__' && basename(path) !== '.DS_Store' })
}
cpSync(licence, fileURLToPath(new URL('../dist/LICENSE', import.meta.url)))
