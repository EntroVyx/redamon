/**
 * The Gateway frame (TD-06, D-34, D-39): what the calling plugin may still do. The
 * install row and the stored manifest decide, on every call; the token's own claims
 * (`perms`, `pid`) and anything in the body are never trusted for that. The SDK is a thin
 * wrapper (D-39), so every case here is a raw HTTP call a plugin could make without it.
 *
 * @vitest-environment node
 */
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'

const h = vi.hoisted(() => ({ db: null as unknown as Record<string, unknown> }))
vi.mock('@/lib/prisma', () => ({ default: new Proxy({}, { get: (_t, k) => h.db[k as string] }) }))

import { createFakePrisma, type FakePrisma } from './__testing__/fakePrisma'
import {
  ALICE,
  BOB,
  CALL_SECRET,
  answer,
  echoInstall,
  echoManifest,
  gatewayRequest,
  seedWorld,
  token,
} from './__testing__/gatewayHarness'
import { withGateway } from './gateway'
import * as store from './dataStore'
import { POST as dataGet } from '@/app/api/plugin-gateway/v1/data/get/route'

let db: FakePrisma

beforeEach(() => {
  db = createFakePrisma()
  h.db = db as unknown as Record<string, unknown>
  vi.stubEnv('PLUGIN_CALL_TOKEN_SECRET', CALL_SECRET)
  vi.stubEnv('AUTH_SECRET', 'a'.repeat(64))
})
afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

const ok = vi.fn(async () => ({ ok: true }))
const call = async (permission?: 'session:read' | 'llm:invoke' | 'override:skill.text', over = {}) =>
  answer(await withGateway(gatewayRequest('x', {}, { token: await token(over) }), { op: 'x', permission }, ok))

describe('the plugin must be serving, at the version the token names', () => {
  test('control: enabled, ready, active version 1.0.0 → 200', async () => {
    seedWorld(db)
    expect((await call()).status).toBe(200)
  })

  test.each<[string, Record<string, unknown>]>([
    ['disabled', { enabled: false }],
    ['revoked', { revokedReason: 'catalog revoked 1.0.0' }],
    ['revoked with an empty reason', { revokedReason: '' }],
    ['updating', { status: 'updating' }],
    ['failed', { status: 'failed' }],
    ['incompatible', { status: 'incompatible' }],
    ['uninstalling', { status: 'uninstalling' }],
    ['available (uninstalled, data kept)', { status: 'available', activeVersion: null }],
    ['on another version', { activeVersion: '1.1.0' }],
  ])('%s: 403 plugin_unavailable, the handler never runs', async (_name, over) => {
    seedWorld(db, { install: echoInstall(over) })
    ok.mockClear()
    const r = await call()
    expect(r.status).toBe(403)
    expect(r.body.code).toBe('plugin_unavailable')
    expect(ok).not.toHaveBeenCalled()
  })

  test('a plugin this instance does not know: 403', async () => {
    seedWorld(db, { install: null })
    expect((await call()).status).toBe(403)
  })

  test('a plugin row is re-read on every call: disabling it stops the next call of the same token', async () => {
    seedWorld(db)
    const t = await token()
    const req = () => withGateway(gatewayRequest('x', {}, { token: t }), { op: 'x' }, ok)
    expect((await req()).status).toBe(200)
    await db.pluginInstall.update({ where: { pluginId: 'echo' }, data: { enabled: false } })
    expect((await req()).status).toBe(403)
  })
})

