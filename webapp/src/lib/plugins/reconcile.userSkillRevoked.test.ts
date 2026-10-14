/**
 * The catalog's kill switch at `user_skill.text` (userSkillRevocation.ts, reconcile step 3b):
 * for every (plugin, version) the verified catalog revokes, INSTALLED OR NOT, its proposals
 * still waiting are withdrawn (`meta.withdrawReason: 'revoked'`) and the skills people saved
 * from its proposals are quarantined and turned off in every project of their owner. Other
 * versions are untouched, a second run changes nothing, and a catalog that cannot load
 * revokes nothing.
 *
 * @vitest-environment node
 */
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'

const h = vi.hoisted(() => ({ db: null as unknown as Record<string, unknown>, audit: [] as Record<string, unknown>[] }))
vi.mock('@/lib/prisma', () => ({ default: new Proxy({}, { get: (_t, k) => h.db[k as string] }) }))
vi.mock('@/lib/audit', () => ({ writeAudit: vi.fn(async (e: Record<string, unknown>) => void h.audit.push(e)) }))

import { createFakePrisma, type FakePrisma, type Row } from './__testing__/fakePrisma'
import { ADMIN, NOW, startLifecycleWorld, type LifecycleWorld } from './__testing__/lifecycleHarness'
import { CatalogError } from './catalog'
import { setNowForTests } from './clock'
import { install } from './lifecycle'
import * as ov from './overrides'
import { reconcile } from './reconcile'
import { DERIVED_QUARANTINE_REASON, QUARANTINE_REASON, pairsWithUserSkillProvenance, revokeUserSkillProvenance } from './userSkillRevocation'
import { releaseUserSkill } from '@/lib/userSkillWrites'

const PERMS = ['session:read', 'llm:invoke', 'override:skill.text', 'override:user_skill.text']
const H = 'a'.repeat(64)
const REVOKED = [{ id: 'echo', version: '1.0.0', reason: 'Sends skill text out.' }]

let db: FakePrisma
let w: LifecycleWorld
const ids: Record<string, string> = {}

async function reconcileNow(deps: Parameters<typeof reconcile>[0]) {
  const r = await reconcile(deps)
  if ('skipped' in r) throw new Error('reconcile was busy')
  return r
}

async function userSkillSet(pluginId: string, pluginVersion: string, owner = 'alice', skill = 'sksource') {
  const { changeSetId } = await ov.propose({
    pluginId, point: 'user_skill.text', scope: { type: 'user', id: owner }, targetGroup: skill,
    parts: [{ targetKey: `${skill}/body`, value: 'proposed', baseSha256: H }],
    platformMeta: { baseText: 'base', sourceName: 'Source', pluginVersion, conversationId: 'conv-1', jobId: null },
    createdBy: owner,
  })
  return changeSetId
}

