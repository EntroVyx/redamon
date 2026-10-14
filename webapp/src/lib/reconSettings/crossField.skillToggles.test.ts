/**
 * validateCrossFieldRules and the user-skill toggles (D9, D10).
 *
 * `attackSkillConfig` is the one cross-field rule that also NORMALIZES: the value in
 * `nextRow` is replaced by the form it may be stored in, so every writer that shares this
 * function (the project PUT, MCP update_recon_settings, preset apply) writes the same
 * thing. The toggles are judged against the project OWNER's skills: the explicit
 * `ownerUserId` first, then `nextRow.userId`, then the actor. A write that does not touch
 * the key is never judged on it.
 *
 * @vitest-environment node
 */
import { describe, test, expect, beforeEach, vi } from 'vitest'

const h = vi.hoisted(() => ({ db: null as unknown as Record<string, unknown> }))
vi.mock('@/lib/prisma', () => ({ default: new Proxy({}, { get: (_t, k) => h.db[k as string] }) }))

import { createFakePrisma, type FakePrisma } from '@/lib/plugins/__testing__/fakePrisma'
import { MAX_ENABLED_USER_SKILLS_PER_PROJECT } from '@/lib/userSkills'
import { validateCrossFieldRules } from './crossField'

const BUILT_IN = { sql_injection: true, xss: false }

let db: FakePrisma

function seedSkills(userId: string, ids: string[], over: Record<string, unknown> = {}) {
  db.seed('userAttackSkill', ids.map((id) => ({ id, userId, name: `skill ${id}`, content: '# body', ...over })))
}

const ownerIds = (n: number) => Array.from({ length: n }, (_, i) => `own${String(i).padStart(2, '0')}`)
const allOn = (ids: string[]) => Object.fromEntries(ids.map((id) => [id, true]))

beforeEach(() => {
  db = createFakePrisma()
  h.db = db as unknown as Record<string, unknown>
  seedSkills('owner', ownerIds(25))
  seedSkills('admin', ['adminSkill'])
  seedSkills('other', ['otherSkill'])
})

describe('the toggles are replaced in nextRow by their storable form', () => {
  test('ids the owner does not have are dropped; the owner\'s own on and off values are kept', async () => {
    const nextRow: Record<string, unknown> = {
      attackSkillConfig: {
        builtIn: BUILT_IN,
        user: { own00: true, own01: false, otherSkill: true, ghost: true },
      },
    }
    expect(await validateCrossFieldRules(nextRow, ['attackSkillConfig'], 'owner')).toBeNull()
    expect(nextRow.attackSkillConfig).toEqual({ builtIn: BUILT_IN, user: { own00: true, own01: false } })
  })

  test('a config with no user map gets an empty one; builtIn is kept as sent', async () => {
    const nextRow: Record<string, unknown> = { attackSkillConfig: { builtIn: BUILT_IN } }
    expect(await validateCrossFieldRules(nextRow, ['attackSkillConfig'], 'owner')).toBeNull()
    expect(nextRow.attackSkillConfig).toEqual({ builtIn: BUILT_IN, user: {} })
  })

  test('exactly the limit of the owner\'s skills on is accepted', async () => {
    const ids = ownerIds(MAX_ENABLED_USER_SKILLS_PER_PROJECT)
    const nextRow: Record<string, unknown> = { attackSkillConfig: { builtIn: BUILT_IN, user: allOn(ids) } }
    expect(await validateCrossFieldRules(nextRow, ['attackSkillConfig'], 'owner')).toBeNull()
    expect(Object.keys((nextRow.attackSkillConfig as { user: object }).user)).toHaveLength(20)
  })

  test('foreign ids never count toward the limit: 20 own plus 5 foreign trues is accepted', async () => {
    const user = { ...allOn(ownerIds(20)), otherSkill: true, adminSkill: true, a: true, b: true, c: true }
    const nextRow: Record<string, unknown> = { attackSkillConfig: { builtIn: BUILT_IN, user } }
    expect(await validateCrossFieldRules(nextRow, ['attackSkillConfig'], 'owner')).toBeNull()
    expect((nextRow.attackSkillConfig as { user: Record<string, boolean> }).user).toEqual(allOn(ownerIds(20)))
  })

  test('the owner\'s skills switched off never count toward the limit', async () => {
    const user = { ...allOn(ownerIds(20)), own20: false, own21: false, own22: false }
    const nextRow: Record<string, unknown> = { attackSkillConfig: { builtIn: BUILT_IN, user } }
    expect(await validateCrossFieldRules(nextRow, ['attackSkillConfig'], 'owner')).toBeNull()
  })
})

