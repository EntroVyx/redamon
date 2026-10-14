/**
 * @vitest-environment node
 */
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'
import { createFakePrisma, type FakePrisma } from './__testing__/fakePrisma'
import { setNowForTests } from './clock'

const h = vi.hoisted(() => ({ db: null as unknown as Record<string, unknown> }))
vi.mock('@/lib/prisma', () => ({ default: new Proxy({}, { get: (_t, k) => h.db[k as string] }) }))
import * as ov from './overrides'
import { alice, bob, p1, p2, hashes, seedPlatform, proposeParts } from './__testing__/overrideFixtures'

let db: FakePrisma
let t: number
beforeEach(() => {
  db = createFakePrisma()
  h.db = db as unknown as Record<string, unknown>
  seedPlatform(db)
  t = Date.parse('2026-10-09T12:00:00Z')
  setNowForTests(() => new Date(t))
})
afterEach(() => setNowForTests(null))
/** Moves the clock, so versions get distinct creation times. */
const later = () => (t += 1000)

const approveNew = async (scope = alice, parts: Record<string, string> = { workflow: 'W' }, pluginId = 'skiller', group = 'sqli') => {
  later()
  const id = await proposeParts(scope, group, parts, { pluginId })
  const r = await ov.approve(id, 'alice', hashes(group, Object.keys(parts)))
  return { id, ...r }
}

describe('numbering (F-13, R-18, R-57)', () => {
  test('the first approval is v2 (v1 is the factory text), the next v3', async () => {
    expect((await approveNew()).revision).toBe(2)
    expect((await approveNew()).revision).toBe(3)
    expect(await ov.lastRevision(alice, 'skill.text', 'sqli')).toBe(3)
  })

  test('deleting v2 and approving again gives v4', async () => {
    const v2 = await approveNew()
    await approveNew()
    await ov.deleteChangeSet(v2.id)
    expect((await approveNew()).revision).toBe(4)
  })

  test('the highest number deleted is never handed out again (RV-04, X5)', async () => {
    const v2 = await approveNew()
    const v3 = await approveNew()
    await ov.reset(alice, 'skill.text', 'sqli', 'alice')
    await ov.deleteChangeSet(v3.id)
    await ov.deleteChangeSet(v2.id)
    expect(db.rows('pluginOverride')).toEqual([])
    expect((await approveNew()).revision).toBe(4)
  })

  test("purging plugin A does not make plugin B's next number reuse A's", async () => {
    await approveNew(alice, { workflow: 'A2' }, 'skiller')
    await approveNew(alice, { workflow: 'A3' }, 'skiller')
    // Purge: the plugin row goes, and its overrides with it (the foreign key cascades).
    for (const r of db.rows('pluginOverride')) if (r.pluginId === 'skiller') db.tables.pluginOverride.delete(r.id)
    db.tables.pluginInstall.delete('skiller')
    expect((await approveNew(alice, { workflow: 'B' }, 'echo')).revision).toBe(4)
  })

  test('numbers are per scope and per skill', async () => {
    expect((await approveNew(alice)).revision).toBe(2)
    expect((await approveNew(bob)).revision).toBe(2)
    expect((await approveNew(p1)).revision).toBe(2)
    expect((await approveNew(alice, { workflow: 'W' }, 'skiller', 'xss')).revision).toBe(2)
    expect((await approveNew(alice)).revision).toBe(3)
  })

  test('proposals do not consume numbers; a rejected one never had one', async () => {
    later()
    const id = await proposeParts(alice, 'sqli', { workflow: 'W' })
    await ov.reject(id, 'alice')
    expect(await ov.lastRevision(alice, 'skill.text', 'sqli')).toBe(1)
    expect((await approveNew()).revision).toBe(2)
  })
})

describe('replacement across plugins (D-60)', () => {
  test("a set from plugin B replaces plugin A's active set and names it", async () => {
    const a = await approveNew(alice, { workflow: 'A' }, 'skiller')
    const b = await approveNew(alice, { workflow: 'B' }, 'echo')
    expect(a.replaced).toBeNull()
    expect(b.replaced).toEqual({ changeSetId: a.id, revision: 2, pluginId: 'skiller' })
    expect((await ov.activeChangeSet(alice, 'skill.text', 'sqli'))?.pluginId).toBe('echo')
  })
})

