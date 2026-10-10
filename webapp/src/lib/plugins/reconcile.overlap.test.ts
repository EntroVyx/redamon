/**
 * One reconcile at a time (RV-16, X4): a client timeout does not cancel a Next.js handler,
 * so the orchestrator's tick, the runner's start and any key holder could otherwise run
 * reconciles that overlap. A platform-wide lease (compare-and-set, renewed between operations) lets one run and
 * answers the others `skipped: 'busy'`; an expired lease is taken over; a reconcile never
 * removes the files of an install in progress.
 *
 * @vitest-environment node
 */
import { test, expect, beforeEach, afterEach, vi } from 'vitest'

const h = vi.hoisted(() => ({ db: null as unknown as Record<string, unknown>, audit: [] as Record<string, unknown>[] }))
vi.mock('@/lib/prisma', () => ({ default: new Proxy({}, { get: (_t, k) => h.db[k as string] }) }))
vi.mock('@/lib/audit', () => ({ writeAudit: vi.fn(async (e: Record<string, unknown>) => void h.audit.push(e)) }))

import { createFakePrisma, type FakePrisma } from './__testing__/fakePrisma'
import { ADMIN, NOW, exists, startLifecycleWorld, type LifecycleWorld } from './__testing__/lifecycleHarness'
import { setNowForTests } from './clock'
import fs from 'node:fs/promises'
import { install, uninstall } from './lifecycle'
import { RECONCILE_LEASE_KEY, RECONCILE_LEASE_MS, reconcile } from './reconcile'
import { removeVersion, stagingPath, versionPath } from './staging'

let db: FakePrisma
let w: LifecycleWorld
let clock: Date
const PERMS = ['session:read', 'llm:invoke', 'override:skill.text']

beforeEach(async () => {
  db = createFakePrisma()
  h.db = db as unknown as Record<string, unknown>
  h.audit = []
  clock = NOW
  setNowForTests(() => clock)
  for (const m of ['warn', 'error', 'log'] as const) vi.spyOn(console, m).mockImplementation(() => {})
  db.seed('user', [{ id: ADMIN, email: 'admin@example.com', role: 'admin' }])
  w = await startLifecycleWorld(() => db, [{}, { manifest: { version: '1.0.1' } }, { manifest: { version: '1.1.0', dataVersion: 2 } }])
})

afterEach(async () => {
  await w.close()
  setNowForTests(null)
  vi.restoreAllMocks()
})

const lease = () => db.rows('pluginPlatformState').find((r) => r.key === RECONCILE_LEASE_KEY)

test('two reconciles at once: one runs, the other answers busy', async () => {
  let release!: () => void
  const gate = new Promise<void>((r) => (release = r))
  const slow = { ...w.deps, loadCatalog: async () => (await gate, w.deps.loadCatalog!()) }
  const first = reconcile(slow)
  await new Promise((r) => setTimeout(r, 20))
  const second = await reconcile(w.deps)
  expect(second).toEqual({ skipped: 'busy' })
  release()
  const done = await first
  expect('skipped' in done).toBe(false)
  expect(lease()).toBeUndefined()
})

test('the lease is released at the end, also after a failure', async () => {
  await reconcile(w.deps)
  expect(lease()).toBeUndefined()
  // A failure the run does not absorb (it does absorb a catalog failure): the database read fails.
  const find = db.pluginInstall.findMany
  db.pluginInstall.findMany = (async () => {
    throw new Error('boom')
  }) as unknown as typeof find
  await expect(reconcile(w.deps)).rejects.toThrow('boom')
  db.pluginInstall.findMany = find
  expect(lease()).toBeUndefined()
})

test('an expired lease (a crashed reconcile) is taken over; a live one is respected', async () => {
  db.seed('pluginPlatformState', [{ key: RECONCILE_LEASE_KEY, value: { holder: 'gone', until: new Date(clock.getTime() + 1000).toISOString() } }])
  expect(await reconcile(w.deps)).toEqual({ skipped: 'busy' })
  clock = new Date(clock.getTime() + RECONCILE_LEASE_MS)
  const out = await reconcile(w.deps)
  expect('skipped' in out).toBe(false)
})

test('an install still downloading keeps its row and lease through a reconcile', async () => {
  let release!: () => void
  const gate = new Promise<void>((r) => (release = r))
  const realFetch = w.deps.fetchArchive!
  const slowDeps = { ...w.deps, fetchArchive: async (u: string) => { const b = await realFetch(u); await gate; return b } }
  const installing = install('echo', { version: '1.0.0', acceptedPermissions: PERMS }, ADMIN, slowDeps)
  await new Promise((r) => setTimeout(r, 20))
  const op = String(db.rows('pluginInstall')[0].operationId)
  await reconcile(w.deps)
  expect(db.rows('pluginInstall')[0]).toMatchObject({ status: 'installing', operationId: op })
  release()
  const out = await installing
  expect(out.plugin.status).toBe('ready')
  expect(await exists(versionPath('echo', '1.0.0'))).toBe(true)
  expect(await exists(stagingPath(op))).toBe(false)
})

test('an install migrating kept data keeps its new version folder through a reconcile, past the grace', async () => {
  // Data kept at version 1: installing 1.1.0 migrates it before committing, its folder already in versions/.
  await install('echo', { version: '1.0.0', acceptedPermissions: PERMS }, ADMIN, w.deps)
  db.seed('pluginData', [{ pluginId: 'echo', ownerType: 'user', ownerId: ADMIN, userId: ADMIN, collection: 'items', key: 'a', value: 1, sizeBytes: 1 }])
  await uninstall('echo', { mode: 'keep', confirm: 'echo' }, ADMIN)
  let release!: () => void
  const gate = new Promise<void>((r) => (release = r))
  let paused!: () => void
  const atMigration = new Promise<void>((r) => (paused = r))
  w.runner.options.migrateHook = async () => {
    paused()
    await gate
    return undefined
  }
  const installing = install('echo', { version: '1.1.0', acceptedPermissions: PERMS }, ADMIN, w.deps)
  await atMigration
  const hourAgo = new Date(Date.now() - 60 * 60_000)
  await fs.utimes(versionPath('echo', '1.1.0'), hourAgo, hourAgo)
  await reconcile(w.deps)
  expect(await exists(versionPath('echo', '1.1.0'))).toBe(true)
  release()
  expect((await installing).plugin).toMatchObject({ status: 'ready', activeVersion: '1.1.0', dataVersion: 2 })
})

test('a run longer than one lease keeps it: renewed before each operation', async () => {
  await install('echo', { version: '1.0.0', acceptedPermissions: PERMS }, ADMIN, w.deps)
  await removeVersion('echo', '1.0.0')
  let until: string | null = null
  const slow = {
    ...w.deps,
    // The catalog takes longer than a whole lease; then step 3 heals with a download.
    loadCatalog: async () => {
      clock = new Date(clock.getTime() + RECONCILE_LEASE_MS + 60_000)
      return w.deps.loadCatalog!()
    },
    fetchArchive: async (u: string) => {
      until = (lease()?.value as { until: string } | undefined)?.until ?? null
      return w.deps.fetchArchive!(u)
    },
  }
  await reconcile(slow)
  expect(until).not.toBeNull()
  expect(new Date(until!).getTime()).toBeGreaterThan(clock.getTime())
})
