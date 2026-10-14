/**
 * The override store at `user_skill.text` (overrides.ts): the terminal `adopted` status, the
 * transaction-scoped helpers adoption, skill deletion and revocation use (lockChangeSet,
 * markAdoptedIn, deleteUserSkillProposalsTx, withdrawRevokedIn), and approve() refusing to
 * make a user-skill proposal active.
 *
 * @vitest-environment node
 */
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'
import { readFileSync } from 'fs'
import path from 'path'

const h = vi.hoisted(() => ({ db: null as unknown as Record<string, unknown> }))
vi.mock('@/lib/prisma', () => ({ default: new Proxy({}, { get: (_t, k) => h.db[k as string] }) }))

import { createFakePrisma, type FakePrisma } from './__testing__/fakePrisma'
import { setNowForTests } from './clock'
import * as ov from './overrides'
import { PluginOverrideError } from './overrides'

const T0 = Date.parse('2026-10-09T12:00:00Z')
const H = 'a'.repeat(64)
let db: FakePrisma
let t = T0

beforeEach(() => {
  db = createFakePrisma()
  h.db = db as unknown as Record<string, unknown>
  db.seed('pluginInstall', [
    { pluginId: 'skiller', status: 'ready', enabled: true, grantedPermissions: ['override:user_skill.text'] },
    { pluginId: 'echo', status: 'ready', enabled: true, grantedPermissions: ['override:user_skill.text', 'override:skill.text'] },
  ])
  t = T0
  setNowForTests(() => new Date(t))
})
afterEach(() => setNowForTests(null))

async function userSkillSet(opts: { owner?: string; skill?: string; pluginId?: string; value?: string; meta?: Record<string, unknown> } = {}) {
  const skill = opts.skill ?? 'skflow'
  const owner = opts.owner ?? 'alice'
  const { changeSetId } = await ov.propose({
    pluginId: opts.pluginId ?? 'skiller',
    point: 'user_skill.text',
    scope: { type: 'user', id: owner },
    targetGroup: skill,
    parts: [{ targetKey: `${skill}/body`, value: opts.value ?? 'new text', baseSha256: H }],
    meta: opts.meta as never,
    platformMeta: { baseText: 'old text', sourceName: 'Flow', pluginVersion: '1.1.0', conversationId: 'conv-1', jobId: 'job-1' },
    createdBy: owner,
  })
  return changeSetId
}

async function builtinSet(group = 'skflow') {
  const { changeSetId } = await ov.propose({
    pluginId: 'skiller', point: 'skill.text', scope: { type: 'user', id: 'alice' }, targetGroup: group,
    parts: [{ targetKey: `${group}/workflow`, value: 'w', baseSha256: H }], createdBy: 'alice',
  })
  return changeSetId
}

const rowsOf = (cs: string) => db.rows('pluginOverride').filter((r) => r.changeSetId === cs)
const statusOf = (cs: string) => rowsOf(cs)[0]?.status
const code = async (p: Promise<unknown>) => {
  const e = await p.catch((x: unknown) => x)
  expect(e).toBeInstanceOf(PluginOverrideError)
  return (e as PluginOverrideError).code
}

describe('the statuses and the platform meta keys', () => {
  test('adopted is a status, terminal, after the 1.0.0 ones; the CHECK script lists the same', () => {
    expect([...ov.OVERRIDE_STATUSES]).toEqual(['proposed', 'active', 'rejected', 'withdrawn', 'superseded', 'stale', 'cleared', 'adopted'])
    const script = readFileSync(path.resolve(__dirname, '../../../scripts/apply-plugin-constraints.mjs'), 'utf8')
    const m = script.match(/const OVERRIDE_STATUSES = \[([^\]]*)\]/)
    expect(m![1].match(/'[^']+'/g)!.map((s) => s.slice(1, -1))).toEqual([...ov.OVERRIDE_STATUSES])
  })

  test('the platform writes every key D2 names, and a plugin can set none of them', async () => {
    for (const k of ['baseText', 'sourceName', 'adoptedSkillId', 'adoptedName', 'pluginVersion', 'conversationId', 'jobId', 'withdrawReason',
      'staleReason', 'fromRevision', 'baseFactoryText', 'basedOn']) {
      expect(ov.PLATFORM_META_KEYS, k).toContain(k)
    }
    const forged = Object.fromEntries(ov.PLATFORM_META_KEYS.map((k) => [k, 'forged']))
    const cs = await userSkillSet({ meta: { ...forged, mine: 1 } })
    expect(rowsOf(cs)[0].meta).toEqual({
      mine: 1, baseText: 'old text', sourceName: 'Flow', pluginVersion: '1.1.0', conversationId: 'conv-1', jobId: 'job-1',
    })
  })

  test('a user-skill proposal is stored proposed, without a revision', async () => {
    const cs = await userSkillSet()
    expect(rowsOf(cs)).toEqual([expect.objectContaining({
      extensionPoint: 'user_skill.text', scopeType: 'user', scopeId: 'alice', userId: 'alice', targetGroup: 'skflow',
      targetKey: 'skflow/body', status: 'proposed', revision: null,
    })])
  })
})

