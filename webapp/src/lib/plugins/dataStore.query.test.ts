/**
 * TD-28 paging, filtering and counting in the data store (R-82, R-83, R-84), on the
 * in-memory Prisma double, whose JSON path filter follows jsonb equality. The same cases
 * run on a real Postgres in stores.pg.integration.test.ts. The `where` cases are those of
 * services/plugin_runner/tests/test_sdk_fake.py, so the SDK's fake and the store agree.
 *
 * @vitest-environment node
 */
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'

const h = vi.hoisted(() => ({ db: null as unknown as Record<string, unknown> }))
vi.mock('@/lib/prisma', () => ({ default: new Proxy({}, { get: (_t, k) => h.db[k as string] }) }))

import { createFakePrisma, type FakePrisma } from './__testing__/fakePrisma'
import { setNowForTests } from './clock'
import * as store from './dataStore'
import { PluginDataError, type PluginOwner, type QueryOrder } from './dataStore'

let db: FakePrisma
let t = Date.parse('2026-10-09T10:00:00.000Z')
const alice: PluginOwner = { type: 'user', id: 'u-alice' }
const bob: PluginOwner = { type: 'user', id: 'u-bob' }
const S = { pluginId: 'skiller' }

beforeEach(() => {
  db = createFakePrisma()
  h.db = db as unknown as Record<string, unknown>
  db.seed('pluginInstall', [{ pluginId: 'skiller' }, { pluginId: 'echo' }])
  t = Date.parse('2026-10-09T10:00:00.000Z')
  setNowForTests(() => new Date(t))
})
afterEach(() => {
  setNowForTests(null)
  vi.unstubAllEnvs()
})

const tick = () => (t += 1000)
const put = async (key: string, value: unknown, owner = alice, collection = 'rows', opts = {}) => {
  tick()
  await store.put(S, owner, collection, key, value, opts)
}
const keys = (page: store.QueryPage) => page.items.map((r) => r.key)

/** Rows as put() would store them, without its quota count over every row per write. */
function seedRows(n: number) {
  db.seed(
    'pluginData',
    Array.from({ length: n }, (_, i) => {
      tick()
      return {
        pluginId: 'skiller',
        namespace: 'live',
        ownerType: 'user',
        ownerId: alice.id,
        userId: alice.id,
        collection: 'rows',
        key: `k${String(i).padStart(4, '0')}`,
        value: i,
        sizeBytes: String(i).length,
        expiresAt: null,
        updatedAt: new Date(t),
      }
    }),
  )
}
const failure = async (p: Promise<unknown>) => {
  const e = await p.catch((err: unknown) => err)
  expect(e).toBeInstanceOf(PluginDataError)
  return { code: (e as PluginDataError).code, message: (e as PluginDataError).message }
}

async function walk(order: QueryOrder, between?: (page: number, seen: string[]) => Promise<void>, limit = 200) {
  const seen: string[] = []
  let cursor: string | null = null
  for (let page = 1; page < 100; page++) {
    const p: store.QueryPage = await store.query(S, alice, 'rows', { order, limit, cursor })
    seen.push(...keys(p))
    if (p.next === null) return { seen, pages: page }
    expect(typeof p.next).toBe('string')
    cursor = p.next
    if (between) await between(page, seen)
  }
  throw new Error('no last page')
}