beforeEach(async () => {
  db = createFakePrisma()
  h.db = db as unknown as Record<string, unknown>
  h.audit = []
  setNowForTests(() => NOW)
  for (const m of ['warn', 'error', 'log'] as const) vi.spyOn(console, m).mockImplementation(() => {})
  db.seed('user', [
    { id: ADMIN, email: 'admin@example.com', role: 'admin' },
    { id: 'alice', email: 'alice@example.com', role: 'standard' },
    { id: 'bob', email: 'bob@example.com', role: 'standard' },
  ])
  w = await startLifecycleWorld(() => db)
  await install('echo', { version: '1.0.0', acceptedPermissions: PERMS }, ADMIN, w.deps)
  db.seed('pluginInstall', [{ pluginId: 'other', enabled: true, status: 'ready', activeVersion: '1.0.0', grantedPermissions: PERMS }])

  db.seed('userAttackSkill', [
    { id: 'sksource', userId: 'alice', name: 'Source', content: 'base' },
    { id: 'sksaved', userId: 'alice', name: 'Source v2', content: 'saved', originPluginId: 'echo', originPluginVersion: '1.0.0', originChangeSetId: 'cs-a', originChain: ['echo@1.0.0'] },
    { id: 'skbobsaved', userId: 'bob', name: 'Bob v2', content: 'saved', originPluginId: 'echo', originPluginVersion: '1.0.0', originChangeSetId: 'cs-b', originChain: ['echo@1.0.0'] },
    { id: 'skolder', userId: 'alice', name: 'Older v2', content: 'saved', originPluginId: 'echo', originPluginVersion: '0.9.0', originChangeSetId: 'cs-c', originChain: ['echo@0.9.0'] },
    { id: 'skothers', userId: 'alice', name: 'Other plugin v2', content: 'saved', originPluginId: 'other', originPluginVersion: '1.0.0', originChangeSetId: 'cs-d', originChain: ['other@1.0.0'] },
    { id: 'skmine', userId: 'alice', name: 'Uploaded', content: 'mine' },
  ])
  db.seed('project', [
    { id: 'p-a1', userId: 'alice', name: 'A1', attackSkillConfig: { builtIn: { xss: true }, user: { sksaved: true, skmine: true, skolder: true } } },
    { id: 'p-a2', userId: 'alice', name: 'A2', attackSkillConfig: { builtIn: {}, user: { sksaved: true } } },
    { id: 'p-a3', userId: 'alice', name: 'A3', attackSkillConfig: { builtIn: {}, user: { sksaved: false } } },
    { id: 'p-a4', userId: 'alice', name: 'A4', attackSkillConfig: null },
    { id: 'p-b1', userId: 'bob', name: 'B1', attackSkillConfig: { builtIn: {}, user: { skbobsaved: true } } },
  ])
  ids.waiting = await userSkillSet('echo', '1.0.0')
  ids.waitingBob = await userSkillSet('echo', '1.0.0', 'bob', 'skbobsaved')
  ids.olderVersion = await userSkillSet('echo', '0.9.0')
  ids.otherPlugin = await userSkillSet('other', '1.0.0')
  ids.rejected = await userSkillSet('echo', '1.0.0')
  await ov.reject(ids.rejected, 'alice')
  const { changeSetId } = await ov.propose({
    pluginId: 'echo', point: 'skill.text', scope: { type: 'user', id: 'alice' }, targetGroup: 'xss',
    parts: [{ targetKey: 'xss/workflow', value: 'w', baseSha256: H }], platformMeta: { pluginVersion: '1.0.0' }, createdBy: 'alice',
  })
  ids.builtin = changeSetId
  h.audit = []
})

afterEach(async () => {
  await w.close()
  setNowForTests(null)
  vi.restoreAllMocks()
})

const statusOf = (cs: string) => db.rows('pluginOverride').find((r) => r.changeSetId === cs)!
const skill = (id: string) => db.rows('userAttackSkill').find((s) => s.id === id)!
const userMap = (projectId: string) => ((db.rows('project').find((p) => p.id === projectId)!.attackSkillConfig as Row | null)?.user ?? null)

function expectRevoked(report: Awaited<ReturnType<typeof reconcileNow>>) {
  expect(report.userSkillRevocations.withdrawn.sort()).toEqual([ids.waiting, ids.waitingBob].sort())
  expect(report.userSkillRevocations.quarantined.sort()).toEqual(['skbobsaved', 'sksaved'])

  for (const cs of [ids.waiting, ids.waitingBob]) {
    expect(statusOf(cs)).toMatchObject({ status: 'withdrawn', decidedBy: null, decidedAt: NOW })
    expect(statusOf(cs).meta).toMatchObject({ pluginVersion: '1.0.0', baseText: 'base', withdrawReason: 'revoked' })
  }
  // Another version, another plugin, a decided set and a built-in proposal are left alone.
  expect(statusOf(ids.olderVersion).status).toBe('proposed')
  expect(statusOf(ids.otherPlugin).status).toBe('proposed')
  expect(statusOf(ids.rejected).status).toBe('rejected')
  expect(statusOf(ids.builtin).status).toBe('proposed')

  for (const id of ['sksaved', 'skbobsaved']) {
    expect(skill(id)).toMatchObject({ quarantinedAt: NOW, quarantineReason: QUARANTINE_REASON })
  }
  for (const id of ['skolder', 'skothers', 'skmine', 'sksource']) expect(skill(id)).toMatchObject({ quarantinedAt: null, quarantineReason: null })
  // Turned off, never deleted, in every project of its owner that had it on.
  expect(userMap('p-a1')).toEqual({ sksaved: false, skmine: true, skolder: true })
  expect(userMap('p-a2')).toEqual({ sksaved: false })
  expect(userMap('p-a3')).toEqual({ sksaved: false })
  expect(userMap('p-b1')).toEqual({ skbobsaved: false })
  expect((db.rows('project').find((p) => p.id === 'p-a1')!.attackSkillConfig as Row).builtIn).toEqual({ xss: true })
  expect(db.rows('project').find((p) => p.id === 'p-a4')!.attackSkillConfig).toBeNull()
}

