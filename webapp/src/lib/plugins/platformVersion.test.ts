import { describe, test, expect } from 'vitest'
import { PLUGIN_PLATFORM_VERSION } from './platformVersion'
import { parseVersion, satisfies } from '@/lib/semver'

describe('the platform version', () => {
  test('is 1.0.0, the version Skiller is published against (OQ-12)', () => {
    expect(PLUGIN_PLATFORM_VERSION).toBe('1.0.0')
  })

  test('is a strict x.y.z version', () => {
    expect(() => parseVersion(PLUGIN_PLATFORM_VERSION)).not.toThrow()
  })

  test("falls inside the range the design's example plugins declare", () => {
    expect(satisfies(PLUGIN_PLATFORM_VERSION, '>=1.0.0 <2.0.0')).toBe(true)
  })
})
