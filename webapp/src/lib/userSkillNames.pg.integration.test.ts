/**
 * The D7 name key and the per-user lock, on a real Postgres: what the in-memory double
 * (fakePrisma's ASCII approximation of the key) cannot prove.
 *
 * - The key `lower(regexp_replace(regexp_replace(normalize(name, NFC), <spaces>, ' ', 'g'), '^ | $', '', 'g'))`
 *   is computed by Postgres on BOTH sides, so a legacy stored name with tabs, double or
 *   edge spaces, a no-break space, other case or decomposed letters collides with its tidy
 *   form, and so does an input of any of those.
 * - `\s` reaches Postgres as a regex class, never as a literal `s` ("Bass" is not "Ba").
 * - The advisory lock of userSkillWrites.ts serializes concurrent creates of one user on
 *   pooled connections: the same name twice makes one row, and the last free slot under
 *   the 1000-skill cap goes to one create.
 *
 * Needs a DISPOSABLE database holding the webapp schema (`prisma db push`); it empties
 * `user_attack_skills` and `users` (CASCADE) between tests. Run it with
 *   PLUGINS_PG_TEST_URL=postgresql://... npx vitest run --no-file-parallelism src/lib/userSkillNames.pg.integration.test.ts
 * Without the variable it is skipped. It refuses a database that already holds users
 * unless that database carries the pg-integration marker table, so a real database is
 * never wiped.
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

import type { PrismaClient } from '@prisma/client'
import { MAX_SKILLS_PER_USER, NAME_MAX_CHARS } from './userSkills'
import { isNameTaken, nameKeys, normalizeName, suggestVersionName } from './userSkillNames'
import { createUserSkill, type AuditActor } from './userSkillWrites'

const MARKER = 'plugins_pg_integration_test_marker'
const db = () => h.db as PrismaClient
const ACTOR: AuditActor = { actorId: 'alice', source: 'ui' }

/** A stored row exactly as given: legacy names were never normalized. */
const stored = (id: string, userId: string, name: string, over: Record<string, unknown> = {}) =>
  db().userAttackSkill.create({ data: { id, userId, name, content: '# body', ...over } })

const settle = <T,>(ps: Promise<T>[]) => Promise.allSettled(ps)
const outcome = (r: PromiseSettledResult<unknown>) =>
  r.status === 'fulfilled' ? 'ok' : ((r.reason as { code?: string }).code ?? String(r.reason))