describe('listVersions', () => {
  test('factory v1 is synthesised, then every set newest first with its status', async () => {
    expect(await ov.listVersions(alice, 'skill.text', 'sqli')).toEqual({ factory: { revision: 1, inUse: true }, sets: [] })
    const v2 = await approveNew()
    const v3 = await approveNew()
    later()
    const pending = await proposeParts(alice, 'sqli', { workflow: 'P' })
    const list = await ov.listVersions(alice, 'skill.text', 'sqli')
    expect(list.factory).toEqual({ revision: 1, inUse: false })
    expect(list.sets.map((s) => [s.changeSetId, s.status, s.revision, s.pluginId])).toEqual([
      [pending, 'proposed', null, 'skiller'],
      [v3.id, 'active', 3, 'skiller'],
      [v2.id, 'superseded', 2, 'skiller'],
    ])
    expect(list.sets[1].parts.map((p) => [p.targetKey, p.partId, p.value])).toEqual([['sqli/workflow', 'workflow', 'W']])
  })

  test('only the asked scope and skill', async () => {
    await approveNew(bob)
    await approveNew(alice, { workflow: 'W' }, 'skiller', 'xss')
    expect((await ov.listVersions(alice, 'skill.text', 'sqli')).sets).toEqual([])
  })

  test('the factory is in use again after a reset', async () => {
    await approveNew()
    await ov.reset(alice, 'skill.text', 'sqli', 'alice')
    expect((await ov.listVersions(alice, 'skill.text', 'sqli')).factory.inUse).toBe(true)
  })
})

