/**
 * The webapp's copy of the orchestrator's scanning-window rule, used to decide
 * which schedules a narrower RoE window would fail.
 *
 * @vitest-environment node
 */
import { describe, test, expect } from 'vitest'

import { afterEngagementEnd, insideScanWindow } from './scanWindow'

const live = {
  roeGlobalMaxRps: 5, roeTimeWindowEnabled: true,
  roeTimeWindowDays: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'],
  roeTimeWindowStartTime: '09:00', roeTimeWindowEndTime: '18:00', roeTimeWindowTimezone: 'UTC',
}

describe('insideScanWindow', () => {
  test('a weekday inside the hours is inside; a weekend or after hours is not', () => {
    expect(insideScanWindow(new Date('2026-10-21T10:00:00Z'), live)).toBe(true) // Wednesday
    expect(insideScanWindow(new Date('2026-10-25T10:00:00Z'), live)).toBe(false) // Sunday
    expect(insideScanWindow(new Date('2026-10-21T19:00:00Z'), live)).toBe(false)
  })

  test('the end time is inclusive, as the orchestrator reads it', () => {
    expect(insideScanWindow(new Date('2026-10-21T18:00:00Z'), live)).toBe(true)
    expect(insideScanWindow(new Date('2026-10-21T18:01:00Z'), live)).toBe(false)
  })

  test('the day and hour are read in the window\'s own timezone', () => {
    // 23:30 UTC on a Friday is Saturday 01:30 in Rome.
    const rome = { ...live, roeTimeWindowTimezone: 'Europe/Rome', roeTimeWindowStartTime: '00:00', roeTimeWindowEndTime: '23:59' }
    expect(insideScanWindow(new Date('2026-10-23T23:30:00Z'), rome)).toBe(false)
  })

  test('an overnight window wraps midnight', () => {
    const night = { ...live, roeTimeWindowStartTime: '22:00', roeTimeWindowEndTime: '06:00' }
    expect(insideScanWindow(new Date('2026-10-21T23:00:00Z'), night)).toBe(true)
    expect(insideScanWindow(new Date('2026-10-21T12:00:00Z'), night)).toBe(false)
  })

  test('a window that is off, or not live, never refuses', () => {
    expect(insideScanWindow(new Date('2026-10-25T10:00:00Z'), { ...live, roeTimeWindowEnabled: false })).toBe(true)
    // A window alone makes the limits live, so this one does bind.
    expect(insideScanWindow(new Date('2026-10-25T10:00:00Z'), { ...live, roeGlobalMaxRps: 0 })).toBe(false)
  })

  test('an unknown timezone throws, so the caller fails closed', () => {
    expect(() => insideScanWindow(new Date(), { ...live, roeTimeWindowTimezone: 'Mars/Olympus' })).toThrow()
  })
})

describe('afterEngagementEnd', () => {
  test('a day after the end date is after; the end date itself is not', () => {
    expect(afterEngagementEnd(new Date('2026-11-28T08:00:00Z'), '2026-11-27')).toBe(true)
    expect(afterEngagementEnd(new Date('2026-11-27T23:00:00Z'), '2026-11-27')).toBe(false)
    expect(afterEngagementEnd(new Date('2026-11-28T08:00:00Z'), '')).toBe(false)
  })
})