describe('lockChangeSet', () => {
  test("takes the lock of the set's scope and skill, then reads the set under it", async () => {
    const cs = await userSkillSet()
    db.rawCalls.length = 0
    const rows = await db.$transaction((tx) => ov.lockChangeSet(tx as never, cs))
    expect(rows.map((r) => r.changeSetId)).toEqual([cs])
    expect(db.rawCalls).toEqual([{ sql: expect.stringContaining('pg_advisory_xact_lock'), values: ['override:user_skill.text:user:alice:skflow'] }])
  })

  test('an unknown id is not_found; a malformed one is not_found before any query', async () => {
    expect(await code(db.$transaction((tx) => ov.lockChangeSet(tx as never, '11111111-2222-3333-4444-555555555555')))).toBe('not_found')
    const find = vi.spyOn(db.pluginOverride, 'findFirst')
    for (const bad of ['', 'x', undefined, null]) {
      expect(await code(db.$transaction((tx) => ov.lockChangeSet(tx as never, bad as never)))).toBe('not_found')
    }
    expect(find).not.toHaveBeenCalled()
  })
})

describe('markAdoptedIn', () => {
  const adopt = (cs: string, decidedBy = 'alice', adopted = { skillId: 'sknew', name: 'Flow v2' }) =>
    db.$transaction(async (tx) => ov.markAdoptedIn(tx as never, await ov.lockChangeSet(tx as never, cs), decidedBy, adopted))

  test('proposed → adopted with who decided and when, and the skill it became; the platform meta stays', async () => {
    const cs = await userSkillSet({ meta: { mine: 1 } })
    t += 5000
    await adopt(cs, 'user-admin')
    expect(rowsOf(cs)[0]).toMatchObject({
      status: 'adopted', decidedBy: 'user-admin', decidedAt: new Date(T0 + 5000), revision: null,
      meta: { mine: 1, baseText: 'old text', sourceName: 'Flow', pluginVersion: '1.1.0', conversationId: 'conv-1', jobId: 'job-1', adoptedSkillId: 'sknew', adoptedName: 'Flow v2' },
    })
    // An adopted set no longer waits: it frees its pending slot.
    expect(await ov.pendingCount({ type: 'user', id: 'alice' }, 'user_skill.text', 'skflow')).toBe(0)
  })

  test('a skill.text set is refused (wrong_state) and unchanged', async () => {
    const cs = await builtinSet()
    expect(await code(adopt(cs))).toBe('wrong_state')
    expect(statusOf(cs)).toBe('proposed')
  })

  test.each(['rejected', 'withdrawn', 'adopted'] as const)('a %s set is refused (wrong_state) and unchanged', async (state) => {
    const cs = await userSkillSet()
    if (state === 'rejected') await ov.reject(cs, 'alice')
    if (state === 'withdrawn') await ov.withdraw(cs, 'skiller')
    if (state === 'adopted') await adopt(cs)
    const before = rowsOf(cs)
    expect(await code(adopt(cs, 'alice', { skillId: 'other', name: 'Other' }))).toBe('wrong_state')
    expect(rowsOf(cs)).toEqual(before)
  })

  test('no decider: refused', async () => {
    const cs = await userSkillSet()
    expect(await code(adopt(cs, ''))).toBe('invalid_target')
    expect(statusOf(cs)).toBe('proposed')
  })

  test('rows that no longer match the set (it changed while saved): wrong_state, and the transaction leaves it proposed', async () => {
    const cs = await userSkillSet()
    const err = await db.$transaction(async (tx) => {
      const rows = await ov.lockChangeSet(tx as never, cs)
      return ov.markAdoptedIn(tx as never, [...rows, { ...rows[0], id: 'ghost' }], 'alice', { skillId: 's', name: 'n' })
    }).catch((e: unknown) => e)
    expect((err as PluginOverrideError).code).toBe('wrong_state')
    expect(statusOf(cs)).toBe('proposed')
  })
})

