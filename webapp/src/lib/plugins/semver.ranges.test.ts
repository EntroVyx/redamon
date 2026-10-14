/**
 * The strict version and range grammar of the plugin platform. Every case of the
 * shared fixture runs here; the plugin repository's Python evaluator runs the same
 * file, which is what keeps the two evaluators equal.
 */
import { describe, test, expect } from 'vitest'
import {
  RANGE_PATTERN,
  RangeSyntaxError,
  VERSION_PATTERN,
  isValidRange,
  isValidVersion,
  parseRange,
  parseVersion,
  satisfies,
} from '@/lib/semver'
import cases from './__fixtures__/semver-cases.json'

type Case =
  | { version: string; range: string; expected: boolean }
  | { range: string; invalid: true }
  | { version: string; invalid: true }

const all = cases as Case[]
const matching = all.filter((c): c is Extract<Case, { expected: boolean }> => 'expected' in c)
const badRanges = all.filter((c): c is { range: string; invalid: true } => 'invalid' in c && 'range' in c)
const badVersions = all.filter(
  (c): c is { version: string; invalid: true } => 'invalid' in c && 'version' in c,
)

describe('the shared fixture', () => {
  test('has cases of all three shapes', () => {
    expect(matching.length).toBeGreaterThanOrEqual(15)
    expect(badRanges.length).toBeGreaterThanOrEqual(15)
    expect(badVersions.length).toBeGreaterThanOrEqual(10)
  })

  test.each(matching.map((c) => [c.version, c.range, c.expected]))(
    'satisfies(%j, %j) is %s',
    (version, range, expected) => {
      expect(satisfies(version as string, range as string)).toBe(expected)
    },
  )

  test.each(badRanges.map((c) => [c.range]))('range %j is refused', (range) => {
    expect(() => parseRange(range as string)).toThrow(RangeSyntaxError)
    expect(isValidRange(range)).toBe(false)
    expect(() => satisfies('1.0.0', range as string)).toThrow(RangeSyntaxError)
  })

  test.each(badVersions.map((c) => [c.version]))('version %j is refused', (version) => {
    expect(() => parseVersion(version as string)).toThrow(RangeSyntaxError)
    expect(isValidVersion(version)).toBe(false)
    expect(() => satisfies(version as string, '>=0.0.0')).toThrow(RangeSyntaxError)
  })
})

describe('the single-pattern form used by JSON Schema', () => {
  test.each(all.filter((c) => 'range' in c).map((c) => [c.range]))('agrees on range %j', (range) => {
    expect(new RegExp(RANGE_PATTERN).test(range as string)).toBe(isValidRange(range))
  })

  test.each(all.filter((c) => 'version' in c).map((c) => [(c as { version: string }).version]))(
    'agrees on version %j',
    (version) => {
      expect(new RegExp(VERSION_PATTERN).test(version as string)).toBe(isValidVersion(version))
    },
  )
})

describe('parsing', () => {
  test('a version parses into numbers', () => {
    expect(parseVersion('1.20.300')).toEqual({ major: 1, minor: 20, patch: 300 })
  })

  test('a range parses into its comparators, in order', () => {
    expect(parseRange('>=1.0.0 <2.0.0')).toEqual([
      { op: '>=', version: { major: 1, minor: 0, patch: 0 } },
      { op: '<', version: { major: 2, minor: 0, patch: 0 } },
    ])
  })

  test('non-string input is refused, not coerced', () => {
    expect(() => parseVersion(100 as unknown as string)).toThrow(RangeSyntaxError)
    expect(() => parseRange(null as unknown as string)).toThrow(RangeSyntaxError)
    expect(isValidRange(undefined)).toBe(false)
  })

  test('the error names the offending token', () => {
    expect(() => parseRange('>=1.0.0 ^2.0.0')).toThrow(/"\^2\.0\.0" is not a comparator/)
    expect(() => parseVersion('1.0')).toThrow(/"1\.0" is not a version/)
  })

  test('RangeSyntaxError is an Error with its own name', () => {
    const err = new RangeSyntaxError('x')
    expect(err).toBeInstanceOf(Error)
    expect(err.name).toBe('RangeSyntaxError')
  })
})
