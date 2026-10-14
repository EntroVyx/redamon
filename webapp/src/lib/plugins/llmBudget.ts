import { randomUUID } from 'crypto'
import prisma from '@/lib/prisma'
import { now } from './clock'
import { isValidPluginId } from './ids'
import { llmDailyCallCap } from './settings'

/**
 * Each plugin's own daily model-call budget per user (README.PLUGINS.md §7.3, TD-09):
 * PLUGIN_LLM_DAILY_CALL_CAP calls per (plugin, user, UTC day), apart from the agent's
 * LLM_GUARD_DAILY_CALL_CAP. The counter is a reserved PluginData row (`__usage`, key
 * `llm:<YYYY-MM-DD>`, owned by the user, kept two days) that also accumulates the tokens
 * and the models used, so usage is attributed to the plugin.
 *
 * A call is charged BEFORE it is made, by one INSERT ... ON CONFLICT DO UPDATE ... WHERE
 * count < cap: Postgres serialises concurrent upserts of one row, and the WHERE is
 * re-checked on the row the winner committed, so the last call of the day goes to exactly
 * one caller, across webapp copies too (tests/plugins_db_test.sh). Raw SQL, because Prisma
 * cannot make an upsert's update conditional; it must then supply what Prisma fills in
 * itself: the id and updated_at.
 */
export const LLM_USAGE_COLLECTION = '__usage'
const ROW_TTL_MS = 2 * 24 * 3600 * 1000
// The value's size is not counted toward quotas (a reserved collection); a fair figure.
const ROW_SIZE_BYTES = 128

type Db = Pick<typeof prisma, '$queryRaw' | '$executeRaw'>

export interface LlmCharge {
  allowed: boolean
  /** The calls made today, this one included, or null when refused. */
  count: number | null
  cap: number
  key: string
}

export function llmUsageKey(at: Date): string {
  return `llm:${at.toISOString().slice(0, 10)}`
}

function check(pluginId: string, userId: string) {
  if (!isValidPluginId(pluginId)) throw new TypeError(`invalid plugin id ${JSON.stringify(pluginId)}`)
  if (typeof userId !== 'string' || userId.length === 0 || userId.length > 128) throw new TypeError('a user is required')
}

export async function chargeLlmCall(pluginId: string, userId: string, db: Db = prisma): Promise<LlmCharge> {
  check(pluginId, userId)
  const at = now()
  const key = llmUsageKey(at)
  const cap = llmDailyCallCap()
  const id = `c${randomUUID().replace(/-/g, '')}`
  const first = JSON.stringify({ count: 1, inputTokens: 0, outputTokens: 0, models: {} })
  const expires = new Date(at.getTime() + ROW_TTL_MS)
  const rows = await db.$queryRaw<{ count: number }[]>`
    INSERT INTO plugin_data (id, plugin_id, namespace, owner_type, owner_id, user_id, collection, key, value, size_bytes, expires_at, updated_at)
    VALUES (${id}, ${pluginId}, 'live', 'user', ${userId}, ${userId}, ${LLM_USAGE_COLLECTION}, ${key}, ${first}::jsonb, ${ROW_SIZE_BYTES}, ${expires}, ${at})
    ON CONFLICT (plugin_id, namespace, owner_type, owner_id, collection, key) DO UPDATE
      SET value = jsonb_set(plugin_data.value, '{count}', to_jsonb((plugin_data.value->>'count')::int + 1)),
          updated_at = ${at}
      WHERE (plugin_data.value->>'count')::int < ${cap}
    RETURNING (plugin_data.value->>'count')::int AS count`
  return rows.length ? { allowed: true, count: Number(rows[0].count), cap, key } : { allowed: false, count: null, cap, key }
}

export interface LlmUsage {
  inputTokens: number
  outputTokens: number
  model: string
}

// No call uses more tokens. A provider reporting more (a custom one can report anything)
// would otherwise push the day's totals past bigint, and every later addition would fail.
const TOKENS_MAX_PER_CALL = 10_000_000
const tokens = (n: number) => (Number.isFinite(n) && n > 0 ? Math.min(Math.round(n), TOKENS_MAX_PER_CALL) : 0)

/** Adds a finished call's tokens and model to the row `chargeLlmCall` charged. */
export async function recordLlmUsage(
  pluginId: string,
  userId: string,
  key: string,
  usage: LlmUsage,
  db: Db = prisma,
): Promise<void> {
  check(pluginId, userId)
  const at = now()
  await db.$executeRaw`
    UPDATE plugin_data SET value =
      jsonb_set(jsonb_set(jsonb_set(value,
        '{inputTokens}', to_jsonb(coalesce((value->>'inputTokens')::bigint, 0) + ${tokens(usage.inputTokens)})),
        '{outputTokens}', to_jsonb(coalesce((value->>'outputTokens')::bigint, 0) + ${tokens(usage.outputTokens)})),
        ARRAY['models', ${usage.model}], to_jsonb(coalesce((value->'models'->>${usage.model})::int, 0) + 1)),
      updated_at = ${at}
    WHERE plugin_id = ${pluginId} AND namespace = 'live' AND owner_type = 'user' AND owner_id = ${userId}
      AND collection = ${LLM_USAGE_COLLECTION} AND key = ${key}`
}
