/**
 * @vitest-environment node
 */
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'
import { createFakePrisma, type FakePrisma } from './__testing__/fakePrisma'
import { setNowForTests } from './clock'

const h = vi.hoisted(() => ({ db: null as unknown as Record<string, unknown> }))
vi.mock('@/lib/prisma', () => ({ default: new Proxy({}, { get: (_t, k) => h.db[k as string] }) }))
import * as ov from './overrides'
import { PluginOverrideError } from './overrides'
import { alice, hashes, seedPlatform, proposeParts } from './__testing__/overrideFixtures'

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
const approved = async (parts: Record<string, string> = { workflow: 'W' }) => {
  const id = await proposeParts(alice, 'sqli', parts)
  await ov.approve(id, 'alice', H)
  return id
}

describe('deleting versions (F-15, R-18)', () => {
  test('the active version cannot be deleted', async () => {
    const id = await approved()
    const e = await ov.deleteChangeSet(id).catch((x) => x)
    expect(e).toBeInstanceOf(PluginOverrideError)
    expect(e.code).toBe('active_not_deletable')
    expect(db.rows('pluginOverride')).toHaveLength(1)
  })

  test('after a reset the former active version is deletable', async () => {
    const id = await approved()
    await ov.reset(alice, 'skill.text', 'sqli', 'alice')
    expect(await ov.deleteChangeSet(id)).toEqual({ deleted: 1 })
  })

  test.each(['proposed', 'rejected', 'withdrawn', 'superseded', 'stale:factory_changed', 'stale:part_removed'])(
    'a %s set is deleted whole',
    async (state) => {
      const id = await proposeParts(alice, 'sqli', { workflow: 'W', payloads: 'P' })
      if (state === 'rejected') await ov.reject(id, 'alice')
      if (state === 'withdrawn') await ov.withdraw(id, 'skiller')
      if (state === 'superseded' || state.startsWith('stale')) await ov.approve(id, 'alice', H)
      if (state === 'superseded') await approved({ workflow: 'X' })
      if (state.startsWith('stale')) await ov.markStale(id, state.split(':')[1] as ov.StaleReason)
      expect(await ov.deleteChangeSet(id)).toEqual({ deleted: 2 })
      expect(db.rows('pluginOverride').filter((r) => r.changeSetId === id)).toEqual([])
    },
  )

  test('deleting old versions never changes what runs (R-44)', async () => {
    const v2 = await approved({ workflow: 'W2', payloads: 'P2' })
    const v3 = await approved({ workflow: 'W3' })
    const before = await ov.resolveForProject('p1')
    await ov.deleteChangeSet(v2)
    expect(await ov.resolveForProject('p1')).toEqual(before)
    expect((await ov.activeChangeSet(alice, 'skill.text', 'sqli'))?.changeSetId).toBe(v3)
  })

  test('deleting does not lower the version counter', async () => {
    const v2 = await approved()
    await approved()
    await ov.deleteChangeSet(v2)
    expect(await ov.lastRevision(alice, 'skill.text', 'sqli')).toBe(3)
  })
})
