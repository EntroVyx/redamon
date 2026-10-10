/**
 * An update that moves the data (README.PLUGINS.md §9.5, TD-28): every row of the copy, for
 * every user and project, goes through the new version's `migrate_row` in batches; the
 * swap and the switch to the new version are one transaction; any failure discards the
 * copy and leaves the old version and the old data exactly as they were. Platform rows
 * (jobs, LLM counters) are never migrated, and no call token goes anywhere.
 *
 * @vitest-environment node
 */
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'

const h = vi.hoisted(() => ({ db: null as unknown as Record<string, unknown>, audit: [] as Record<string, unknown>[] }))
vi.mock('@/lib/prisma', () => ({ default: new Proxy({}, { get: (_t, k) => h.db[k as string] }) }))
vi.mock('@/lib/audit', () => ({ writeAudit: vi.fn(async (e: Record<string, unknown>) => void h.audit.push(e)) }))

import { createFakePrisma, type FakePrisma, type Row } from './__testing__/fakePrisma'
import { ADMIN, NOW, exists, startLifecycleWorld, type LifecycleWorld } from './__testing__/lifecycleHarness'
import { setNowForTests } from './clock'
import { LifecycleError, install, update } from './lifecycle'
import { MIGRATION_BATCH_ROWS } from './migrations'
import { versionPath } from './staging'

let db: FakePrisma
let w: LifecycleWorld
const PERMS = ['session:read', 'llm:invoke', 'override:skill.text']
const USERS = ['user-a', 'user-b', 'user-c']
const PROJECTS = ['project-1', 'project-2']

beforeEach(async () => {
  db = createFakePrisma()
  h.db = db as unknown as Record<string, unknown>
  h.audit = []
  setNowForTests(() => NOW)
  for (const m of ['warn', 'error', 'log'] as const) vi.spyOn(console, m).mockImplementation(() => {})
  db.seed('user', [{ id: ADMIN, email: 'admin@example.com', role: 'admin' }, ...USERS.map((id) => ({ id, email: `${id}@example.com` }))])
  db.seed('project', PROJECTS.map((id) => ({ id, userId: 'user-a', name: id })))
  w = await startLifecycleWorld(() => db, [{}, { manifest: { version: '1.1.0', dataVersion: 2 } }])
  await install('echo', { version: '1.0.0', acceptedPermissions: PERMS }, ADMIN, w.deps)
  h.audit = []
})

afterEach(async () => {
  await w.close()
  setNowForTests(null)
  vi.restoreAllMocks()
})

const row = () => db.rows('pluginInstall').find((r) => r.pluginId === 'echo')!
const go = () => update('echo', { version: '1.1.0', acceptedPermissions: PERMS }, ADMIN, w.deps)

function seedData(perOwner: number, value: (owner: string, i: number) => unknown = (o, i) => ({ owner: o, i })) {
  const rows: Row[] = []
  for (const u of USERS) for (let i = 0; i < perOwner; i++) {
    rows.push({ pluginId: 'echo', ownerType: 'user', ownerId: u, userId: u, collection: 'items', key: `k${i}`, value: value(u, i), sizeBytes: 20 })
  }
  for (const p of PROJECTS) for (let i = 0; i < perOwner; i++) {
    rows.push({ pluginId: 'echo', ownerType: 'project', ownerId: p, projectId: p, collection: 'items', key: `k${i}`, value: value(p, i), sizeBytes: 20 })
  }
  db.seed('pluginData', rows)
}

const live = () => db.rows('pluginData').filter((r) => r.namespace === 'live' && !String(r.collection).startsWith('__'))
const copies = () => db.rows('pluginData').filter((r) => String(r.namespace).startsWith('migrating:'))

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