describe('refusals return a message and leave nextRow as it was', () => {
  test('one more than the limit of the owner\'s skills on is refused, naming the limit and the count', async () => {
    const config = { builtIn: BUILT_IN, user: allOn(ownerIds(21)) }
    const nextRow: Record<string, unknown> = { attackSkillConfig: config }
    const error = await validateCrossFieldRules(nextRow, ['attackSkillConfig'], 'owner')
    expect(error).toBe(
      'A project can use at most 20 of your skills; this turns on 21. Turn some off first.')
    expect(nextRow.attackSkillConfig).toBe(config)
  })

  test('true on a quarantined skill is refused, naming it', async () => {
    db.seed('userAttackSkill', [{
      id: 'quar', userId: 'owner', name: 'Revoked flow', content: '# x',
      quarantinedAt: new Date('2026-10-01T00:00:00Z'), quarantineReason: 'revoked',
    }])
    const nextRow: Record<string, unknown> = { attackSkillConfig: { builtIn: BUILT_IN, user: { quar: true } } }
    const error = await validateCrossFieldRules(nextRow, ['attackSkillConfig'], 'owner')
    expect(error).toContain('"Revoked flow" is quarantined')
  })

  test('a quarantined skill switched off is accepted (turning it off is always allowed)', async () => {
    db.seed('userAttackSkill', [{
      id: 'quar', userId: 'owner', name: 'Revoked flow', content: '# x', quarantinedAt: new Date(),
    }])
    const nextRow: Record<string, unknown> = { attackSkillConfig: { builtIn: BUILT_IN, user: { quar: false } } }
    expect(await validateCrossFieldRules(nextRow, ['attackSkillConfig'], 'owner')).toBeNull()
    expect(nextRow.attackSkillConfig).toEqual({ builtIn: BUILT_IN, user: { quar: false } })
  })

  test.each([
    ['a missing builtIn (never invented: the agent reads it as "no built-in skill")', { user: {} }, 'must carry builtIn'],
    ['an array', [], 'must be an object'],
    ['null', null, 'must be an object'],
    ['an unknown top-level key', { builtIn: BUILT_IN, user: {}, extra: {} }, "unknown key 'extra'"],
    ['a non-boolean user toggle', { builtIn: BUILT_IN, user: { own00: 'yes' } }, 'user.own00 must be true or false'],
    ['a non-boolean built-in toggle', { builtIn: { xss: 1 }, user: {} }, 'builtIn.xss must be true or false'],
    ['a user map that is an array', { builtIn: BUILT_IN, user: ['own00'] }, 'user must be an object'],
  ])('%s is refused', async (_label, value, message) => {
    const nextRow: Record<string, unknown> = { attackSkillConfig: value }
    const error = await validateCrossFieldRules(nextRow, ['attackSkillConfig'], 'owner')
    expect(error).toContain('attackSkillConfig')
    expect(error).toContain(message)
    expect(nextRow.attackSkillConfig).toBe(value)
  })

  test('a database failure is thrown, never turned into an accepted write', async () => {
    db.userAttackSkill.findMany = async () => { throw new Error('db down') }
    const nextRow: Record<string, unknown> = { attackSkillConfig: { builtIn: BUILT_IN, user: { own00: true } } }
    await expect(validateCrossFieldRules(nextRow, ['attackSkillConfig'], 'owner')).rejects.toThrow('db down')
  })
})

describe('whose skills the toggles may name', () => {
  const config = () => ({ builtIn: BUILT_IN, user: { own00: true, adminSkill: true, otherSkill: true } })
  const userOf = (row: Record<string, unknown>) => (row.attackSkillConfig as { user: Record<string, boolean> }).user

  test('opts.ownerUserId wins over nextRow.userId and the actor (an admin acting on a project)', async () => {
    const nextRow: Record<string, unknown> = { userId: 'other', attackSkillConfig: config() }
    expect(await validateCrossFieldRules(nextRow, ['attackSkillConfig'], 'admin', { ownerUserId: 'owner' })).toBeNull()
    expect(userOf(nextRow)).toEqual({ own00: true })
  })

  test('without opts, nextRow.userId is the owner, not the actor', async () => {
    const nextRow: Record<string, unknown> = { userId: 'owner', attackSkillConfig: config() }
    expect(await validateCrossFieldRules(nextRow, ['attackSkillConfig'], 'admin')).toBeNull()
    expect(userOf(nextRow)).toEqual({ own00: true })
  })

  test('without opts and without nextRow.userId, the actor is the owner', async () => {
    const nextRow: Record<string, unknown> = { attackSkillConfig: config() }
    expect(await validateCrossFieldRules(nextRow, ['attackSkillConfig'], 'admin')).toBeNull()
    expect(userOf(nextRow)).toEqual({ adminSkill: true })
  })

  test('ownerUserId null (a project with no owner) may name none', async () => {
    const nextRow: Record<string, unknown> = { userId: 'owner', attackSkillConfig: config() }
    expect(await validateCrossFieldRules(nextRow, ['attackSkillConfig'], 'owner', { ownerUserId: null })).toBeNull()
    expect(userOf(nextRow)).toEqual({})
  })

  test('the limit counts the OWNER\'s skills: the actor\'s 21 would not exist for this owner', async () => {
    seedSkills('admin', ownerIds(21).map((id) => `adm-${id}`))
    const user = allOn(ownerIds(21).map((id) => `adm-${id}`))
    const nextRow: Record<string, unknown> = { attackSkillConfig: { builtIn: BUILT_IN, user } }
    expect(await validateCrossFieldRules(nextRow, ['attackSkillConfig'], 'admin', { ownerUserId: 'owner' })).toBeNull()
    expect(userOf(nextRow)).toEqual({})
  })
})

describe('a write that does not touch the toggles is never judged on them', () => {
  test('an invalid stored value is left alone when the key is not touched', async () => {
    const legacy = { builtIn: BUILT_IN, user: allOn(ownerIds(25)), stray: 1 }
    const nextRow: Record<string, unknown> = { attackSkillConfig: legacy, katanaDepth: 3 }
    let reads = 0
    const findMany = db.userAttackSkill.findMany
    db.userAttackSkill.findMany = async (a) => { reads++; return findMany(a) }
    expect(await validateCrossFieldRules(nextRow, ['katanaDepth'], 'owner')).toBeNull()
    expect(nextRow.attackSkillConfig).toBe(legacy)
    expect(reads).toBe(0)
  })

  test('a touched key that nextRow does not carry is not judged', async () => {
    const nextRow: Record<string, unknown> = { katanaDepth: 3 }
    expect(await validateCrossFieldRules(nextRow, ['attackSkillConfig', 'katanaDepth'], 'owner')).toBeNull()
    expect(nextRow).not.toHaveProperty('attackSkillConfig')
  })
})