describe('a permission must be both granted and declared', () => {
  test('granted and declared: 200', async () => {
    seedWorld(db)
    expect((await call('session:read')).status).toBe(200)
  })

  test('declared in the manifest but not granted by the admin: 403 permission_denied', async () => {
    seedWorld(db, { install: echoInstall({ grantedPermissions: ['llm:invoke'] }) })
    const r = await call('session:read')
    expect(r).toEqual({
      status: 403,
      body: { error: 'This plugin was not granted session:read.', code: 'permission_denied' },
    })
  })

  test('granted but no longer declared by the active manifest: 403', async () => {
    seedWorld(db, {
      install: echoInstall({ manifest: echoManifest({ permissions: ['llm:invoke'], llmFeature: { description: 'x' } }) }),
    })
    expect((await call('session:read')).status).toBe(403)
  })

  test('the token claiming the permission changes nothing', async () => {
    seedWorld(db, { install: echoInstall({ grantedPermissions: [] }) })
    expect((await call('override:skill.text', { perms: ['override:skill.text', 'session:read', 'llm:invoke'] })).status).toBe(403)
  })

  test('a manifest that is missing or malformed grants nothing', async () => {
    seedWorld(db, { install: echoInstall({ manifest: null }) })
    expect((await call('session:read')).status).toBe(403)
    db = createFakePrisma()
    h.db = db as unknown as Record<string, unknown>
    seedWorld(db, { install: echoInstall({ manifest: { permissions: 'session:read' } }) })
    expect((await call('session:read')).status).toBe(403)
  })
})

describe('the body never widens what a call reaches (D-39)', () => {
  test('pluginId, namespace, userId and ownerId in the body are ignored', async () => {
    seedWorld(db)
    db.seed('pluginInstall', [echoInstall({ pluginId: 'other', manifest: echoManifest({ id: 'other' }) })])
    await store.put({ pluginId: 'echo' }, { type: 'user', id: ALICE }, 'notes', 'k1', 'mine')
    await store.put({ pluginId: 'echo' }, { type: 'user', id: BOB }, 'notes', 'k1', 'bob')
    await store.put({ pluginId: 'other' }, { type: 'user', id: ALICE }, 'notes', 'k1', 'other plugin')
    await store.put({ pluginId: 'echo', namespace: 'migrating:op-1' }, { type: 'user', id: ALICE }, 'notes', 'k1', 'copy')
    const body = {
      collection: 'notes',
      key: 'k1',
      owner: 'user',
      pluginId: 'other',
      namespace: 'migrating:op-1',
      userId: BOB,
      ownerId: BOB,
      ownerType: 'user',
      platform: true,
    }
    const r = await answer(await dataGet(gatewayRequest('data/get', body, { token: await token() })))
    expect(r).toEqual({ status: 200, body: { found: true, value: 'mine' } })
  })

  test('a platform-reserved collection stays refused whatever the body claims', async () => {
    seedWorld(db)
    const body = { collection: '__jobs', key: 'k', owner: 'user', platform: true }
    const r = await answer(await dataGet(gatewayRequest('data/get', body, { token: await token() })))
    expect(r).toEqual({
      status: 400,
      body: { error: 'collections starting with __ are reserved for the platform', code: 'reserved_collection' },
    })
  })
})

describe('the handler', () => {
  test('receives the checked context, never the raw token', async () => {
    seedWorld(db)
    let seen: Record<string, unknown> = {}
    const t = await token()
    await withGateway(gatewayRequest('x', { a: 1 }, { token: t }), { op: 'x' }, async (ctx) => {
      seen = { ...ctx, plugin: ctx.plugin.pluginId }
      return { ok: true }
    })
    expect(seen).toMatchObject({
      pluginId: 'echo',
      version: '1.0.0',
      userId: ALICE,
      projectId: 'project-alice',
      sessionId: 'session-alice',
      body: { a: 1 },
      plugin: 'echo',
    })
    expect(JSON.stringify(seen)).not.toContain(t)
  })

  test('an unexpected error is a 500 with no detail; the log has it', async () => {
    seedWorld(db)
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const r = await answer(
      await withGateway(gatewayRequest('x', {}, { token: await token() }), { op: 'x' }, async () => {
        throw new Error('db password=hunter2 exploded')
      }),
    )
    expect(r).toEqual({ status: 500, body: { error: 'The Gateway failed; the webapp log has the details.', code: 'internal_error' } })
    expect(err.mock.calls.flat().join(' ')).toContain('exploded')
  })

  test('answers are never cached', async () => {
    seedWorld(db)
    const res = await withGateway(gatewayRequest('x', {}, { token: await token() }), { op: 'x' }, ok)
    expect(res.headers.get('cache-control')).toBe('no-store')
  })
})
