// The import direction. The lint refuses a value import of a node in the engine and the session runtime,
// and it lets a type import through. No cycle of value imports runs through either of them.
// The lint runs through the ESLint API on the controller's own configuration. The cycles are read from
// the value imports of every source, and a fixture of its own proves the search finds one.
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ESLint } from 'eslint'
import ts from 'typescript'
import { expect, test } from 'vitest'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const through = ['engine/engine.ts', 'sessions/session.ts']

// lint lints the code as if it were the named source of the controller and answers the rules it broke.
async function lint(code: string, file: string): Promise<string[]> {
  const eslint = new ESLint({ cwd: root })
  const [result] = await eslint.lintText(code, { filePath: join(root, 'src', file) })
  return (result?.messages ?? []).map((m) => m.ruleId ?? m.message)
}

test('the engine and the session runtime may not import a node for its value', async () => {
  for (const file of through) {
    expect(await lint("import { gateNode } from '../stages/gate.js'\nexport const n = gateNode\n", file)).toContain('@typescript-eslint/no-restricted-imports')
  }
})

test('the engine and the session runtime may import a node for its type', async () => {
  for (const file of through) {
    expect(await lint("import type { gateNode } from '../stages/gate.js'\nexport type N = typeof gateNode\n", file)).toEqual([])
  }
})

// sources are the TypeScript files under the directory, by their path relative to it.
function sources(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: 'utf8' }).filter((f) => f.endsWith('.ts')).sort()
}

// valueImports are the sources a source imports for a value: an import or an export from a relative
// module that is not type-only as a whole or in every name it brings in.
function valueImports(dir: string, file: string): string[] {
  const text = readFileSync(join(dir, file), 'utf8')
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, false)
  const out: string[] = []
  for (const s of source.statements) {
    let spec: ts.Expression | undefined
    if (ts.isImportDeclaration(s)) {
      const c = s.importClause
      const typeOnly = c !== undefined && (c.isTypeOnly || (!c.name && c.namedBindings !== undefined && ts.isNamedImports(c.namedBindings) && c.namedBindings.elements.length > 0 && c.namedBindings.elements.every((e) => e.isTypeOnly)))
      if (!typeOnly) spec = s.moduleSpecifier
    } else if (ts.isExportDeclaration(s) && !s.isTypeOnly) {
      spec = s.moduleSpecifier
    }
    if (!spec || !ts.isStringLiteral(spec) || !spec.text.startsWith('.')) continue
    out.push(relative(dir, resolve(dir, dirname(file), spec.text.replace(/\.js$/, '.ts'))))
  }
  return out
}

// cycles are the cycles of value imports among the sources of the directory that pass through one of the
// named sources, each as the path from that source back to it.
function cycles(dir: string, named: string[]): string[][] {
  const graph = new Map(sources(dir).map((f) => [f, valueImports(dir, f)]))
  const found: string[][] = []
  for (const start of named) {
    const seen = new Set<string>()
    const walk = (at: string, path: string[]): void => {
      for (const next of graph.get(at) ?? []) {
        if (next === start) found.push([...path, next])
        else if (!seen.has(next)) {
          seen.add(next)
          walk(next, [...path, next])
        }
      }
    }
    walk(start, [start])
  }
  return found
}

test('no cycle of value imports runs through the engine or the session runtime', () => {
  expect(cycles(join(root, 'src'), through)).toEqual([])
})

test('the cycle search finds a cycle through the session runtime in its fixture', () => {
  const dir = mkdtempSync(join(tmpdir(), 'imports-'))
  try {
    writeFileSync(join(dir, 'engine.ts'), "import type { Node } from './gate.js'\nexport type N = Node\n")
    writeFileSync(join(dir, 'session.ts'), "import { github } from './github.js'\nexport const s = github\n")
    writeFileSync(join(dir, 'github.ts'), "import { version } from './actions.js'\nexport const github = version\n")
    writeFileSync(join(dir, 'actions.ts'), "import { held } from './claim.js'\nexport const version = held\n")
    writeFileSync(join(dir, 'claim.ts'), "import { type Runtime, s } from './session.js'\nexport const held = s\nexport type R = Runtime\n")
    writeFileSync(join(dir, 'gate.ts'), "import { advance } from './engine.js'\nexport type Node = typeof advance\n")
    expect(cycles(dir, through)).toEqual([['session.ts', 'github.ts', 'actions.ts', 'claim.ts', 'session.ts']])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
