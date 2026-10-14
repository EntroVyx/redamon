/**
 * update_recon_settings and the user-skill toggles (D10, §9 row 11).
 *
 * The MCP writer is the other door onto `attackSkillConfig`. The registry validator
 * refuses a malformed shape; the cross-field rule then normalizes the value against the
 * project OWNER's skills, and the normalized value is what the compare-and-swap writes,
 * because the writer builds its update from `filtered.data`, not from the row the rule
 * normalized. More than 20 of the owner's skills on is `setting_rejected`, with nothing
 * written. The project row lives in an in-memory Prisma double.
 *
 * @vitest-environment node
 */
import { describe, test, expect, beforeEach, vi } from 'vitest'

const h = vi.hoisted(() => ({ db: null as unknown as Record<string, unknown>, extra: {} as Record<string, unknown> }))

vi.mock('@/lib/prisma', () => ({
  // The test's own stubs first: a table the shared double also models is replaced, not shadowed.
  default: new Proxy({}, { get: (_t, k) => h.extra[k as string] ?? h.db[k as string] }),
}))
vi.mock('@/lib/orchestrator', () => ({ orchestratorFetch: vi.fn() }))
vi.mock('@/lib/graphWriters', () => ({
  describeLiveGraphWriters: async () => null,
  describeScanWriters: async () => null,
}))
vi.mock('@/lib/startFullScan', () => ({ startFullScan: vi.fn() }))
vi.mock('@/lib/audit', () => ({ writeAudit: vi.fn(async () => undefined) }))

import { createFakePrisma, type FakePrisma } from '@/lib/plugins/__testing__/fakePrisma'
import { __resetRateLimiter } from '@/lib/mcpAuth'
import { updateReconSettings } from './writeTools'
import type { McpContext } from './tools'

const BUILT_IN = { sql_injection: true, xss: false }
const READ_AT = new Date('2026-10-01T08:00:00.000Z')
const ownerIds = (n: number) => Array.from({ length: n }, (_, i) => `own${String(i).padStart(2, '0')}`)
const allOn = (ids: string[]) => Object.fromEntries(ids.map((id) => [id, true]))

const ctx = (): McpContext => ({
  token: {
    tokenId: 't1', userId: 'owner', tokenPrefix: 'rdmn_mcp_aaaaaaaa',
    name: 'agent', scopes: ['recon:read', 'recon:settings'] as never,
  },
})

let db: FakePrisma
const storedConfig = () => db.rows('project')[0].attackSkillConfig

beforeEach(() => {
  db = createFakePrisma()
  h.db = db as unknown as Record<string, unknown>
  h.extra = {
    jobQueue: { findMany: async () => [] },
    scanSchedule: { findMany: async () => [] },
    fireteamSettingsAudit: { createMany: async () => ({ count: 0 }) },
    userLlmProvider: { count: async () => 0 },
    projectAuthProfile: { findUnique: async () => null },
  }
  __resetRateLimiter()
  db.seed('project', [{
    id: 'p1', userId: 'owner', name: 'p', updatedAt: READ_AT, katanaDepth: 2,
    attackSkillConfig: { builtIn: BUILT_IN, user: { own00: true } },
  }])
  db.seed('userAttackSkill', [
    ...ownerIds(25).map((id) => ({ id, userId: 'owner', name: `flow ${id}`, content: '# x' })),
    { id: 'otherSkill', userId: 'other', name: 'other flow', content: '# x' },
  ])
})

describe('update_recon_settings writes the normalized toggles', () => {
  test('ids the owner does not have are dropped from what is written, and from what is reported', async () => {
    const r = await updateReconSettings(ctx(), 'p1', {
      attackSkillConfig: { builtIn: BUILT_IN, user: { own01: true, own02: false, otherSkill: true, ghost: true } },
    })
    const expected = { builtIn: BUILT_IN, user: { own01: true, own02: false } }
    expect(storedConfig()).toEqual(expected)
    expect(r.updated.attackSkillConfig).toEqual(expected)
    expect(r.changed).toEqual(['attackSkillConfig'])
  })

  test('a config with no user map is written with an empty one', async () => {
    await updateReconSettings(ctx(), 'p1', { attackSkillConfig: { builtIn: BUILT_IN } })
    expect(storedConfig()).toEqual({ builtIn: BUILT_IN, user: {} })
  })

  test('20 of the owner\'s skills on, plus foreign trues, is written as the 20', async () => {
    await updateReconSettings(ctx(), 'p1', {
      attackSkillConfig: { builtIn: BUILT_IN, user: { ...allOn(ownerIds(20)), otherSkill: true } },
    })
    expect(storedConfig()).toEqual({ builtIn: BUILT_IN, user: allOn(ownerIds(20)) })
  })
})

describe('update_recon_settings refuses, and writes nothing', () => {
  test('21 of the owner\'s skills on is setting_rejected with the limit message', async () => {
    await expect(updateReconSettings(ctx(), 'p1', {
      attackSkillConfig: { builtIn: BUILT_IN, user: allOn(ownerIds(21)) }, katanaDepth: 5,
    })).rejects.toMatchObject({
      code: 'setting_rejected',
      message: 'A project can use at most 20 of your skills; this turns on 21. Turn some off first.',
    })
    expect(storedConfig()).toEqual({ builtIn: BUILT_IN, user: { own00: true } })
    expect(db.rows('project')[0].katanaDepth).toBe(2)
  })

  test('true on a quarantined skill is setting_rejected', async () => {
    db.seed('userAttackSkill', [{ id: 'quar', userId: 'owner', name: 'Revoked flow', content: '# x', quarantinedAt: new Date() }])
    await expect(updateReconSettings(ctx(), 'p1', { attackSkillConfig: { builtIn: BUILT_IN, user: { quar: true } } }))
      .rejects.toMatchObject({ code: 'setting_rejected' })
    expect(storedConfig()).toEqual({ builtIn: BUILT_IN, user: { own00: true } })
  })

  test.each([
    ['an array', []],
    ['a missing builtIn', { user: {} }],
    ['a non-boolean toggle', { builtIn: BUILT_IN, user: { own01: 'on' } }],
    ['an extra key', { builtIn: BUILT_IN, user: {}, notes: 'x' }],
  ])('%s is refused by the registry validator, naming the key', async (_label, value) => {
    await expect(updateReconSettings(ctx(), 'p1', { attackSkillConfig: value }))
      .rejects.toMatchObject({ code: 'setting_rejected', audit: { rejectedKey: 'attackSkillConfig' } })
    expect(storedConfig()).toEqual({ builtIn: BUILT_IN, user: { own00: true } })
  })
})

describe('a write that does not name the toggles never reads the skills', () => {
  test('a stored map the normalizer would refuse survives an unrelated write', async () => {
    const legacy = { builtIn: BUILT_IN, user: { ...allOn(ownerIds(25)), otherSkill: true } }
    db.tables.project.get('p1')!.attackSkillConfig = legacy
    let reads = 0
    const findMany = db.userAttackSkill.findMany
    db.userAttackSkill.findMany = async (a) => { reads++; return findMany(a) }
    await updateReconSettings(ctx(), 'p1', { katanaDepth: 4 })
    expect(db.rows('project')[0].katanaDepth).toBe(4)
    expect(storedConfig()).toEqual(legacy)
    expect(reads).toBe(0)
  })
})
