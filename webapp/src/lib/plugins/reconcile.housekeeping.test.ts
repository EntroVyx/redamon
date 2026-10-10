/**
 * Clean-up (README.PLUGINS.md §9.7): a version folder no row references (active, previous
 * or pending) and a staging folder no live lease holds are removed, but never one younger
 * than 15 minutes (a racing install may not have written its row yet; X4). Expired data
 * rows are deleted in batches; a job past its deadline is failed with `timeout`.
 *
 * @vitest-environment node
 */
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'

const h = vi.hoisted(() => ({ db: null as unknown as Record<string, unknown>, audit: [] as Record<string, unknown>[] }))
vi.mock('@/lib/prisma', () => ({ default: new Proxy({}, { get: (_t, k) => h.db[k as string] }) }))
vi.mock('@/lib/audit', () => ({ writeAudit: vi.fn(async (e: Record<string, unknown>) => void h.audit.push(e)) }))

import { createFakePrisma, type FakePrisma, type Row } from './__testing__/fakePrisma'
import { ADMIN, NOW, exists, startLifecycleWorld, type LifecycleWorld } from './__testing__/lifecycleHarness'
import { readArchive } from './archive'
import { setNowForTests } from './clock'
import { install } from './lifecycle'
import { FOLDER_GRACE_MS, reconcile } from './reconcile'

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
const PERMS = ['session:read', 'llm:invoke', 'override:skill.text']
const OP1 = '0f8b6c1e-2a3d-4e5f-8a9b-0c1d2e3f4a5b'
const OP2 = '1f8b6c1e-2a3d-4e5f-8a9b-0c1d2e3f4a5b'

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
  w = await startLifecycleWorld(() => db, [{}, { manifest: { version: '1.0.1' } }])
  await install('echo', { version: '1.0.0', acceptedPermissions: PERMS }, ADMIN, w.deps)
})

afterEach(async () => {
  await w.close()
  setNowForTests(null)
  vi.restoreAllMocks()
})

const archive = (v = '1.0.1') => readArchive(w.archives.get(v)!.bytes, { pluginId: 'echo', maxBytes: 5_000_000 })
/** Ages a path on the real file system: folder ages are read from the volume. */
async function age(p: string, ms: number) {
  const t = new Date(Date.now() - ms)
  await fs.utimes(p, t, t)
}

describe('folders', () => {
  test('an unreferenced version folder older than 15 minutes is removed; the active one stays', async () => {
    await stageArchive(OP1, archive())
    await commitVersion(OP1, 'echo', '1.0.1')
    await age(versionPath('echo', '1.0.1'), FOLDER_GRACE_MS + 60_000)
    const report = await reconcileNow(w.deps)
    expect(await exists(versionPath('echo', '1.0.1'))).toBe(false)
    expect(await exists(versionPath('echo', '1.0.0'))).toBe(true)
    expect(report.foldersRemoved).toEqual(['echo/versions/1.0.1'])
  })

  test('a young unreferenced folder survives (an install in progress may not have written its row)', async () => {
    await stageArchive(OP1, archive())
    await commitVersion(OP1, 'echo', '1.0.1')
    await reconcileNow(w.deps)
    expect(await exists(versionPath('echo', '1.0.1'))).toBe(true)
  })

  test('previous and pending versions are referenced', async () => {
    await stageArchive(OP1, archive())
    await commitVersion(OP1, 'echo', '1.0.1')
    await age(versionPath('echo', '1.0.1'), FOLDER_GRACE_MS + 60_000)
    db.tables.pluginInstall.set('echo', { ...db.tables.pluginInstall.get('echo')!, previousVersion: '1.0.1' })
    await reconcileNow(w.deps)
    expect(await exists(versionPath('echo', '1.0.1'))).toBe(true)
  })

  test('the folder of a plugin no row knows is removed once old enough', async () => {
    await stageArchive(OP1, readArchive(w.archives.get('1.0.0')!.bytes, { pluginId: 'echo', maxBytes: 5_000_000 }))
    await fs.rename(stagingPath(OP1), path.join(w.root, 'echo', 'versions', '0.9.0'))
    db.tables.pluginInstall.delete('echo')
    await age(path.join(w.root, 'echo', 'versions', '0.9.0'), FOLDER_GRACE_MS + 60_000)
    await age(versionPath('echo', '1.0.0'), FOLDER_GRACE_MS + 60_000)
    await reconcileNow(w.deps)
    expect(await exists(path.join(w.root, 'echo'))).toBe(false)
  })

  test('staging of a live lease stays; an old orphan staging folder goes', async () => {
    await stageArchive(OP1, archive())
    await stageArchive(OP2, archive())
    await age(stagingPath(OP1), FOLDER_GRACE_MS + 60_000)
    await age(stagingPath(OP2), FOLDER_GRACE_MS + 60_000)
    db.tables.pluginInstall.set('other', {
      ...db.tables.pluginInstall.get('echo')!, pluginId: 'other', status: 'installing', operationId: OP2, operationKind: 'install',
      leaseExpiresAt: new Date(clock.getTime() + 60_000), activeVersion: null,
    })
    const report = await reconcileNow(w.deps)
    expect(await exists(stagingPath(OP1))).toBe(false)
    expect(await exists(stagingPath(OP2))).toBe(true)
    expect(report.stagingRemoved).toEqual([OP1])
  })
})

