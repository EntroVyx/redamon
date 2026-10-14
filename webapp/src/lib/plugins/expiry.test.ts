/**
 * Retention of plugin data (R-13): a row written with ttlSeconds disappears from every
 * read once it expires, on the platform clock. Reconciliation deletes such rows later
 * (phase 05); until then they must already be invisible and must not hold quota.
 *
 * @vitest-environment node
 */
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'
import { createFakePrisma, type FakePrisma } from './__testing__/fakePrisma'
import { setNowForTests } from './clock'

const h = vi.hoisted(() => ({ db: null as unknown as Record<string, unknown> }))
vi.mock('@/lib/prisma', () => ({ default: new Proxy({}, { get: (_t, k) => h.db[k as string] }) }))

import * as store from './dataStore'
import { PluginDataError } from './dataStore'

let db: FakePrisma
let t: number
const S = { pluginId: 'skiller' }
const alice = { type: 'user' as const, id: 'u-alice' }

beforeEach(() => {
  db = createFakePrisma()
  h.db = db as unknown as Record<string, unknown>
  db.seed('pluginInstall', [{ pluginId: 'skiller' }])
  t = Date.parse('2026-10-09T12:00:00Z')
  setNowForTests(() => new Date(t))
})
afterEach(() => {
  setNowForTests(null)
  vi.unstubAllEnvs()
})

describe('ttlSeconds', () => {
  test('sets expiresAt and the row is visible until then', async () => {
    const r = await store.put(S, alice, 'c', 'k', 'v', { ttlSeconds: 60 })
    expect(r.expiresAt?.toISOString()).toBe('2026-10-09T12:01:00.000Z')
    t += 59_999
    expect((await store.get(S, alice, 'c', 'k'))?.value).toBe('v')
  })

  test('after expiry the row is invisible to get and query', async () => {
    await store.put(S, alice, 'c', 'k', 'v', { ttlSeconds: 60 })
    await store.put(S, alice, 'c', 'kept', 'v')
    t += 60_000
    expect(await store.get(S, alice, 'c', 'k')).toBeNull()
    expect((await store.query(S, alice, 'c')).items.map((r) => r.key)).toEqual(['kept'])
    expect(db.rows('pluginData')).toHaveLength(2) // still stored until reconciliation
  })

  test('an expired row never blocks a write: reaching the quota first deletes expired rows', async () => {
    vi.stubEnv('PLUGIN_DATA_MAX_ROWS', '1')
    await store.put(S, alice, 'c', 'k', 'v', { ttlSeconds: 1 })
    expect((await store.put(S, alice, 'c', 'other', 1).catch((e) => e)).code).toBe('rows_exceeded')
    t += 1_000
    await store.put(S, alice, 'c', 'other', 1)
    expect(db.rows('pluginData').map((r) => r.key)).toEqual(['other'])
    expect((await store.put(S, alice, 'c', 'k', 'again').catch((e) => e)).code).toBe('rows_exceeded')
  })

  test('short-lived rows cannot grow storage past the quota before reconciliation runs', async () => {
    vi.stubEnv('PLUGIN_DATA_MAX_ROWS', '3')
    vi.stubEnv('PLUGIN_DATA_MAX_BYTES', '40')
    for (let i = 0; i < 20; i++) {
      await store.put(S, alice, 'c', `k${i}`, 'x'.repeat(8), { ttlSeconds: 1 })
      t += 2_000
      const stored = db.rows('pluginData')
      expect(stored.length).toBeLessThanOrEqual(3)
      expect(stored.reduce((n, r) => n + (r.sizeBytes as number), 0)).toBeLessThanOrEqual(40)
    }
  })

  test('replacing an expired row counts as a replacement, not a new row', async () => {
    vi.stubEnv('PLUGIN_DATA_MAX_ROWS', '1')
    await store.put(S, alice, 'c', 'k', 'v', { ttlSeconds: 1 })
    t += 1_000
    await store.put(S, alice, 'c', 'k', 'again')
    expect((await store.get(S, alice, 'c', 'k'))?.value).toBe('again')
  })

  test('a put without ttlSeconds makes the row permanent again', async () => {
    await store.put(S, alice, 'c', 'k', 'v', { ttlSeconds: 1 })
    await store.put(S, alice, 'c', 'k', 'v2')
    t += 10_000
    expect((await store.get(S, alice, 'c', 'k'))?.value).toBe('v2')
  })

  test.each([0, -1, 1.5, Number.NaN, 315_360_001])('ttlSeconds %s is refused', async (ttl) => {
    const e = await store.put(S, alice, 'c', 'k', 'v', { ttlSeconds: ttl }).catch((x) => x)
    expect(e).toBeInstanceOf(PluginDataError)
    expect(e.code).toBe('invalid_ttl')
  })

  test('copyNamespace skips rows that already expired', async () => {
    await store.put(S, alice, 'c', 'gone', 1, { ttlSeconds: 1 })
    await store.put(S, alice, 'c', 'kept', 1)
    t += 1_000
    expect(await store.copyNamespace('skiller', 'live', 'migrating:op1')).toBe(1)
  })
})
