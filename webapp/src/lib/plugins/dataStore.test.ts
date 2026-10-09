/**
 * The generic plugin data store against the in-memory Prisma double, which applies
 * Postgres LIKE semantics to startsWith (Prisma 6 does not escape `_` and `%`).
 *
 * @vitest-environment node
 */
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'
import { createFakePrisma, type FakePrisma } from './__testing__/fakePrisma'

const h = vi.hoisted(() => ({ db: null as unknown as Record<string, unknown> }))
vi.mock('@/lib/prisma', () => ({ default: new Proxy({}, { get: (_t, k) => h.db[k as string] }) }))

import * as store from './dataStore'
import { PluginDataError, likePrefix, type PluginOwner } from './dataStore'

let db: FakePrisma
const alice: PluginOwner = { type: 'user', id: 'u-alice' }
const bob: PluginOwner = { type: 'user', id: 'u-bob' }
const proj: PluginOwner = { type: 'project', id: 'p-1' }
const S = { pluginId: 'skiller' }

beforeEach(() => {
  db = createFakePrisma()
  h.db = db as unknown as Record<string, unknown>
  db.seed('pluginInstall', [{ pluginId: 'skiller' }, { pluginId: 'echo' }])
})
afterEach(() => vi.unstubAllEnvs())

const code = async (p: Promise<unknown>) => {
  const e = await p.catch((err: unknown) => err)
  expect(e).toBeInstanceOf(PluginDataError)
  return (e as PluginDataError).code
}

describe('put and get', () => {
  test('a value round-trips and its size is the UTF-8 length of its JSON', async () => {
    const value = { name: 'é', n: [1, 2], ok: true, emoji: '🙂' }
    const r = await store.put(S, alice, 'notes', 'k1', value)
    expect(r.sizeBytes).toBe(Buffer.byteLength(JSON.stringify(value), 'utf8'))
    expect(r.sizeBytes).toBe(JSON.stringify(value).length + 1 + 2)
    expect((await store.get(S, alice, 'notes', 'k1'))?.value).toEqual(value)
  })

  test('what is stored is what JSON keeps', async () => {
    await store.put(S, alice, 'c', 'k', { a: undefined, d: new Date('2026-01-01T00:00:00Z'), b: 1 })
    expect((await store.get(S, alice, 'c', 'k'))?.value).toEqual({ d: '2026-01-01T00:00:00.000Z', b: 1 })
  })

  test('JSON null is a stored value, not a missing row', async () => {
    await store.put(S, alice, 'c', 'k', null)
    const r = await store.get(S, alice, 'c', 'k')
    expect(r).not.toBeNull()
    expect(r?.value).toBeNull()
  })

  test('put replaces the value of an existing key', async () => {
    await store.put(S, alice, 'c', 'k', 1)
    await store.put(S, alice, 'c', 'k', 2)
    expect((await store.get(S, alice, 'c', 'k'))?.value).toBe(2)
    expect(db.rows('pluginData')).toHaveLength(1)
  })

  test('the owner sets exactly its own foreign key', async () => {
    await store.put(S, alice, 'c', 'k', 1)
    await store.put(S, proj, 'c', 'k', 1)
    const rows = db.rows('pluginData').map((r) => [r.ownerType, r.ownerId, r.userId, r.projectId])
    expect(rows).toEqual([
      ['user', 'u-alice', 'u-alice', null],
      ['project', 'p-1', null, 'p-1'],
    ])
  })
})

describe('separation', () => {
  test("a user-owned row is invisible to another user's owner", async () => {
    await store.put(S, alice, 'c', 'k', 'secret')
    expect(await store.get(S, bob, 'c', 'k')).toBeNull()
    expect(await store.query(S, bob, 'c')).toEqual([])
    expect(await store.remove(S, bob, 'c', 'k')).toBe(false)
    expect((await store.get(S, alice, 'c', 'k'))?.value).toBe('secret')
  })

  test('a user and a project with the same id are different owners', async () => {
    await store.put(S, { type: 'user', id: 'x' }, 'c', 'k', 'user')
    expect(await store.get(S, { type: 'project', id: 'x' }, 'c', 'k')).toBeNull()
  })

  test("another plugin's rows are invisible", async () => {
    await store.put({ pluginId: 'echo' }, alice, 'c', 'k', 'echo')
    expect(await store.get(S, alice, 'c', 'k')).toBeNull()
  })

  test('namespaces do not see each other', async () => {
    await store.put(S, alice, 'c', 'k', 'live')
    await store.put({ ...S, namespace: 'migrating:op1' }, alice, 'c', 'k', 'copy')
    expect((await store.get(S, alice, 'c', 'k'))?.value).toBe('live')
    expect((await store.get({ ...S, namespace: 'migrating:op1' }, alice, 'c', 'k'))?.value).toBe('copy')
  })
})

