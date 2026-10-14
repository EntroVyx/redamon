/**
 * What the Gateway frame accepts as a body (phase 04 review). A body is parsed on the
 * webapp's one thread and held while its handler runs, and an empty container costs ~64
 * bytes of heap: 8 MB of `{}` took 179 MB, so a few concurrent calls could exhaust the
 * container. Each operation therefore has its own limit (64 KB unless it carries data),
 * containers and nesting are counted before parsing, and text Postgres cannot store is
 * refused at the door instead of failing a write as a 500. The call ledger lives on
 * globalThis, so a second copy of the module cannot split a token's budget.
 *
 * @vitest-environment node
 */
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'

const h = vi.hoisted(() => ({ db: null as unknown as Record<string, unknown> }))
vi.mock('@/lib/prisma', () => ({ default: new Proxy({}, { get: (_t, k) => h.db[k as string] }) }))

import { createFakePrisma, type FakePrisma } from './__testing__/fakePrisma'
import { CALL_SECRET, answer, gatewayRequest, seedWorld, token } from './__testing__/gatewayHarness'
import { setNowForTests } from './clock'
import { callBudgetEntries } from './gateway'
import { POST as dataGet } from '@/app/api/plugin-gateway/v1/data/get/route'
import { POST as dataPut } from '@/app/api/plugin-gateway/v1/data/put/route'

let db: FakePrisma

beforeEach(() => {
  db = createFakePrisma()
  h.db = db as unknown as Record<string, unknown>
  seedWorld(db)
  vi.stubEnv('PLUGIN_CALL_TOKEN_SECRET', CALL_SECRET)
  vi.stubEnv('AUTH_SECRET', 'a'.repeat(64))
  setNowForTests(() => new Date('2026-10-09T10:00:00.000Z'))
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => {
  setNowForTests(null)
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

const get = async (body: unknown, raw?: string) => answer(await dataGet(gatewayRequest('data/get', body, { token: await token(), rawBody: raw })))
const put = async (value: unknown, raw?: string) =>
  answer(await dataPut(gatewayRequest('data/put', { collection: 'notes', key: 'k', owner: 'user', value }, { token: await token(), rawBody: raw })))
const nested = (levels: number) => '['.repeat(levels) + ']'.repeat(levels)

describe('each operation has its own body limit', () => {
  test('data/get takes 64 KB', async () => {
    expect(await get({ collection: 'notes', key: 'k', owner: 'user', pad: 'x'.repeat(65_536) })).toMatchObject({
      status: 413,
      body: { code: 'body_too_large', limit: 65_536 },
    })
  })

  test('data/put still takes a 1 MB value', async () => {
    expect((await put('x'.repeat(1_000_000))).status).toBe(200)
  })
})

describe('the shape is checked before parsing', () => {
  test('nesting past 64 levels: 400 invalid_json', async () => {
    const raw = `{"collection":"notes","key":"k","owner":"user","value":${nested(64)}}`
    expect(await put(null, raw)).toMatchObject({ status: 400, body: { code: 'invalid_json' } })
    expect((await put(null, `{"collection":"notes","key":"k","owner":"user","value":${nested(63)}}`)).status).toBe(200)
  })

  test('more than 200,000 objects and arrays: 400 invalid_json, before any parsing', async () => {
    const raw = `{"collection":"notes","key":"k","owner":"user","value":[${'{},'.repeat(200_000)}{}]}`
    const r = await put(null, raw)
    expect(r).toMatchObject({ status: 400, body: { code: 'invalid_json' } })
    expect(String(r.body.error)).toContain('200000')
  })

  test('brackets and quotes inside strings are text, not structure', async () => {
    expect((await put('['.repeat(100) + '{"\\"'.repeat(100))).status).toBe(200)
  })
})

describe('text Postgres cannot store is refused at the door', () => {
  test.each([
    ['U+0000 in a value', { value: 'a\u0000b' }],
    ['an unpaired high surrogate', { value: 'a\ud800b' }],
    ['an unpaired low surrogate', { value: '\udc80' }],
    ['U+0000 in a key of the value', { value: { 'k\u0000': 1 } }],
  ])('%s: 400 invalid_text', async (_n, { value }) => {
    expect(await put(value)).toMatchObject({ status: 400, body: { code: 'invalid_text' } })
  })

  test('in a lookup too, which no store reaches', async () => {
    expect(await get({ collection: 'notes', key: 'k\ud800', owner: 'user' })).toMatchObject({ status: 400, body: { code: 'invalid_text' } })
  })

  test('a surrogate pair, and an escaped backslash before u0000, are ordinary text', async () => {
    expect((await put('😀 \\u0000')).status).toBe(200)
  })
})

test('the call ledger is one per process, even if the module is loaded twice', async () => {
  const before = callBudgetEntries()
  await get({ collection: 'notes', key: 'k', owner: 'user' })
  expect(callBudgetEntries()).toBe(before + 1)
  vi.resetModules()
  const fresh = await import('./gateway')
  expect(fresh.callBudgetEntries()).toBe(before + 1)
})