describe('resolveForProject: per skill, never per part (TD-18, RV-05, X7)', () => {
  test("the owner's user-scope version applies to every project the owner has", async () => {
    await approveNew(alice, { workflow: 'UW', payloads: 'UP' })
    const r = await ov.resolveForProject('p1')
    expect(Object.keys(r).sort()).toEqual(['sqli/payloads', 'sqli/workflow'])
    expect(r['sqli/workflow']).toMatchObject({ value: 'UW', revision: 2, pluginId: 'skiller' })
  })

  test("a one-part project version hides EVERY user-scope part of that skill", async () => {
    await approveNew(alice, { workflow: 'UW', payloads: 'UP' })
    await approveNew(p1, { workflow: 'PW' })
    const r = await ov.resolveForProject('p1')
    expect(r).toEqual({ 'sqli/workflow': expect.objectContaining({ value: 'PW' }) })
  })

  test('the user-scope version still applies to the skills the project did not change', async () => {
    await approveNew(alice, { workflow: 'UX' }, 'skiller', 'xss')
    await approveNew(p1, { workflow: 'PW' })
    const r = await ov.resolveForProject('p1')
    expect(Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v.value]))).toEqual({
      'sqli/workflow': 'PW',
      'xss/workflow': 'UX',
    })
  })

  test("nothing from another user, nothing from another project", async () => {
    await approveNew(bob, { workflow: 'B' })
    await approveNew(p2, { workflow: 'P2' })
    expect(await ov.resolveForProject('p1')).toEqual({})
  })

  test('the owner comes from the project row, so a transferred project follows its new owner', async () => {
    await approveNew(bob, { workflow: 'B' })
    db.tables.project.get('p1')!.userId = 'bob'
    expect((await ov.resolveForProject('p1'))['sqli/workflow']?.value).toBe('B')
  })

  test.each([
    ['disabled', { enabled: false }],
    ['failed', { status: 'failed' }],
    ['uninstalled', { status: 'available' }],
    ['revoked', { revokedReason: 'leak' }],
    ['without the permission', { grantedPermissions: [] }],
  ])('nothing from a plugin that is %s', async (_n, patch) => {
    await approveNew(alice, { workflow: 'U' })
    Object.assign(db.tables.pluginInstall.get('skiller')!, patch)
    expect(await ov.resolveForProject('p1')).toEqual({})
  })

  test('a still-updating plugin keeps applying (approved data, not code)', async () => {
    await approveNew(alice, { workflow: 'U' })
    db.tables.pluginInstall.get('skiller')!.status = 'updating'
    expect(Object.keys(await ov.resolveForProject('p1'))).toEqual(['sqli/workflow'])
  })

  test("a dormant project version leaves the skill on factory text, not on the user's version", async () => {
    await approveNew(alice, { workflow: 'U' }, 'skiller')
    await approveNew(p1, { workflow: 'P' }, 'echo')
    db.tables.pluginInstall.get('echo')!.enabled = false
    expect(await ov.resolveForProject('p1')).toEqual({})
  })

  test("a stale project version keeps that skill on factory text, not on the owner's version", async () => {
    await approveNew(alice, { workflow: 'U' })
    await approveNew(alice, { workflow: 'UX' }, 'skiller', 'xss')
    const p = await approveNew(p1, { workflow: 'P' })
    await ov.markStale(p.id, 'factory_changed')
    const r = await ov.resolveForProject('p1')
    expect(Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v.value]))).toEqual({ 'xss/workflow': 'UX' })
    const e = await ov.effectiveForProject('p1', 'sqli')
    expect(e).toMatchObject({ scope: p1, status: 'stale', applies: false, staleReason: 'factory_changed' })
  })

  test('a project with a stale and a newer active version runs the active one', async () => {
    await approveNew(alice, { workflow: 'U' })
    const v2 = await approveNew(p1, { workflow: 'P2' })
    await ov.markStale(v2.id, 'factory_changed')
    await approveNew(p1, { workflow: 'P3' })
    expect((await ov.resolveForProject('p1'))['sqli/workflow']).toMatchObject({ value: 'P3', revision: 3 })
  })

  test('a re-approved project version applies again', async () => {
    const p = await approveNew(p1, { workflow: 'P' })
    await ov.markStale(p.id, 'factory_changed')
    await ov.approve(p.id, 'alice', hashes('sqli', ['workflow'], 2))
    expect((await ov.resolveForProject('p1'))['sqli/workflow']?.value).toBe('P')
  })

  test("a project version reset to factory hands the skill back to the owner's user scope (TD-18)", async () => {
    await approveNew(alice, { workflow: 'U' })
    await approveNew(p1, { workflow: 'P' })
    await ov.reset(p1, 'skill.text', 'sqli', 'alice')
    expect((await ov.resolveForProject('p1'))['sqli/workflow']?.value).toBe('U')
  })

  test('an unknown project resolves to nothing', async () => {
    await approveNew(alice)
    expect(await ov.resolveForProject('nope')).toEqual({})
  })

  test('effectiveForProject returns the governing set with its scope, applied or dormant', async () => {
    expect(await ov.effectiveForProject('p1', 'sqli')).toBeNull()
    await approveNew(alice, { workflow: 'U' })
    expect(await ov.effectiveForProject('p1', 'sqli')).toMatchObject({ scope: alice, revision: 2, applies: true })
    await approveNew(p1, { workflow: 'P' }, 'echo')
    db.tables.pluginInstall.get('echo')!.enabled = false
    const e = await ov.effectiveForProject('p1', 'sqli')
    expect(e).toMatchObject({ scope: p1, pluginId: 'echo', applies: false, plugin: { enabled: false } })
    expect(await ov.effectiveForProject('p1', 'xss')).toBeNull()
  })

  test('only active sets resolve', async () => {
    later()
    await proposeParts(alice, 'sqli', { workflow: 'pending' })
    const v = await approveNew(alice, { payloads: 'X' })
    await ov.markStale(v.id, 'factory_changed')
    expect(await ov.resolveForProject('p1')).toEqual({})
  })
})

describe('pendingCount', () => {
  test('counts change sets, not rows', async () => {
    await proposeParts(alice, 'sqli', { workflow: 'W', payloads: 'P' })
    await proposeParts(alice, 'sqli', { workflow: 'W2' })
    expect(await ov.pendingCount(alice, 'skill.text', 'sqli')).toBe(2)
    expect(await ov.pendingCount(alice, 'skill.text', 'xss')).toBe(0)
  })
})
