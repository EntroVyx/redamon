import { describe, test, expect, afterEach, vi } from 'vitest'
import { dataLimits } from './settings'

afterEach(() => vi.unstubAllEnvs())

describe('dataLimits', () => {
  test('the section 5 defaults', () => {
    expect(dataLimits()).toEqual({ maxRows: 10_000, maxBytes: 52_428_800, maxValueBytes: 1_048_576, maxRowsPerOwner: 2_000 })
  })

  // NaN or 0 would silently disable a limit: every comparison with NaN is false.
  test.each(['', '   ', 'lots', '-5', '0', '1e3', '12.5', '0x10', '99999999999999999999'])(
    'PLUGIN_DATA_MAX_VALUE_BYTES=%j falls back to the default',
    (raw) => {
      vi.stubEnv('PLUGIN_DATA_MAX_VALUE_BYTES', raw)
      expect(dataLimits().maxValueBytes).toBe(1_048_576)
    },
  )

  test('a valid value, surrounding spaces allowed, is used', () => {
    vi.stubEnv('PLUGIN_DATA_MAX_ROWS', ' 250 ')
    vi.stubEnv('PLUGIN_DATA_MAX_ROWS_PER_OWNER', '7')
    expect(dataLimits()).toMatchObject({ maxRows: 250, maxRowsPerOwner: 7 })
  })
})
