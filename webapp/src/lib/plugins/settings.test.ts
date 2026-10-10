import { describe, test, expect, afterEach, vi } from 'vitest'
import { dataLimits, transcriptMaxBytes } from './settings'

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

describe('transcriptMaxBytes', () => {
  afterEach(() => vi.unstubAllEnvs())

  test('2 MB by default', () => {
    expect(transcriptMaxBytes()).toBe(2_097_152)
  })

  // Below the metadata's own size (a cut title alone can reach ~16 KB) no answer could fit.
  test.each(['1', '1000', '65535'])('a cap of %s bytes is raised to 64 KB', (value) => {
    vi.stubEnv('PLUGIN_TRANSCRIPT_MAX_BYTES', value)
    expect(transcriptMaxBytes()).toBe(65_536)
  })

  test('a larger cap is used as it is', () => {
    vi.stubEnv('PLUGIN_TRANSCRIPT_MAX_BYTES', '500000')
    expect(transcriptMaxBytes()).toBe(500_000)
  })
})
