/**
 * Plugin platform settings, read from the environment on every call. The webapp has no
 * `env_file`, so each variable must also be listed in its compose `environment:` block
 * before an operator can change it there. A missing, empty or invalid value falls back
 * to the default, never to 0 or NaN, which would disable a limit.
 */
function positiveInt(name: string, fallback: number): number {
  const raw = (process.env[name] ?? '').trim()
  if (!/^[0-9]+$/.test(raw)) return fallback
  const n = Number(raw)
  return Number.isSafeInteger(n) && n > 0 ? n : fallback
}

export interface DataLimits {
  maxRows: number
  maxBytes: number
  maxValueBytes: number
  maxRowsPerOwner: number
}

/** Per plugin and namespace; platform-reserved collections are not counted. */
export function dataLimits(): DataLimits {
  return {
    maxRows: positiveInt('PLUGIN_DATA_MAX_ROWS', 10_000),
    maxBytes: positiveInt('PLUGIN_DATA_MAX_BYTES', 52_428_800),
    maxValueBytes: positiveInt('PLUGIN_DATA_MAX_VALUE_BYTES', 1_048_576),
    maxRowsPerOwner: positiveInt('PLUGIN_DATA_MAX_ROWS_PER_OWNER', 2_000),
  }
}