describe('deleteUserSkillProposalsTx', () => {
  test("deletes the user's sets for that skill that did not become a skill, and returns them; adopted ones stay", async () => {
    const proposed = await userSkillSet()
    const rejected = await userSkillSet()
    await ov.reject(rejected, 'alice')
    const withdrawn = await userSkillSet({ pluginId: 'echo' })
    await ov.withdraw(withdrawn, 'echo')
    const adopted = await userSkillSet()
    await db.$transaction(async (tx) => ov.markAdoptedIn(tx as never, await ov.lockChangeSet(tx as never, adopted), 'alice', { skillId: 'skv2', name: 'Flow v2' }))
    const otherSkill = await userSkillSet({ skill: 'skother' })
    const bobs = await userSkillSet({ owner: 'bob' })
    const builtin = await builtinSet('skflow')

    db.rawCalls.length = 0
    const removed = await db.$transaction((tx) => ov.deleteUserSkillProposalsTx(tx as never, 'alice', 'skflow'))
    expect(removed.sort((a, b) => a.changeSetId.localeCompare(b.changeSetId))).toEqual([
      { changeSetId: proposed, pluginId: 'skiller', status: 'proposed' },
      { changeSetId: rejected, pluginId: 'skiller', status: 'rejected' },
      { changeSetId: withdrawn, pluginId: 'echo', status: 'withdrawn' },
    ].sort((a, b) => a.changeSetId.localeCompare(b.changeSetId)))
    const left = new Set(db.rows('pluginOverride').map((r) => r.changeSetId))
    expect(left).toEqual(new Set([adopted, otherSkill, bobs, builtin]))
    expect(db.rawCalls).toEqual([{ sql: expect.stringContaining('pg_advisory_xact_lock'), values: ['override:user_skill.text:user:alice:skflow'] }])
  })

  test('nothing to delete: an empty list', async () => {
    expect(await db.$transaction((tx) => ov.deleteUserSkillProposalsTx(tx as never, 'alice', 'skflow'))).toEqual([])
  })

  test('a malformed skill id or no user: an empty list and nothing removed (never a where without its key)', async () => {
    const cs = await userSkillSet()
    for (const [user, skill] of [['alice', 'Bad-Id'], ['alice', ''], ['', 'skflow'], ['alice', undefined]] as const) {
      expect(await db.$transaction((tx) => ov.deleteUserSkillProposalsTx(tx as never, user, skill as never))).toEqual([])
    }
    expect(statusOf(cs)).toBe('proposed')
  })
})

describe('withdrawRevokedIn', () => {
  const run = (cs: string) => db.$transaction((tx) => ov.withdrawRevokedIn(tx as never, cs))

  test("proposed → withdrawn, decided now by nobody, meta.withdrawReason 'revoked' next to the rest", async () => {
    const cs = await userSkillSet({ meta: { mine: 1 } })
    t += 1000
    expect(await run(cs)).toBe(true)
    expect(rowsOf(cs)[0]).toMatchObject({
      status: 'withdrawn', decidedBy: null, decidedAt: new Date(T0 + 1000),
      meta: { mine: 1, baseText: 'old text', pluginVersion: '1.1.0', withdrawReason: 'revoked' },
    })
  })

  test('a set that no longer waits, or does not exist: false and unchanged', async () => {
    const rejected = await userSkillSet()
    await ov.reject(rejected, 'alice')
    const adopted = await userSkillSet()
    await db.$transaction(async (tx) => ov.markAdoptedIn(tx as never, await ov.lockChangeSet(tx as never, adopted), 'alice', { skillId: 's', name: 'n' }))
    const before = db.rows('pluginOverride')
    expect(await run(rejected)).toBe(false)
    expect(await run(adopted)).toBe(false)
    expect(await run('11111111-2222-3333-4444-555555555555')).toBe(false)
    expect(db.rows('pluginOverride')).toEqual(before)
  })

  test('a second run is a no-op', async () => {
    const cs = await userSkillSet()
    expect(await run(cs)).toBe(true)
    const after = rowsOf(cs)
    expect(await run(cs)).toBe(false)
    expect(rowsOf(cs)).toEqual(after)
  })
})

describe('approve() never makes a user-skill proposal active', () => {
  test('wrong_state, the set stays proposed and no revision counter is raised', async () => {
    const cs = await userSkillSet()
    expect(await code(ov.approve(cs, 'alice', { 'skflow/body': H }))).toBe('wrong_state')
    expect(rowsOf(cs)[0]).toMatchObject({ status: 'proposed', revision: null, decidedBy: null })
    expect(db.rows('pluginPlatformState')).toEqual([])
    expect(db.rows('pluginOverride').some((r) => r.status === 'active')).toBe(false)
  })

  test('reject, withdraw and delete still work on a user-skill set', async () => {
    const a = await userSkillSet()
    await ov.reject(a, 'alice')
    expect(statusOf(a)).toBe('rejected')
    const b = await userSkillSet()
    await ov.withdraw(b, 'skiller')
    expect(statusOf(b)).toBe('withdrawn')
    expect(await ov.deleteChangeSet(b)).toEqual({ deleted: 1 })
    expect(rowsOf(b)).toEqual([])
  })
})
