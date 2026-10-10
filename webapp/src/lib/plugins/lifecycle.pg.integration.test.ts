/**
 * What the in-memory double can only imitate about the lifecycle, on a real Postgres:
 * the purge's raw statement that strips `plugin:<id>` from every user's Models by feature
 * (jsonb `-` and `jsonb_exists`, TD-10), and the cascade that removes a plugin's data and
 * overrides with its install row.
 *
 * Same contract as stores.pg.integration.test.ts: a DISPOSABLE database holding the
 * webapp schema and the plugin constraints, given as PLUGINS_PG_TEST_URL; skipped
 * without it; refuses a database holding users unless it carries the test marker table.
 *
 * @vitest-environment node
 */
import { describe, test, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import { PrismaClient } from '@prisma/client'
import { stripFeatureModelKey } from './lifecycle'
import { runMigrations } from './migrations'
import { createForInstall } from './registry'
import type { MigrationAnswer, MigrationRequest } from './runnerClient'

const URL = process.env.PLUGINS_PG_TEST_URL
const MARKER = 'plugins_pg_integration_test_marker'
const db = URL ? new PrismaClient({ datasources: { db: { url: URL } } }) : (null as unknown as PrismaClient)

describe.skipIf(!URL)('lifecycle on a real Postgres (PLUGINS_PG_TEST_URL)', () => {
  beforeAll(async () => {
    const [{ users }] = await db.$queryRaw<{ users: number }[]>`SELECT count(*)::int AS users FROM users`
    const [{ marked }] = await db.$queryRaw<{ marked: boolean }[]>`SELECT to_regclass(${MARKER}) IS NOT NULL AS marked`
    if (users > 0 && !marked) throw new Error('Refusing to run: this database holds users and is not a disposable test database')
    await db.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS ${MARKER} (created_at timestamptz DEFAULT now())`)
  })

  beforeEach(async () => {
    await db.$executeRawUnsafe('TRUNCATE plugin_data, plugin_overrides, plugin_installs, plugin_platform_state, projects, users CASCADE')
    await db.user.createMany({
      data: [
        { id: 'alice', name: 'Alice', email: 'alice@example.invalid' },
        { id: 'bob', name: 'Bob', email: 'bob@example.invalid' },
        { id: 'carol', name: 'Carol', email: 'carol@example.invalid' },
      ],
    })
    await db.userSettings.create({ data: { userId: 'alice', featureModels: { 'plugin:echo': 'openai/gpt-x', skiller: 'anthropic/c' } } })
    await db.userSettings.create({ data: { userId: 'bob', featureModels: { 'plugin:echoes': 'm', 'plugin:other': 'n' } } })
    await db.userSettings.create({ data: { userId: 'carol', featureModels: {} } })
  })

  afterAll(async () => {
    await db?.$disconnect()
  })

  test('the purge strips exactly plugin:<id> from every user and touches no one else', async () => {
    expect(await stripFeatureModelKey(db, 'echo')).toBe(1)
    const rows = await db.userSettings.findMany({ orderBy: { userId: 'asc' } })
    expect(rows.map((r) => [r.userId, r.featureModels])).toEqual([
      ['alice', { skiller: 'anthropic/c' }],
      ['bob', { 'plugin:echoes': 'm', 'plugin:other': 'n' }],
      ['carol', {}],
    ])
    expect(await stripFeatureModelKey(db, 'echo')).toBe(0)
  })

  describe('a data migration (TD-28)', () => {
    async function world(perOwner: number) {
      await db.project.create({ data: { id: 'p1', userId: 'alice', name: 'p1' } })
      const op = await createForInstall('echo', undefined, db)
      const rows = []
      for (const [ownerType, ownerId] of [['user', 'alice'], ['user', 'bob'], ['project', 'p1']] as const) {
        for (let i = 0; i < perOwner; i++) {
          rows.push({
            pluginId: 'echo', ownerType, ownerId, userId: ownerType === 'user' ? ownerId : null,
            projectId: ownerType === 'project' ? ownerId : null, collection: 'items', key: `k${i}`, value: { i }, sizeBytes: 7,
          })
        }
      }
      await db.pluginData.createMany({ data: rows })
      await db.pluginData.create({
        data: { pluginId: 'echo', ownerType: 'user', ownerId: 'alice', userId: 'alice', collection: '__jobs', key: 'j', value: { s: 1 }, sizeBytes: 7 },
      })
      return op
    }
    const wrap = async (_p: string, req: MigrationRequest): Promise<MigrationAnswer[]> =>
      req.rows.map((r) => ((r.value as { i: number }).i === 3
        ? { id: r.id, delete: true as const }
        : { id: r.id, value: { v: 2, data: r.value } }))

    test('every row of every owner migrated, platform rows untouched, data version committed with the swap', async () => {
      const op = await world(300)
      const stats = await runMigrations(
        { operation: op, version: '1.1.0', from: 1, to: 2 },
        async (tx) => {
          await tx.pluginInstall.update({ where: { pluginId: 'echo' }, data: { dataVersion: 2 } })
        },
        { migrate: wrap },
        db,
      )
      expect(stats).toMatchObject({ steps: 1, rows: 900, deleted: 3 })
      const live = await db.pluginData.findMany({ where: { pluginId: 'echo', namespace: 'live', collection: 'items' } })
      expect(live).toHaveLength(897)
      expect(live.every((r) => (r.value as { v: number }).v === 2)).toBe(true)
      expect(live.every((r) => r.sizeBytes === Buffer.byteLength(JSON.stringify(r.value)))).toBe(true)
      expect(await db.pluginData.count({ where: { namespace: { startsWith: 'migrating:' } } })).toBe(0)
      const job = await db.pluginData.findFirst({ where: { collection: '__jobs' } })
      expect(job?.value).toEqual({ s: 1 })
      expect((await db.pluginInstall.findUnique({ where: { pluginId: 'echo' } }))?.dataVersion).toBe(2)
    }, 60_000)

    test('a failing commit swaps nothing and discards the copy', async () => {
      const op = await world(50)
      await expect(
        runMigrations({ operation: op, version: '1.1.0', from: 1, to: 2 }, async () => {
          throw new Error('lease lost')
        }, { migrate: wrap }, db),
      ).rejects.toThrow()
      const live = await db.pluginData.findMany({ where: { pluginId: 'echo', namespace: 'live', collection: 'items' } })
      expect(live).toHaveLength(150)
      expect(live.every((r) => !('v' in (r.value as object)))).toBe(true)
      expect(await db.pluginData.count({ where: { namespace: { startsWith: 'migrating:' } } })).toBe(0)
    }, 60_000)
  })

  test('deleting the install row cascades to its data and overrides only', async () => {
    for (const pluginId of ['echo', 'other']) {
      await db.pluginInstall.create({ data: { pluginId, status: 'ready', enabled: true } })
      await db.pluginData.create({
        data: { pluginId, ownerType: 'user', ownerId: 'alice', userId: 'alice', collection: 'c', key: 'k', value: 1, sizeBytes: 1 },
      })
    }
    await db.pluginInstall.delete({ where: { pluginId: 'echo' } })
    expect((await db.pluginData.findMany()).map((r) => r.pluginId)).toEqual(['other'])
  })
})