describe('paging (R-82)', () => {
  const ORDERS: QueryOrder[] = ['-updated', 'updated', 'key', '-key']

  test.each(ORDERS)('order %s: 1,000 rows, 200 a page, writes between pages: each surviving row exactly once', { timeout: 30_000 }, async (order) => {
    seedRows(1000)
    const deleted = new Set<string>()
    const { seen, pages } = await walk(order, async (page, seenSoFar) => {
      // New rows, a deleted row not yet returned, a deleted row already returned.
      await put(`late-${order}-${page}`, page)
      const notYet = ['k0333', 'k0666', 'k0999', 'k0001'].find((k) => !seenSoFar.includes(k) && !deleted.has(k))
      if (notYet) {
        deleted.add(notYet)
        await store.remove(S, alice, 'rows', notYet)
      }
      await store.remove(S, alice, 'rows', seenSoFar[0])
    })
    const originals = seen.filter((k) => k.startsWith('k'))
    const expected = Array.from({ length: 1000 }, (_, i) => `k${String(i).padStart(4, '0')}`).filter((k) => !deleted.has(k))
    expect([...originals].sort()).toEqual(expected)
    expect(new Set(seen).size).toBe(seen.length)
    expect(pages).toBeGreaterThanOrEqual(5)
  })

  test('the four orders, ties broken by the row id in the same direction', async () => {
    await put('b', 'b')
    await put('a', 'a')
    await put('c', 'c')
    const all = async (order: QueryOrder) => keys(await store.query(S, alice, 'rows', { order }))
    expect(await all('-updated')).toEqual(['c', 'a', 'b'])
    expect(await all('updated')).toEqual(['b', 'a', 'c'])
    expect(await all('key')).toEqual(['a', 'b', 'c'])
    expect(await all('-key')).toEqual(['c', 'b', 'a'])
    expect(keys(await store.query(S, alice, 'rows'))).toEqual(['c', 'a', 'b'])
  })

  test('rows written in the same millisecond page by id, none lost or repeated', async () => {
    for (let i = 0; i < 25; i++) await store.put(S, alice, 'rows', `same${i}`, i)
    for (const order of ['-updated', 'updated'] as const) {
      const { seen } = await walk(order, undefined, 4)
      expect([...seen].sort()).toEqual(Array.from({ length: 25 }, (_, i) => `same${i}`).sort())
    }
  })

  test('next is null on the last page, also when it is exactly full', async () => {
    for (let i = 0; i < 4; i++) await put(`k${i}`, i)
    const first = await store.query(S, alice, 'rows', { limit: 2 })
    const second = await store.query(S, alice, 'rows', { limit: 2, cursor: first.next })
    expect(first.next).not.toBeNull()
    expect(keys(second)).toHaveLength(2)
    expect(second.next).toBeNull()
    expect((await store.query(S, alice, 'rows', { limit: 4 })).next).toBeNull()
    expect((await store.query(S, alice, 'rows', { limit: 3 })).next).not.toBeNull()
  })

  test('items carry key, value, updatedAt and expiresAt', async () => {
    await put('k', { a: 1 })
    const [item] = (await store.query(S, alice, 'rows')).items
    expect(item).toMatchObject({ key: 'k', value: { a: 1 }, expiresAt: null })
    expect(item.updatedAt).toBeInstanceOf(Date)
  })
})

