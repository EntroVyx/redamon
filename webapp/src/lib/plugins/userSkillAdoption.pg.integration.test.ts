/**
 * The `adopted` override status on a real Postgres (D2): what the in-memory double, which
 * enforces neither the CHECK constraints nor the partial one-active index of
 * scripts/apply-plugin-constraints.mjs, cannot prove.
 *
 * - `plugin_overrides_status_ck2` accepts `adopted` (and still refuses an unknown status);
 * - two adopted rows for the same target coexist: approving a user-skill proposal moves it
 *   `proposed -> adopted`, never `active`, so the one-active index never blocks a second
 *   saved version of the same source skill (while two ACTIVE rows still collide);
 * - the real save path (propose, then adoptUserSkillVersion) writes both of those rows
 *   through the constraints, twice for one source.
 *
 * Needs a DISPOSABLE database with the webapp schema (`prisma db push`) and the constraints
 * of scripts/apply-plugin-constraints.mjs; it empties the plugin tables, `audit_log`,
 * `user_attack_skills`, `projects` and `users`. Run it with
 *   PLUGINS_PG_TEST_URL=postgresql://... npx vitest run --no-file-parallelism src/lib/plugins/userSkillAdoption.pg.integration.test.ts
 * Without the variable it is skipped; it refuses a database that holds users and has no
 * marker table.
 *
 * @vitest-environment node
 */
