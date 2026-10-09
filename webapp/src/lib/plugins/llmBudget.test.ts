/**
 * The plugin LLM budget (TD-09, R-69): one reserved PluginData row per (plugin, user, UTC
 * day), charged BEFORE the call with a single conditional upsert, so two copies of the
 * webapp, or two concurrent calls, can never both take the last call of the day. The real
 * statements run on Postgres in stores.pg.integration.test.ts and tests/plugins_db_test.sh;
 * here, what this module sends.
 *
 * @vitest-environment node
 */
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'
import { setNowForTests } from './clock'
import { LLM_USAGE_COLLECTION, chargeLlmCall, llmUsageKey, recordLlmUsage } from './llmBudget'

const raw = (strings: TemplateStringsArray, ...values: unknown[]) => ({ sql: strings.join('$?'), values })
let sent: { sql: string; values: unknown[] }[]
let answer: unknown[]
// Only the two tagged-template calls the module makes; typed as the client it takes.
const db = {
  $queryRaw: vi.fn(async (s: TemplateStringsArray, ...v: unknown[]) => {
    sent.push(raw(s, ...v))
    return answer
  }),
  $executeRaw: vi.fn(async (s: TemplateStringsArray, ...v: unknown[]) => {
    sent.push(raw(s, ...v))
    return 1
  }),
} as unknown as Parameters<typeof chargeLlmCall>[2]

beforeEach(() => {
  sent = []
  answer = [{ count: 1 }]
  setNowForTests(() => new Date('2026-10-09T23:59:59.500Z'))
})
afterEach(() => {
  setNowForTests(null)
  vi.unstubAllEnvs()
})

const flat = (sql: string) => sql.replace(/\s+/g, ' ').trim()

describe('chargeLlmCall', () => {
  test('one conditional upsert on the reserved row of the UTC day; allowed with the new count', async () => {
    answer = [{ count: 7 }]
    expect(await chargeLlmCall('skiller', 'user-1', db)).toEqual({ allowed: true, count: 7, cap: 100, key: 'llm:2026-10-09' })
    expect(sent).toHaveLength(1)
    const sql = flat(sent[0].sql)
    expect(sql).toContain('INSERT INTO plugin_data')
    expect(sql).toContain('ON CONFLICT (plugin_id, namespace, owner_type, owner_id, collection, key) DO UPDATE')
    expect(sql).toContain("WHERE (plugin_data.value->>'count')::int < $?")
    expect(sql).toContain("RETURNING (plugin_data.value->>'count')::int AS count")
    const v = sent[0].values
    expect(v).toContain('skiller')
    expect(v).toContain('user-1')
    expect(v).toContain(LLM_USAGE_COLLECTION)
    expect(v).toContain('llm:2026-10-09')
    expect(v).toContain(100)
  })

  test('the insert supplies the id and updated_at, which Prisma fills itself and SQL does not', async () => {
    await chargeLlmCall('skiller', 'user-1', db)
    const sql = flat(sent[0].sql)
    expect(sql).toMatch(/\(id, plugin_id, namespace, owner_type, owner_id, user_id, collection, key, value, size_bytes, expires_at, updated_at\)/)
    const id = sent[0].values[0] as string
    expect(id).toMatch(/^[a-z0-9]{20,}$/)
    expect(sent[0].values).toContainEqual(new Date('2026-10-11T23:59:59.500Z'))
  })

  test('no row back: the cap is reached', async () => {
    answer = []
    vi.stubEnv('PLUGIN_LLM_DAILY_CALL_CAP', '3')
    expect(await chargeLlmCall('skiller', 'user-1', db)).toEqual({ allowed: false, count: null, cap: 3, key: 'llm:2026-10-09' })
    expect(sent[0].values).toContain(3)
  })

  test('the day is the UTC day', () => {
    expect(llmUsageKey(new Date('2026-10-09T23:59:59.999Z'))).toBe('llm:2026-10-09')
    expect(llmUsageKey(new Date('2026-10-10T00:00:00.000Z'))).toBe('llm:2026-10-10')
  })

  test('malformed ids never reach the database', async () => {
    await expect(chargeLlmCall('Bad Id', 'user-1', db)).rejects.toThrow(/plugin/)
    await expect(chargeLlmCall('skiller', '', db)).rejects.toThrow(/user/)
    expect(sent).toEqual([])
  })
})

describe('recordLlmUsage', () => {
  test('adds the tokens and counts the model on the same row', async () => {
    await recordLlmUsage('skiller', 'user-1', 'llm:2026-10-09', { inputTokens: 120, outputTokens: 30, model: 'openai/gpt-test' }, db)
    const sql = flat(sent[0].sql)
    expect(sql).toContain('UPDATE plugin_data SET value =')
    expect(sql).toContain("'{inputTokens}'")
    expect(sql).toContain("'{outputTokens}'")
    expect(sql).toContain("ARRAY['models', $?]")
    expect(sent[0].values).toEqual(expect.arrayContaining([120, 30, 'openai/gpt-test', 'skiller', 'user-1', 'llm:2026-10-09']))
  })

  test('a negative or fractional token count is recorded as a whole, non-negative number', async () => {
    await recordLlmUsage('skiller', 'user-1', 'llm:2026-10-09', { inputTokens: -5, outputTokens: 2.7, model: 'm' }, db)
    expect(sent[0].values).toEqual(expect.arrayContaining([0, 3]))
  })
})
