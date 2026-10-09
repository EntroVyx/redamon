/**
 * The Gateway's data operations (`sdk.data.*`, D-44, R-82..R-84): always granted, the
 * calling plugin's own rows only, in the `live` namespace, owned by the token's user or
 * project. Nothing in the body (an owner id, a namespace, a where, a cursor) reaches
 * another plugin, owner or namespace.
 *
 * @vitest-environment node
 */
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'

const h = vi.hoisted(() => ({ db: null as unknown as Record<string, unknown> }))
vi.mock('@/lib/prisma', () => ({ default: new Proxy({}, { get: (_t, k) => h.db[k as string] }) }))

import { createFakePrisma, type FakePrisma } from './__testing__/fakePrisma'
import {
  ALICE,
  ALICE_PROJECT,
  BOB,
  CALL_SECRET,
  answer,
  echoInstall,
  echoManifest,
  gatewayRequest,
  seedWorld,
  token,
  type TokenInput,
} from './__testing__/gatewayHarness'
import { setNowForTests } from './clock'
import * as store from './dataStore'
import { POST as dataGet } from '@/app/api/plugin-gateway/v1/data/get/route'
import { POST as dataPut } from '@/app/api/plugin-gateway/v1/data/put/route'
import { POST as dataQuery } from '@/app/api/plugin-gateway/v1/data/query/route'
import { POST as dataCount } from '@/app/api/plugin-gateway/v1/data/count/route'
import { POST as dataDelete } from '@/app/api/plugin-gateway/v1/data/delete/route'

let db: FakePrisma
let t = Date.parse('2026-10-09T10:00:00.000Z')
const ROUTES = { get: dataGet, put: dataPut, query: dataQuery, count: dataCount, delete: dataDelete }
type Op = keyof typeof ROUTES