describe.skipIf(!URL)('user skill names on a real Postgres (PLUGINS_PG_TEST_URL)', () => {
  beforeAll(async () => {
    const [{ users }] = await db().$queryRaw<{ users: number }[]>`SELECT count(*)::int AS users FROM users`
    const [{ marked }] = await db().$queryRaw<{ marked: boolean }[]>`SELECT to_regclass(${MARKER}) IS NOT NULL AS marked`
    if (users > 0 && !marked) throw new Error('Refusing to run: this database holds users and is not a disposable test database')
    await db().$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS ${MARKER} (created_at timestamptz DEFAULT now())`)
  })

  beforeEach(async () => {
    await db().$executeRawUnsafe('TRUNCATE user_attack_skills, users CASCADE')
    await db().user.createMany({
      data: [
        { id: 'alice', name: 'Alice', email: 'alice@example.invalid' },
        { id: 'bob', name: 'Bob', email: 'bob@example.invalid' },
      ],
    })
  })

  afterAll(async () => {
    await db()?.$disconnect()
  })

  describe('isNameTaken: the SQL key of a legacy stored name', () => {
    beforeEach(async () => {
      await stored('s-case', 'alice', 'My Flow')
      await stored('s-tab', 'alice', 'Tab\tSeparated')
      await stored('s-double', 'alice', 'Double  Space')
      await stored('s-edge', 'alice', '  Padded name \t')
      await stored('s-newline', 'alice', 'Line\nBreak')
      await stored('s-cafe', 'alice', 'Café recon')
      await stored('s-bass', 'alice', 'Bass')
      await stored('s-dot', 'alice', 'a.b')
      await stored('s-bob', 'bob', 'Bob flow')
    })

    test.each([
      ['case', 'my flow'],
      ['case, upper', 'MY FLOW'],
      ['a stored tab', 'tab separated'],
      ['stored double spaces', 'double space'],
      ['stored leading and trailing spaces', 'padded name'],
      ['a stored newline', 'line break'],
      ['input spacing, raw (the key is computed on the input too)', '  my \t  FLOW  '],
    ])('%s: "%s" is taken', async (_label, input) => {
      expect(await isNameTaken(db(), 'alice', input)).toBe(true)
    })

    test.each([
      ['a different name', 'My Flows'],
      ['an inner space that is not in the stored name', 'MyFlow'],
      ['`\\s` is a regex class in SQL, never a literal "s" ("Bass" is not "Ba")', 'Ba'],
      ['a regex metacharacter in the stored name is data, not a pattern', 'axb'],
      ['a quote in the input is a parameter, not SQL', "x' OR '1'='1"],
    ])('%s: "%s" is free', async (_label, input) => {
      expect(await isNameTaken(db(), 'alice', input)).toBe(false)
    })

    test('NBSP and other Unicode spaces in the INPUT: normalizeName collapses them, then it collides', async () => {
      for (const raw of ['My Flow', ' My Flow　', 'My    Flow']) {
        expect(normalizeName(raw)).toBe('My Flow')
        expect(await isNameTaken(db(), 'alice', normalizeName(raw)), JSON.stringify(raw)).toBe(true)
      }
    })

    test('NFC: an NFD input collides with a stored NFC name, also before normalizeName', async () => {
      const nfd = 'Café recon'
      expect(normalizeName(nfd)).toBe('Café recon')
      expect(await isNameTaken(db(), 'alice', normalizeName(nfd))).toBe(true)
      expect(await isNameTaken(db(), 'alice', 'café RECON')).toBe(true)
      expect(await isNameTaken(db(), 'alice', nfd)).toBe(true)
    })

    test('a legacy stored name with a no-break space or decomposed letters collides with its tidy form', async () => {
      await stored('s-nbsp', 'alice', 'Legacy\u00a0Flow')
      await stored('s-nfd', 'alice', 'Re\u0301sume\u0301 recon')
      expect(await isNameTaken(db(), 'alice', 'legacy flow')).toBe(true)
      expect(await isNameTaken(db(), 'alice', normalizeName('R\u00e9sum\u00e9 recon'))).toBe(true)
    })

    test('exceptId: the skill being renamed does not collide with itself, another skill still does', async () => {
      expect(await isNameTaken(db(), 'alice', 'my flow', 's-case')).toBe(false)
      expect(await isNameTaken(db(), 'alice', 'tab separated', 's-case')).toBe(true)
      await stored('s-case-dup', 'alice', 'MY  FLOW')
      expect(await isNameTaken(db(), 'alice', 'my flow', 's-case')).toBe(true)
    })

    test('names are per user', async () => {
      expect(await isNameTaken(db(), 'alice', 'bob flow')).toBe(false)
      expect(await isNameTaken(db(), 'bob', 'BOB  FLOW')).toBe(true)
      expect(await isNameTaken(db(), 'bob', 'my flow')).toBe(false)
    })
  })

  describe('nameKeys', () => {
    test('the key of each string, in input order', async () => {
      expect(await nameKeys(db(), ['  A\tB  ', 'a b', 'X', 'Bass', 'Line\r\nBreak', 'a.b', 'a b']))
        .toEqual(['a b', 'a b', 'x', 'bass', 'line break', 'a.b', 'a b'])
    })

    test('order holds for many inputs (ORDER BY ordinality, not the planner)', async () => {
      const names = Array.from({ length: 300 }, (_, i) => `Name ${String(299 - i).padStart(3, '0')}`)
      expect(await nameKeys(db(), names)).toEqual(names.map((n) => n.toLowerCase()))
    })

    test('an empty list asks nothing', async () => {
      expect(await nameKeys({ $queryRaw: () => { throw new Error('queried') } } as never, [])).toEqual([])
    })
  })

  describe('suggestVersionName', () => {
    test('the next number over every same-root name, whatever its spacing or case', async () => {
      const src = await stored('root', 'alice', 'Recon flow')
      await stored('v2', 'alice', 'recon  FLOW v2')
      await stored('v3', 'alice', ' Recon flow   V3')
      expect(await suggestVersionName(db(), 'alice', src)).toEqual({ name: 'Recon flow v4', version: 4 })
    })

    test('a renamed member of the lineage still counts', async () => {
      const src = await stored('root', 'alice', 'Recon flow', { version: 1 })
      await stored('renamed', 'alice', 'Totally different', { lineageRootId: 'root', version: 5 })
      expect(await suggestVersionName(db(), 'alice', src)).toEqual({ name: 'Recon flow v6', version: 6 })
    })

    test('another user\'s versions do not count', async () => {
      const src = await stored('root', 'alice', 'Recon flow')
      await stored('bob-v9', 'bob', 'Recon flow v9')
      expect(await suggestVersionName(db(), 'alice', src)).toEqual({ name: 'Recon flow v2', version: 2 })
    })

    test('a root at the length limit is cut so the suggestion fits, and is free', async () => {
      const long = 'x'.repeat(NAME_MAX_CHARS)
      const src = await stored('root', 'alice', long)
      const { name, version } = await suggestVersionName(db(), 'alice', src)
      expect(version).toBe(2)
      expect(name.length).toBeLessThanOrEqual(NAME_MAX_CHARS)
      expect(name.endsWith(' v2')).toBe(true)
      expect(await isNameTaken(db(), 'alice', name)).toBe(false)
    })
  })

  describe('createUserSkill under the per-user advisory lock (real concurrency)', () => {
    test('ten creates of the same name, spelled differently, make exactly one row', async () => {
      const spellings = ['Race flow', 'race  FLOW', ' Race flow ', 'RACE\tflow', 'Race flow']
      const results = await settle(Array.from({ length: 10 }, (_, i) =>
        createUserSkill({ userId: 'alice', name: spellings[i % spellings.length], content: `# ${i}` }, ACTOR)))
      expect(results.map(outcome).sort()).toEqual(['name_taken', 'name_taken', 'name_taken', 'name_taken',
        'name_taken', 'name_taken', 'name_taken', 'name_taken', 'name_taken', 'ok'])
      const rows = await db().userAttackSkill.findMany({ where: { userId: 'alice' } })
      expect(rows).toHaveLength(1)
      expect(spellings.map(normalizeName)).toContain(rows[0].name)
    })

    test('the refusal carries a free suggestion', async () => {
      const results = await settle([0, 1].map(() =>
        createUserSkill({ userId: 'alice', name: 'Twin', content: '# t' }, ACTOR)))
      const refused = results.find((r) => r.status === 'rejected') as PromiseRejectedResult
      expect(refused.reason.extra.suggestion).toBe('Twin v2')
    })

    test('two users may create the same name at once', async () => {
      const results = await settle(['alice', 'bob'].map((userId) =>
        createUserSkill({ userId, name: 'Shared name', content: '# s' }, { actorId: userId, source: 'ui' })))
      expect(results.map(outcome)).toEqual(['ok', 'ok'])
    })

    test('the last free slot under the cap goes to exactly one of several concurrent creates', async () => {
      await db().userAttackSkill.createMany({
        data: Array.from({ length: MAX_SKILLS_PER_USER - 1 }, (_, i) => ({
          userId: 'alice', name: `seed ${i}`, content: '# s',
        })),
      })
      const results = await settle(Array.from({ length: 6 }, (_, i) =>
        createUserSkill({ userId: 'alice', name: `last slot ${i}`, content: '# l' }, ACTOR)))
      expect(results.map(outcome).sort()).toEqual(['ok', 'skill_limit', 'skill_limit', 'skill_limit', 'skill_limit', 'skill_limit'])
      expect(await db().userAttackSkill.count({ where: { userId: 'alice' } })).toBe(MAX_SKILLS_PER_USER)
    })

    test('the stored name is the normalized one', async () => {
      await createUserSkill({ userId: 'alice', name: '  Café  flow\t', content: '# n' }, ACTOR)
      const [row] = await db().userAttackSkill.findMany({ where: { userId: 'alice' } })
      expect(row.name).toBe('Café flow')
    })
  })
})