describe('where (R-83): the cases of test_sdk_fake.py', () => {
  beforeEach(async () => {
    const rows: Record<string, unknown> = {
      'open-int': { status: 'open', n: 1, flag: true, gone: null },
      'closed-float': { status: 'closed', n: 1.0, flag: false },
      'bool-one': { status: 'open', n: true },
      'text-one': { status: 'open', n: '1' },
      'not-an-object': 'open',
      'list-value': ['open'],
    }
    for (const [k, v] of Object.entries(rows)) await put(k, v)
  })
  const where = async (w: Record<string, store.WhereValue>) => keys(await store.query(S, alice, 'rows', { where: w })).sort()

  test('jsonb equality', async () => {
    expect(await where({ status: 'open' })).toEqual(['bool-one', 'open-int', 'text-one'])
    expect(await where({ n: 1 })).toEqual(['closed-float', 'open-int'])
    expect(await where({ n: 1.0 })).toEqual(['closed-float', 'open-int'])
    expect(await where({ n: true })).toEqual(['bool-one'])
    expect(await where({ flag: false })).toEqual(['closed-float'])
    expect(await where({ n: '1' })).toEqual(['text-one'])
    expect(await where({ gone: null })).toEqual(['open-int'])
    expect(await where({ missing: null })).toEqual([])
    expect(await where({ status: 'open', n: 1 })).toEqual(['open-int'])
  })

  test('ANDed with the prefix, and counted the same way', async () => {
    expect(keys(await store.query(S, alice, 'rows', { keyPrefix: 'open', where: { status: 'open' } }))).toEqual(['open-int'])
    expect(await store.count(S, alice, 'rows')).toBe(6)
    expect(await store.count(S, alice, 'rows', { where: { status: 'open' } })).toBe(3)
    expect(await store.count(S, alice, 'rows', { keyPrefix: 'open', where: { status: 'open' } })).toBe(1)
  })

  test('never reaches another owner, plugin or namespace', async () => {
    await put('bob-open', { status: 'open' }, bob)
    await store.put({ pluginId: 'echo' }, alice, 'rows', 'echo-open', { status: 'open' })
    await store.put({ pluginId: 'skiller', namespace: 'migrating:op-1' }, alice, 'rows', 'copy-open', { status: 'open' })
    expect(await where({ status: 'open' })).toEqual(['bool-one', 'open-int', 'text-one'])
    expect(await store.count(S, alice, 'rows', { where: { status: 'open' } })).toBe(3)
  })
})

describe('count', () => {
  test('equals the number of rows a full walk returns; expired rows are invisible to both', async () => {
    for (let i = 0; i < 30; i++) await put(`k${i}`, { even: i % 2 === 0 }, alice, 'rows', i < 5 ? { ttlSeconds: 60 } : {})
    t += 120_000
    const walked: string[] = []
    let cursor: string | null = null
    do {
      const p: store.QueryPage = await store.query(S, alice, 'rows', { limit: 7, cursor, where: { even: true } })
      walked.push(...keys(p))
      cursor = p.next
    } while (cursor)
    expect(await store.count(S, alice, 'rows', { where: { even: true } })).toBe(walked.length)
    expect(walked).toHaveLength(12)
    expect(await store.count(S, alice, 'rows')).toBe(25)
  })

  test('a reserved collection needs the platform scope, as for every other operation', async () => {
    expect((await failure(store.count(S, alice, '__jobs'))).code).toBe('reserved_collection')
    expect(await store.count({ ...S, platform: true }, alice, '__jobs')).toBe(0)
  })
})

describe('cursors (R-84)', () => {
  beforeEach(async () => {
    for (let i = 0; i < 5; i++) await put(`k${i}`, { even: i % 2 === 0 })
  })

  test.each<[string, store.QueryOptions, PluginOwner?, string?]>([
    ['another where', { where: { even: true } }],
    ['another order', { order: 'key' }],
    ['another prefix', { keyPrefix: 'k1' }],
    ['another owner', {}, bob],
    ['another collection', {}, alice, 'other'],
  ])('reused with %s: invalid_cursor, "This cursor belongs to another query."', async (_n, opts, owner = alice, collection = 'rows') => {
    const { next } = await store.query(S, alice, 'rows', { limit: 2 })
    expect(await failure(store.query(S, owner, collection, { limit: 2, ...opts, cursor: next }))).toEqual({
      code: 'invalid_cursor',
      message: 'This cursor belongs to another query.',
    })
  })

  test('reused by another plugin: invalid_cursor', async () => {
    const { next } = await store.query(S, alice, 'rows', { limit: 2 })
    expect((await failure(store.query({ pluginId: 'echo' }, alice, 'rows', { limit: 2, cursor: next }))).code).toBe('invalid_cursor')
  })

  test('a different limit is the same query: the cursor still fits', async () => {
    const { next } = await store.query(S, alice, 'rows', { limit: 2 })
    expect(keys(await store.query(S, alice, 'rows', { limit: 3, cursor: next }))).toEqual(['k2', 'k1', 'k0'])
  })

  test.each([
    ['garbage', 'not a cursor'],
    ['empty', ''],
    ['valid base64 of something else', Buffer.from('{"a":1}').toString('base64url')],
  ])('%s: invalid_cursor', async (_n, cursor) => {
    expect((await failure(store.query(S, alice, 'rows', { cursor }))).code).toBe('invalid_cursor')
  })

  test('a tampered cursor: invalid_cursor', async () => {
    const { next } = await store.query(S, alice, 'rows', { limit: 2 })
    const decoded = JSON.parse(Buffer.from(next!, 'base64url').toString('utf8'))
    for (const field of ['v', 'i'] as const) {
      const changed = Buffer.from(JSON.stringify({ ...decoded, [field]: `${decoded[field]}x` })).toString('base64url')
      expect((await failure(store.query(S, alice, 'rows', { limit: 2, cursor: changed }))).code).toBe('invalid_cursor')
    }
  })
})