describe('a revoked version that is installed', () => {
  test('its waiting proposals withdrawn, its saved skills quarantined and turned off; the plugin revoked as before', async () => {
    w.catalog.revoked = REVOKED
    const report = await reconcileNow(w.deps)
    expectRevoked(report)
    expect(report.revoked).toEqual(['echo'])
    expect(db.rows('pluginInstall').find((r) => r.pluginId === 'echo')).toMatchObject({ revokedReason: 'Sends skill text out.', enabled: true })
  })

  test('the audits: a system withdraw per set, a quarantine per skill with the projects turned off', async () => {
    w.catalog.revoked = REVOKED
    await reconcileNow(w.deps)
    const withdraws = h.audit.filter((a) => a.action === 'plugin.override.withdraw')
    expect(withdraws.map((a) => a.targetId).sort()).toEqual([ids.waiting, ids.waitingBob].sort())
    expect(withdraws.find((a) => a.targetId === ids.waiting)).toMatchObject({
      actorId: null, source: 'system', targetType: 'plugin_change_set',
      after: { point: 'user_skill.text', targetGroup: 'sksource', scope: 'user', scopeId: 'alice', reason: 'revoked', version: '1.0.0', pluginId: 'echo' },
    })
    const quarantines = h.audit.filter((a) => a.action === 'user_attack_skill.quarantine')
    expect(quarantines.find((a) => a.targetId === 'sksaved')).toMatchObject({
      actorId: null, source: 'system', targetType: 'user_attack_skill',
      after: { reason: QUARANTINE_REASON, pluginId: 'echo', pluginVersion: '1.0.0', userId: 'alice', projectsTurnedOff: ['p-a1', 'p-a2'] },
    })
    expect(quarantines.find((a) => a.targetId === 'skbobsaved')!.after).toMatchObject({ userId: 'bob', projectsTurnedOff: ['p-b1'] })
  })

  test('projects are written with update (updatedAt moves), never updateMany', async () => {
    const calls: string[] = []
    const orig = db.$transaction
    db.$transaction = (async (fn: (tx: FakePrisma) => Promise<unknown>, ...rest: unknown[]) =>
      (orig as (f: (tx: FakePrisma) => Promise<unknown>, ...r: unknown[]) => Promise<unknown>)(async (tx) => {
        const u = tx.project.update
        tx.project.update = (async (a: never) => (calls.push('update'), u(a))) as never
        tx.project.updateMany = (async () => {
          calls.push('updateMany')
          throw new Error('updateMany must not be used')
        }) as never
        return fn(tx)
      }, ...rest)) as never
    await revokeUserSkillProvenance('echo', '1.0.0')
    db.$transaction = orig
    expect(calls).toEqual(['update', 'update', 'update'])
  })

  test('a second run changes nothing and audits nothing of it', async () => {
    w.catalog.revoked = REVOKED
    await reconcileNow(w.deps)
    const before = { o: db.rows('pluginOverride'), s: db.rows('userAttackSkill'), p: db.rows('project') }
    h.audit = []
    const report = await reconcileNow(w.deps)
    expect(report.userSkillRevocations).toEqual({ withdrawn: [], quarantined: [] })
    expect(db.rows('pluginOverride')).toEqual(before.o)
    expect(db.rows('userAttackSkill')).toEqual(before.s)
    expect(db.rows('project')).toEqual(before.p)
    expect(h.audit.filter((a) => a.action === 'plugin.override.withdraw' || a.action === 'user_attack_skill.quarantine')).toEqual([])
  })

  test('a skill its owner released after reading it stays released at the next run (D3: release is the way back)', async () => {
    w.catalog.revoked = REVOKED
    await reconcileNow(w.deps)
    // The owner releases it (userSkillWrites.ts), then turns it back on.
    const owner = skill('sksaved').userId as string
    await releaseUserSkill({ userId: owner, skillId: 'sksaved' }, { actorId: owner, source: 'ui' })
    await db.project.update({ where: { id: 'p-a2' }, data: { attackSkillConfig: { builtIn: {}, user: { sksaved: true } } } })
    // The catalog keeps revoking 1.0.0 (a revocation is not lifted), and reconcile runs on a tick.
    const report = await reconcileNow(w.deps)
    expect(report.userSkillRevocations.quarantined).toEqual([])
    expect(skill('sksaved')).toMatchObject({ quarantinedAt: null, quarantineReason: null, quarantinedFor: null, releasedFor: ['echo@1.0.0'] })
    expect(userMap('p-a2')).toEqual({ sksaved: true })
  })
})