describe('platform-reserved collections', () => {
  test.each(['__jobs', '__llm', '__x'])('%s needs {platform: true} for every operation', async (c) => {
    expect(await code(store.put(S, alice, c, 'k', 1))).toBe('reserved_collection')
    expect(await code(store.get(S, alice, c, 'k'))).toBe('reserved_collection')
    expect(await code(store.query(S, alice, c))).toBe('reserved_collection')
    expect(await code(store.remove(S, alice, c, 'k'))).toBe('reserved_collection')
    await store.put({ ...S, platform: true }, alice, c, 'k', 1)
    expect((await store.get({ ...S, platform: true }, alice, c, 'k'))?.value).toBe(1)
  })

  test('a single underscore is an ordinary collection', async () => {
    await store.put(S, alice, '_drafts', 'k', 1)
    expect((await store.get(S, alice, '_drafts', 'k'))?.value).toBe(1)
  })

  test('reserved rows do not count toward the quotas, so a full store never blocks a job', async () => {
    vi.stubEnv('PLUGIN_DATA_MAX_ROWS', '2')
    vi.stubEnv('PLUGIN_DATA_MAX_BYTES', '1000')
    vi.stubEnv('PLUGIN_DATA_MAX_ROWS_PER_OWNER', '2')
    await store.put(S, alice, 'c', 'a', 1)
    await store.put(S, alice, 'c', 'b', 1)
    expect(await code(store.put(S, alice, 'c', 'c', 1))).toBe('rows_exceeded')
    for (const k of ['j1', 'j2', 'j3', 'j4']) await store.put({ ...S, platform: true }, alice, '__jobs', k, 'x'.repeat(400))
    await store.remove(S, alice, 'c', 'a')
    await store.put(S, alice, 'c', 'c', 1)
  })

  test("collections named like the reserved prefix's LIKE pattern still count", async () => {
    // '__' unescaped would match any two characters: 'ab' must still be counted.
    vi.stubEnv('PLUGIN_DATA_MAX_ROWS', '1')
    await store.put(S, alice, 'ab', 'k', 1)
    expect(await code(store.put(S, alice, 'cd', 'k', 1))).toBe('rows_exceeded')
  })
})

