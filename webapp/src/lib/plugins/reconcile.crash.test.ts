/**
 * Crash recovery (README.PLUGINS.md §9.7): an operation whose lease expired was
 * interrupted. Reconciliation claims it (takeOverOperation) and rolls the install back,
 * finishes an update whose new version is on the volume and needs no data migration (else
 * rolls it back), and finishes an uninstall, honouring a purge recorded in its arguments.
 * An operation whose lease is still live is never touched.
 *
 * @vitest-environment node
 */
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'

const h = vi.hoisted(() => ({ db: null as unknown as Record<string, unknown>, audit: [] as Record<string, unknown>[] }))
vi.mock('@/lib/prisma', () => ({ default: new Proxy({}, { get: (_t, k) => h.db[k as string] }) }))
vi.mock('@/lib/audit', () => ({ writeAudit: vi.fn(async (e: Record<string, unknown>) => void h.audit.push(e)) }))

import { createFakePrisma, type FakePrisma } from './__testing__/fakePrisma'
import { ADMIN, NOW, exists, startLifecycleWorld, type LifecycleWorld } from './__testing__/lifecycleHarness'
import { readArchive } from './archive'
import { setNowForTests } from './clock'
import { install } from './lifecycle'
import { LEASE_MS } from './registry'
import { reconcile } from './reconcile'

/** A run that was not refused as busy (no other reconcile runs in these tests). */
async function reconcileNow(deps: Parameters<typeof reconcile>[0]) {
  const r = await reconcile(deps)
  if ('skipped' in r) throw new Error('reconcile was busy')
  return r
}
import { commitVersion, stageArchive, stagingPath, versionPath } from './staging'

let db: FakePrisma
let w: LifecycleWorld
let clock: Date
const PERMS = ['session:read', 'llm:invoke', 'override:skill.text', 'override:user_skill.text']
const OP = '0f8b6c1e-2a3d-4e5f-8a9b-0c1d2e3f4a5b'

beforeEach(async () => {
  db = createFakePrisma()
  h.db = db as unknown as Record<string, unknown>
  h.audit = []
  clock = NOW
  setNowForTests(() => clock)
  for (const m of ['warn', 'error', 'log'] as const) vi.spyOn(console, m).mockImplementation(() => {})
  db.seed('user', [
    { id: ADMIN, email: 'admin@example.com', role: 'admin' },
    { id: 'user-a', email: 'a@example.com', role: 'standard' },
  ])
  db.seed('userSettings', [{ userId: 'user-a', featureModels: { 'plugin:echo': 'm', other: 'n' } }])
  w = await startLifecycleWorld(() => db, [{}, { manifest: { version: '1.0.1' } }, { manifest: { version: '1.1.0', dataVersion: 2 } }])
  await install('echo', { version: '1.0.0', acceptedPermissions: PERMS }, ADMIN, w.deps)
  h.audit = []
})

afterEach(async () => {
  await w.close()
  setNowForTests(null)
  vi.restoreAllMocks()
})

const row = () => db.rows('pluginInstall').find((r) => r.pluginId === 'echo')
const set = (p: Record<string, unknown>) => db.tables.pluginInstall.set('echo', { ...row()!, ...p })
const expired = () => new Date(clock.getTime() - 1000)
const go = () => reconcileNow(w.deps)

/** Puts a version's files where an interrupted operation left them. */
async function placeVersion(version: string, opId = OP) {
  const a = w.archives.get(version)!
  await stageArchive(opId, readArchive(a.bytes, { pluginId: 'echo', maxBytes: 5_000_000 }))
  await commitVersion(opId, 'echo', version)
  return a
}

describe('an interrupted install', () => {
  test('goes back to available, its staging folder removed', async () => {
    set({ status: 'installing', operationId: OP, operationKind: 'install', leaseExpiresAt: expired(), activeVersion: null })
    await stageArchive(OP, readArchive(w.archives.get('1.0.1')!.bytes, { pluginId: 'echo', maxBytes: 5_000_000 }))
    const report = await go()
    expect(row()).toMatchObject({ status: 'available', operationId: null, leaseExpiresAt: null })
    expect(String(row()!.lastError)).toMatch(/^interrupted/)
    expect(await exists(stagingPath(OP))).toBe(false)
    expect(report.recovered).toEqual([{ pluginId: 'echo', from: 'installing', outcome: 'rolled_back' }])
    expect(h.audit.find((e) => e.action === 'plugin.install_failed')).toMatchObject({ actorId: null, source: 'system' })
  })

  test('that was migrating kept data: the copy is deleted, the kept rows stay', async () => {
    set({ status: 'installing', operationId: OP, operationKind: 'install', leaseExpiresAt: expired(), activeVersion: null })
    const data = (namespace: string) => ({ pluginId: 'echo', namespace, ownerType: 'user', ownerId: 'user-a', userId: 'user-a', collection: 'items', key: 'a', value: 1, sizeBytes: 1 })
    db.seed('pluginData', [data('live'), data(`migrating:${OP}`)])
    await go()
    expect(row()).toMatchObject({ status: 'available', operationId: null })
    expect(db.rows('pluginData').map((r) => r.namespace)).toEqual(['live'])
  })

  test('a live lease is left alone', async () => {
    set({ status: 'installing', operationId: OP, operationKind: 'install', leaseExpiresAt: new Date(clock.getTime() + LEASE_MS) })
    await stageArchive(OP, readArchive(w.archives.get('1.0.1')!.bytes, { pluginId: 'echo', maxBytes: 5_000_000 }))
    const before = JSON.stringify(row())
    const report = await go()
    expect(JSON.stringify(row())).toBe(before)
    expect(await exists(stagingPath(OP))).toBe(true)
    expect(report.recovered).toEqual([])
  })
})

