import js from '@eslint/js'
import globals from 'globals'
import tseslint from 'typescript-eslint'

// The import direction: the restricted modules import no graph, node, agent run or stage module, but
// their types. The graph registry, the server and the entry point import those. They hand the graphs to
// the engine as data. test/imports.test.ts tests the rule and the absence of a cycle.
const restricted = ['src/engine.ts', 'src/session.ts', 'src/store.ts', 'src/running.ts', 'src/settings.ts', 'src/briefs.ts']
const forbidden = [
  'graphs',
  'delivery',
  'planning',
  'agents',
  'claim',
  'gate',
  'cigate',
  'review',
  'pr',
  'ci',
  'hunt',
  'plan',
  'standardize',
  'acceptance',
]
const message = 'the engine and the session runtime import no graph, node, agent run or stage module but its types; hand it in as data'

export default tseslint.config(
  { ignores: ['dist', 'node_modules'] },
  js.configs.recommended,
  tseslint.configs.recommended,
  { languageOptions: { globals: globals.node } },
  {
    files: restricted,
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          paths: forbidden.map((name) => ({ name: `./${name}.js`, message, allowTypeImports: true })),
          patterns: [{ group: ['./standard/*'], message, allowTypeImports: true }],
        },
      ],
    },
  },
)
