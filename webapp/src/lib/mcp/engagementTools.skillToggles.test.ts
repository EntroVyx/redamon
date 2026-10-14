/**
 * create_project and the user-skill toggles (D10, §9 row 11).
 *
 * `settings.attackSkillConfig` passes the registry's shape validator, then is normalized
 * against the TOKEN owner's skills (the creator): ids the creator does not have are
 * dropped from the create call, and more than 20 on, or a quarantined one on, is
 * setting_rejected before anything is written.
 *
 * @vitest-environment node
 */
import { describe, test, expect, beforeEach, vi } from 'vitest'

const h = vi.hoisted(() => ({
  createProject: vi.fn(),
  findProject: vi.fn(),
  skillFindMany: vi.fn(),
  skills: [] as { id: string; userId: string; name: string; quarantinedAt: Date | null }[],
}))

vi.mock('@/lib/prisma', () => {
  const client = {
    project: {
      create: (...a: unknown[]) => h.createProject(...a),
      findUnique: (...a: unknown[]) => h.findProject(...a),
    },
    engagementAuthorization: {
      create: vi.fn(), findFirst: async () => null, findUnique: async () => null,
      findMany: async () => [], count: async () => 0,
    },
    scanJob: { findFirst: async () => null },
    userLlmProvider: { count: async () => 0 },
    userAttackSkill: { findMany: (...a: unknown[]) => h.skillFindMany(...a) },
    $transaction: (fn: (tx: unknown) => unknown) => fn(client),
  }
  return { default: client }
})
vi.mock('@/lib/graphWriters', () => ({ describeScanWriters: async () => null }))
vi.mock('@/lib/audit', () => ({ writeAudit: vi.fn(async () => undefined) }))

import { __resetRateLimiter } from '@/lib/mcpAuth'
import { createProject } from './engagementTools'
import type { McpContext } from './tools'

const ctx = (): McpContext => ({
  token: {
    tokenId: 't1', userId: 'creator', tokenPrefix: 'rdmn_mcp_aaaaaaaa',
    name: 'agent', scopes: ['recon:read', 'project:create'] as never,
  },
})
const BUILT_IN = { sql_injection: true, xss: false }
const ids = (n: number) => Array.from({ length: n }, (_, i) => `own${String(i).padStart(2, '0')}`)
const allOn = (list: string[]) => Object.fromEntries(list.map((id) => [id, true]))

const create = (attackSkillConfig: unknown) => createProject(ctx(), {
  name: 'test', engagementKind: 'internal', targetDomain: 'example.invalid',
  settings: { attackSkillConfig } as never,
})

beforeEach(() => {
  vi.clearAllMocks()
  __resetRateLimiter()
  h.skills = [
    ...ids(25).map((id) => ({ id, userId: 'creator', name: `flow ${id}`, quarantinedAt: null })),
    { id: 'otherSkill', userId: 'other', name: 'other flow', quarantinedAt: null },
    { id: 'quar', userId: 'creator', name: 'Revoked flow', quarantinedAt: new Date('2026-10-01T00:00:00Z') },
  ]
  h.skillFindMany.mockImplementation(async ({ where }: { where: { userId: string; id: { in: string[] } } }) =>
    h.skills.filter((s) => s.userId === where.userId && where.id.in.includes(s.id)))
  h.createProject.mockResolvedValue({ id: 'p1', name: 'test' })
  h.findProject.mockResolvedValue(null)
})

describe('create_project: the toggles name only the creator\'s skills', () => {
  test('ids the creator does not have are dropped from the create call', async () => {
    const r = await create({ builtIn: BUILT_IN, user: { own00: true, own01: false, otherSkill: true, ghost: true } })
    expect(r.created).toBe(true)
    expect(h.createProject.mock.calls[0][0].data.attackSkillConfig)
      .toEqual({ builtIn: BUILT_IN, user: { own00: true, own01: false } })
    expect(h.skillFindMany.mock.calls[0][0].where.userId).toBe('creator')
  })

  test('20 on is created as sent', async () => {
    await create({ builtIn: BUILT_IN, user: allOn(ids(20)) })
    expect(h.createProject.mock.calls[0][0].data.attackSkillConfig.user).toEqual(allOn(ids(20)))
  })
})

describe('create_project: refused, nothing created', () => {
  test('21 on is setting_rejected naming attackSkillConfig, with the limit message', async () => {
    await expect(create({ builtIn: BUILT_IN, user: allOn(ids(21)) })).rejects.toMatchObject({
      code: 'setting_rejected',
      audit: { rejectedKey: 'attackSkillConfig' },
      message: 'A project can use at most 20 of your skills; this turns on 21. Turn some off first.',
    })
    expect(h.createProject).not.toHaveBeenCalled()
  })

  test('a quarantined skill on is setting_rejected', async () => {
    await expect(create({ builtIn: BUILT_IN, user: { quar: true } }))
      .rejects.toMatchObject({ code: 'setting_rejected' })
    expect(h.createProject).not.toHaveBeenCalled()
  })

  test.each([
    ['a missing builtIn', { user: {} }],
    ['an array', []],
    ['a non-boolean toggle', { builtIn: BUILT_IN, user: { own00: 'true' } }],
  ])('%s is refused by the registry validator', async (_label, value) => {
    await expect(create(value)).rejects.toMatchObject({ code: 'setting_rejected' })
    expect(h.createProject).not.toHaveBeenCalled()
    expect(h.skillFindMany).not.toHaveBeenCalled()
  })
})
