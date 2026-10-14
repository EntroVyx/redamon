/**
 * GET /api/plugins/[pluginId]/export: a JSON download of everything one plugin left in the
 * database, for every user and project (R-17: the way back before a purge or a downgrade
 * whose `db push --accept-data-loss` would drop the plugin tables). Admin only, audited,
 * and it is what unlocks a purge for the next hour.
 *
 * @vitest-environment node
 */
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'
import { NextRequest } from 'next/server'

const h = vi.hoisted(() => ({
  db: null as unknown as Record<string, unknown>,
  session: null as { userId: string; role: string } | null,
  audit: [] as Record<string, unknown>[],
}))
vi.mock('@/lib/prisma', () => ({ default: new Proxy({}, { get: (_t, k) => h.db[k as string] }) }))
vi.mock('@/lib/session', async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  getSession: async () => h.session,
}))
vi.mock('@/lib/audit', () => ({ writeAudit: vi.fn(async (e: Record<string, unknown>) => void h.audit.push(e)) }))

import { createFakePrisma, type FakePrisma } from './__testing__/fakePrisma'
import { setNowForTests } from './clock'
import { EXPORT_FORMAT, lastExportAt } from './exportData'
import { GET as exportRoute } from '@/app/api/plugins/[pluginId]/export/route'

const NOW = new Date('2026-10-10T10:00:00Z')
let db: FakePrisma

beforeEach(() => {
  db = createFakePrisma()
  h.db = db as unknown as Record<string, unknown>
  h.audit = []
  h.session = { userId: 'user-admin', role: 'admin' }
  setNowForTests(() => NOW)
  db.seed('user', [
    { id: 'user-admin', email: 'admin@example.com', role: 'admin' },
    { id: 'user-alice', email: 'alice@example.com', role: 'standard' },
  ])
  db.seed('pluginInstall', [
    { pluginId: 'echo', status: 'ready', enabled: true, activeVersion: '1.0.0', dataVersion: 1 },
    { pluginId: 'other', status: 'ready', enabled: true, activeVersion: '2.0.0' },
  ])
  db.seed('pluginData', [
    { pluginId: 'echo', ownerType: 'user', ownerId: 'user-alice', userId: 'user-alice', collection: 'items', key: 'a', value: { n: 1 }, sizeBytes: 7 },
    { pluginId: 'echo', ownerType: 'project', ownerId: 'p1', projectId: 'p1', collection: 'items', key: 'b', value: [1, 2], sizeBytes: 5 },
    { pluginId: 'echo', ownerType: 'user', ownerId: 'user-alice', userId: 'user-alice', collection: '__jobs', key: 'j', value: { status: 'succeeded' }, sizeBytes: 20 },
    { pluginId: 'other', ownerType: 'user', ownerId: 'user-alice', userId: 'user-alice', collection: 'items', key: 'x', value: 0, sizeBytes: 1 },
  ])
  db.seed('pluginOverride', [
    {
      pluginId: 'echo', extensionPoint: 'skill.text', scopeType: 'user', scopeId: 'user-alice', userId: 'user-alice',
      targetGroup: 'sqli', targetKey: 'sqli/workflow', changeSetId: 'cs-1', revision: 2, value: 'v', baseSha256: 'a'.repeat(64),
      status: 'active', createdBy: 'user-alice',
    },
  ])
})

afterEach(() => {
  setNowForTests(null)
  vi.restoreAllMocks()
})

const call = (pluginId = 'echo') =>
  exportRoute(new NextRequest(`http://localhost:3000/api/plugins/${pluginId}/export`), { params: Promise.resolve({ pluginId }) })

describe('export', () => {
  test('a JSON attachment with the install row, every data row of the plugin and its overrides', async () => {
    const res = await call()
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toMatch(/^application\/json/)
    expect(res.headers.get('content-disposition')).toMatch(/^attachment; filename="redamon-plugin-echo-2026-10-10T10-00-00-000Z\.json"$/)
    expect(res.headers.get('cache-control')).toBe('no-store')
    const doc = await res.json()
    expect(doc).toMatchObject({ format: EXPORT_FORMAT, exportVersion: 2, pluginId: 'echo', exportedAt: NOW.toISOString() })
    expect(doc.install).toMatchObject({ pluginId: 'echo', activeVersion: '1.0.0' })
    expect(doc.data.map((r: { key: string }) => r.key).sort()).toEqual(['a', 'b', 'j'])
    expect(doc.data.find((r: { key: string }) => r.key === 'b').value).toEqual([1, 2])
    expect(doc.overrides).toHaveLength(1)
    expect(doc.overrides[0]).toMatchObject({ changeSetId: 'cs-1', status: 'active' })
  })

  test('audited plugin.export with the counts, and it unlocks a purge', async () => {
    expect(await lastExportAt('echo')).toBeNull()
    await call()
    expect(h.audit.find((e) => e.action === 'plugin.export')).toMatchObject({
      actorId: 'user-admin',
      targetId: 'echo',
      after: { dataRows: 3, overrideRows: 1 },
    })
    expect((await lastExportAt('echo'))?.toISOString()).toBe(NOW.toISOString())
    expect(await lastExportAt('other')).toBeNull()
  })

  test('a cross-site request is refused before anything is exported: a link elsewhere cannot open the purge gate', async () => {
    const res = await exportRoute(
      new NextRequest('http://localhost:3000/api/plugins/echo/export', { headers: { 'sec-fetch-site': 'cross-site' } }),
      { params: Promise.resolve({ pluginId: 'echo' }) },
    )
    expect(res.status).toBe(403)
    expect(db.rows('pluginPlatformState').some((s) => String(s.key).startsWith('export:echo'))).toBe(false)
    // The page's own download link is same-origin.
    const ok = await exportRoute(
      new NextRequest('http://localhost:3000/api/plugins/echo/export', { headers: { 'sec-fetch-site': 'same-origin' } }),
      { params: Promise.resolve({ pluginId: 'echo' }) },
    )
    expect(ok.status).toBe(200)
  })

  test('an unknown plugin is 404 and writes nothing', async () => {
    const res = await call('nobody')
    expect(res.status).toBe(404)
    expect(h.audit).toEqual([])
    expect(db.rows('pluginPlatformState')).toEqual([])
  })

  test('a standard user gets 403 and no data', async () => {
    h.session = { userId: 'user-alice', role: 'standard' }
    const res = await call()
    expect(res.status).toBe(403)
    expect(JSON.stringify(await res.json())).not.toMatch(/sqli/)
  })
})