beforeEach(() => {
  db = createFakePrisma()
  h.db = db as unknown as Record<string, unknown>
  seedWorld(db)
  db.seed('pluginInstall', [echoInstall({ pluginId: 'other', manifest: echoManifest({ id: 'other' }) })])
  vi.stubEnv('PLUGINS_ENABLED', 'true')
  vi.stubEnv('PLUGIN_CALL_TOKEN_SECRET', CALL_SECRET)
  vi.stubEnv('AUTH_SECRET', 'a'.repeat(64))
  t = Date.parse('2026-10-09T10:00:00.000Z')
  setNowForTests(() => new Date(t))
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => {
  setNowForTests(null)
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

const call = async (op: Op, body: Record<string, unknown>, over: TokenInput = {}) =>
  answer(await ROUTES[op](gatewayRequest(`data/${op}`, body, { token: await token(over) })))

const echo = { pluginId: 'echo' }
const aliceOwner: store.PluginOwner = { type: 'user', id: ALICE }

describe('the operations, in the shapes of the SDK contract', () => {
  test('put then get, with and without a time to live', async () => {
    expect(await call('put', { collection: 'notes', key: 'k3', value: 'text', owner: 'user' })).toEqual({
      status: 200,
      body: { sizeBytes: 6, expiresAt: null },
    })
    expect(await call('put', { collection: 'cache', key: 'k2', value: [1, 2, 3], owner: 'user', ttlSeconds: 3600 })).toEqual({
      status: 200,
      body: { sizeBytes: 7, expiresAt: '2026-10-09T11:00:00.000Z' },
    })
    expect((await call('get', { collection: 'notes', key: 'k3', owner: 'user' })).body).toEqual({ found: true, value: 'text' })
    expect((await call('get', { collection: 'notes', key: 'missing', owner: 'user' })).body).toEqual({ found: false })
  })

  test('a stored null is found, a missing value is refused', async () => {
    await call('put', { collection: 'notes', key: 'n', value: null, owner: 'user' })
    expect((await call('get', { collection: 'notes', key: 'n', owner: 'user' })).body).toEqual({ found: true, value: null })
    const r = await call('put', { collection: 'notes', key: 'none', owner: 'user' })
    expect(r).toMatchObject({ status: 400, body: { code: 'invalid_value' } })
  })

  test('delete answers whether a row was removed', async () => {
    await call('put', { collection: 'notes', key: 'k1', value: 1, owner: 'user' })
    expect((await call('delete', { collection: 'notes', key: 'k1', owner: 'user' })).body).toEqual({ deleted: true })
    expect((await call('delete', { collection: 'notes', key: 'k1', owner: 'user' })).body).toEqual({ deleted: false })
  })

  test('query pages with next, items as {key, value, updatedAt, expiresAt}; count agrees', async () => {
    for (const [k, v] of [['other', 0], ['run:1', 1], ['run:2', 2]] as const) {
      t += 1000
      await call('put', { collection: 'notes', key: k, value: v, owner: 'user' })
    }
    const first = await call('query', { collection: 'notes', owner: 'user', limit: 1, prefix: 'run:' })
    expect(first.status).toBe(200)
    expect(first.body.items).toEqual([{ key: 'run:2', value: 2, updatedAt: '2026-10-09T10:00:03.000Z', expiresAt: null }])
    expect(typeof first.body.next).toBe('string')
    const second = await call('query', { collection: 'notes', owner: 'user', limit: 1, prefix: 'run:', cursor: first.body.next })
    expect(second.body).toEqual({
      items: [{ key: 'run:1', value: 1, updatedAt: '2026-10-09T10:00:02.000Z', expiresAt: null }],
      next: null,
    })
    expect((await call('count', { collection: 'notes', owner: 'user', prefix: 'run:' })).body).toEqual({ count: 2 })
    expect((await call('query', { collection: 'notes', owner: 'user', limit: 50 })).body).toMatchObject({ next: null })
  })

  test('query with where and order, and count with where', async () => {
    for (const [k, v] of [['f1', { severity: 'low', fixed: false }], ['f3', { severity: 'high', fixed: false }], ['f2', { severity: 'high', fixed: true }]] as const) {
      await call('put', { collection: 'findings', key: k, value: v, owner: 'user' })
    }
    const r = await call('query', { collection: 'findings', owner: 'user', limit: 5, where: { severity: 'high' }, order: 'key' })
    expect((r.body.items as { key: string }[]).map((i) => i.key)).toEqual(['f2', 'f3'])
    expect((await call('count', { collection: 'findings', owner: 'user', where: { fixed: false } })).body).toEqual({ count: 2 })
  })
})

describe('owner, plugin and namespace come from the token only', () => {
  beforeEach(async () => {
    await store.put(echo, aliceOwner, 'notes', 'k1', { status: 'open', who: 'alice' })
    await store.put(echo, { type: 'user', id: BOB }, 'notes', 'k1', { status: 'open', who: 'bob' })
    await store.put({ pluginId: 'other' }, aliceOwner, 'notes', 'k1', { status: 'open', who: 'other plugin' })
    await store.put({ pluginId: 'echo', namespace: 'migrating:op-1' }, aliceOwner, 'notes', 'k1', { status: 'open', who: 'copy' })
    await store.put(echo, { type: 'project', id: ALICE_PROJECT }, 'notes', 'k1', { status: 'open', who: 'project' })
  })
  const smuggled = { ownerId: BOB, ownerType: 'user', userId: BOB, projectId: 'project-bob', pluginId: 'other', namespace: 'migrating:op-1', platform: true }

  test('get, query and count with smuggled ids read only the token owner', async () => {
    expect((await call('get', { collection: 'notes', key: 'k1', owner: 'user', ...smuggled })).body).toEqual({
      found: true,
      value: { status: 'open', who: 'alice' },
    })
    const q = await call('query', { collection: 'notes', owner: 'user', limit: 50, where: { status: 'open' }, ...smuggled })
    expect((q.body.items as { value: { who: string } }[]).map((i) => i.value.who)).toEqual(['alice'])
    expect((await call('count', { collection: 'notes', owner: 'user', where: { status: 'open' }, ...smuggled })).body).toEqual({ count: 1 })
  })

  test('put and delete with smuggled ids touch only the token owner', async () => {
    await call('put', { collection: 'notes', key: 'k1', value: 'overwritten', owner: 'user', ...smuggled })
    expect((await store.get(echo, { type: 'user', id: BOB }, 'notes', 'k1'))?.value).toEqual({ status: 'open', who: 'bob' })
    expect((await store.get({ pluginId: 'other' }, aliceOwner, 'notes', 'k1'))?.value).toEqual({ status: 'open', who: 'other plugin' })
    expect((await store.get(echo, aliceOwner, 'notes', 'k1'))?.value).toBe('overwritten')
    expect(db.rows('pluginData').filter((r) => r.namespace !== 'live')).toHaveLength(1)
    await call('delete', { collection: 'notes', key: 'k1', owner: 'user', ...smuggled })
    expect(await store.get(echo, { type: 'user', id: BOB }, 'notes', 'k1')).not.toBeNull()
    expect(await store.get(echo, aliceOwner, 'notes', 'k1')).toBeNull()
  })

  test("owner project is the token's project", async () => {
    expect((await call('get', { collection: 'notes', key: 'k1', owner: 'project' })).body).toEqual({
      found: true,
      value: { status: 'open', who: 'project' },
    })
  })

  test.each<Op>(['get', 'put', 'query', 'count', 'delete'])('%s with owner project outside a project: 400 invalid_owner', async (op) => {
    const r = await call(op, { collection: 'notes', key: 'k1', value: 1, owner: 'project' }, { prj: undefined, ses: undefined, conv: undefined })
    expect(r).toEqual({ status: 400, body: { error: 'This action was not started from a project.', code: 'invalid_owner' } })
  })

  test("a cursor made for Bob's query is refused for Alice", async () => {
    for (let i = 0; i < 3; i++) await store.put(echo, { type: 'user', id: BOB }, 'many', `k${i}`, i)
    const bobs = await call('query', { collection: 'many', owner: 'user', limit: 1 }, { sub: BOB, prj: 'project-bob', ses: 'session-bob', conv: 'conv-bob' })
    const r = await call('query', { collection: 'many', owner: 'user', limit: 1, cursor: bobs.body.next })
    expect(r).toEqual({ status: 400, body: { error: 'This cursor belongs to another query.', code: 'invalid_cursor' } })
  })
})

describe('refusals', () => {
  test.each<Op>(['get', 'put', 'query', 'count', 'delete'])('%s on a reserved collection: 400 with the contract body', async (op) => {
    const r = await call(op, { collection: '__jobs', key: 'k', value: 1, owner: 'user' })
    expect(r).toEqual({ status: 400, body: { error: 'collections starting with __ are reserved for the platform', code: 'reserved_collection' } })
  })

  test('a value over the limit: 413 value_too_large naming the limit', async () => {
    vi.stubEnv('PLUGIN_DATA_MAX_VALUE_BYTES', '10')
    const r = await call('put', { collection: 'notes', key: 'big', value: 'x'.repeat(20), owner: 'user' })
    expect(r).toEqual({
      status: 413,
      body: { error: 'a value is limited to 10 bytes of JSON, this one has 22', code: 'value_too_large', limit: 10 },
    })
  })

  test.each([
    ['PLUGIN_DATA_MAX_ROWS', 'rows'],
    ['PLUGIN_DATA_MAX_ROWS_PER_OWNER', 'owner_rows'],
  ])('%s reached: 413 quota_exceeded naming the quota and its limit', async (variable, quota) => {
    vi.stubEnv(variable, '1')
    await call('put', { collection: 'notes', key: 'a', value: 1, owner: 'user' })
    const r = await call('put', { collection: 'notes', key: 'b', value: 1, owner: 'user' })
    expect(r.status).toBe(413)
    expect(r.body).toMatchObject({ code: 'quota_exceeded', quota, limit: 1 })
  })

  test('the byte quota too', async () => {
    vi.stubEnv('PLUGIN_DATA_MAX_BYTES', '5')
    const r = await call('put', { collection: 'notes', key: 'a', value: 'abcdefgh', owner: 'user' })
    expect(r.body).toMatchObject({ code: 'quota_exceeded', quota: 'bytes', limit: 5 })
  })

  test.each<[string, Record<string, unknown>]>([
    ['a bad field name', { where: { 'a-b': 1 } }],
    ['a non-scalar value', { where: { tags: ['x'] } }],
    ['an empty where', { where: {} }],
    ['an unknown order', { order: 'random' }],
    ['limit 0', { limit: 0 }],
    ['limit 500', { limit: 500 }],
    ['a text limit', { limit: '5' }],
    ['a cursor that is a number', { cursor: 7 }],
  ])('query with %s: 400 invalid_query', async (_n, extra) => {
    const r = await call('query', { collection: 'notes', owner: 'user', limit: 50, ...extra })
    expect(r.status).toBe(400)
    expect(r.body.code).toBe('invalid_query')
  })

  test('a number past the JSON range (1e999 parses as Infinity) is refused in where', async () => {
    const req = gatewayRequest('data/query', null, {
      token: await token(),
      rawBody: '{"collection":"notes","owner":"user","limit":50,"where":{"n":1e999}}',
    })
    expect((await answer(await dataQuery(req))).body.code).toBe('invalid_query')
  })

  test('count with a bad where: 400 invalid_query', async () => {
    expect((await call('count', { collection: 'notes', owner: 'user', where: { meta: { a: 1 } } })).body.code).toBe('invalid_query')
  })

  test('collection and key are checked: 400 with the store code', async () => {
    expect((await call('get', { collection: 7, key: 'k', owner: 'user' })).body.code).toBe('invalid_collection')
    expect((await call('get', { collection: 'notes', key: '', owner: 'user' })).body.code).toBe('invalid_key')
    expect((await call('put', { collection: 'notes', key: 'k', value: 1, owner: 'user', ttlSeconds: -1 })).body.code).toBe('invalid_ttl')
  })
})
