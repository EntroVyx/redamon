/**
 * The user skills the agent receives for a project (plan 0.A.2, 0.B, 4.9 D14): only ids set
 * to `true`, owned by the project's owner and not quarantined, by name then id, at most 20,
 * each with the family members it `supersedes` in that project.
 *
 * @vitest-environment node
 */
import { describe, test, expect, beforeEach } from 'vitest'
import type { Prisma } from '@prisma/client'
import { createFakePrisma, type FakePrisma } from '@/lib/plugins/__testing__/fakePrisma'
import { enabledUserSkillIds, userSkillsForAgent } from './userSkillAgentPayload'

let db: FakePrisma
// The fake as the client type the module takes (it implements the subset used).
let pg: Prisma.TransactionClient

function seed(rows: Record<string, unknown>[]) {
  db.seed('userAttackSkill', rows.map((r) => ({ userId: 'alice', content: `${r.id} text`, ...r })))
}

const cfg = (user: Record<string, unknown>) => ({ builtIn: {}, user })

beforeEach(() => {
  db = createFakePrisma()
  pg = db as unknown as Prisma.TransactionClient
})

describe('enabledUserSkillIds', () => {
  test('only ids whose value is exactly true', () => {
    expect(enabledUserSkillIds(cfg({ a: true, b: false, c: 'true', d: 1, e: null }))).toEqual(['a'])
  })

  test.each([[null], [[]], ['x'], [{ builtIn: {} }], [{ user: [] }], [{ user: null }]])('nothing from %j', (config) => {
    expect(enabledUserSkillIds(config)).toEqual([])
  })
})