describe('versions saved from a revoked one', () => {
  const CHAIN = ['echo@1.0.0', 'other@1.0.0']
  beforeEach(() => {
    // v3 was saved by ANOTHER plugin version from a proposal built on sksaved's text, then v4
    // from v3: their chains carry echo@1.0.0 on. skorphan's source was deleted since (its
    // derivedFromId went to null), its chain still holds it. skreleased's owner had released it
    // from echo@1.0.0's revocation, and skwhat, saved from it, inherited that release.
    db.seed('userAttackSkill', [
      { id: 'skv3', userId: 'alice', name: 'Source v3', content: 'saved+', derivedFromId: 'sksaved', originPluginId: 'other', originPluginVersion: '1.0.0', originChangeSetId: 'cs-v3', originChain: CHAIN },
      { id: 'skv4', userId: 'alice', name: 'Source v4', content: 'saved++', derivedFromId: 'skv3', originPluginId: 'other', originPluginVersion: '1.0.0', originChangeSetId: 'cs-v4', originChain: CHAIN },
      { id: 'skorphan', userId: 'alice', name: 'Orphan v3', content: 'saved+', derivedFromId: null, originPluginId: 'other', originPluginVersion: '1.0.0', originChangeSetId: 'cs-o', originChain: CHAIN },
      { id: 'skreleased', userId: 'alice', name: 'Kept', content: 'saved', derivedFromId: 'sksaved', releasedFor: ['echo@1.0.0'], originPluginId: 'other', originPluginVersion: '1.0.0', originChangeSetId: 'cs-r', originChain: CHAIN },
      { id: 'skwhat', userId: 'alice', name: 'Kept v2', content: 'saved', derivedFromId: 'skreleased', releasedFor: ['echo@1.0.0'], originPluginId: 'other', originPluginVersion: '1.0.0', originChangeSetId: 'cs-w', originChain: CHAIN },
    ])
    db.seed('project', [{ id: 'p-a5', userId: 'alice', name: 'A5', attackSkillConfig: { builtIn: {}, user: { skv4: true, skwhat: true, skorphan: true } } }])
  })

  test('are quarantined with it, whichever plugin version proposed them, also when a version in between was deleted', async () => {
    w.catalog.revoked = REVOKED
    const report = await reconcileNow(w.deps)
    expect(report.userSkillRevocations.quarantined.sort()).toEqual(['skbobsaved', 'skorphan', 'sksaved', 'skv3', 'skv4'])
    for (const id of ['skv3', 'skv4', 'skorphan']) {
      expect(skill(id)).toMatchObject({ quarantinedAt: NOW, quarantineReason: DERIVED_QUARANTINE_REASON, quarantinedFor: 'echo@1.0.0' })
    }
    expect(skill('sksaved')).toMatchObject({ quarantineReason: QUARANTINE_REASON, quarantinedFor: 'echo@1.0.0' })
    expect(userMap('p-a5')).toEqual({ skv4: false, skwhat: true, skorphan: false })
    expect(h.audit).toContainEqual(expect.objectContaining({
      action: 'user_attack_skill.quarantine', targetId: 'skv4',
      after: expect.objectContaining({ reason: DERIVED_QUARANTINE_REASON, pluginId: 'echo', pluginVersion: '1.0.0' }),
    }))
  })

  test('a version its owner released from this revocation, and one that inherited the release, are left alone', async () => {
    w.catalog.revoked = REVOKED
    await reconcileNow(w.deps)
    for (const id of ['skreleased', 'skwhat']) expect(skill(id)).toMatchObject({ quarantinedAt: null })
  })

  test('a release covers one revocation: a later one of another version in its chain quarantines it again', async () => {
    w.catalog.revoked = [...REVOKED, { id: 'other', version: '1.0.0', reason: 'Also sends text out.' }]
    await reconcileNow(w.deps)
    expect(skill('skreleased')).toMatchObject({ quarantinedAt: NOW, quarantinedFor: 'other@1.0.0', quarantineReason: QUARANTINE_REASON })
    expect(skill('skwhat')).toMatchObject({ quarantinedAt: NOW, quarantinedFor: 'other@1.0.0' })
  })
})

