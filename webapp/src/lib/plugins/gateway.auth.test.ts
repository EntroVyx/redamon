/**
 * The Gateway frame (TD-06): who may call. Plugin code holds only its call token; the
 * frame re-checks everything else on every call and never honours a cookie, a session,
 * the effective user or X-Internal-Key (RV-33).
 *
 * @vitest-environment node
 */
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'
import { SignJWT } from 'jose'

const h = vi.hoisted(() => ({ db: null as unknown as Record<string, unknown> }))
vi.mock('@/lib/prisma', () => ({ default: new Proxy({}, { get: (_t, k) => h.db[k as string] }) }))

import { createFakePrisma, type FakePrisma } from './__testing__/fakePrisma'
import {
  ALICE,
  CALL_SECRET,
  answer,
  gatewayRequest,
  seedWorld,
  token,
} from './__testing__/gatewayHarness'
import { setNowForTests } from './clock'
import { withGateway, GATEWAY_BODY_MAX_BYTES } from './gateway'
import { POST as dataGet } from '@/app/api/plugin-gateway/v1/data/get/route'

const AUTH = 'a'.repeat(64)
const INTERNAL = 'i'.repeat(64)
let db: FakePrisma
let clock = new Date('2026-10-09T10:00:00.000Z')

beforeEach(() => {
  db = createFakePrisma()
  h.db = db as unknown as Record<string, unknown>
  seedWorld(db)
  vi.stubEnv('PLUGIN_CALL_TOKEN_SECRET', CALL_SECRET)
  vi.stubEnv('AUTH_SECRET', AUTH)
  vi.stubEnv('INTERNAL_API_KEY', INTERNAL)
  vi.stubEnv('PLUGIN_GATEWAY_CALLS_PER_TOKEN', '')
  clock = new Date('2026-10-09T10:00:00.000Z')
  setNowForTests(() => clock)
})
afterEach(() => {
  setNowForTests(null)
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

const getBody = { collection: 'notes', key: 'k1', owner: 'user' }

describe('before anything is read', () => {
  test.each([null, 'text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x'])(
    'content type %s: 415',
    async (contentType) => {
      const r = await answer(await dataGet(gatewayRequest('data/get', getBody, { token: await token(), contentType })))
      expect(r.status).toBe(415)
    },
  )

  test('a body that is not JSON: 400', async () => {
    const r = await answer(await dataGet(gatewayRequest('data/get', null, { token: await token(), rawBody: '{nope' })))
    expect(r.status).toBe(400)
    expect(r.body.code).toBe('invalid_json')
  })

  test.each(['[1,2]', '"text"', 'null', '7'])('a JSON body that is not an object (%s): 400', async (raw) => {
    const r = await answer(await dataGet(gatewayRequest('data/get', null, { token: await token(), rawBody: raw })))
    expect(r.status).toBe(400)
    expect(r.body.code).toBe('invalid_json')
  })

  test('a body over 8 MB: 413, by declared length and when streamed', async () => {
    const big = JSON.stringify({ collection: 'notes', key: 'k', pad: 'x'.repeat(GATEWAY_BODY_MAX_BYTES) })
    const declared = gatewayRequest('data/get', null, {
      token: await token(),
      rawBody: big,
      headers: { 'content-length': String(big.length) },
    })
    expect((await answer(await dataGet(declared))).status).toBe(413)
    const streamed = gatewayRequest('data/get', null, { token: await token(), rawBody: big })
    streamed.headers.delete('content-length')
    expect((await answer(await dataGet(streamed))).status).toBe(413)
  })
})

describe('the call token is the only credential', () => {
  test('no Authorization header: 401 invalid_token with the contract message', async () => {
    const r = await answer(await dataGet(gatewayRequest('data/get', getBody)))
    expect(r).toEqual({ status: 401, body: { error: 'Invalid or expired call token.', code: 'invalid_token' } })
  })

  test.each([
    ['Basic dXNlcjpwYXNz'],
    ['Bearer'],
    ['Bearer not-a-jwt'],
    ['bearer  '],
  ])('Authorization %j: 401', async (authorization) => {
    const r = await answer(await dataGet(gatewayRequest('data/get', getBody, { headers: { authorization } })))
    expect(r.status).toBe(401)
    expect(r.body.code).toBe('invalid_token')
  })

  test('an expired token: 401', async () => {
    const t = await token({ timeoutSeconds: 30 })
    clock = new Date(clock.getTime() + 91_000)
    expect((await answer(await dataGet(gatewayRequest('data/get', getBody, { token: t })))).status).toBe(401)
  })

  test('a token signed with another secret: 401', async () => {
    vi.stubEnv('PLUGIN_CALL_TOKEN_SECRET', 'z'.repeat(64))
    const t = await token()
    vi.stubEnv('PLUGIN_CALL_TOKEN_SECRET', CALL_SECRET)
    expect((await answer(await dataGet(gatewayRequest('data/get', getBody, { token: t })))).status).toBe(401)
  })

  test('only a valid X-Internal-Key: 401', async () => {
    const r = await answer(await dataGet(gatewayRequest('data/get', getBody, { headers: { 'x-internal-key': INTERNAL } })))
    expect(r.status).toBe(401)
  })

  test('only a valid login cookie, with user headers: 401', async () => {
    const login = await new SignJWT({ sub: ALICE, role: 'admin' })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(new TextEncoder().encode(AUTH))
    const r = await answer(
      await dataGet(
        gatewayRequest('data/get', getBody, {
          headers: { cookie: `redamon-auth=${login}`, 'x-user-id': ALICE, 'x-user-role': 'admin' },
        }),
      ),
    )
    expect(r.status).toBe(401)
  })

  test('the login cookie sent as the bearer: 401', async () => {
    const login = await new SignJWT({ sub: ALICE, role: 'admin' })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(new TextEncoder().encode(AUTH))
    expect((await answer(await dataGet(gatewayRequest('data/get', getBody, { token: login })))).status).toBe(401)
  })

  test('a job token where only action tokens are accepted: 401', async () => {
    const t = await token({ kind: 'job', jid: 'job-1' })
    const handler = vi.fn(async () => ({ ok: true }))
    const r = await answer(await withGateway(gatewayRequest('x', {}, { token: t }), { op: 'x', kinds: ['action'] }, handler))
    expect(r.status).toBe(401)
    expect(handler).not.toHaveBeenCalled()
  })

  test.each(['', 'changeme', 'short'])(
    'call token secret %j: 503 plugins_not_configured, nothing read',
    async (secret) => {
      const t = await token()
      vi.stubEnv('PLUGIN_CALL_TOKEN_SECRET', secret)
      const r = await answer(await dataGet(gatewayRequest('data/get', getBody, { token: t })))
      expect(r.status).toBe(503)
      expect(r.body.code).toBe('plugins_not_configured')
    },
  )

  test('the user the token acts for was deleted: 401', async () => {
    const t = await token()
    await db.user.delete({ where: { id: ALICE } })
    const r = await answer(await dataGet(gatewayRequest('data/get', getBody, { token: t })))
    expect(r.status).toBe(401)
    expect(r.body.code).toBe('invalid_token')
  })
})

describe('call budget (RV-39)', () => {
  test('a token makes at most PLUGIN_GATEWAY_CALLS_PER_TOKEN calls; another token is not affected', async () => {
    vi.stubEnv('PLUGIN_GATEWAY_CALLS_PER_TOKEN', '3')
    const t = await token()
    for (let i = 0; i < 3; i++) {
      expect((await answer(await dataGet(gatewayRequest('data/get', getBody, { token: t })))).status).toBe(200)
    }
    const over = await answer(await dataGet(gatewayRequest('data/get', getBody, { token: t })))
    expect(over).toEqual({
      status: 429,
      body: { error: 'This call token has made its 3 calls.', code: 'call_budget_exceeded' },
    })
    expect((await answer(await dataGet(gatewayRequest('data/get', getBody, { token: await token() })))).status).toBe(200)
  })

  test('the default budget is 600 calls', async () => {
    const t = await token()
    const handler = vi.fn(async () => ({ ok: true }))
    for (let i = 0; i < 600; i++) {
      expect((await withGateway(gatewayRequest('x', {}, { token: t }), { op: 'x' }, handler)).status).toBe(200)
    }
    const r = await answer(await withGateway(gatewayRequest('x', {}, { token: t }), { op: 'x' }, handler))
    expect(r.body).toEqual({ error: 'This call token has made its 600 calls.', code: 'call_budget_exceeded' })
    expect(handler).toHaveBeenCalledTimes(600)
  })

  test('refused calls count too, so a flood of refusals cannot hammer the database', async () => {
    vi.stubEnv('PLUGIN_GATEWAY_CALLS_PER_TOKEN', '2')
    const t = await token()
    await db.pluginInstall.update({ where: { pluginId: 'echo' }, data: { enabled: false } })
    for (let i = 0; i < 2; i++) {
      expect((await answer(await dataGet(gatewayRequest('data/get', getBody, { token: t })))).status).toBe(403)
    }
    expect((await answer(await dataGet(gatewayRequest('data/get', getBody, { token: t })))).status).toBe(429)
  })
})

describe('what the frame logs', () => {
  test('one line per call with op, plugin, status and time, never the body', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const t = await token()
    await dataGet(gatewayRequest('data/get', { ...getBody, key: 'secret-looking-key' }, { token: t }))
    await dataGet(gatewayRequest('data/get', getBody))
    const lines = [...log.mock.calls, ...warn.mock.calls].map((c) => c.join(' '))
    expect(lines.some((l) => /^\[plugins\] gateway data\/get plugin=echo status=200 ms=\d+$/.test(l))).toBe(true)
    expect(lines.some((l) => /^\[plugins\] gateway data\/get plugin=- status=401 ms=\d+$/.test(l))).toBe(true)
    expect(lines.join('\n')).not.toContain('secret-looking-key')
  })
})
