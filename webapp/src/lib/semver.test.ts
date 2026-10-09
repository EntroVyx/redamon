/**
 * The two comparisons that existed before the plugin platform extended this module
 * (the update banner and the changelog filter use them), pinned as they behave, so
 * the extension cannot change them.
 */
import { describe, test, expect } from 'vitest'
import { compareSemver, isNewerVersion } from './semver'

describe('isNewerVersion', () => {
  test.each([
    ['3.1.0', '3.1.1', true],
    ['3.1.1', '3.1.0', false],
    ['3.1.0', '3.1.0', false],
    ['3.9.0', '3.10.0', true],
    ['3.10.0', '3.9.0', false],
    ['2.9.9', '3.0.0', true],
    ['3.1', '3.1.1', true],
    ['3.1.0', '3.1', false],
    ['6.26.2', '6.27.0', true],
  ])('current %s, latest %s -> %s', (current, latest, expected) => {
    expect(isNewerVersion(current, latest)).toBe(expected)
  })
})

describe('compareSemver', () => {
  test.each([
    ['1.0.0', '1.0.0', 0],
    ['1.0.1', '1.0.0', 1],
    ['1.0.0', '1.0.1', -1],
    ['1.10.0', '1.9.0', 1],
    ['2.0.0', '10.0.0', -1],
    ['1.2', '1.2.0', 0],
    ['1', '1.0.0', 0],
  ])('%s vs %s -> %i', (a, b, expected) => {
    expect(compareSemver(a, b)).toBe(expected)
  })

  test('sorts a changelog newest first', () => {
    const versions = ['6.9.0', '6.26.2', '6.10.1', '6.26.0']
    expect([...versions].sort((a, b) => compareSemver(b, a))).toEqual([
      '6.26.2', '6.26.0', '6.10.1', '6.9.0',
    ])
  })
})
