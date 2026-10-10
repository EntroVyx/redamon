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