describe('an interrupted update', () => {
  const updating = (version: string, extra: Record<string, unknown> = {}) => {
    const a = w.archives.get(version)!
    set({
      status: 'updating', operationId: OP, operationKind: 'update', leaseExpiresAt: expired(), pendingVersion: version,
      operationArgs: { version, from: '1.0.0', fromDataVersion: 1, by: ADMIN, release: { ...a.release } },
      ...extra,
    })
  }

  test('whose new version never reached the volume is rolled back', async () => {
    updating('1.0.1')
    db.seed('pluginData', [
      { pluginId: 'echo', namespace: `migrating:${OP}`, ownerType: 'user', ownerId: 'user-a', userId: 'user-a', collection: 'items', key: 'a', value: 1, sizeBytes: 1 },
    ])
    const report = await go()
    expect(row()).toMatchObject({ status: 'ready', activeVersion: '1.0.0', pendingVersion: null, operationId: null })
    expect(String(row()!.lastError)).toMatch(/^interrupted/)
    expect(db.rows('pluginData').filter((r) => String(r.namespace).startsWith('migrating:'))).toEqual([])
    expect(report.recovered).toEqual([{ pluginId: 'echo', from: 'updating', outcome: 'rolled_back' }])
  })

  test('whose new version is on the volume and moves no data is finished', async () => {
    await placeVersion('1.0.1')
    updating('1.0.1')
    const report = await go()
    expect(row()).toMatchObject({ status: 'ready', activeVersion: '1.0.1', previousVersion: '1.0.0', pendingVersion: null, operationId: null })
    expect((row()!.manifest as { version: string }).version).toBe('1.0.1')
    expect(row()!.catalogEntry).toMatchObject({ version: '1.0.1', previous: { version: '1.0.0' } })
    expect(report.recovered).toEqual([{ pluginId: 'echo', from: 'updating', outcome: 'finished' }])
    expect(w.runner.options.workers?.map((x) => x.version)).toEqual(['1.0.1'])
  })

  test('finished away from a revoked version: the new one runs, unrevoked', async () => {
    await placeVersion('1.0.1')
    updating('1.0.1', { revokedReason: 'Sends transcripts out.' })
    // Without a catalog the revocation step changes nothing: only the recovery can clear it.
    w.catalog.unavailable = new Error('offline')
    await go()
    expect(row()).toMatchObject({ status: 'ready', activeVersion: '1.0.1', revokedReason: null })
  })

  test('whose new version would migrate kept data is rolled back, its folder removed', async () => {
    db.seed('pluginData', [
      { pluginId: 'echo', ownerType: 'user', ownerId: 'user-a', userId: 'user-a', collection: 'items', key: 'a', value: 1, sizeBytes: 1 },
    ])
    await placeVersion('1.1.0')
    updating('1.1.0')
    clock = new Date(clock.getTime() + 16 * 60_000)
    set({ leaseExpiresAt: expired() })
    await go()
    expect(row()).toMatchObject({ status: 'ready', activeVersion: '1.0.0', dataVersion: 1, pendingVersion: null })
    expect(await exists(versionPath('echo', '1.1.0'))).toBe(false)
    expect(db.rows('pluginData').map((r) => r.value)).toEqual([1])
  })

  test('an interrupted rollback that moves no data is finished', async () => {
    await placeVersion('1.0.1')
    set({ activeVersion: '1.0.1', previousVersion: '1.0.0', manifest: { ...(row()!.manifest as object), version: '1.0.1' } })
    set({ status: 'updating', operationId: OP, operationKind: 'rollback', leaseExpiresAt: expired(), pendingVersion: '1.0.0',
      operationArgs: { to: '1.0.0', from: '1.0.1', by: ADMIN } })
    const report = await go()
    expect(row()).toMatchObject({ status: 'ready', activeVersion: '1.0.0', previousVersion: '1.0.1' })
    expect(report.recovered[0]).toMatchObject({ outcome: 'finished' })
  })
})

describe('an interrupted uninstall', () => {
  test('keep: finished, the code gone, the row available', async () => {
    set({ status: 'uninstalling', operationId: OP, operationKind: 'uninstall', leaseExpiresAt: expired(), operationArgs: { mode: 'keep' } })
    const report = await go()
    expect(row()).toMatchObject({ status: 'available', enabled: false, activeVersion: null, operationId: null })
    expect(await exists(path.join(w.root, 'echo'))).toBe(false)
    expect(report.recovered).toEqual([{ pluginId: 'echo', from: 'uninstalling', outcome: 'finished' }])
  })

  test('purge, recorded in its arguments: the rows deleted and the model choice stripped', async () => {
    db.seed('pluginData', [
      { pluginId: 'echo', ownerType: 'user', ownerId: 'user-a', userId: 'user-a', collection: 'items', key: 'a', value: 1, sizeBytes: 1 },
    ])
    set({ status: 'uninstalling', operationId: OP, operationKind: 'uninstall', leaseExpiresAt: expired(), operationArgs: { mode: 'purge' } })
    await go()
    expect(row()).toBeUndefined()
    expect(db.rows('pluginData')).toEqual([])
    expect(db.rows('userSettings')[0].featureModels).toEqual({ other: 'n' })
    expect(h.audit.find((e) => e.action === 'plugin.purge')).toMatchObject({ source: 'system' })
    await expect(fs.stat(path.join(w.root, 'echo'))).rejects.toThrow()
  })
})
