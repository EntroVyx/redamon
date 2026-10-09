/**
 * @vitest-environment node
 */
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'
import { createFakePrisma, type FakePrisma } from './__testing__/fakePrisma'
import { setNowForTests } from './clock'

const h = vi.hoisted(() => ({ db: null as unknown as Record<string, unknown> }))
vi.mock('@/lib/prisma', () => ({ default: new Proxy({}, { get: (_t, k) => h.db[k as string] }) }))
import * as ov from './overrides'
import { alice, hashes, seedPlatform, proposeParts, statuses, activeKeys } from './__testing__/overrideFixtures'

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
const settle = (ps: Promise<unknown>[]) => Promise.allSettled(ps)
const codes = (rs: PromiseSettledResult<unknown>[]) =>
  rs.map((r) => (r.status === 'fulfilled' ? 'ok' : (r.reason as ov.PluginOverrideError).code)).sort()

describe('racing decisions (R-21)', () => {
  test('two approvals of two proposals for one scope and skill: they serialize, never two active', async () => {
    const a = await proposeParts(alice, 'sqli', { workflow: 'A', payloads: 'A' })
    const b = await proposeParts(alice, 'sqli', { workflow: 'B', payloads: 'B' }, { pluginId: 'echo' })
    const rs = await settle([ov.approve(a, 'alice', H), ov.approve(b, 'bob', H)])
    expect(codes(rs)).toEqual(['ok', 'ok'])
    const revisions = rs.map((r) => (r as PromiseFulfilledResult<ov.ApproveResult>).value.revision).sort()
    expect(revisions).toEqual([2, 3])
    expect(new Set(activeKeys(db)).size).toBe(activeKeys(db).length)
    expect([statuses(db, a)[0].split(':')[1], statuses(db, b)[0].split(':')[1]].sort()).toEqual(['active', 'superseded'])
  })

  test('the same set approved twice at once: one wins, the other finds it decided', async () => {
    const id = await proposeParts(alice, 'sqli', { workflow: 'W' })
    expect(codes(await settle([ov.approve(id, 'alice', H), ov.approve(id, 'alice', H)]))).toEqual(['ok', 'wrong_state'])
    expect(await ov.lastRevision(alice, 'skill.text', 'sqli')).toBe(2)
  })

  test('approve and delete of one set at once: never approved and deleted', async () => {
    const id = await proposeParts(alice, 'sqli', { workflow: 'W' })
    const rs = await settle([ov.approve(id, 'alice', H), ov.deleteChangeSet(id)])
    const rows = db.rows('pluginOverride')
    if (rs[0].status === 'fulfilled') {
      expect((rs[1] as PromiseRejectedResult).reason.code).toBe('active_not_deletable')
      expect(rows.map((r) => r.status)).toEqual(['active'])
    } else {
      expect((rs[0] as PromiseRejectedResult).reason.code).toBe('not_found')
      expect(rows).toEqual([])
    }
  })

  test('two proposals for the last pending slot: exactly one is refused', async () => {
    for (let i = 0; i < 4; i++) await proposeParts(alice, 'sqli', { workflow: `W${i}` })
    const rs = await settle([proposeParts(alice, 'sqli', { workflow: 'X' }), proposeParts(alice, 'sqli', { workflow: 'Y' })])
    expect(codes(rs)).toEqual(['ok', 'too_many_pending'])
    expect(await ov.pendingCount(alice, 'skill.text', 'sqli')).toBe(5)
  })

  test('an approval racing a reset ends in one consistent state', async () => {
    const v2 = await proposeParts(alice, 'sqli', { workflow: 'W2' })
    await ov.approve(v2, 'alice', H)
    const v3 = await proposeParts(alice, 'sqli', { workflow: 'W3' })
    await settle([ov.approve(v3, 'alice', H), ov.reset(alice, 'skill.text', 'sqli', 'alice')])
    expect(activeKeys(db).length).toBeLessThanOrEqual(1)
    expect(statuses(db, v2)).not.toContain('sqli/workflow:active')
  })

  test('five approvals at once on one scope and skill hand out five distinct numbers', async () => {
    const ids = []
    for (let i = 0; i < 5; i++) ids.push(await proposeParts(alice, 'sqli', { workflow: `W${i}` }))
    const rs = await settle(ids.map((id) => ov.approve(id, 'alice', H)))
    const revisions = rs.map((r) => (r as PromiseFulfilledResult<ov.ApproveResult>).value.revision).sort((x, y) => x - y)
    expect(revisions).toEqual([2, 3, 4, 5, 6])
    expect(activeKeys(db)).toHaveLength(1)
  })
})
