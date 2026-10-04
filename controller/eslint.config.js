import js from '@eslint/js'
import globals from 'globals'
import tseslint from 'typescript-eslint'
import { posix } from 'node:path'

// The import direction: the restricted modules import no graph, node, agent run or stage module, but
// their types. The graph registry, the server and the entry point import those. They hand the graphs to
// the engine as data. Each restricted file names the forbidden modules by its own relative path.
// test/imports.test.ts tests the rule and the absence of a cycle.
const restricted = [
  'src/engine/engine.ts',
  'src/sessions/session.ts',
  'src/records/store.ts',
  'src/sessions/running.ts',
  'src/sessions/settings.ts',
  'src/sessions/briefs.ts',
]
const forbidden = [
  'src/engine/graphs',
  'src/graphs/delivery',
  'src/graphs/planning',
  'src/sessions/agents',
  'src/github/claim',
  'src/stages/gate',
  'src/stages/cigate',
  'src/stages/review',
  'src/stages/pr',
  'src/stages/ci',
  'src/stages/hunt',
  'src/stages/plan',
  'src/stages/standardize',
  'src/stages/acceptance',
]
// from is the specifier the restricted file names a forbidden module by.
const from = (file, target) => {
  const path = posix.relative(posix.dirname(file), target)
  return path.startsWith('.') ? path : `./${path}`
}
const message = 'the engine and the session runtime import no graph, node, agent run or stage module but its types; hand it in as data'

export default tseslint.config(
  { ignores: ['dist', 'node_modules'] },
  js.configs.recommended,
  tseslint.configs.recommended,
  { languageOptions: { globals: globals.node } },
  ...restricted.map((file) => ({
    files: [file],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          paths: forbidden.map((target) => ({ name: `${from(file, target)}.js`, message, allowTypeImports: true })),
          patterns: [{ group: [`${from(file, 'src/stages/standard')}/*`], message, allowTypeImports: true }],
        },
      ],
    },
  })),
)