describe('a migration that succeeds', () => {
  test('3 users and 2 projects with 250 rows each: every row migrated, in batches of at most 200', async () => {
    seedData(250)
    const out = await go()
    expect(out.plugin).toMatchObject({ status: 'ready', activeVersion: '1.1.0', previousVersion: '1.0.0', dataVersion: 2 })
    expect(row().previousDataVersion).toBe(1)
    const rows = live()
    expect(rows).toHaveLength(1250)
    for (const r of rows) {
      expect(r.value).toEqual({ v: 2, data: { owner: r.ownerId, i: Number(String(r.key).slice(1)) } })
    }
    const calls = w.runner.migrateCalls
    expect(calls.length).toBeGreaterThanOrEqual(Math.ceil(1250 / MIGRATION_BATCH_ROWS))
    for (const c of calls) {
      expect((c.body.rows as unknown[]).length).toBeLessThanOrEqual(MIGRATION_BATCH_ROWS)
      expect(c.body).toMatchObject({ version: '1.1.0', step: 2, direction: 'up' })
    }
    const sent = new Set(calls.flatMap((c) => (c.body.rows as { id: string }[]).map((r) => r.id)))
    expect(sent.size).toBe(1250)
    expect(copies()).toEqual([])
    expect(h.audit.find((e) => e.action === 'plugin.update')!.after).toMatchObject({ migration: { steps: 1, rows: 1250 } })
    // The in-memory double scans every row per write: seconds here, milliseconds on Postgres.
  }, 60_000)

  test('DELETE removes a row', async () => {
    seedData(2, (o, i) => (o === 'user-b' && i === 1 ? { delete: true } : i))
    await go()
    expect(live()).toHaveLength(9)
    expect(live().find((r) => r.ownerId === 'user-b' && r.key === 'k1')).toBeUndefined()
  })

  test('platform rows are untouched and never sent to the plugin', async () => {
    seedData(1)
    db.seed('pluginData', [
      { pluginId: 'echo', ownerType: 'user', ownerId: 'user-a', userId: 'user-a', collection: '__jobs', key: 'j1', value: { status: 'succeeded' }, sizeBytes: 22 },
      { pluginId: 'echo', ownerType: 'user', ownerId: 'user-a', userId: 'user-a', collection: '__usage', key: 'd', value: { calls: 3 }, sizeBytes: 11 },
    ])
    const before = db.rows('pluginData').filter((r) => String(r.collection).startsWith('__'))
    await go()
    const after = db.rows('pluginData').filter((r) => String(r.collection).startsWith('__'))
    expect(after.map((r) => [r.id, r.value, r.namespace])).toEqual(before.map((r) => [r.id, r.value, r.namespace]))
    const sent = w.runner.migrateCalls.flatMap((c) => (c.body.rows as { collection: string }[]).map((r) => r.collection))
    expect(sent.every((c) => !c.startsWith('__'))).toBe(true)
  })

  test('no call token in any migration request', async () => {
    seedData(1)
    await go()
    expect(w.runner.migrateCalls.length).toBeGreaterThan(0)
    for (const c of w.runner.migrateCalls) expect(JSON.stringify(c.body)).not.toMatch(/token/i)
  })

  test('a batch whose answer is too large is split and still migrates', async () => {
    db.seed('pluginData', [0, 1, 2, 3].map((i) => ({
      pluginId: 'echo', ownerType: 'user', ownerId: 'user-a', userId: 'user-a', collection: 'items', key: `g${i}`, value: { grow: 600_000 }, sizeBytes: 16,
    })))
    await go()
    expect(live().every((r) => (r.value as { blob: string }).blob.length === 600_000)).toBe(true)
    expect(w.runner.migrateCalls.length).toBeGreaterThan(1)
  })

  test('no data rows: the version and data version switch without a migration', async () => {
    const out = await go()
    expect(out.plugin).toMatchObject({ activeVersion: '1.1.0', dataVersion: 2 })
    expect(w.runner.migrateCalls).toEqual([])
  })
})

describe('a migration that fails leaves the old version and the old data intact', () => {
  async function failsAndKeepsEverything(code: string, status: number) {
    const before = JSON.stringify(live().map((r) => [r.id, r.value]).sort())
    const e = await refusal(go())
    expect([e.status, e.code]).toEqual([status, code])
    expect(JSON.stringify(live().map((r) => [r.id, r.value]).sort())).toBe(before)
    expect(copies()).toEqual([])
    expect(row()).toMatchObject({ status: 'ready', activeVersion: '1.0.0', previousVersion: null, pendingVersion: null, dataVersion: 1, operationId: null })
    expect(String(row().lastError)).toMatch(new RegExp(`^${code}`))
    expect(await exists(versionPath('echo', '1.1.0'))).toBe(false)
    expect(await exists(versionPath('echo', '1.0.0'))).toBe(true)
    expect(w.runner.options.workers?.map((x) => x.version)).toEqual(['1.0.0'])
    return e
  }

  test('one row whose migrate_row raises discards the whole copy', async () => {
    seedData(250, (o, i) => (o === 'project-2' && i === 249 ? { raise: true } : i))
    const e = await failsAndKeepsEverything('migration_failed', 422)
    expect(e.message).toMatch(/ValueError/)
    expect(h.audit.find((x) => x.action === 'plugin.update')!.after).toMatchObject({ outcome: 'failed', code: 'migration_failed' })
  }, 60_000)

  test('an answer over the value limit fails cleanly', async () => {
    seedData(1, (o) => (o === 'user-c' ? { grow: 1_500_000 } : 1))
    await failsAndKeepsEverything('value_too_large', 422)
  })

  test('a migration timeout', async () => {
    seedData(1)
    w.runner.options.migrateHook = () => ({ status: 504, body: { error: 'Too slow.', code: 'migration_timeout' } })
    await failsAndKeepsEverything('migration_timeout', 504)
  })

  test('the runner down during the migration', async () => {
    seedData(1)
    w.runner.options.migrateHook = () => ({ status: 502, body: { error: 'x', code: 'upstream_unreachable' } })
    await failsAndKeepsEverything('runner_unavailable', 503)
  })

  test('a step the new version does not ship', async () => {
    seedData(1)
    delete w.runner.options.migrations!['echo/0002_up']
    await failsAndKeepsEverything('migration_missing', 422)
  })

  test('an answer for a row that was not in the batch', async () => {
    seedData(1)
    w.runner.options.migrateHook = ({ body }) => ({
      status: 200,
      body: { results: (body.rows as { id: string }[]).map((r, i) => ({ id: i === 0 ? 'someone-else' : r.id, value: 1 })) },
    })
    await failsAndKeepsEverything('invalid_result', 422)
  })

  test('the swap and the new version are one transaction: a lost lease swaps nothing', async () => {
    seedData(1)
    const real = w.runner.options.migrations!['echo/0002_up']
    w.runner.options.migrations!['echo/0002_up'] = (r) => {
      // Reconciliation takes the plugin over while the batch runs.
      db.tables.pluginInstall.set('echo', { ...row(), operationId: '00000000-0000-4000-8000-000000000000' })
      return real(r)
    }
    const before = JSON.stringify(live().map((r) => [r.id, r.value]).sort())
    const e = await refusal(go())
    expect(e.code).toBe('plugin_busy')
    expect(JSON.stringify(live().map((r) => [r.id, r.value]).sort())).toBe(before)
    expect(copies()).toEqual([])
    expect(row().activeVersion).toBe('1.0.0')
    expect(row().dataVersion).toBe(1)
  })
})