describe('userSkillsForAgent', () => {
  test('no enabled id, no query', async () => {
    const reader = { userAttackSkill: { findMany: async () => { throw new Error('no read expected') } } }
    expect(await userSkillsForAgent(reader as never, 'alice', cfg({ a: false }))).toEqual([])
    expect(await userSkillsForAgent(reader as never, 'alice', { builtIn: {} })).toEqual([])
  })

  test('only true ids, the fields the agent reads, and supersedes [] without a family', async () => {
    seed([
      { id: 'on', name: 'On', description: 'Turned on' },
      { id: 'off', name: 'Off' },
      { id: 'missing', name: 'Missing' },
    ])
    expect(await userSkillsForAgent(pg, 'alice', cfg({ on: true, off: false }))).toEqual([
      { id: 'on', name: 'On', description: 'Turned on', content: 'on text', supersedes: [] },
    ])
  })

  test("another user's skill set to true in this project is never sent", async () => {
    seed([{ id: 'mine', name: 'Mine' }, { id: 'theirs', userId: 'bob', name: 'Theirs' }])
    expect((await userSkillsForAgent(pg, 'alice', cfg({ mine: true, theirs: true }))).map((s) => s.id)).toEqual(['mine'])
  })

  test('a quarantined skill is never sent, even when set to true', async () => {
    seed([{ id: 'ok', name: 'Ok' }, { id: 'q', name: 'Quarantined', quarantinedAt: new Date('2026-10-01T00:00:00Z') }])
    expect((await userSkillsForAgent(pg, 'alice', cfg({ ok: true, q: true }))).map((s) => s.id)).toEqual(['ok'])
  })

  test('ordered by name, then id, and cut to 20', async () => {
    // Seeded in reverse so the order cannot come from insertion.
    const rows = Array.from({ length: 24 }, (_, i) => ({ id: `id_${String(23 - i).padStart(2, '0')}`, name: `Skill ${String(23 - i).padStart(2, '0')}` }))
    rows.push({ id: 'id_tie_b', name: 'Skill 00' }, { id: 'id_tie_a', name: 'Skill 00' })
    seed(rows)
    const out = await userSkillsForAgent(pg, 'alice', cfg(Object.fromEntries(rows.map((r) => [r.id, true]))))
    expect(out).toHaveLength(20)
    expect(out.slice(0, 4).map((s) => s.id)).toEqual(['id_00', 'id_tie_a', 'id_tie_b', 'id_01'])
    expect(out.at(-1)!.id).toBe('id_17')
  })

  describe('supersedes', () => {
    test('the source off and v2 on: v2 supersedes the source', async () => {
      seed([
        { id: 'src', name: 'Flow', lineageRootId: 'src', version: 1 },
        { id: 'v2', name: 'Flow v2', lineageRootId: 'src', version: 2 },
      ])
      const out = await userSkillsForAgent(pg, 'alice', cfg({ src: false, v2: true }))
      expect(out).toEqual([expect.objectContaining({ id: 'v2', supersedes: ['src'] })])
    })

    test('a member with no toggle at all is off, so it is superseded too', async () => {
      seed([
        { id: 'src', name: 'Flow', lineageRootId: 'src', version: 1 },
        { id: 'v2', name: 'Flow v2', lineageRootId: 'src', version: 2 },
      ])
      expect((await userSkillsForAgent(pg, 'alice', cfg({ v2: true })))[0].supersedes).toEqual(['src'])
    })

    test('the whole family on: nothing to supersede', async () => {
      seed([
        { id: 'src', name: 'Flow', lineageRootId: 'src', version: 1 },
        { id: 'v2', name: 'Flow v2', lineageRootId: 'src', version: 2 },
      ])
      const out = await userSkillsForAgent(pg, 'alice', cfg({ src: true, v2: true }))
      expect(out.map((s) => s.supersedes)).toEqual([[], []])
    })

    test('two members on: only the highest version gets the off ones', async () => {
      seed([
        { id: 'src', name: 'Flow', lineageRootId: 'src', version: 1 },
        { id: 'v2', name: 'Flow v2', lineageRootId: 'src', version: 2 },
        { id: 'v3', name: 'Flow v3', lineageRootId: 'src', version: 3 },
        { id: 'v4', name: 'Flow v4', lineageRootId: 'src', version: 4 },
      ])
      const out = await userSkillsForAgent(pg, 'alice', cfg({ src: false, v2: true, v3: true, v4: false }))
      const by = Object.fromEntries(out.map((s) => [s.id, s.supersedes]))
      expect(by).toEqual({ v2: [], v3: ['src', 'v4'] })
    })

    test('a quarantined member that is off is still superseded by the enabled head', async () => {
      seed([
        { id: 'src', name: 'Flow', lineageRootId: 'src', version: 1 },
        { id: 'v2', name: 'Flow v2', lineageRootId: 'src', version: 2 },
        { id: 'v3', name: 'Flow v3', lineageRootId: 'src', version: 3, quarantinedAt: new Date(), quarantineReason: 'plugin_version_revoked' },
      ])
      const out = await userSkillsForAgent(pg, 'alice', cfg({ src: false, v2: true, v3: false }))
      expect(out).toEqual([expect.objectContaining({ id: 'v2', supersedes: ['src', 'v3'] })])
    })

    test('families do not mix, and another user\'s skill in the same lineage is not superseded', async () => {
      seed([
        { id: 'a1', name: 'Alpha', lineageRootId: 'a1', version: 1 },
        { id: 'a2', name: 'Alpha v2', lineageRootId: 'a1', version: 2 },
        { id: 'b1', name: 'Beta', lineageRootId: 'b1', version: 1 },
        { id: 'b2', name: 'Beta v2', lineageRootId: 'b1', version: 2 },
        { id: 'bob_a3', userId: 'bob', name: 'Alpha v3', lineageRootId: 'a1', version: 3 },
      ])
      const out = await userSkillsForAgent(pg, 'alice', cfg({ a2: true, b1: true }))
      expect(Object.fromEntries(out.map((s) => [s.id, s.supersedes]))).toEqual({ a2: ['a1'], b1: ['b2'] })
    })

    test('a skill outside any family never supersedes', async () => {
      seed([
        { id: 'plain', name: 'Plain' },
        { id: 'other', name: 'Other' },
      ])
      expect((await userSkillsForAgent(pg, 'alice', cfg({ plain: true, other: false })))[0].supersedes).toEqual([])
    })
  })
})