describe('a revoked version that is no longer installed', () => {
  test('no install row at all: the same withdrawals and quarantines', async () => {
    await db.pluginInstall.delete({ where: { pluginId: 'echo' } })
    w.catalog.revoked = REVOKED
    const report = await reconcileNow(w.deps)
    expectRevoked(report)
    expect(report.revoked).toEqual([])
  })

  test('uninstalled with its data kept (status available): the same', async () => {
    await db.pluginInstall.update({ where: { pluginId: 'echo' }, data: { status: 'available', enabled: false, activeVersion: null } })
    w.catalog.revoked = REVOKED
    expectRevoked(await reconcileNow(w.deps))
  })
})

describe('what is not revoked', () => {
  test('a catalog that cannot load revokes nothing', async () => {
    w.catalog.revoked = REVOKED
    w.catalog.unavailable = new CatalogError('catalog_unreachable', 'down')
    const before = { o: db.rows('pluginOverride'), s: db.rows('userAttackSkill'), p: db.rows('project') }
    const report = await reconcileNow(w.deps)
    expect(report.catalog).toBe('unavailable: catalog_unreachable')
    expect(report.userSkillRevocations).toEqual({ withdrawn: [], quarantined: [] })
    expect(db.rows('pluginOverride')).toEqual(before.o)
    expect(db.rows('userAttackSkill')).toEqual(before.s)
    expect(db.rows('project')).toEqual(before.p)
  })

  test('a catalog revoking nothing, or another version only, leaves 1.0.0 alone', async () => {
    let report = await reconcileNow(w.deps)
    expect(report.userSkillRevocations).toEqual({ withdrawn: [], quarantined: [] })
    w.catalog.revoked = [{ id: 'echo', version: '0.9.0', reason: 'old' }]
    report = await reconcileNow(w.deps)
    expect(report.userSkillRevocations).toEqual({ withdrawn: [ids.olderVersion], quarantined: ['skolder'] })
    expect(statusOf(ids.waiting).status).toBe('proposed')
    expect(skill('sksaved').quarantinedAt).toBeNull()
    expect(userMap('p-a1')).toEqual({ sksaved: true, skmine: true, skolder: false })
  })
})

describe('pairsWithUserSkillProvenance', () => {
  test('keeps only the revoked pairs that still left a waiting proposal or an unquarantined skill', async () => {
    const pairs = [
      { id: 'echo', version: '1.0.0' },
      { id: 'echo', version: '0.8.0' },
      { id: 'other', version: '1.0.0' },
      { id: 'ghost', version: '1.0.0' },
    ]
    expect(await pairsWithUserSkillProvenance(pairs)).toEqual([{ id: 'echo', version: '1.0.0' }, { id: 'other', version: '1.0.0' }])
    await revokeUserSkillProvenance('echo', '1.0.0')
    expect(await pairsWithUserSkillProvenance(pairs)).toEqual([{ id: 'other', version: '1.0.0' }])
  })

  test('a pair with only a saved skill left still counts; an empty list asks nothing', async () => {
    await db.pluginOverride.deleteMany({})
    expect(await pairsWithUserSkillProvenance([{ id: 'echo', version: '0.9.0' }])).toEqual([{ id: 'echo', version: '0.9.0' }])
    const spy = vi.spyOn(db.pluginOverride, 'findMany')
    expect(await pairsWithUserSkillProvenance([])).toEqual([])
    expect(spy).not.toHaveBeenCalled()
  })

  test('revokeUserSkillProvenance returns what it did', async () => {
    expect(await revokeUserSkillProvenance('echo', '1.0.0')).toEqual({ withdrawn: [ids.waiting, ids.waitingBob], quarantined: ['sksaved', 'skbobsaved'] })
    expect(await revokeUserSkillProvenance('echo', '1.0.0')).toEqual({ withdrawn: [], quarantined: [] })
  })
})
