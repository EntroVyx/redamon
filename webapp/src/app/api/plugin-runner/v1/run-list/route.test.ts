/**
 * GET /api/plugin-runner/v1/run-list: which plugin versions the runner must run
 * (README.PLUGINS.md §7.2, D-38). Cookie-less: the runner authenticates with its key,
 * compared in constant time, failing closed (TD-08). The session, X-Internal-Key and
 * user headers mean nothing here.
 *
 * @vitest-environment node
 */
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'
import { NextRequest } from 'next/server'

const db = vi.hoisted(() => ({ current: null as unknown }))
vi.mock('@/lib/prisma', () => ({
  default: new Proxy({}, { get: (_t, prop) => (db.current as Record<string | symbol, unknown>)[prop] }),
}))

import { GET } from './route'
import { createFakePrisma, type FakePrisma } from '@/lib/plugins/__testing__/fakePrisma'
import { PLUGIN_PLATFORM_VERSION } from '@/lib/plugins/platformVersion'

const KEY = 'r'.repeat(64)
let fake: FakePrisma

function manifest(id: string, version: string) {
  return { id, version, actions: [{ id: 'run', entry: 'engine/main.py:run', timeoutSeconds: 30 }] }
}

function row(id: string, over: Record<string, unknown> = {}) {
  return {
    pluginId: id, enabled: true, status: 'ready', activeVersion: '1.0.0', manifest: manifest(id, '1.0.0'),
    grantedPermissions: [], revokedReason: null, ...over,
  }
}

function req(headers: Record<string, string> = {}) {
  return new NextRequest('http://webapp:3000/api/plugin-runner/v1/run-list', { headers })
}

beforeEach(() => {
  fake = createFakePrisma()
  db.current = fake
  vi.stubEnv('PLUGIN_RUNNER_KEY', KEY)
  vi.stubEnv('INTERNAL_API_KEY', 'i'.repeat(64))
})
afterEach(() => vi.unstubAllEnvs())

describe('refusals', () => {
  test.each(['', 'changeme', '   '])('no runner key configured (%j): 503 runner_not_configured', async (configured) => {
    vi.stubEnv('PLUGIN_RUNNER_KEY', configured)
    for (const given of [configured, KEY, '']) {
      const res = await GET(req(given ? { 'x-plugin-runner-key': given } : {}))
      expect(res.status).toBe(503)
      expect((await res.json()).code).toBe('runner_not_configured')
    }
  })

  test.each<Record<string, string>>([
    {},
    { 'x-plugin-runner-key': 'wrong' },
    { 'x-plugin-runner-key': KEY + 'x' },
    { authorization: `Bearer ${KEY}` },
    { 'x-internal-key': 'i'.repeat(64) },
    { cookie: 'redamon-auth=anything', 'x-user-id': 'admin-1', 'x-user-role': 'admin' },
  ])('a request without the runner key is 401 (%o)', async (headers) => {
    fake.seed('pluginInstall', [row('echo')])
    const res = await GET(req(headers))
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: 'Invalid or missing runner key.', code: 'unauthorized' })
  })
})

describe('the list', () => {
  test('only enabled, unrevoked plugins that are ready or updating, at their active version', async () => {
    fake.seed('pluginInstall', [
      row('echo'),
      row('mid-update', { status: 'updating', activeVersion: '1.2.0', pendingVersion: '1.3.0', manifest: manifest('mid-update', '1.2.0') }),
      row('disabled', { enabled: false }),
      row('revoked', { revokedReason: 'catalog revoked 1.0.0' }),
      row('revoked-empty', { revokedReason: '' }),
      row('failed', { status: 'failed' }),
      row('incompatible', { status: 'incompatible' }),
      row('installing', { status: 'installing', activeVersion: null }),
      row('uninstalling', { status: 'uninstalling' }),
      row('available', { status: 'available', activeVersion: null, manifest: null }),
      row('no-version', { activeVersion: null }),
      row('no-manifest', { manifest: null }),
    ])
    const res = await GET(req({ 'x-plugin-runner-key': KEY }))
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    const body = await res.json()
    expect(body.platformVersion).toBe(PLUGIN_PLATFORM_VERSION)
    expect(body.plugins).toEqual([
      { id: 'echo', version: '1.0.0', manifest: manifest('echo', '1.0.0'), root: '/plugins/echo/versions/1.0.0' },
      { id: 'mid-update', version: '1.2.0', manifest: manifest('mid-update', '1.2.0'), root: '/plugins/mid-update/versions/1.2.0' },
    ])
  })

  test('an empty platform answers an empty list', async () => {
    const res = await GET(req({ 'x-plugin-runner-key': KEY }))
    expect(await res.json()).toEqual({ platformVersion: PLUGIN_PLATFORM_VERSION, plugins: [] })
  })

  test('the root is where the runner mounts the volume, not the webapp', async () => {
    vi.stubEnv('PLUGINS_DIR', '/data/plugins')
    fake.seed('pluginInstall', [row('echo')])
    const body = await (await GET(req({ 'x-plugin-runner-key': KEY }))).json()
    expect(body.plugins[0].root).toBe('/plugins/echo/versions/1.0.0')
  })
})
