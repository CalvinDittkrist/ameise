// The bundle: where the plugins the controller ships lie once built, and the scripts of them the
// controller runs itself. It lies at the top of the source tree, so its built file lies in dist beside
// the plugins it points at.
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// The plugins ship with the controller (ADR 0060): its build copies the worker, planner and
// repo-standards plugins of the checkout into dist/plugins, and dist/bundle.js reaches them there, in a
// checkout and in the installed package alike.
export const bundledPlugins = fileURLToPath(new URL('./plugins', import.meta.url))

// The worker's hunt.sh the controller bundles, whose print is the hunt record a brief names in place of
// the issue, and whose json the controller keeps in the process record.
export const huntScript = join(bundledPlugins, 'worker', 'scripts', 'hunt.sh')