import { describe, test, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest'

const URL = process.env.PLUGINS_PG_TEST_URL
const h = vi.hoisted(() => ({ db: null as unknown }))
vi.mock('@/lib/prisma', async () => {
  const { PrismaClient } = await import('@prisma/client')
  const url = process.env.PLUGINS_PG_TEST_URL
  h.db = url ? new PrismaClient({ datasources: { db: { url } } }) : null
  return { default: h.db }
})
vi.mock('@/lib/audit', () => ({ writeAudit: vi.fn(async () => undefined) }))

import { createHash } from 'crypto'
import type { PrismaClient } from '@prisma/client'
import * as ov from './overrides'
import { adoptUserSkillVersion } from './userSkillAdoption'

const MARKER = 'plugins_pg_integration_test_marker'
const db = () => h.db as PrismaClient
const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex')
const SOURCE_ID = 'srcskill'
const SOURCE_TEXT = '# Source flow\n\nStep one.\n'
const PLUGIN_VERSION = '1.1.0'

/** One raw override row for alice's source skill; the stores never write two like this. */
const row = (status: string, changeSetId: string) => ({
  pluginId: 'skiller', extensionPoint: 'user_skill.text', scopeType: 'user', scopeId: 'alice', userId: 'alice',
  targetGroup: SOURCE_ID, targetKey: `${SOURCE_ID}/body`, changeSetId, value: `text of ${changeSetId}`,
  baseSha256: sha(SOURCE_TEXT), status, createdBy: 'alice',
})

const proposeVersion = async (text: string) => (await ov.propose({
  pluginId: 'skiller',
  point: ov.USER_SKILL_POINT,
  scope: { type: 'user', id: 'alice' },
  targetGroup: SOURCE_ID,
  parts: [{ targetKey: `${SOURCE_ID}/body`, value: text, baseSha256: sha(SOURCE_TEXT) }],
  platformMeta: { baseText: SOURCE_TEXT, sourceName: 'Source flow', pluginVersion: PLUGIN_VERSION },
  createdBy: 'alice',
}, db())).changeSetId

describe.skipIf(!URL)('the adopted override status on a real Postgres (PLUGINS_PG_TEST_URL)', () => {
  beforeAll(async () => {
    const [{ users }] = await db().$queryRaw<{ users: number }[]>`SELECT count(*)::int AS users FROM users`
    const [{ marked }] = await db().$queryRaw<{ marked: boolean }[]>`SELECT to_regclass(${MARKER}) IS NOT NULL AS marked`
    if (users > 0 && !marked) throw new Error('Refusing to run: this database holds users and is not a disposable test database')
    await db().$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS ${MARKER} (created_at timestamptz DEFAULT now())`)
    const [{ ck }] = await db().$queryRaw<{ ck: string | null }[]>`
      SELECT pg_get_constraintdef(oid) AS ck FROM pg_constraint
       WHERE conrelid = 'plugin_overrides'::regclass AND conname = 'plugin_overrides_status_ck2'`
      .then((r) => (r.length ? r : [{ ck: null }]))
    if (!ck) throw new Error('plugin_overrides_status_ck2 is missing: run scripts/apply-plugin-constraints.mjs first')
    const [{ n }] = await db().$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM pg_indexes WHERE indexname = 'plugin_overrides_one_active'`
    if (n !== 1) throw new Error('The one-active index is missing: run scripts/apply-plugin-constraints.mjs first')
  })

  beforeEach(async () => {
    await db().$executeRawUnsafe(
      'TRUNCATE plugin_data, plugin_overrides, plugin_installs, plugin_platform_state, audit_log, user_attack_skills, projects, users CASCADE',
    )
    await db().user.create({ data: { id: 'alice', name: 'Alice', email: 'alice@example.invalid' } })
    await db().pluginInstall.create({
      data: {
        pluginId: 'skiller', status: 'ready', enabled: true, activeVersion: PLUGIN_VERSION,
        grantedPermissions: ['override:user_skill.text'],
      },
    })
    await db().userAttackSkill.create({ data: { id: SOURCE_ID, userId: 'alice', name: 'Source flow', content: SOURCE_TEXT } })
  })

  afterAll(async () => {
    await db()?.$disconnect()
  })

  test('the status CHECK lists adopted, and still refuses a status it does not list', async () => {
    const [{ ck }] = await db().$queryRaw<{ ck: string }[]>`
      SELECT pg_get_constraintdef(oid) AS ck FROM pg_constraint
       WHERE conrelid = 'plugin_overrides'::regclass AND conname = 'plugin_overrides_status_ck2'`
    expect(ck).toContain("'adopted'")
    await db().pluginOverride.create({ data: row('adopted', 'set-a') })
    await expect(db().pluginOverride.create({ data: row('kept', 'set-b') })).rejects.toThrow(/plugin_overrides_status_ck/)
  })

  test('two adopted rows for one target coexist; two active ones still collide (the index is there)', async () => {
    await db().pluginOverride.create({ data: row('adopted', 'set-a') })
    await db().pluginOverride.create({ data: row('adopted', 'set-b') })
    expect(await db().pluginOverride.count({ where: { status: 'adopted', targetKey: `${SOURCE_ID}/body` } })).toBe(2)

    await db().pluginOverride.create({ data: row('active', 'set-c') })
    await expect(db().pluginOverride.create({ data: row('active', 'set-d') })).rejects.toThrow(/plugin_overrides_one_active|Unique constraint/)
  })

  test('the real save path: two proposals for one source both become saved versions, both rows adopted', async () => {
    const first = await proposeVersion('# Source flow\n\nStep one, better.\n')
    const second = await proposeVersion('# Source flow\n\nStep one, different.\n')
    const actor = { actorId: 'alice', source: 'ui' as const }
    const a = await adoptUserSkillVersion({ changeSetId: first, ownerId: 'alice', actor, name: 'Source flow v2' })
    const b = await adoptUserSkillVersion({ changeSetId: second, ownerId: 'alice', actor, name: 'Source flow v3' })

    expect([a.version, b.version]).toEqual([2, 3])
    const rows = await db().pluginOverride.findMany({ where: { targetGroup: SOURCE_ID }, orderBy: { createdAt: 'asc' } })
    expect(rows.map((r) => r.status)).toEqual(['adopted', 'adopted'])
    expect(rows.map((r) => (r.meta as Record<string, unknown>).adoptedSkillId)).toEqual([a.skillId, b.skillId])

    const skills = await db().userAttackSkill.findMany({ where: { userId: 'alice' }, orderBy: { name: 'asc' } })
    expect(skills.map((s) => [s.name, s.version, s.lineageRootId, s.originPluginVersion])).toEqual([
      ['Source flow', 1, SOURCE_ID, null],
      ['Source flow v2', 2, SOURCE_ID, PLUGIN_VERSION],
      ['Source flow v3', 3, SOURCE_ID, PLUGIN_VERSION],
    ])
    expect(skills[0].content).toBe(SOURCE_TEXT)
  })

  test('saving with a project swaps its toggles, keeps builtIn, and moves updatedAt', async () => {
    const T0 = new Date('2026-01-01T00:00:00.000Z')
    const builtIn = { sql_injection: true, xss: false }
    await db().project.create({
      data: { id: 'p1', userId: 'alice', name: 'p1', attackSkillConfig: { builtIn, user: { [SOURCE_ID]: true } } },
    })
    await db().$executeRaw`UPDATE projects SET updated_at = ${T0} WHERE id = 'p1'`
    const changeSetId = await proposeVersion('# Source flow\n\nStep one, swapped in.\n')
    const r = await adoptUserSkillVersion({
      changeSetId, ownerId: 'alice', actor: { actorId: 'alice', source: 'ui' }, name: 'Source flow v2',
      projectId: 'p1', enableNew: true, disableSource: true,
    })
    const p = await db().project.findUniqueOrThrow({ where: { id: 'p1' } })
    expect(p.attackSkillConfig).toEqual({ builtIn, user: { [SOURCE_ID]: false, [r.skillId]: true } })
    expect(p.updatedAt.getTime()).toBeGreaterThan(T0.getTime())
  })
})
