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

/** The cap on any plugin action's timeout, whatever its manifest says (the runner applies it too). */
export function actionMaxTimeoutSeconds(): number {
  return positiveInt('PLUGIN_ACTION_MAX_TIMEOUT', 900)
}

/** Gateway calls one call token may make (RV-39): a plugin cannot flood the webapp during a long action. */
export function gatewayCallsPerToken(): number {
  return positiveInt('PLUGIN_GATEWAY_CALLS_PER_TOKEN', 600)
}

/** The most a plugin receives of one session transcript, as JSON bytes (TD-25). */
export function transcriptMaxBytes(): number {
  return positiveInt('PLUGIN_TRANSCRIPT_MAX_BYTES', 2_097_152)
}

/** Model calls one plugin may make per user and UTC day (TD-09), apart from the agent's own cap. */
export function llmDailyCallCap(): number {
  return positiveInt('PLUGIN_LLM_DAILY_CALL_CAP', 100)
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
