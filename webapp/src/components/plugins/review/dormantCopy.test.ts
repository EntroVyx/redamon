/**
 * Every dormant reason the registry can return has review copy (the re-check for phase 06):
 * a new reason must not ship without words, and the copy names the real cause (R-03/R-54).
 */
import { describe, test, expect } from 'vitest'
import { DORMANT_COPY, dormantCopy } from './dormantCopy'
import { DORMANT_REASONS } from '@/lib/plugins/registry'

describe('dormant copy', () => {
  test('there is copy for every DORMANT_REASONS entry, and no extra', () => {
    expect(Object.keys(DORMANT_COPY).sort()).toEqual([...DORMANT_REASONS].sort())
  })

  test('each reason has non-empty, distinct words', () => {
    const seen = new Set<string>()
    for (const reason of DORMANT_REASONS) {
      const copy = dormantCopy(reason)
      expect(copy.length).toBeGreaterThan(0)
      expect(seen.has(copy)).toBe(false)
      seen.add(copy)
    }
  })

  test('permission_missing names the permission, not a generic "disabled"', () => {
    expect(dormantCopy('permission_missing')).toMatch(/permission/i)
    expect(dormantCopy('permission_missing')).not.toBe(dormantCopy('disabled'))
  })
})