describe('data rows and jobs', () => {
  const dataRow = (key: string, extra: Row = {}): Row => ({
    pluginId: 'echo', ownerType: 'user', ownerId: 'user-a', userId: 'user-a', collection: 'items', key, value: 1, sizeBytes: 1, ...extra,
  })

  test('expired rows are deleted (in batches); live ones stay', async () => {
    const rows: Row[] = []
    for (let i = 0; i < 1500; i++) rows.push(dataRow(`old${i}`, { expiresAt: new Date(clock.getTime() - 1000) }))
    rows.push(dataRow('keep', { expiresAt: new Date(clock.getTime() + 60_000) }), dataRow('forever'))
    db.seed('pluginData', rows)
    const report = await reconcileNow(w.deps)
    expect(db.rows('pluginData').map((r) => r.key).sort()).toEqual(['forever', 'keep'])
    expect(report.expiredRows).toBe(1500)
  }, 60_000)

  test('a running job past its deadline is failed with timeout; others are left alone', async () => {
    const job = (key: string, status: string, deadline: Date): Row => dataRow(key, {
      collection: '__jobs',
      value: {
        status, actionId: 'sleep', context: { projectId: null, sessionId: null, conversationId: null }, progress: null, result: null,
        error: null, deadline: deadline.toISOString(), bootId: null, createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(),
      },
    })
    db.seed('pluginData', [
      job('aaaaaaaa-0000-4000-8000-000000000001', 'running', new Date(clock.getTime() - 1000)),
      job('aaaaaaaa-0000-4000-8000-000000000002', 'queued', new Date(clock.getTime() - 1000)),
      job('aaaaaaaa-0000-4000-8000-000000000003', 'running', new Date(clock.getTime() + 60_000)),
      job('aaaaaaaa-0000-4000-8000-000000000004', 'succeeded', new Date(clock.getTime() - 1000)),
    ])
    const report = await reconcileNow(w.deps)
    const status = Object.fromEntries(db.rows('pluginData').map((r) => [String(r.key).slice(-1), (r.value as { status: string; error: { code: string } | null })]))
    expect(status['1']).toMatchObject({ status: 'failed', error: { code: 'timeout' } })
    expect(status['2']).toMatchObject({ status: 'failed', error: { code: 'timeout' } })
    expect(status['3'].status).toBe('running')
    expect(status['4'].status).toBe('succeeded')
    expect(report.overdueJobs).toBe(2)
  })
})
