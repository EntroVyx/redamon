/**
 * The one-time backfill that made a missing user-skill toggle mean OFF (D9), on a real
 * Postgres.
 *
 * Before it, the agent ran every one of the owner's skills a project did not set to
 * false. The backfill writes that state down as explicit `true`, so nothing that runs
 * today stops: it touches only `attackSkillConfig.user` (creating it when absent), keeps
 * an explicit `false`, never names another account's skill, keeps at most 20 of the
 * owner's skills on (by name, then id), and moves `updatedAt` on the projects it changes,
 * so a form opened before the upgrade gets a stale-save refusal. It runs once: the
 * marker is an AuditLog row written in the same transaction, under an advisory lock.
 *
 * Needs a DISPOSABLE database holding the webapp schema (`prisma db push`); it empties
 * `audit_log`, `user_attack_skills`, `projects` and `users` (CASCADE) between tests. Run:
 *   PLUGINS_PG_TEST_URL=postgresql://... npx vitest run --no-file-parallelism scripts/backfill-user-skill-toggles.pg.integration.test.ts
 * Without the variable it is skipped. It refuses a database that already holds users
 * unless that database carries the pg-integration marker table.
 *
 * @vitest-environment node
 */
import { describe, test, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import { PrismaClient } from '@prisma/client'
import { backfillUserSkillToggles, MARKER_ACTION, MAX_ENABLED } from './backfill-user-skill-toggles.mjs'

const URL = process.env.PLUGINS_PG_TEST_URL
const MARKER = 'plugins_pg_integration_test_marker'
const db = URL ? new PrismaClient({ datasources: { db: { url: URL } } }) : (null as unknown as PrismaClient)

const BUILT_IN = { sql_injection: true, xss: false, rce: true }
const T0 = new Date('2026-01-01T00:00:00.000Z')

type Config = { builtIn?: Record<string, boolean>; user?: Record<string, boolean> }

/** Bob's 25 skills: names `skill 00`..`skill 24`, ids in REVERSE name order (so id order would pick wrong). */
const BOB = Array.from({ length: 25 }, (_, i) => ({
  id: `bob-${String(24 - i).padStart(2, '0')}`,
  name: `skill ${String(i).padStart(2, '0')}`,
}))
const BOB_BY_NAME = BOB.map((s) => s.id)

async function project(id: string, userId: string, attackSkillConfig: unknown) {
  await db.project.create({ data: { id, userId, name: id, attackSkillConfig: attackSkillConfig as never } })
  // A known past updatedAt, so a write by the backfill is visible.
  await db.$executeRaw`UPDATE projects SET updated_at = ${T0} WHERE id = ${id}`
}

const read = async (id: string) => {
  const p = await db.project.findUniqueOrThrow({ where: { id }, select: { attackSkillConfig: true, updatedAt: true } })
  return { config: p.attackSkillConfig as Config, updatedAt: p.updatedAt }
}
const enabled = (c: Config) => Object.entries(c.user ?? {}).filter(([, v]) => v === true).map(([k]) => k)

describe.skipIf(!URL)('backfillUserSkillToggles on a real Postgres (PLUGINS_PG_TEST_URL)', () => {
  beforeAll(async () => {
    const [{ users }] = await db.$queryRaw<{ users: number }[]>`SELECT count(*)::int AS users FROM users`
    const [{ marked }] = await db.$queryRaw<{ marked: boolean }[]>`SELECT to_regclass(${MARKER}) IS NOT NULL AS marked`
    if (users > 0 && !marked) throw new Error('Refusing to run: this database holds users and is not a disposable test database')
    await db.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS ${MARKER} (created_at timestamptz DEFAULT now())`)
  })

  beforeEach(async () => {
    await db.$executeRawUnsafe('TRUNCATE audit_log, user_attack_skills, projects, users CASCADE')
    await db.user.createMany({
      data: ['alice', 'bob', 'carol'].map((id) => ({ id, name: id, email: `${id}@example.invalid` })),
    })
    // Alice: three skills whose name order (a, b, c) differs from their id order.
    await db.userAttackSkill.createMany({
      data: [
        { id: 'al-3', userId: 'alice', name: 'a flow', content: '# a' },
        { id: 'al-1', userId: 'alice', name: 'b flow', content: '# b' },
        { id: 'al-2', userId: 'alice', name: 'c flow', content: '# c' },
        ...BOB.map((s) => ({ ...s, userId: 'bob', content: '# s' })),
      ],
    })
    await project('a-empty', 'alice', { builtIn: BUILT_IN, user: {} })
    await project('a-off', 'alice', { builtIn: BUILT_IN, user: { 'al-1': false } })
    await project('a-nouser', 'alice', { builtIn: BUILT_IN })
    await project('a-full', 'alice', { builtIn: BUILT_IN, user: { 'al-1': true, 'al-2': false, 'al-3': true } })
    await project('a-array', 'alice', [])
    await project('b-empty', 'bob', { builtIn: BUILT_IN, user: {} })
    await project('b-someoff', 'bob', { builtIn: BUILT_IN, user: Object.fromEntries(BOB_BY_NAME.slice(0, 5).map((id) => [id, false])) })
    await project('b-someon', 'bob', { builtIn: BUILT_IN, user: Object.fromEntries(BOB_BY_NAME.slice(22).map((id) => [id, true])) })
    await project('c-empty', 'carol', { builtIn: BUILT_IN, user: {} })
  })

  afterAll(async () => {
    await db?.$disconnect()
  })

  test('each owner skill with no key becomes an explicit true; an explicit false stays false', async () => {
    await backfillUserSkillToggles(db)
    expect((await read('a-empty')).config).toEqual({ builtIn: BUILT_IN, user: { 'al-1': true, 'al-2': true, 'al-3': true } })
    expect((await read('a-off')).config).toEqual({ builtIn: BUILT_IN, user: { 'al-1': false, 'al-2': true, 'al-3': true } })
  })

  test('a config without a user map gets one; builtIn is never touched', async () => {
    await backfillUserSkillToggles(db)
    expect((await read('a-nouser')).config).toEqual({ builtIn: BUILT_IN, user: { 'al-1': true, 'al-2': true, 'al-3': true } })
  })

  test('only the OWNER\'s skills are written: no project names another account\'s skill', async () => {
    await backfillUserSkillToggles(db)
    const bobIds = new Set(BOB.map((s) => s.id))
    for (const id of ['a-empty', 'a-off', 'a-nouser', 'a-full']) {
      expect(Object.keys((await read(id)).config.user ?? {}).some((k) => bobIds.has(k)), id).toBe(false)
    }
    expect((await read('b-empty')).config.user).not.toHaveProperty('al-1')
  })

  test(`at most ${MAX_ENABLED} enabled per project, filled by name then id`, async () => {
    expect(MAX_ENABLED).toBe(20)
    await backfillUserSkillToggles(db)
    const empty = (await read('b-empty')).config
    expect(enabled(empty).sort()).toEqual(BOB_BY_NAME.slice(0, 20).sort())
    for (const id of BOB_BY_NAME.slice(20)) expect(empty.user, id).not.toHaveProperty(id)

    // Five explicit offs: the next twenty by name are on.
    const someOff = (await read('b-someoff')).config
    expect(enabled(someOff).sort()).toEqual(BOB_BY_NAME.slice(5).sort())
    for (const id of BOB_BY_NAME.slice(0, 5)) expect(someOff.user![id]).toBe(false)

    // Three already on count toward the twenty.
    const someOn = (await read('b-someon')).config
    expect(enabled(someOn).sort()).toEqual([...BOB_BY_NAME.slice(0, 17), ...BOB_BY_NAME.slice(22)].sort())

    for (const p of await db.project.findMany({ select: { id: true, attackSkillConfig: true } })) {
      expect(enabled((p.attackSkillConfig ?? {}) as Config).length, p.id).toBeLessThanOrEqual(20)
    }
  })

  test('equal names are filled by id', async () => {
    await db.userAttackSkill.createMany({
      data: Array.from({ length: 21 }, (_, i) => ({
        id: `same-${String(20 - i).padStart(2, '0')}`, userId: 'carol', name: 'same name', content: '# s',
      })),
    })
    await backfillUserSkillToggles(db)
    const user = (await read('c-empty')).config.user!
    expect(user).not.toHaveProperty('same-20')
    expect(user['same-00']).toBe(true)
    expect(enabled({ user })).toHaveLength(20)
  })

  test('updatedAt moves on every changed project and on no other', async () => {
    await backfillUserSkillToggles(db)
    for (const id of ['a-empty', 'a-off', 'a-nouser', 'b-empty', 'b-someoff', 'b-someon']) {
      expect((await read(id)).updatedAt.getTime(), id).toBeGreaterThan(T0.getTime())
    }
    for (const id of ['a-full', 'a-array', 'c-empty']) {
      expect((await read(id)).updatedAt.toISOString(), id).toBe(T0.toISOString())
    }
    expect((await read('a-full')).config).toEqual({ builtIn: BUILT_IN, user: { 'al-1': true, 'al-2': false, 'al-3': true } })
    expect((await read('a-array')).config).toEqual([])
    expect((await read('c-empty')).config).toEqual({ builtIn: BUILT_IN, user: {} })
  })

  test('the marker row is written with what was done, and the result says the same', async () => {
    const result = await backfillUserSkillToggles(db)
    // a-empty 3, a-off 2, a-nouser 3, b-empty 20, b-someoff 20, b-someon 17.
    expect(result).toEqual({ done: true, projects: 6, presets: 0, keysWritten: 65 })
    const markers = await db.auditLog.findMany({ where: { action: MARKER_ACTION } })
    expect(markers).toHaveLength(1)
    expect(markers[0]).toMatchObject({
      action: 'system.user_skill_toggles_backfill', targetType: 'system', source: 'system', actorId: null,
      after: { projects: 6, presets: 0, keysWritten: 65 },
    })
  })

  test('a second run is a no-op: nothing is written, no second marker', async () => {
    await backfillUserSkillToggles(db)
    const after1 = await db.project.findMany({ select: { id: true, attackSkillConfig: true, updatedAt: true }, orderBy: { id: 'asc' } })
    // A skill created after the first run must start OFF, so the second run may not touch it.
    await db.userAttackSkill.create({ data: { id: 'al-new', userId: 'alice', name: 'aa new flow', content: '# n' } })
    expect(await backfillUserSkillToggles(db)).toEqual({ done: false })
    const after2 = await db.project.findMany({ select: { id: true, attackSkillConfig: true, updatedAt: true }, orderBy: { id: 'asc' } })
    expect(after2).toEqual(after1)
    expect(await db.auditLog.count({ where: { action: MARKER_ACTION } })).toBe(1)
  })

  test('an existing marker means the backfill never runs, even on a fresh project', async () => {
    await db.auditLog.create({ data: { action: MARKER_ACTION, targetType: 'system', source: 'system' } })
    expect(await backfillUserSkillToggles(db)).toEqual({ done: false })
    expect((await read('a-empty')).config).toEqual({ builtIn: BUILT_IN, user: {} })
  })

  test('two webapp copies booting together backfill once (the advisory lock)', async () => {
    const results = await Promise.all([backfillUserSkillToggles(db), backfillUserSkillToggles(db), backfillUserSkillToggles(db)])
    expect(results.filter((r) => r.done)).toHaveLength(1)
    expect(results.filter((r) => !r.done)).toHaveLength(2)
    expect(await db.auditLog.count({ where: { action: MARKER_ACTION } })).toBe(1)
    expect((await read('b-empty')).config.user).toEqual(Object.fromEntries(BOB_BY_NAME.slice(0, 20).map((id) => [id, true])))
  })

  test('another account\'s ids already in a project never take the owner\'s places (D10 counts only the owner\'s skills)', async () => {
    // A bundle imported before this change could carry the exporting account's ids.
    // The agent ignored them and ran all of the owner's skills; that must keep running.
    await project('a-foreign', 'alice', {
      builtIn: BUILT_IN, user: Object.fromEntries(BOB_BY_NAME.slice(0, 20).map((id) => [id, true])),
    })
    await backfillUserSkillToggles(db)
    const user = (await read('a-foreign')).config.user!
    expect(user['al-1']).toBe(true)
    expect(user['al-2']).toBe(true)
    expect(user['al-3']).toBe(true)
  })

  test('a quarantined skill is never turned on (D3: it cannot be on until its owner releases it)', async () => {
    // Reachable when a boot's backfill failed (it is retried next boot) and a catalog
    // revocation quarantined a skill in between.
    await db.userAttackSkill.update({ where: { id: 'al-2' }, data: { quarantinedAt: new Date(), quarantineReason: 'revoked' } })
    await backfillUserSkillToggles(db)
    expect((await read('a-empty')).config.user!['al-2']).not.toBe(true)
    expect((await read('a-empty')).config.user!['al-1']).toBe(true)
  })
})
