/**
 * The plugin stores (registry, data store, override store) run with the real Prisma
 * client against a real Postgres: what the in-memory double cannot prove. LIKE and
 * jsonb semantics, the database constraints accepting what the stores write, and real
 * concurrency on several pooled connections with real advisory locks.
 *
 * It needs a DISPOSABLE database holding the webapp schema (`prisma db push`) and the
 * constraints of scripts/apply-plugin-constraints.mjs, and it empties the plugin
 * tables, `users` and `projects` between tests. Run it with
 *   PLUGINS_PG_TEST_URL=postgresql://... npx vitest run src/lib/plugins/stores.pg.integration.test.ts
 * Without the variable it is skipped. It refuses a database that already holds users
 * unless that database carries its own marker table, so a real database is never wiped.
 *
 * @vitest-environment node
 */
import { describe, test, expect, beforeAll, beforeEach, afterAll, afterEach } from 'vitest'
import { Prisma, PrismaClient } from '@prisma/client'
import { setNowForTests } from './clock'
import * as registry from './registry'
import * as store from './dataStore'
import * as ov from './overrides'

const URL = process.env.PLUGINS_PG_TEST_URL
const MARKER = 'plugins_pg_integration_test_marker'

const db = URL ? new PrismaClient({ datasources: { db: { url: URL } } }) : (null as unknown as PrismaClient)
const sha = (n: number) => n.toString(16).padStart(64, '0')
const alice: ov.OverrideScope = { type: 'user', id: 'alice' }
const p1: ov.OverrideScope = { type: 'project', id: 'p1' }
const H = { 'sqli/workflow': sha(1), 'sqli/payloads': sha(1) }

async function propose(scope: ov.OverrideScope, parts: Record<string, string>, opts: { pluginId?: string; base?: number; meta?: Prisma.InputJsonValue } = {}) {
  const { changeSetId } = await ov.propose(
    {
      pluginId: opts.pluginId ?? 'skiller',
      point: 'skill.text',
      scope,
      targetGroup: 'sqli',
      parts: Object.entries(parts).map(([p, value]) => ({ targetKey: `sqli/${p}`, value, baseSha256: sha(opts.base ?? 1) })),
      meta: opts.meta,
      createdBy: 'alice',
    },
    db,
  )
  return changeSetId
}

const settle = <T,>(ps: Promise<T>[]) => Promise.allSettled(ps)
const outcome = (r: PromiseSettledResult<unknown>) =>
  r.status === 'fulfilled' ? 'ok' : ((r.reason as { code?: string }).code ?? String(r.reason))

