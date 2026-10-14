/**
 * @vitest-environment node
 */
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'
import { createFakePrisma, type FakePrisma } from './__testing__/fakePrisma'
import { setNowForTests } from './clock'

const h = vi.hoisted(() => ({ db: null as unknown as Record<string, unknown> }))
vi.mock('@/lib/prisma', () => ({ default: new Proxy({}, { get: (_t, k) => h.db[k as string] }) }))
import * as ov from './overrides'
import { PluginStaleProposalError } from './overrides'
import { alice, sha, hashes, seedPlatform, proposeParts, statuses } from './__testing__/overrideFixtures'

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

const H = hashes('sqli', ['workflow', 'payloads'])

describe('a version is a whole snapshot (TD-19, R-44, R-58)', () => {
  test('after approval only the approved set is active: a part it does not change reverts to factory', async () => {
    const v2 = await proposeParts(alice, 'sqli', { workflow: 'W2', payloads: 'P2' })
    await ov.approve(v2, 'alice', H)
    const v3 = await proposeParts(alice, 'sqli', { workflow: 'W3' })
    await ov.approve(v3, 'alice', H)
    expect(statuses(db, v2)).toEqual(['sqli/payloads:superseded', 'sqli/workflow:superseded'])
    const r = await ov.resolveForProject('p1')
    expect(Object.keys(r)).toEqual(['sqli/workflow'])
    expect(r['sqli/workflow'].value).toBe('W3')
  })

  test('a proposal built on another factory text is refused and nothing changes', async () => {
    const v2 = await proposeParts(alice, 'sqli', { workflow: 'W2' })
    await ov.approve(v2, 'alice', H)
    const old = await proposeParts(alice, 'sqli', { workflow: 'OLD', payloads: 'P' }, { base: 7 })
    const e = await ov.approve(old, 'alice', H).catch((x) => x)
    expect(e).toBeInstanceOf(PluginStaleProposalError)
    expect(e.targetKeys).toEqual(['sqli/payloads', 'sqli/workflow'])
    expect(statuses(db, old)).toEqual(['sqli/payloads:proposed', 'sqli/workflow:proposed'])
    expect(statuses(db, v2)).toEqual(['sqli/workflow:active'])
    expect(await ov.lastRevision(alice, 'skill.text', 'sqli')).toBe(2)
  })

  test('a part the registry no longer lists makes the proposal stale', async () => {
    const id = await proposeParts(alice, 'sqli', { workflow: 'W', gone: 'G' })
    const e = await ov.approve(id, 'alice', H).catch((x) => x)
    expect(e).toBeInstanceOf(PluginStaleProposalError)
    expect(e.targetKeys).toEqual(['sqli/gone'])
  })
})

describe('staleness belongs to the set (RV-06)', () => {
  test('markStale marks every row of the set and no other set', async () => {
    const mine = await proposeParts(alice, 'sqli', { workflow: 'W', payloads: 'P' }, { meta: { summary: 'keep me' } })
    await ov.approve(mine, 'alice', H)
    const other = await proposeParts(alice, 'xss', { workflow: 'X' })
    await ov.approve(other, 'alice', hashes('xss', ['workflow']))
    expect(await ov.markStale([mine], 'factory_changed')).toEqual([mine])
    expect(statuses(db, mine)).toEqual(['sqli/payloads:stale', 'sqli/workflow:stale'])
    expect(statuses(db, other)).toEqual(['xss/workflow:active'])
    const set = await ov.getChangeSet(mine)
    expect(set).toMatchObject({ status: 'stale', staleReason: 'factory_changed', meta: { summary: 'keep me', staleReason: 'factory_changed' } })
    expect(Object.keys(await ov.resolveForProject('p1'))).toEqual(['xss/workflow'])
  })

  test('re-approving a factory_changed set keeps its number and re-bases on the new factory', async () => {
    const id = await proposeParts(alice, 'sqli', { workflow: 'W', payloads: 'P' }, { meta: { summary: 's' } })
    await ov.approve(id, 'alice', H)
    await ov.markStale(id, 'factory_changed')
    const r = await ov.approve(id, 'bob-admin', hashes('sqli', ['workflow', 'payloads'], 5))
    expect(r).toEqual({ revision: 2, replaced: null })
    const set = await ov.getChangeSet(id)
    expect(set).toMatchObject({ status: 'active', revision: 2, staleReason: null, decidedBy: 'bob-admin', meta: { summary: 's' } })
    expect(set!.parts.map((p) => p.baseSha256)).toEqual([sha(5), sha(5)])
    expect(await ov.lastRevision(alice, 'skill.text', 'sqli')).toBe(2)
  })

  test('re-approval is refused when a part disappeared since', async () => {
    const id = await proposeParts(alice, 'sqli', { workflow: 'W', payloads: 'P' })
    await ov.approve(id, 'alice', H)
    await ov.markStale(id, 'factory_changed')
    const e = await ov.approve(id, 'alice', hashes('sqli', ['workflow'], 5)).catch((x) => x)
    expect(e).toBeInstanceOf(PluginStaleProposalError)
    expect(e.targetKeys).toEqual(['sqli/payloads'])
  })

  test('a part_removed set can be deleted but not re-approved', async () => {
    const id = await proposeParts(alice, 'sqli', { workflow: 'W' })
    await ov.approve(id, 'alice', H)
    expect(await ov.markStale(id, 'part_removed')).toEqual([id])
    expect((await ov.approve(id, 'alice', H).catch((x) => x)).code).toBe('wrong_state')
    expect(await ov.deleteChangeSet(id)).toEqual({ deleted: 1 })
  })

  test('re-approving an older stale version supersedes the one approved since', async () => {
    const v2 = await proposeParts(alice, 'sqli', { workflow: 'W2' })
    await ov.approve(v2, 'alice', H)
    await ov.markStale(v2, 'factory_changed')
    const v3 = await proposeParts(alice, 'sqli', { workflow: 'W3' })
    await ov.approve(v3, 'alice', H)
    const r = await ov.approve(v2, 'alice', H)
    expect(r.revision).toBe(2)
    expect(r.replaced).toMatchObject({ changeSetId: v3, revision: 3 })
    expect(statuses(db, v3)).toEqual(['sqli/workflow:superseded'])
  })

  test('an unknown stale reason is a programming error', async () => {
    await expect(ov.markStale('x', 'whatever' as ov.StaleReason)).rejects.toThrow(/Unknown stale reason/)
  })
})
