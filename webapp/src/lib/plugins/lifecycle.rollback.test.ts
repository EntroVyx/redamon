/**
 * Rollback (README.PLUGINS.md §9.5): the previous version becomes active again. With no
 * data migration it is immediate; data migrated forward is first taken back by the newer
 * version's down migrations, copy and swap; with no down migration the rollback is refused
 * (old code never runs on newer data), and the details say so before an update.
 *
 * @vitest-environment node
 */
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'

const h = vi.hoisted(() => ({ db: null as unknown as Record<string, unknown>, audit: [] as Record<string, unknown>[] }))
vi.mock('@/lib/prisma', () => ({ default: new Proxy({}, { get: (_t, k) => h.db[k as string] }) }))
vi.mock('@/lib/audit', () => ({ writeAudit: vi.fn(async (e: Record<string, unknown>) => void h.audit.push(e)) }))

import { createFakePrisma, type FakePrisma } from './__testing__/fakePrisma'
import { ADMIN, NOW, startLifecycleWorld, type LifecycleWorld } from './__testing__/lifecycleHarness'
import { setNowForTests } from './clock'
import { LifecycleError, install, rollback, rollbackCheck, update } from './lifecycle'
import { removeVersion } from './staging'

let db: FakePrisma
let w: LifecycleWorld
const PERMS = ['session:read', 'llm:invoke', 'override:skill.text']

beforeEach(async () => {
  db = createFakePrisma()
  h.db = db as unknown as Record<string, unknown>
  h.audit = []
  setNowForTests(() => NOW)
  for (const m of ['warn', 'error', 'log'] as const) vi.spyOn(console, m).mockImplementation(() => {})
  db.seed('user', [
    { id: ADMIN, email: 'admin@example.com', role: 'admin' },
    { id: 'user-a', email: 'a@example.com', role: 'standard' },
  ])
  w = await startLifecycleWorld(() => db, [
    {},
    { manifest: { version: '1.0.1' } },
    { manifest: { version: '1.1.0', dataVersion: 2 } },
    { manifest: { version: '1.2.0', dataVersion: 3 } },
  ])
  await install('echo', { version: '1.0.0', acceptedPermissions: PERMS }, ADMIN, w.deps)
  h.audit = []
})

afterEach(async () => {
  await w.close()
  setNowForTests(null)
  vi.restoreAllMocks()
})

const row = () => db.rows('pluginInstall').find((r) => r.pluginId === 'echo')!
const up = (version: string) => update('echo', { version, acceptedPermissions: PERMS }, ADMIN, w.deps)
const data = () => db.rows('pluginData').filter((r) => r.namespace === 'live').map((r) => [r.key, r.value]).sort()

function seed() {
  db.seed('pluginData', [
    { pluginId: 'echo', ownerType: 'user', ownerId: 'user-a', userId: 'user-a', collection: 'items', key: 'a', value: { n: 1 }, sizeBytes: 7 },
    { pluginId: 'echo', ownerType: 'user', ownerId: 'user-a', userId: 'user-a', collection: 'items', key: 'b', value: 'two', sizeBytes: 5 },
  ])
}

async function refusal(p: Promise<unknown>): Promise<LifecycleError> {
  const e = await p.then(
    () => {
      throw new Error('expected a refusal')
    },
    (err) => err,
  )
  expect(e).toBeInstanceOf(LifecycleError)
  return e as LifecycleError
}

describe('rollback', () => {
  test('with no data migration: immediate, the previous version and its manifest active again', async () => {
    await up('1.0.1')
    const out = await rollback('echo', ADMIN, w.deps)
    expect(out.plugin).toMatchObject({ status: 'ready', activeVersion: '1.0.0', previousVersion: '1.0.1', dataVersion: 1 })
    expect((row().manifest as { version: string }).version).toBe('1.0.0')
    expect(row().catalogEntry).toMatchObject({ version: '1.0.0', previous: { version: '1.0.1' } })
    expect(w.runner.options.workers?.map((x) => x.version)).toEqual(['1.0.0'])
    expect(w.runner.migrateCalls).toEqual([])
    const a = h.audit.find((e) => e.action === 'plugin.rollback')!
    expect(a.before).toMatchObject({ activeVersion: '1.0.1' })
    expect(a.after).toMatchObject({ activeVersion: '1.0.0' })
  })

  test('away from a revoked version: the previous one runs, unrevoked', async () => {
    await up('1.0.1')
    db.tables.pluginInstall.set('echo', { ...row(), revokedReason: 'Sends transcripts out.' })
    const out = await rollback('echo', ADMIN, w.deps)
    expect(out.plugin).toMatchObject({ status: 'ready', activeVersion: '1.0.0', revokedReason: null })
    expect(w.runner.options.workers?.map((x) => x.version)).toEqual(['1.0.0'])
  })

  test('data migrated forward is taken back by the down migration first', async () => {
    seed()
    const original = data()
    await up('1.1.0')
    expect(data()).toEqual([['a', { v: 2, data: { n: 1 } }], ['b', { v: 2, data: 'two' }]])
    const out = await rollback('echo', ADMIN, w.deps)
    expect(out.plugin).toMatchObject({ activeVersion: '1.0.0', dataVersion: 1 })
    expect(data()).toEqual(original)
    const call = w.runner.migrateCalls.at(-1)!
    expect(call.body).toMatchObject({ version: '1.1.0', step: 2, direction: 'down' })
  })

  test('no down migration: refused before anything changes', async () => {
    seed()
    await up('1.1.0')
    await up('1.2.0')
    const before = JSON.stringify([row(), data()])
    const e = await refusal(rollback('echo', ADMIN, w.deps))
    expect([e.status, e.code]).toEqual([409, 'no_down_migration'])
    expect(e.message).toMatch(/0003_down/)
    expect(JSON.stringify([row(), data()])).toBe(before)
  })

  test('rollbackCheck tells the page beforehand', async () => {
    expect(await rollbackCheck('echo')).toEqual({ possible: false, reason: 'no_previous_version' })
    seed()
    await up('1.1.0')
    expect(await rollbackCheck('echo')).toEqual({ possible: true, migrates: true })
    await up('1.2.0')
    expect(await rollbackCheck('echo')).toEqual({ possible: false, reason: 'no_down_migration', missing: ['migrations/0003_down.py'] })
  })

  test('newer data with no data rows left rolls back without a migration', async () => {
    await up('1.1.0')
    const out = await rollback('echo', ADMIN, w.deps)
    expect(out.plugin).toMatchObject({ activeVersion: '1.0.0', dataVersion: 1 })
    expect(w.runner.migrateCalls).toEqual([])
  })

  test('no previous version, or its folder gone → 409', async () => {
    expect((await refusal(rollback('echo', ADMIN, w.deps))).code).toBe('no_previous_version')
    await up('1.0.1')
    await removeVersion('echo', '1.0.0')
    expect((await refusal(rollback('echo', ADMIN, w.deps))).code).toBe('no_previous_version')
  })

  test('a failing down migration keeps the newer version and its data', async () => {
    seed()
    await up('1.1.0')
    const migrated = data()
    w.runner.options.migrateHook = () => ({ status: 422, body: { error: 'migrate_row raised KeyError on row x.', code: 'migration_failed' } })
    const e = await refusal(rollback('echo', ADMIN, w.deps))
    expect(e.code).toBe('migration_failed')
    expect(row()).toMatchObject({ activeVersion: '1.1.0', dataVersion: 2, status: 'ready', operationId: null })
    expect(data()).toEqual(migrated)
  })
})
