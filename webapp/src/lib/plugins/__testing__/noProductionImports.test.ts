/**
 * Test doubles must never ship: no production module may import `__testing__/`.
 * Only test files and the doubles themselves may.
 *
 * @vitest-environment node
 */
import { describe, test, expect } from 'vitest'
import { readdirSync, readFileSync } from 'fs'
import path from 'path'

const SRC = path.resolve(__dirname, '../../..')
const IMPORT_RE = /(?:from\s+|import\s*\(\s*|require\s*\(\s*)['"][^'"]*__testing__[^'"]*['"]/

function* sourceFiles(dir: string): Generator<string> {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) {
      if (e.name !== 'node_modules') yield* sourceFiles(p)
    } else if (/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(e.name)) {
      yield p
    }
  }
}

const isTestFile = (p: string) => /\.test\.(ts|tsx|js|jsx)$/.test(p)
const isDouble = (p: string) => p.split(path.sep).includes('__testing__')

describe('__testing__ stays out of production code', () => {
  test('the scan sees this repository\'s src tree', () => {
    expect(path.basename(SRC)).toBe('src')
    expect([...sourceFiles(SRC)].length).toBeGreaterThan(100)
  })

  test('no non-test module imports a test double', () => {
    const offenders = [...sourceFiles(SRC)]
      .filter(p => !isTestFile(p) && !isDouble(p))
      .filter(p => IMPORT_RE.test(readFileSync(p, 'utf8')))
      .map(p => path.relative(SRC, p))
    expect(offenders).toEqual([])
  })

  test('the pattern catches the import forms it must', () => {
    for (const line of [
      "import { makeKeyPair } from './__testing__/ed25519'",
      "import x from '@/lib/plugins/__testing__/fakeRunner'",
      "const m = await import('../__testing__/clock')",
      "const r = require('./__testing__/x')",
    ]) {
      expect(IMPORT_RE.test(line), line).toBe(true)
    }
    expect(IMPORT_RE.test("// see __testing__ for the doubles")).toBe(false)
  })
})
