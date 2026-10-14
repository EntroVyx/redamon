/**
 * Is an instant inside a project's scanning window?
 *
 * The TypeScript copy of the orchestrator's `_check_roe_time_window`, for the
 * one question only the webapp asks: will a scheduled scan's next fire be
 * refused under a RoE that is about to apply? Same semantics: the window only
 * binds while the engagement limits are live and it is switched on, the day is
 * the weekday in the window's own timezone, the end time is inclusive, and a
 * start later than the end is an overnight window.
 *
 * Throws on a timezone Intl does not know, so a caller fails closed rather than
 * guessing which schedules to pause.
 */
import { deriveRoeEnabled } from '@/lib/engagement'

export interface WindowRow {
  roeGlobalMaxRps?: unknown
  roeExcludedHosts?: unknown
  roeTimeWindowEnabled?: unknown
  roeTimeWindowDays?: unknown
  roeTimeWindowStartTime?: unknown
  roeTimeWindowEndTime?: unknown
  roeTimeWindowTimezone?: unknown
}

export function insideScanWindow(at: Date, row: WindowRow): boolean {
  if (!(deriveRoeEnabled(row as Parameters<typeof deriveRoeEnabled>[0]) && row.roeTimeWindowEnabled === true)) {
    return true
  }
  const timeZone = typeof row.roeTimeWindowTimezone === 'string' && row.roeTimeWindowTimezone
    ? row.roeTimeWindowTimezone
    : 'UTC'
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, weekday: 'long', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(at)
  const get = (type: string) => parts.find(p => p.type === type)?.value ?? ''
  const day = get('weekday').toLowerCase()
  const time = `${get('hour')}:${get('minute')}`

  const days = Array.isArray(row.roeTimeWindowDays) ? row.roeTimeWindowDays.map(d => String(d).toLowerCase()) : []
  if (!days.includes(day)) return false
  const start = typeof row.roeTimeWindowStartTime === 'string' ? row.roeTimeWindowStartTime : '09:00'
  const end = typeof row.roeTimeWindowEndTime === 'string' ? row.roeTimeWindowEndTime : '18:00'
  return start <= end ? time >= start && time <= end : time >= start || time <= end
}

/** Is `at` after the engagement's end date (a whole day, read in UTC)? */
export function afterEngagementEnd(at: Date, endDate: unknown): boolean {
  if (typeof endDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(endDate.trim())) return false
  return at.toISOString().slice(0, 10) > endDate.trim()
}
