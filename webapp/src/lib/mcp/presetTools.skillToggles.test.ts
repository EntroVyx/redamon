/**
 * apply_recon_preset and the user-skill toggles (D10, D15, §9 row 5).
 *
 * The MCP apply writes `application.data`, so the toggles validateApplication
 * normalized against the project OWNER's skills are what lands: foreign ids dropped,
 * more than 20 on refused as setting_rejected with nothing written, and a preset that
 * does not name a `user` map keeps the project's own toggles instead of turning every
 * user skill off. The project row lives in an in-memory Prisma double.
 *
 * @vitest-environment node
 */
import { describe, test, expect, beforeEach, vi } from 'vitest'

const h = vi.hoisted(() => ({
  db: null as unknown as Record<string, unknown>,
  extra: {} as Record<string, unknown>,
  presetSettings: {} as Record<string, unknown>,
}))

vi.mock('@/lib/prisma', () => ({
  // The test's own stubs first: a table the shared double also models is replaced, not shadowed.
  default: new Proxy({}, { get: (_t, k) => h.extra[k as string] ?? h.db[k as string] }),
}))
vi.mock('@/lib/orchestrator', () => ({ orchestratorFetch: vi.fn() }))
vi.mock('@/lib/graphWriters', () => ({ describeLiveGraphWriters: async () => null, describeScanWriters: async () => null }))
vi.mock('@/lib/audit', () => ({ writeAudit: vi.fn(async () => undefined) }))
vi.mock('@/lib/reconPresets/badges', () => ({ renamePresetBadges: vi.fn(), clearPresetBadges: vi.fn() }))
vi.mock('@/lib/reconPresets/server', async () => {
  const actual = await vi.importActual<typeof import('@/lib/reconPresets/server')>('@/lib/reconPresets/server')
  return { ...actual, fetchBackendDefaults: async () => ({}) }
})

import { createFakePrisma, type FakePrisma } from '@/lib/plugins/__testing__/fakePrisma'
import { __resetRateLimiter, type McpScope } from '@/lib/mcpAuth'
import { extractPresetSettings } from '@/lib/project-preset-utils'
import { applyReconPreset } from './presetTools'
import type { McpContext } from './tools'

const ctx = (): McpContext => ({
  token: {
    tokenId: 't1', userId: 'owner', tokenPrefix: 'rdmn_mcp_aaaaaaaa', name: 'agent',
    scopes: ['recon:read', 'preset:write', 'preset:apply'] as McpScope[],
  },
})
const DEFAULT_BUILT_IN = (extractPresetSettings({}).attackSkillConfig as { builtIn: Record<string, boolean> }).builtIn
const CUSTOM_BUILT_IN = { ...DEFAULT_BUILT_IN, xss: !DEFAULT_BUILT_IN.xss }
const ownerIds = (n: number) => Array.from({ length: n }, (_, i) => `own${String(i).padStart(2, '0')}`)
const allOn = (ids: string[]) => Object.fromEntries(ids.map((id) => [id, true]))
const PROJECT_AT = new Date('2026-10-01T08:00:00.000Z')

let db: FakePrisma
const storedConfig = () => db.rows('project')[0].attackSkillConfig

const apply = () => applyReconPreset(ctx(), { projectId: 'p1', presetId: 'up1' })

beforeEach(() => {
  db = createFakePrisma()
  h.db = db as unknown as Record<string, unknown>
  h.presetSettings = { katanaDepth: 3 }
  h.extra = {
    userProjectPreset: {
      findFirst: async () => ({
        id: 'up1', name: 'Mine', description: '', settings: h.presetSettings, updatedAt: PROJECT_AT,
        createdVia: 'ui', updatedVia: 'ui', lastWriterTokenPrefix: null,
      }),
    },
    jobQueue: { findMany: async () => [] },
    scanSchedule: { findMany: async () => [] },
    fireteamSettingsAudit: { createMany: async () => ({ count: 0 }) },
    userLlmProvider: { count: async () => 0 },
    userSettings: { findUnique: async () => null },
  }
  __resetRateLimiter()
  db.seed('project', [{
    ...extractPresetSettings({}),
    id: 'p1', userId: 'owner', name: 'p', loadedPreset: null, ipMode: false, domainBatchMode: false,
    updatedAt: PROJECT_AT,
    attackSkillConfig: { builtIn: CUSTOM_BUILT_IN, user: { own00: true, own01: false } },
  }])
  db.seed('userAttackSkill', [
    ...ownerIds(25).map((id) => ({ id, userId: 'owner', name: `flow ${id}`, content: '# x' })),
    { id: 'otherSkill', userId: 'other', name: 'other flow', content: '# x' },
  ])
})

describe('apply_recon_preset writes the normalized toggles', () => {
  test('a preset that does not name attackSkillConfig resets builtIn and keeps the project\'s user map', async () => {
    const r = await apply()
    expect(r.written).toBe(true)
    expect(storedConfig()).toEqual({ builtIn: DEFAULT_BUILT_IN, user: { own00: true, own01: false } })
  })

  test('a preset naming attackSkillConfig without a user map keeps the project\'s user map', async () => {
    h.presetSettings = { attackSkillConfig: { builtIn: { ...DEFAULT_BUILT_IN, rce: false } } }
    await apply()
    expect(storedConfig()).toEqual({ builtIn: { ...DEFAULT_BUILT_IN, rce: false }, user: { own00: true, own01: false } })
  })

  test('a preset carrying a user map: its own ids are kept, the ones this owner does not have dropped', async () => {
    h.presetSettings = { attackSkillConfig: { builtIn: DEFAULT_BUILT_IN, user: { own05: true, otherSkill: true, ghost: true } } }
    await apply()
    expect(storedConfig()).toEqual({ builtIn: DEFAULT_BUILT_IN, user: { own05: true } })
  })
})

describe('apply_recon_preset refuses, and writes nothing', () => {
  test('a preset turning on 21 of the owner\'s skills is setting_rejected', async () => {
    h.presetSettings = { katanaDepth: 4, attackSkillConfig: { builtIn: DEFAULT_BUILT_IN, user: allOn(ownerIds(21)) } }
    await expect(apply()).rejects.toMatchObject({ code: 'setting_rejected' })
    await expect(apply()).rejects.toThrow('A project can use at most 20 of your skills; this turns on 21.')
    expect(storedConfig()).toEqual({ builtIn: CUSTOM_BUILT_IN, user: { own00: true, own01: false } })
    expect(db.rows('project')[0].katanaDepth).not.toBe(4)
  })
})
