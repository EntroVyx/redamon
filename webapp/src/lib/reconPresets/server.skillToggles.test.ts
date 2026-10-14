/**
 * Applying a preset and the user-skill toggles (D10, D15, §9 rows 5 and 11).
 *
 * computePresetApplication keeps the project's own `user` toggle map unless the preset
 * carries one (D15); validateApplication then judges the result against the project
 * OWNER's skills, looked up from the project (the applied row is limited to readable
 * fields and the actor may be an admin), and copies the normalized value back into
 * `application.data`, which is what the caller writes.
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

import { createFakePrisma, type FakePrisma } from '@/lib/plugins/__testing__/fakePrisma'
import { extractPresetSettings } from '@/lib/project-preset-utils'
import { computePresetApplication, validateApplication } from './server'

const PRESET = { name: 'Mine', id: 'up1', source: 'user' as const }
const DEFAULT_BUILT_IN = (extractPresetSettings({}).attackSkillConfig as { builtIn: Record<string, boolean> }).builtIn
const ownerIds = (n: number) => Array.from({ length: n }, (_, i) => `own${String(i).padStart(2, '0')}`)
const allOn = (ids: string[]) => Object.fromEntries(ids.map((id) => [id, true]))

let db: FakePrisma
let ownerReads: number

const row = (attackSkillConfig: unknown): Record<string, unknown> => ({ ...extractPresetSettings({}), attackSkillConfig })

beforeEach(() => {
  db = createFakePrisma()
  h.db = db as unknown as Record<string, unknown>
  h.extra = { userLlmProvider: { count: async () => 0 }, userSettings: { findUnique: async () => null } }
  db.seed('project', [{ id: 'p1', userId: 'owner', name: 'p' }])
  db.seed('userAttackSkill', [
    ...ownerIds(25).map((id) => ({ id, userId: 'owner', name: `flow ${id}`, content: '# x' })),
    { id: 'adminSkill', userId: 'admin', name: 'admin flow', content: '# x' },
  ])
  ownerReads = 0
  const findUnique = db.project.findUnique
  db.project.findUnique = async (a) => { ownerReads++; return findUnique(a) }
})

describe('a preset that names a user map', () => {
  test('ids the OWNER does not have are dropped from application.data (the actor is an admin)', async () => {
    const current = row({ builtIn: DEFAULT_BUILT_IN, user: {} })
    const app = computePresetApplication(current, {
      attackSkillConfig: { builtIn: DEFAULT_BUILT_IN, user: { own00: true, adminSkill: true, ghost: false } },
    }, {}, PRESET)
    expect(app.changed).toContain('attackSkillConfig')
    expect(await validateApplication(app, current, 'p1', 'admin')).toBeNull()
    expect(app.data.attackSkillConfig).toEqual({ builtIn: DEFAULT_BUILT_IN, user: { own00: true } })
  })

  test('21 of the owner\'s skills on is refused, keyless, with the limit message', async () => {
    const current = row({ builtIn: DEFAULT_BUILT_IN, user: {} })
    const app = computePresetApplication(current, {
      attackSkillConfig: { builtIn: DEFAULT_BUILT_IN, user: allOn(ownerIds(21)) },
    }, {}, PRESET)
    expect(await validateApplication(app, current, 'p1', 'owner')).toEqual({
      key: '',
      error: 'A project can use at most 20 of your skills; this turns on 21. Turn some off first.',
    })
  })

  test('a malformed config is refused by the registry check, naming the key', async () => {
    const current = row({ builtIn: DEFAULT_BUILT_IN, user: {} })
    const app = computePresetApplication(current, { attackSkillConfig: { user: { own00: true } } }, {}, PRESET)
    const problem = await validateApplication(app, current, 'p1', 'owner')
    expect(problem?.key).toBe('attackSkillConfig')
    expect(problem?.error).toContain('must carry builtIn')
  })

  test('the owner read failing refuses the apply', async () => {
    db.project.findUnique = async () => { throw new Error('db down') }
    const current = row({ builtIn: DEFAULT_BUILT_IN, user: {} })
    const app = computePresetApplication(current, {
      attackSkillConfig: { builtIn: DEFAULT_BUILT_IN, user: { own00: true } },
    }, {}, PRESET)
    expect(await validateApplication(app, current, 'p1', 'owner')).toEqual({
      key: '', error: 'The project owner could not be read to check its skill toggles; nothing was written',
    })
  })

  test('a project with no owner row keeps no user toggle at all', async () => {
    const current = row({ builtIn: DEFAULT_BUILT_IN, user: {} })
    const app = computePresetApplication(current, {
      attackSkillConfig: { builtIn: DEFAULT_BUILT_IN, user: { own00: true } },
    }, {}, PRESET)
    expect(await validateApplication(app, current, 'missing', 'owner')).toBeNull()
    expect(app.data.attackSkillConfig).toEqual({ builtIn: DEFAULT_BUILT_IN, user: {} })
  })
})

describe('a preset that does not name the toggles (D15)', () => {
  test('builtIn resets to the default, the project\'s own user map is kept and then normalized', async () => {
    const current = row({ builtIn: { ...DEFAULT_BUILT_IN, xss: !DEFAULT_BUILT_IN.xss }, user: { own00: true, own01: false, adminSkill: true } })
    const app = computePresetApplication(current, { katanaDepth: 3 }, {}, PRESET)
    expect(app.changed).toContain('attackSkillConfig')
    expect(app.resetToDefault).toContain('attackSkillConfig')
    expect(await validateApplication(app, current, 'p1', 'owner')).toBeNull()
    expect(app.data.attackSkillConfig).toEqual({ builtIn: DEFAULT_BUILT_IN, user: { own00: true, own01: false } })
  })

  test('when nothing about the toggles moves they are not judged and the owner is not read', async () => {
    const current = row({ builtIn: DEFAULT_BUILT_IN, user: { own00: true, adminSkill: true } })
    const app = computePresetApplication(current, { katanaDepth: 3 }, {}, PRESET)
    expect(app.changed).not.toContain('attackSkillConfig')
    expect(await validateApplication(app, current, 'p1', 'owner')).toBeNull()
    expect(ownerReads).toBe(0)
    expect(app.data.attackSkillConfig).toEqual({ builtIn: DEFAULT_BUILT_IN, user: { own00: true, adminSkill: true } })
  })
})