describe.skipIf(!URL)('plugin stores on a real Postgres (PLUGINS_PG_TEST_URL)', () => {
  beforeAll(async () => {
    const [{ users }] = await db.$queryRaw<{ users: number }[]>`SELECT count(*)::int AS users FROM users`
    const [{ marked }] = await db.$queryRaw<{ marked: boolean }[]>`SELECT to_regclass(${MARKER}) IS NOT NULL AS marked`
    if (users > 0 && !marked) throw new Error('Refusing to run: this database holds users and is not a disposable test database')
    await db.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS ${MARKER} (created_at timestamptz DEFAULT now())`)
    const [{ n }] = await db.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM pg_indexes WHERE indexname = 'plugin_overrides_one_active'`
    if (n !== 1) throw new Error('The one-active index is missing: run scripts/apply-plugin-constraints.mjs first')
  })

  beforeEach(async () => {
    await db.$executeRawUnsafe(
      'TRUNCATE plugin_data, plugin_overrides, plugin_installs, plugin_platform_state, projects, users CASCADE',
    )
    await db.user.createMany({
      data: [
        { id: 'alice', name: 'Alice', email: 'alice@example.invalid' },
        { id: 'bob', name: 'Bob', email: 'bob@example.invalid' },
      ],
    })
    await db.project.create({ data: { id: 'p1', userId: 'alice', name: 'p1' } })
    await db.project.create({ data: { id: 'p2', userId: 'bob', name: 'p2' } })
    for (const pluginId of ['skiller', 'echo']) {
      await db.pluginInstall.create({
        data: { pluginId, status: 'ready', enabled: true, grantedPermissions: ['override:skill.text'] },
      })
    }
  })

  afterEach(() => setNowForTests(null))
  afterAll(async () => {
    await db?.$disconnect()
  })

  describe('data store', () => {
    const S = { pluginId: 'skiller' }
    const me: store.PluginOwner = { type: 'user', id: 'alice' }

    test('jsonb round trip: key order may change, values do not; JSON null is a value', async () => {
      const value = { zeta: 1, a: { nested: ['é', '🙂'] }, b: null }
      const r = await store.put(S, me, 'notes', 'k', value, {}, db)
      expect(r.sizeBytes).toBe(Buffer.byteLength(JSON.stringify(value), 'utf8'))
      expect((await store.get(S, me, 'notes', 'k', db))?.value).toEqual(value)
      await store.put(S, me, 'notes', 'n', null, {}, db)
      const n = await store.get(S, me, 'notes', 'n', db)
      expect(n).not.toBeNull()
      expect(n?.value).toBeNull()
    })

    test('the CHECK constraints accept both owner kinds as the store writes them', async () => {
      await store.put(S, me, 'c', 'k', 1, {}, db)
      await store.put(S, { type: 'project', id: 'p1' }, 'c', 'k', 1, {}, db)
      expect(await db.pluginData.count()).toBe(2)
    })

    test('reserved rows never count, and a collection like "ab" does (real LIKE)', async () => {
      process.env.PLUGIN_DATA_MAX_ROWS = '2'
      try {
        await store.put(S, me, 'ab', 'k1', 1, {}, db)
        for (let i = 0; i < 5; i++) await store.put({ ...S, platform: true }, me, '__jobs', `j${i}`, i, {}, db)
        await store.put(S, me, 'cd', 'k2', 1, {}, db)
        await expect(store.put(S, me, 'ef', 'k3', 1, {}, db)).rejects.toMatchObject({ code: 'rows_exceeded' })
      } finally {
        delete process.env.PLUGIN_DATA_MAX_ROWS
      }
    })

    test('a key prefix with _ and % matches literally (real LIKE)', async () => {
      for (const k of ['a_1', 'ab1', 'a%1', 'a1']) await store.put(S, me, 'c', k, k, {}, db)
      const keys = async (keyPrefix: string) =>
        (await store.query(S, me, 'c', { keyPrefix }, db)).map((r) => r.key).sort()
      expect(await keys('a_')).toEqual(['a_1'])
      expect(await keys('a%')).toEqual(['a%1'])
      expect(await keys('a')).toEqual(['a%1', 'a1', 'a_1', 'ab1'])
    })

    test('expiry follows the platform clock in SQL comparisons', async () => {
      const t0 = Date.parse('2030-01-01T00:00:00Z')
      setNowForTests(() => new Date(t0))
      await store.put(S, me, 'c', 'k', 'v', { ttlSeconds: 60 }, db)
      setNowForTests(() => new Date(t0 + 59_000))
      expect((await store.get(S, me, 'c', 'k', db))?.value).toBe('v')
      setNowForTests(() => new Date(t0 + 60_000))
      expect(await store.get(S, me, 'c', 'k', db)).toBeNull()
      expect(await store.query(S, me, 'c', {}, db)).toEqual([])
    })

    test('copy and swap namespaces keep owners and leave platform rows in live', async () => {
      await store.put(S, me, 'c', 'a', 'old', {}, db)
      await store.put(S, { type: 'project', id: 'p1' }, 'c', 'b', 'proj', {}, db)
      await store.put({ ...S, platform: true }, me, '__jobs', 'j', 'job', {}, db)
      expect(await store.copyNamespace('skiller', 'live', 'migrating:op-1', db)).toBe(2)
      await store.put({ ...S, namespace: 'migrating:op-1' }, me, 'c', 'a', 'new', {}, db)
      await store.swapNamespace('skiller', 'migrating:op-1', 'live', db)
      const rows = await db.pluginData.findMany({ orderBy: [{ collection: 'asc' }, { key: 'asc' }] })
      expect(rows.map((r) => [r.namespace, r.collection, r.key, r.value, r.userId, r.projectId])).toEqual([
        ['live', '__jobs', 'j', 'job', 'alice', null],
        ['live', 'c', 'a', 'new', 'alice', null],
        ['live', 'c', 'b', 'proj', null, 'p1'],
      ])
    })

    test('expired rows are cleaned up when they would block a write (SQL comparison on the clock)', async () => {
      const t0 = Date.parse('2030-01-01T00:00:00Z')
      setNowForTests(() => new Date(t0))
      process.env.PLUGIN_DATA_MAX_ROWS = '2'
      try {
        await store.put(S, me, 'c', 'a', 1, { ttlSeconds: 1 }, db)
        await store.put(S, me, 'c', 'b', 1, { ttlSeconds: 1 }, db)
        await expect(store.put(S, me, 'c', 'x', 1, {}, db)).rejects.toMatchObject({ code: 'rows_exceeded' })
        setNowForTests(() => new Date(t0 + 1_000))
        await store.put(S, me, 'c', 'x', 1, {}, db)
        expect((await db.pluginData.findMany()).map((r) => r.key)).toEqual(['x'])
      } finally {
        delete process.env.PLUGIN_DATA_MAX_ROWS
      }
    })

    test('a full quota (10,000 rows, ~50 MB) copies and swaps within the migration transaction', async () => {
      await db.$executeRawUnsafe(`INSERT INTO plugin_data (id, plugin_id, namespace, owner_type, owner_id, user_id,
          collection, key, value, size_bytes, updated_at)
        SELECT 'r' || g, 'skiller', 'live', 'user', 'alice', 'alice', 'c', 'k' || g, to_jsonb(repeat('x', 5200)), 5202, now()
        FROM generate_series(1, 10000) g`)
      expect(await store.copyNamespace('skiller', 'live', 'migrating:op-1', db)).toBe(10_000)
      await store.swapNamespace('skiller', 'migrating:op-1', 'live', db)
      expect(await db.pluginData.count({ where: { namespace: 'live' } })).toBe(10_000)
      expect(await db.pluginData.count({ where: { namespace: 'migrating:op-1' } })).toBe(0)
    }, 120_000)

    test('deleting the owner deletes its rows (cascade)', async () => {
      await store.put(S, me, 'c', 'k', 1, {}, db)
      await db.user.delete({ where: { id: 'alice' } })
      expect(await db.pluginData.count()).toBe(0)
    })
  })

  describe('install registry', () => {
    test('eight concurrent operations on one plugin, on separate connections: exactly one wins', async () => {
      await db.pluginInstall.create({ data: { pluginId: 'racer' } })
      const rs = await settle(
        Array.from({ length: 8 }, () => registry.beginOperation('racer', ['available'], 'installing', 'install', undefined, db)),
      )
      expect(rs.map(outcome).sort()).toEqual(['ok', ...Array(7).fill('plugin_busy')])
    })

    test('five concurrent first installs: one insert, four conflicts', async () => {
      const rs = await settle(Array.from({ length: 5 }, () => registry.createForInstall('fresh', { mode: 'x' }, db)))
      expect(rs.map(outcome).sort()).toEqual(['ok', ...Array(4).fill('plugin_busy')])
    })

    test('lease expiry, takeover, and the four lease fields cleared to SQL NULL', async () => {
      const t0 = Date.parse('2030-01-01T00:00:00Z')
      setNowForTests(() => new Date(t0))
      const op = await registry.createForInstall('leasey', { mode: 'purge' }, db)
      await expect(registry.transition('leasey', { from: ['installing'], to: 'ready' }, db)).rejects.toMatchObject({ code: 'plugin_busy' })
      setNowForTests(() => new Date(t0 + registry.LEASE_MS + 1))
      const other = await registry.beginOperation('leasey', ['installing'], 'ready', 'install', undefined, db).catch((e) => e)
      expect(other).toMatchObject({ status: 'ready' })
      await expect(registry.heartbeat(op, db)).rejects.toMatchObject({ code: 'plugin_busy' })
      const row = await db.pluginInstall.findUnique({ where: { pluginId: 'leasey' } })
      expect(row?.operationArgs).toBeNull()
      expect(row?.status).toBe('ready')
    })
  })

  describe('override store', () => {
    test('five concurrent approvals on separate connections: numbers 2..6, one active set, the index never trips', async () => {
      const ids = []
      for (let i = 0; i < 5; i++) ids.push(await propose(alice, { workflow: `W${i}`, payloads: `P${i}` }))
      const rs = await settle(ids.map((id) => ov.approve(id, 'alice', H, db)))
      expect(rs.map(outcome)).toEqual(Array(5).fill('ok'))
      const revisions = rs.map((r) => (r as PromiseFulfilledResult<ov.ApproveResult>).value.revision).sort((a, b) => a - b)
      expect(revisions).toEqual([2, 3, 4, 5, 6])
      const active = await db.pluginOverride.findMany({ where: { status: 'active' } })
      expect(new Set(active.map((r) => r.changeSetId)).size).toBe(1)
      expect(active).toHaveLength(2)
      expect(await ov.lastRevision(alice, 'skill.text', 'sqli', db)).toBe(6)
    })

    test('one set approved four times at once: one approval, three find it decided', async () => {
      const id = await propose(alice, { workflow: 'W' })
      const rs = await settle(Array.from({ length: 4 }, () => ov.approve(id, 'alice', H, db)))
      expect(rs.map(outcome).sort()).toEqual(['ok', 'wrong_state', 'wrong_state', 'wrong_state'])
    })

    test('six concurrent proposals with no pending: exactly five are accepted', async () => {
      const rs = await settle(Array.from({ length: 6 }, (_, i) => propose(alice, { workflow: `W${i}` })))
      expect(rs.map(outcome).sort()).toEqual([...Array(5).fill('ok'), 'too_many_pending'])
      expect(await ov.pendingCount(alice, 'skill.text', 'sqli', db)).toBe(5)
    })

    test('approve and delete of one set at once never both succeed', async () => {
      const id = await propose(alice, { workflow: 'W' })
      const rs = await settle([ov.approve(id, 'alice', H, db), ov.deleteChangeSet(id, db)])
      expect(rs.map(outcome).sort()).toEqual(expect.arrayContaining(['ok']))
      expect(rs.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    })

    test('the whole numbering story on jsonb counters: v2, v3, reset, delete both, next is v4', async () => {
      const v2 = await propose(alice, { workflow: 'W2' })
      await ov.approve(v2, 'alice', H, db)
      const v3 = await propose(alice, { workflow: 'W3' })
      await ov.approve(v3, 'alice', H, db)
      await ov.reset(alice, 'skill.text', 'sqli', 'alice', db)
      await ov.deleteChangeSet(v3, db)
      await ov.deleteChangeSet(v2, db)
      expect(await db.pluginOverride.count()).toBe(0)
      const v4 = await propose(alice, { workflow: 'W4' })
      expect((await ov.approve(v4, 'alice', H, db)).revision).toBe(4)
      const state = await db.pluginPlatformState.findUnique({ where: { key: ov.revisionCounterKey('skill.text', alice, 'sqli') } })
      expect(state?.value).toEqual({ last: 4 })
    })

    test('meta round trip, staleness and re-approval re-basing on real rows', async () => {
      const id = await propose(alice, { workflow: 'W', payloads: 'P' }, { meta: { summary: 's', lessons: ['a', 'b'], fromRevision: 1 } })
      await ov.approve(id, 'alice', H, db)
      expect(await ov.markStale(id, 'factory_changed', db)).toEqual([id])
      const stale = await ov.getChangeSet(id, db)
      expect(stale).toMatchObject({ status: 'stale', staleReason: 'factory_changed', meta: { summary: 's', lessons: ['a', 'b'] } })
      const r = await ov.approve(id, 'alice', { 'sqli/workflow': sha(9), 'sqli/payloads': sha(9) }, db)
      expect(r.revision).toBe(2)
      const again = await ov.getChangeSet(id, db)
      expect(again).toMatchObject({ status: 'active', staleReason: null, meta: { summary: 's', lessons: ['a', 'b'], fromRevision: 1 } })
      expect(again!.parts.map((p) => p.baseSha256)).toEqual([sha(9), sha(9)])
    })

    test('a proposal without meta stores SQL NULL', async () => {
      const id = await propose(alice, { workflow: 'W' })
      expect((await ov.getChangeSet(id, db))?.meta).toBeNull()
    })

    test('resolveForProject on real rows: per skill, owner from the project, qualifying plugins only', async () => {
      const u = await propose(alice, { workflow: 'UW', payloads: 'UP' })
      await ov.approve(u, 'alice', H, db)
      expect(Object.keys(await ov.resolveForProject('p1', db)).sort()).toEqual(['sqli/payloads', 'sqli/workflow'])
      expect(await ov.resolveForProject('p2', db)).toEqual({})
      const p = await propose(p1, { workflow: 'PW' }, { pluginId: 'echo' })
      await ov.approve(p, 'alice', H, db)
      const r = await ov.resolveForProject('p1', db)
      expect(Object.keys(r)).toEqual(['sqli/workflow'])
      expect(r['sqli/workflow']).toMatchObject({ value: 'PW', pluginId: 'echo', revision: 2 })
      await db.pluginInstall.update({ where: { pluginId: 'echo' }, data: { enabled: false } })
      expect(await ov.resolveForProject('p1', db)).toEqual({})
      expect(await ov.effectiveForProject('p1', 'sqli', db)).toMatchObject({ applies: false, scope: p1 })
    })

    test("a stale project version keeps the skill on factory text, not on the owner's version", async () => {
      const u = await propose(alice, { workflow: 'U' })
      await ov.approve(u, 'alice', H, db)
      const p = await propose(p1, { workflow: 'P' })
      await ov.approve(p, 'alice', H, db)
      await ov.markStale(p, 'factory_changed', db)
      expect(await ov.resolveForProject('p1', db)).toEqual({})
      expect(await ov.effectiveForProject('p1', 'sqli', db)).toMatchObject({ status: 'stale', applies: false })
    })

    test('the database refuses rows whose owner key is NULL (ck2)', async () => {
      await expect(
        db.$executeRawUnsafe(`INSERT INTO plugin_data (id, plugin_id, owner_type, owner_id, collection, key, value,
          size_bytes, updated_at) VALUES ('n1', 'skiller', 'user', 'alice', 'c', 'k', '1', 1, now())`),
      ).rejects.toThrow(/plugin_data_owner_ck2/)
    })

    test('the index is the second wall: two active rows written around the store are refused', async () => {
      const a = await propose(alice, { workflow: 'A' })
      const b = await propose(alice, { workflow: 'B' })
      await db.pluginOverride.updateMany({ where: { changeSetId: a }, data: { status: 'active' } })
      await expect(db.pluginOverride.updateMany({ where: { changeSetId: b }, data: { status: 'active' } })).rejects.toMatchObject({
        code: 'P2002',
      })
    })

    test('deleting a project deletes its project-scope versions (cascade)', async () => {
      const p = await propose(p1, { workflow: 'P' })
      await ov.approve(p, 'alice', H, db)
      await db.project.delete({ where: { id: 'p1' } })
      expect(await db.pluginOverride.count()).toBe(0)
    })
  })
})