describe("refused queries (invalid_query, the SDK client's messages)", () => {
  test.each<[string, store.QueryOptions, string]>([
    ['an empty where', { where: {} }, 'where takes 1 to 5 fields.'],
    ['six where fields', { where: { a: 1, b: 2, c: 3, d: 4, e: 5, f: 6 } }, 'where takes 1 to 5 fields.'],
    ['a where that is a list', { where: [] as never }, 'where takes 1 to 5 fields.'],
    ['a field name with a dash', { where: { 'a-b': 1 } }, "where field 'a-b' is not a valid name."],
    ['a field name starting with a digit', { where: { '1a': 1 } }, "where field '1a' is not a valid name."],
    ['a 65-character field name', { where: { ['a'.repeat(65)]: 1 } }, `where field '${'a'.repeat(65)}' is not a valid name.`],
    ['a list value', { where: { tags: ['x'] as never } }, "where value for 'tags' must be text of at most 512 characters, a finite number, true, false or null."],
    ['an object value', { where: { meta: { a: 1 } as never } }, "where value for 'meta' must be text of at most 512 characters, a finite number, true, false or null."],
    ['513 characters of text', { where: { long: 'x'.repeat(513) } }, "where value for 'long' must be text of at most 512 characters, a finite number, true, false or null."],
    ['infinity', { where: { n: Infinity } }, "where value for 'n' must be text of at most 512 characters, a finite number, true, false or null."],
    ['NaN', { where: { n: Number.NaN } }, "where value for 'n' must be text of at most 512 characters, a finite number, true, false or null."],
    ['an unknown order', { order: 'random' as never }, 'order is one of -updated, updated, key, -key.'],
    ['a cursor that is not text', { cursor: 7 as never }, 'cursor must be the string a previous page returned.'],
    ['limit 0', { limit: 0 }, 'limit is a whole number from 1 to 200.'],
    ['limit 201', { limit: 201 }, 'limit is a whole number from 1 to 200.'],
    ['limit 1.5', { limit: 1.5 }, 'limit is a whole number from 1 to 200.'],
    ['limit as text', { limit: '5' as never }, 'limit is a whole number from 1 to 200.'],
    ['a prefix that is not text', { keyPrefix: 5 as never }, 'prefix must be text of at most 512 characters.'],
  ])('%s', async (_n, opts, message) => {
    expect(await failure(store.query(S, alice, 'rows', opts))).toEqual({ code: 'invalid_query', message })
  })

  test('512 characters of text and a 64-character name are fine', async () => {
    expect((await store.query(S, alice, 'rows', { where: { ['a'.repeat(64)]: 'x'.repeat(512) } })).items).toEqual([])
  })

  test('count checks where and prefix the same way', async () => {
    expect((await failure(store.count(S, alice, 'rows', { where: {} }))).code).toBe('invalid_query')
    expect((await failure(store.count(S, alice, 'rows', { keyPrefix: 5 as never }))).code).toBe('invalid_query')
  })
})