describe('limits, each with its own error', () => {
  test('a value over PLUGIN_DATA_MAX_VALUE_BYTES; exactly at it is fine', async () => {
    vi.stubEnv('PLUGIN_DATA_MAX_VALUE_BYTES', '12')
    await store.put(S, alice, 'c', 'k', 'x'.repeat(10)) // "xxxxxxxxxx" = 12 bytes
    const e = (await store.put(S, alice, 'c', 'k', 'x'.repeat(11)).catch((x) => x)) as PluginDataError
    expect(e.code).toBe('value_too_large')
    expect(e.limit).toBe(12)
  })

  test('the plugin row quota; replacing an existing key at the limit is fine', async () => {
    vi.stubEnv('PLUGIN_DATA_MAX_ROWS', '2')
    await store.put(S, alice, 'c', 'a', 1)
    await store.put(S, bob, 'c', 'b', 1)
    const e = (await store.put(S, alice, 'c', 'c', 1).catch((x) => x)) as PluginDataError
    expect([e.code, e.limit]).toEqual(['rows_exceeded', 2])
    await store.put(S, alice, 'c', 'a', 2)
  })

  test('the plugin byte quota; shrinking a value at the limit is fine', async () => {
    vi.stubEnv('PLUGIN_DATA_MAX_BYTES', '30')
    await store.put(S, alice, 'c', 'a', 'x'.repeat(18)) // 20 bytes
    const e = (await store.put(S, alice, 'c', 'b', 'x'.repeat(9)).catch((x) => x)) as PluginDataError
    expect([e.code, e.limit]).toEqual(['bytes_exceeded', 30])
    await store.put(S, alice, 'c', 'a', 'x'.repeat(8)) // 10 bytes
    await store.put(S, alice, 'c', 'b', 'x'.repeat(18)) // 10 + 20 = 30: at the limit
  })

  test("one owner cannot exhaust the plugin's shared quota", async () => {
    vi.stubEnv('PLUGIN_DATA_MAX_ROWS_PER_OWNER', '2')
    await store.put(S, alice, 'c', 'a', 1)
    await store.put(S, alice, 'd', 'b', 1)
    const e = (await store.put(S, alice, 'e', 'c', 1).catch((x) => x)) as PluginDataError
    expect([e.code, e.limit]).toEqual(['owner_rows_exceeded', 2])
    await store.put(S, bob, 'c', 'a', 1)
  })

  test('quotas are per plugin and per namespace', async () => {
    vi.stubEnv('PLUGIN_DATA_MAX_ROWS', '1')
    await store.put(S, alice, 'c', 'a', 1)
    await store.put({ pluginId: 'echo' }, alice, 'c', 'a', 1)
    await store.put({ ...S, namespace: 'migrating:op1' }, alice, 'c', 'a', 1)
  })

  test('the four quota errors are distinct', async () => {
    const codes = new Set<string>()
    vi.stubEnv('PLUGIN_DATA_MAX_VALUE_BYTES', '5')
    codes.add(await code(store.put(S, alice, 'c', 'k', 'toolong')))
    vi.unstubAllEnvs()
    vi.stubEnv('PLUGIN_DATA_MAX_ROWS', '1')
    await store.put(S, alice, 'c', 'k', 1)
    codes.add(await code(store.put(S, bob, 'c', 'k2', 1)))
    vi.unstubAllEnvs()
    vi.stubEnv('PLUGIN_DATA_MAX_BYTES', '3')
    codes.add(await code(store.put(S, bob, 'c', 'k3', 'abc')))
    vi.unstubAllEnvs()
    vi.stubEnv('PLUGIN_DATA_MAX_ROWS_PER_OWNER', '1')
    codes.add(await code(store.put(S, alice, 'c', 'k4', 1)))
    expect([...codes].sort()).toEqual(['bytes_exceeded', 'owner_rows_exceeded', 'rows_exceeded', 'value_too_large'])
  })

  test('an empty or invalid setting falls back to its default', async () => {
    vi.stubEnv('PLUGIN_DATA_MAX_ROWS', '')
    vi.stubEnv('PLUGIN_DATA_MAX_VALUE_BYTES', 'lots')
    vi.stubEnv('PLUGIN_DATA_MAX_BYTES', '-5')
    await store.put(S, alice, 'c', 'k', 'x'.repeat(1000))
  })
})

describe('input checks', () => {
  test.each([
    ['', 'invalid_collection'],
    ['has space', 'invalid_collection'],
    ['x'.repeat(65), 'invalid_collection'],
    ['../c', 'invalid_collection'],
  ])('collection %j', async (c, expected) => {
    expect(await code(store.put(S, alice, c, 'k', 1))).toBe(expected)
  })

  test('keys: empty, too long, NUL', async () => {
    expect(await code(store.put(S, alice, 'c', '', 1))).toBe('invalid_key')
    expect(await code(store.put(S, alice, 'c', 'k'.repeat(513), 1))).toBe('invalid_key')
    expect(await code(store.put(S, alice, 'c', 'a\u0000b', 1))).toBe('invalid_key')
  })

  test('values JSON cannot hold, or Postgres cannot store', async () => {
    expect(await code(store.put(S, alice, 'c', 'k', undefined))).toBe('invalid_value')
    expect(await code(store.put(S, alice, 'c', 'k', () => 1))).toBe('invalid_value')
    expect(await code(store.put(S, alice, 'c', 'k', { s: 'a\u0000b' }))).toBe('invalid_value')
    const loop: Record<string, unknown> = {}
    loop.self = loop
    expect(await code(store.put(S, alice, 'c', 'k', loop))).toBe('invalid_value')
  })

  test('owners', async () => {
    expect(await code(store.put(S, { type: 'team' as 'user', id: 'x' }, 'c', 'k', 1))).toBe('invalid_owner')
    expect(await code(store.put(S, { type: 'user', id: '' }, 'c', 'k', 1))).toBe('invalid_owner')
  })
})

