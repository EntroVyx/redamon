/**
 * The installed plugins' state (README.PLUGINS.md §9.7): a lost version folder heals from
 * the pinned catalog entry (at most one download per call) or the plugin becomes `failed`
 * with the reason; a platform outside the plugin's range makes it `incompatible`, and back
 * in range `ready`; a failed plugin is retried (the runner said why); the runner is told
 * when the run list changed.
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
import { setNowForTests } from './clock'
import { install } from './lifecycle'
import { reconcile } from './reconcile'

/** A run that was not refused as busy (no other reconcile runs in these tests). */
async function reconcileNow(deps: Parameters<typeof reconcile>[0]) {
  const r = await reconcile(deps)
  if ('skipped' in r) throw new Error('reconcile was busy')
  return r
}
import { removePluginFolder, removeVersion, versionPath } from './staging'

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
  vi.restoreAllMocks()
})

const row = (id = 'echo') => db.rows('pluginInstall').find((r) => r.pluginId === id)!
const set = (p: Record<string, unknown>, id = 'echo') => db.tables.pluginInstall.set(id, { ...row(id), ...p })

describe('a lost version folder', () => {
  test('heals from the pinned catalog entry, checked like an install', async () => {
    await removePluginFolder('echo')
    const downloads = w.downloads.length
    const report = await reconcileNow(w.deps)
    expect(await exists(path.join(versionPath('echo', '1.0.0'), 'engine', 'main.py'))).toBe(true)
    expect(w.downloads.slice(downloads)).toEqual([w.archives.get('1.0.0')!.release.url])
    expect(row()).toMatchObject({ status: 'ready', operationId: null })
    expect(report.healed).toEqual(['echo'])
  })

  test('a download that fails, or bytes that do not match the pin, end failed with the reason', async () => {
    await removeVersion('echo', '1.0.0')
    w.deps.fetchArchive = async () => Buffer.from('not the archive')
    const report = await reconcileNow(w.deps)
    expect(row()).toMatchObject({ status: 'failed', operationId: null })
    expect(String(row().lastError)).toMatch(/^heal_failed: sha256_mismatch/)
    expect(report.healed).toEqual([])
    w.deps.fetchArchive = async () => {
      throw new Error('offline')
    }
    await reconcileNow(w.deps)
    expect(String(row().lastError)).toMatch(/^heal_failed: download_failed/)
  })

  test('at most one heal download per call: the next plugin waits for the next tick', async () => {
    db.tables.pluginInstall.set('other', { ...row(), pluginId: 'other' })
    await removePluginFolder('echo')
    const first = await reconcileNow(w.deps)
    expect(first.healed).toHaveLength(1)
    expect(first.deferred).toEqual(['other'])
  })

  test('a row without a pinned entry cannot heal and ends failed', async () => {
    set({ catalogEntry: null })
    await removePluginFolder('echo')
    await reconcileNow(w.deps)
    expect(String(row().lastError)).toMatch(/^heal_failed: no_catalog_entry/)
  })
})

describe('the platform range', () => {
  test('out of range → incompatible; back in range → ready', async () => {
    const manifest = row().manifest as Record<string, unknown>
    set({ manifest: { ...manifest, platform: '>=2.0.0 <3.0.0' } })
    let report = await reconcileNow(w.deps)
    expect(row().status).toBe('incompatible')
    expect(report.statusChanges).toEqual([{ pluginId: 'echo', from: 'ready', to: 'incompatible' }])
    expect(w.runner.options.workers).toEqual([])
    set({ manifest })
    report = await reconcileNow(w.deps)
    expect(row().status).toBe('ready')
    expect(w.runner.options.workers?.map((x) => x.id)).toEqual(['echo'])
  })

  test('a failed plugin out of range becomes incompatible, with no error', async () => {
    set({ status: 'failed', lastError: 'worker_failed: x', manifest: { ...(row().manifest as object), platform: '>=2.0.0' } })
    const report = await reconcileNow(w.deps)
    expect(row().status).toBe('incompatible')
    expect(report.errors).toEqual([])
  })

  test.each([
    ['disabled', { enabled: false }, []],
    ['revoked', {}, [{ id: 'echo', version: '1.0.0', reason: 'x' }]],
  ])('a %s plugin back in range is ready, not retried into failed', async (_kind, extra, revoked) => {
    w.catalog.revoked = revoked
    set({ status: 'incompatible', ...extra })
    const report = await reconcileNow(w.deps)
    expect(row().status).toBe('ready')
    expect(report.statusChanges.filter((c) => c.to === 'failed')).toEqual([])
  })

  test('a platform update the range does not cover makes even a disabled plugin incompatible', async () => {
    set({ enabled: false, manifest: { ...(row().manifest as object), platform: '>=1.5.0' } })
    await reconcileNow(w.deps)
    expect(row()).toMatchObject({ status: 'incompatible', enabled: false })
  })
})

describe('a failed plugin', () => {
  test('is retried: ready when its worker starts now', async () => {
    set({ status: 'failed', lastError: 'runner_unavailable' })
    const report = await reconcileNow(w.deps)
    expect(row()).toMatchObject({ status: 'ready', lastError: null })
    expect(report.statusChanges).toContainEqual({ pluginId: 'echo', from: 'failed', to: 'ready' })
  })

  test('stays failed, with the runner reason, when it still does not start', async () => {
    set({ status: 'failed', lastError: 'runner_unavailable' })
    w.failing.add('echo@1.0.0')
    await reconcileNow(w.deps)
    expect(row().status).toBe('failed')
    expect(String(row().lastError)).toMatch(/^worker_failed/)
  })

  test('a disabled failed plugin is left alone', async () => {
    set({ status: 'failed', enabled: false, lastError: 'worker_failed: x' })
    await reconcileNow(w.deps)
    expect(row().status).toBe('failed')
  })
})

describe('nothing to do', () => {
  test('a healthy instance changes nothing and does not reload the runner', async () => {
    const before = JSON.stringify(db.rows('pluginInstall'))
    const reloads = w.runner.reloads
    const report = await reconcileNow(w.deps)
    expect(JSON.stringify(db.rows('pluginInstall'))).toBe(before)
    expect(w.runner.reloads).toBe(reloads)
    expect(report.runnerReloaded).toBe(false)
    expect(await fs.readdir(path.join(w.root, 'echo', 'versions'))).toEqual(['1.0.0'])
  })
})
