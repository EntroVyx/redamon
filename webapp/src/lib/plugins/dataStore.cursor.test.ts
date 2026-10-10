/**
 * Data-store cursors (TD-28; phase 04 review). The hash in a cursor is not a secret, so a
 * plugin can forge one for its own query: whatever position it then names must be refused
 * as `invalid_cursor` when Postgres could not compare it (a date outside its range, text it
 * cannot hold, an id that no row can have), not reach the database as a 500. And a walk in
 * the `updated` order is bounded by the newest row when it began: a plugin that writes each
 * row back as it reads it moves that row to the end, and the walk never finished.
 *
 * @vitest-environment node
 */
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'
import { createHash } from 'crypto'

const h = vi.hoisted(() => ({ db: null as unknown as Record<string, unknown> }))
vi.mock('@/lib/prisma', () => ({ default: new Proxy({}, { get: (_t, k) => h.db[k as string] }) }))

import { createFakePrisma } from './__testing__/fakePrisma'
import { setNowForTests } from './clock'
import * as store from './dataStore'
import { PluginDataError, type PluginOwner, type QueryOrder } from './dataStore'

let t = Date.parse('2026-10-09T10:00:00.000Z')
const alice: PluginOwner = { type: 'user', id: 'u-alice' }
const S = { pluginId: 'skiller' }

beforeEach(() => {
  const db = createFakePrisma()
  h.db = db as unknown as Record<string, unknown>
  db.seed('pluginInstall', [{ pluginId: 'skiller' }])
  t = Date.parse('2026-10-09T10:00:00.000Z')
  setNowForTests(() => new Date(t))
})
afterEach(() => setNowForTests(null))

const put = async (key: string, value: unknown) => {
  t += 1000
  await store.put(S, alice, 'rows', key, value)
}
const keys = (p: store.QueryPage) => p.items.map((r) => r.key)

/** What a plugin can do: decode its cursor, change a field, and hash it again. */
function forge(cursor: string, order: QueryOrder, change: Record<string, unknown>): string {
  const body = { ...JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')), ...change }
  const query = ['skiller', 'live', 'user', alice.id, 'rows', null, null, order]
  body.h = createHash('sha256')
    .update(JSON.stringify([...query, body.o, body.v, body.i, ...(body.s === undefined ? [] : [body.s])]))
    .digest('base64url')
    .slice(0, 32)
  return Buffer.from(JSON.stringify(body), 'utf8').toString('base64url')
}

async function firstCursor(order: QueryOrder) {
  for (const k of ['a', 'b', 'c']) await put(k, k)
  const { next } = await store.query(S, alice, 'rows', { order, limit: 1 })
  return next!
}

describe('a forged cursor naming a position Postgres cannot compare is invalid_cursor', () => {
  test.each(['updated', 'key'] as const)('order %s: the forgery itself works (an unchanged cursor is accepted)', async (order) => {
    const forged = forge(await firstCursor(order), order, {})
    expect(keys(await store.query(S, alice, 'rows', { order, limit: 1, cursor: forged }))).toEqual(['b'])
  })

  test.each([
    ['a date before year 1', { v: '-271821-04-20T00:00:00.000Z' }],
    ['a date after year 9999', { v: '+275760-09-13T00:00:00.000Z' }],
    ['year 0', { v: '0000-01-01T00:00:00.000Z' }],
    ['a date in another format', { v: 'Fri, 09 Oct 2026 10:00:00 GMT' }],
    ['an id with U+0000', { i: 'cl\u0000x' }],
    ['an id with a lone surrogate', { i: '\ud800' }],
    ['a start bound that is no date', { s: 'soon' }],
  ])('order updated, %s', async (_n, change) => {
    const forged = forge(await firstCursor('updated'), 'updated', change)
    const e = await store.query(S, alice, 'rows', { order: 'updated', limit: 1, cursor: forged }).catch((x: unknown) => x)
    expect(e).toBeInstanceOf(PluginDataError)
    expect((e as PluginDataError).code).toBe('invalid_cursor')
  })

  test.each([
    ['a key with U+0000', { v: 'a\u0000' }],
    ['a key with a lone surrogate', { v: 'a\udc80' }],
  ])('order key, %s', async (_n, change) => {
    const forged = forge(await firstCursor('key'), 'key', change)
    await expect(store.query(S, alice, 'rows', { order: 'key', limit: 1, cursor: forged })).rejects.toMatchObject({ code: 'invalid_cursor' })
  })
})

describe('a walk that writes each row back as it reads it', () => {
  test.each(['updated', '-updated'] as const)('order %s: ends, each row once', async (order) => {
    for (let i = 0; i < 12; i++) await put(`k${String(i).padStart(2, '0')}`, i)
    const seen: string[] = []
    let cursor: string | null = null
    for (let page = 0; page < 50; page++) {
      const p: store.QueryPage = await store.query(S, alice, 'rows', { order, limit: 5, cursor })
      seen.push(...keys(p))
      for (const k of keys(p)) await put(k, `migrated ${k}`)
      cursor = p.next
      if (!cursor) break
    }
    expect(cursor).toBeNull()
    expect([...seen].sort()).toEqual(Array.from({ length: 12 }, (_, i) => `k${String(i).padStart(2, '0')}`))
  })
})