describe('query', () => {
  test('newest first, with a default and a maximum limit', async () => {
    let t = Date.parse('2026-01-01T00:00:00Z')
    const { setNowForTests } = await import('./clock')
    setNowForTests(() => new Date(t))
    for (let i = 0; i < 230; i++) {
      t += 1000
      await store.put(S, alice, 'c', `k${String(i).padStart(3, '0')}`, i)
    }
    setNowForTests(null)
    const first = await store.query(S, alice, 'c')
    expect(first).toHaveLength(store.QUERY_LIMIT_DEFAULT)
    expect(first[0].key).toBe('k229')
    expect((await store.query(S, alice, 'c', { limit: 1000 })).length).toBe(store.QUERY_LIMIT_MAX)
    expect((await store.query(S, alice, 'c', { limit: 0 })).length).toBe(1)
  })

  test('keyPrefix is literal: _ and % are not wildcards', async () => {
    for (const k of ['a_1', 'ab1', 'a%1', 'a1']) await store.put(S, alice, 'c', k, k)
    const keys = async (keyPrefix: string) => (await store.query(S, alice, 'c', { keyPrefix })).map((r) => r.key).sort()
    expect(await keys('a_')).toEqual(['a_1'])
    expect(await keys('a%')).toEqual(['a%1'])
    expect(await keys('a')).toEqual(['a%1', 'a1', 'a_1', 'ab1'])
  })

  test('likePrefix escapes the LIKE wildcards and the escape character', () => {
    expect(likePrefix('__jobs')).toBe('\\_\\_jobs')
    expect(likePrefix('50%_a\\b')).toBe('50\\%\\_a\\\\b')
  })
})

describe('delete', () => {
  test('returns whether a row was removed', async () => {
    await store.put(S, alice, 'c', 'k', 1)
    expect(await store.remove(S, alice, 'c', 'k')).toBe(true)
    expect(await store.remove(S, alice, 'c', 'k')).toBe(false)
  })

  test('is exported under its contract name too', () => {
    expect(store.delete).toBe(store.remove)
  })
})

describe('namespaces for migrations', () => {
  test('copyNamespace copies plugin rows (never reserved ones) and replaces the target', async () => {
    await store.put(S, alice, 'c', 'a', 1)
    await store.put(S, proj, 'c', 'b', 2)
    await store.put({ ...S, platform: true }, alice, '__jobs', 'j', 'job')
    await store.put({ ...S, namespace: 'migrating:op1' }, alice, 'c', 'stale', 0)
    expect(await store.copyNamespace('skiller', 'live', 'migrating:op1')).toBe(2)
    const copy = db.rows('pluginData').filter((r) => r.namespace === 'migrating:op1')
    expect(copy.map((r) => [r.key, r.value, r.userId, r.projectId]).sort()).toEqual([
      ['a', 1, 'u-alice', null],
      ['b', 2, null, 'p-1'],
    ])
  })

  test('swapNamespace replaces live with the migrated rows in one transaction', async () => {
    await store.put(S, alice, 'c', 'a', 'old')
    await store.put({ ...S, platform: true }, alice, '__jobs', 'j', 'job')
    await store.put({ ...S, namespace: 'migrating:op1' }, alice, 'c', 'a', 'new')
    await store.put({ ...S, namespace: 'migrating:op1' }, alice, 'c', 'b', 'added')
    const before = db.transactions
    await store.swapNamespace('skiller', 'migrating:op1', 'live')
    expect(db.transactions).toBe(before + 1)
    const live = db.rows('pluginData').filter((r) => r.namespace === 'live')
    expect(live.map((r) => [r.collection, r.key, r.value]).sort()).toEqual([
      ['__jobs', 'j', 'job'],
      ['c', 'a', 'new'],
      ['c', 'b', 'added'],
    ])
    expect(db.rows('pluginData').filter((r) => r.namespace === 'migrating:op1')).toEqual([])
  })

  test('a failed swap leaves both namespaces as they were', async () => {
    await store.put(S, alice, 'c', 'a', 'old')
    await store.put({ ...S, namespace: 'migrating:op1' }, alice, 'c', 'a', 'new')
    // Fail the second statement of the swap, after the first already deleted live rows.
    const realTransaction = db.$transaction.bind(db)
    db.$transaction = ((fn: (tx: FakePrisma) => Promise<unknown>) =>
      realTransaction(async (tx) => {
        tx.pluginData.updateMany = async () => {
          throw new Error('connection lost')
        }
        return fn(tx)
      })) as FakePrisma['$transaction']
    await expect(store.swapNamespace('skiller', 'migrating:op1', 'live')).rejects.toThrow('connection lost')
    db.$transaction = realTransaction
    expect(db.rows('pluginData').map((r) => [r.namespace, r.value]).sort()).toEqual([
      ['live', 'old'],
      ['migrating:op1', 'new'],
    ])
  })

  test('namespace names are checked', async () => {
    expect(await code(store.copyNamespace('skiller', 'live', 'live'))).toBe('invalid_namespace')
    expect(await code(store.copyNamespace('skiller', 'live', 'other'))).toBe('invalid_namespace')
    expect(await code(store.put({ ...S, namespace: 'tmp' }, alice, 'c', 'k', 1))).toBe('invalid_namespace')
  })
})
