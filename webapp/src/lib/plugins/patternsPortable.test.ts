/**
 * The exported JSON Schema patterns are applied by two regex engines: JavaScript's (the
 * platform, ECMA-262 as JSON Schema specifies) and Python's `re` (the plugin
 * repository's CI, through jsonschema, which uses re.search). They differ: in Python `$`
 * also matches before a trailing newline, and `\d` matches any Unicode digit. The
 * export rewrites every pattern into a form both engines read alike; this test runs
 * every exported pattern through both engines on the same inputs.
 *
 * @vitest-environment node
 */
import { describe, test, expect } from 'vitest'
import { spawnSync } from 'child_process'
import { exportPluginSchemas, portablePattern } from './schemas/export'
import { RANGE_PATTERN, VERSION_PATTERN } from '@/lib/semver'
import cases from './__fixtures__/semver-cases.json'

function patternsOf(node: unknown, out: string[] = []): string[] {
  if (Array.isArray(node)) node.forEach((n) => patternsOf(n, out))
  else if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      if (k === 'pattern' && typeof v === 'string') out.push(v)
      else patternsOf(v, out)
    }
  }
  return out
}

const schemas = exportPluginSchemas()
const patterns = [...new Set([...Object.values(schemas).flatMap((s) => patternsOf(s)), VERSION_PATTERN, RANGE_PATTERN])]

const fixtureStrings = (cases as Record<string, unknown>[]).flatMap((c) =>
  [c.version, c.range].filter((s): s is string => typeof s === 'string'),
)
const SAMPLES = [
  ...fixtureStrings,
  ...fixtureStrings.map((s) => `${s}\n`),
  'skiller', 'skiller\n', 'plugins', 'plugins\n', 'external-link', 'echo-2',
  'a'.repeat(64), `${'a'.repeat(64)}\n`, 'engine/main.py:run', 'engine/main.py:run\n',
  'ui/home.json', 'ui/home.json\n', 'list_items', 'list_items\n', 'session:read', 'name_1',
  '2026-12-31T00:00:00Z', '2026-12-31T00:00:00Z\n', '٢٠٢٦-12-31T00:00:00Z', 'https://example.org/a', 'ftp://example.org',
]

describe('exported patterns', () => {
  test('every pattern is in the portable form', () => {
    expect(patterns.length).toBeGreaterThanOrEqual(10)
    for (const p of patterns) {
      expect(p, p).not.toMatch(/\\d/)
      expect(portablePattern(p), p).toBe(p)
    }
  })

  test('portablePattern anchors every end of string and spells out digits', () => {
    expect(portablePattern('^a$')).toBe('^a(?!\\n)$')
    expect(portablePattern('^(?!(?:api|core)$)')).toBe('^(?!(?:api|core)(?!\\n)$)')
    expect(portablePattern('^\\d[\\d-]\\$[$]$')).toBe('^[0-9][0-9-]\\$[$](?!\\n)$')
    expect(portablePattern('^a(?!\\n)$')).toBe('^a(?!\\n)$')
  })

  const python = spawnSync('python3', ['-c', 'print(1)'], { encoding: 'utf8' })
  test.skipIf(python.status !== 0)('JavaScript and Python accept exactly the same inputs', () => {
    const script =
      'import json, re, sys\n' +
      'd = json.load(sys.stdin)\n' +
      'print(json.dumps([[bool(re.search(p, s)) for s in d["samples"]] for p in d["patterns"]]))\n'
    const r = spawnSync('python3', ['-c', script], { input: JSON.stringify({ patterns, samples: SAMPLES }), encoding: 'utf8' })
    expect(r.status, r.stderr).toBe(0)
    const py = JSON.parse(r.stdout) as boolean[][]
    const differ: string[] = []
    patterns.forEach((p, i) => {
      const re = new RegExp(p)
      SAMPLES.forEach((s, j) => {
        if (re.test(s) !== py[i][j]) differ.push(`${JSON.stringify(s)} on ${p.slice(0, 50)}: js=${re.test(s)} py=${py[i][j]}`)
      })
    })
    expect(differ).toEqual([])
  })
})

describe('rules that JSON Schema now carries too', () => {
  test('reserved plugin ids are refused by the exported manifest schema', () => {
    const idPatterns = patternsOf((schemas.manifest as { properties: { id: unknown } }).properties.id)
    expect(idPatterns.some((p) => !new RegExp(p).test('plugins'))).toBe(true)
    expect(idPatterns.every((p) => new RegExp(p).test('skiller'))).toBe(true)
  })

  test('catalog archive URLs must be http(s) in the exported schema', () => {
    const json = JSON.stringify(schemas.catalog)
    expect(json).toContain('^https?:')
  })
})
