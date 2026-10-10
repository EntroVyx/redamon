/**
 * Revocation (README.PLUGINS.md §6.2, RV-17): a version the signed catalog revokes gets
 * `revokedReason` (audited `plugin.revoked`), which every serving predicate reads, so the
 * run list drops it and its worker stops; the admin's `enabled` is never touched. A version
 * no longer revoked has the reason cleared. Without a usable catalog nothing changes.
 *
 * @vitest-environment node
 */
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'
import { NextRequest } from 'next/server'

const h = vi.hoisted(() => ({ db: null as unknown as Record<string, unknown>, audit: [] as Record<string, unknown>[] }))
vi.mock('@/lib/prisma', () => ({ default: new Proxy({}, { get: (_t, k) => h.db[k as string] }) }))
vi.mock('@/lib/audit', () => ({ writeAudit: vi.fn(async (e: Record<string, unknown>) => void h.audit.push(e)) }))

import { createFakePrisma, type FakePrisma } from './__testing__/fakePrisma'
import { ADMIN, NOW, RUNNER_KEY, startLifecycleWorld, type LifecycleWorld } from './__testing__/lifecycleHarness'
import { CatalogError } from './catalog'
import { setNowForTests } from './clock'
import { install } from './lifecycle'
import { reconcile } from './reconcile'

/** A run that was not refused as busy (no other reconcile runs in these tests). */
async function reconcileNow(deps: Parameters<typeof reconcile>[0]) {
  const r = await reconcile(deps)
  if ('skipped' in r) throw new Error('reconcile was busy')
  return r
}
import { servesActions } from './registry'
import { GET as runList } from '@/app/api/plugin-runner/v1/run-list/route'

let db: FakePrisma
let w: LifecycleWorld
const PERMS = ['session:read', 'llm:invoke', 'override:skill.text']

beforeEach(async () => {
  db = createFakePrisma()
  h.db = db as unknown as Record<string, unknown>
  h.audit = []
  setNowForTests(() => NOW)
  for (const m of ['warn', 'error', 'log'] as const) vi.spyOn(console, m).mockImplementation(() => {})
  db.seed('user', [{ id: ADMIN, email: 'admin@example.com', role: 'admin' }])
  w = await startLifecycleWorld(() => db)
  await install('echo', { version: '1.0.0', acceptedPermissions: PERMS }, ADMIN, w.deps)
  h.audit = []
})

afterEach(async () => {
  await w.close()
  setNowForTests(null)
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

const row = () => db.rows('pluginInstall').find((r) => r.pluginId === 'echo')!

async function runListIds(): Promise<string[]> {
  vi.stubEnv('PLUGINS_ENABLED', 'true')
  const res = await runList(new NextRequest('http://webapp:3000/api/plugin-runner/v1/run-list', { headers: { 'x-plugin-runner-key': RUNNER_KEY } }))
  return ((await res.json()).plugins as { id: string }[]).map((p) => p.id)
}

describe('revocation', () => {
  test('sets revokedReason, leaves enabled alone, drops the plugin from the run list and stops its worker', async () => {
    expect(await runListIds()).toEqual(['echo'])
    w.catalog.revoked = [{ id: 'echo', version: '1.0.0', reason: 'Sends transcripts out.' }]
    const report = await reconcileNow(w.deps)
    expect(row()).toMatchObject({ revokedReason: 'Sends transcripts out.', enabled: true, status: 'ready' })
    expect(servesActions(row() as never)).toBe(false)
    expect(await runListIds()).toEqual([])
    expect(w.runner.options.workers).toEqual([])
    expect(report.revoked).toEqual(['echo'])
    expect(h.audit.find((e) => e.action === 'plugin.revoked')).toMatchObject({
      actorId: null, targetId: 'echo', source: 'system', after: { version: '1.0.0', revokedReason: 'Sends transcripts out.' },
    })
  })

  test('a second run changes nothing and audits nothing', async () => {
    w.catalog.revoked = [{ id: 'echo', version: '1.0.0', reason: 'x' }]
    await reconcileNow(w.deps)
    h.audit = []
    await reconcileNow(w.deps)
    expect(h.audit).toEqual([])
  })

  test('only the installed version: revoking another version changes nothing', async () => {
    w.catalog.revoked = [{ id: 'echo', version: '0.9.0', reason: 'x' }]
    await reconcileNow(w.deps)
    expect(row().revokedReason).toBeNull()
  })

  test('a version no longer revoked is served again', async () => {
    w.catalog.revoked = [{ id: 'echo', version: '1.0.0', reason: 'x' }]
    await reconcileNow(w.deps)
    w.catalog.revoked = []
    const report = await reconcileNow(w.deps)
    expect(row().revokedReason).toBeNull()
    expect(report.unrevoked).toEqual(['echo'])
    expect(await runListIds()).toEqual(['echo'])
  })

  test('without a usable catalog the revocation state is kept as it is', async () => {
    w.catalog.revoked = [{ id: 'echo', version: '1.0.0', reason: 'x' }]
    await reconcileNow(w.deps)
    w.catalog.unavailable = new CatalogError('catalog_unreachable', 'down')
    const report = await reconcileNow(w.deps)
    expect(row().revokedReason).toBe('x')
    expect(report.catalog).toBe('unavailable: catalog_unreachable')
  })
})
