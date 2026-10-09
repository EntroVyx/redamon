/**
 * @vitest-environment node
 */
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'
import { createFakePrisma, type FakePrisma } from './__testing__/fakePrisma'
import { setNowForTests } from './clock'

const h = vi.hoisted(() => ({ db: null as unknown as Record<string, unknown> }))
vi.mock('@/lib/prisma', () => ({ default: new Proxy({}, { get: (_t, k) => h.db[k as string] }) }))
import { readFileSync } from 'fs'
import path from 'path'
import * as ov from './overrides'
import { PluginOverrideError, PluginStaleProposalError, OVERRIDE_STATUSES } from './overrides'
import { alice, bob, p1, sha, hashes, seedPlatform, proposeParts, statuses } from './__testing__/overrideFixtures'

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
const code = async (p: Promise<unknown>) => {
  const e = await p.catch((x: unknown) => x)
  expect(e).toBeInstanceOf(PluginOverrideError)
  return (e as PluginOverrideError).code
}

test('the statuses match the CHECK constraint the database enforces', () => {
  const script = readFileSync(path.resolve(__dirname, '../../../scripts/apply-plugin-constraints.mjs'), 'utf8')
  const m = script.match(/const OVERRIDE_STATUSES = \[([^\]]*)\]/)
  expect(m![1].match(/'[^']+'/g)!.map((s) => s.slice(1, -1))).toEqual([...OVERRIDE_STATUSES])
})

describe('propose', () => {
  test('stores one proposed row per part, sharing one change set id', async () => {
    const id = await proposeParts(alice, 'sqli', { workflow: 'W', payloads: 'P' }, { note: 'why', meta: { summary: 's' } })
    const rows = db.rows('pluginOverride')
    expect(rows).toHaveLength(2)
    for (const r of rows) {
      expect(r).toMatchObject({
        changeSetId: id, status: 'proposed', pluginId: 'skiller', extensionPoint: 'skill.text',
        scopeType: 'user', scopeId: 'alice', userId: 'alice', projectId: null, targetGroup: 'sqli',
        note: 'why', meta: { summary: 's' }, revision: null, baseSha256: sha(1),
      })
    }
    expect(statuses(db, id)).toEqual(['sqli/payloads:proposed', 'sqli/workflow:proposed'])
  })

  test('a project scope sets the project foreign key', async () => {
    await proposeParts(p1, 'sqli', { workflow: 'W' })
    expect(db.rows('pluginOverride')[0]).toMatchObject({ scopeType: 'project', scopeId: 'p1', userId: null, projectId: 'p1' })
  })

  const base = {
    pluginId: 'skiller', point: 'skill.text' as const, scope: alice, targetGroup: 'sqli', createdBy: 'alice',
  }
  const part = (targetKey: string, baseSha256 = sha(1)) => ({ targetKey, value: 'x', baseSha256 })

  test.each([
    ['an empty set', { parts: [] }],
    ['a duplicate target', { parts: [part('sqli/workflow'), part('sqli/workflow')] }],
    ['a target outside the group', { parts: [part('xss/workflow')] }],
    ['a target that only starts like the group', { parts: [part('sqlimap/workflow')] }],
    ['a bad part id', { parts: [part('sqli/Workflow')] }],
    ['a bad hash', { parts: [part('sqli/workflow', 'abc')] }],
    ['an unknown point', { point: 'nav', parts: [part('sqli/workflow')] }],
    ['a bad plugin id', { pluginId: 'Bad', parts: [part('sqli/workflow')] }],
    ['a bad group', { targetGroup: 'SQLi', parts: [part('SQLi/workflow')] }],
    ['a long note', { note: 'x'.repeat(4001), parts: [part('sqli/workflow')] }],
    ['a bad scope', { scope: { type: 'team', id: 'x' }, parts: [part('sqli/workflow')] }],
  ])('refuses %s', async (_name, over) => {
    expect(await code(ov.propose({ ...base, ...(over as object) } as never))).toBe('invalid_proposal')
    expect(db.rows('pluginOverride')).toEqual([])
  })

  test('five pending change sets per scope and skill; the sixth is refused (sets, not rows)', async () => {
    for (let i = 0; i < 5; i++) await proposeParts(alice, 'sqli', { workflow: `W${i}`, payloads: `P${i}` })
    expect(await ov.pendingCount(alice, 'skill.text', 'sqli')).toBe(5)
    expect(await code(proposeParts(alice, 'sqli', { workflow: 'W5' }))).toBe('too_many_pending')
    // Other scopes and skills have their own five.
    await proposeParts(bob, 'sqli', { workflow: 'W' })
    await proposeParts(alice, 'xss', { workflow: 'W' })
  })

  test('a decided proposal frees its pending slot', async () => {
    const ids = []
    for (let i = 0; i < 5; i++) ids.push(await proposeParts(alice, 'sqli', { workflow: `W${i}` }))
    await ov.reject(ids[0], 'alice')
    await proposeParts(alice, 'sqli', { workflow: 'W5' })
  })
})

describe('the state machine of design §7.6 with the plan additions', () => {
  test('proposed -> active, the scope lock taken first', async () => {
    const id = await proposeParts(alice, 'sqli', { workflow: 'W', payloads: 'P' })
    await ov.approve(id, 'alice', H)
    expect(statuses(db, id)).toEqual(['sqli/payloads:active', 'sqli/workflow:active'])
    expect(db.rows('pluginOverride')[0]).toMatchObject({ decidedBy: 'alice', revision: 2 })
    const locks = db.rawCalls.filter((c) => c.sql.includes('pg_advisory_xact_lock'))
    expect(locks.at(-1)!.values).toEqual(['override:skill.text:user:alice:sqli'])
  })

  test('proposed -> rejected', async () => {
    const id = await proposeParts(alice, 'sqli', { workflow: 'W' })
    await ov.reject(id, 'alice')
    expect(statuses(db, id)).toEqual(['sqli/workflow:rejected'])
    expect(db.rows('pluginOverride')[0].decidedBy).toBe('alice')
  })

  test('proposed -> withdrawn, only by the proposing plugin', async () => {
    const id = await proposeParts(alice, 'sqli', { workflow: 'W' })
    expect(await code(ov.withdraw(id, 'echo'))).toBe('not_found')
    await ov.withdraw(id, 'skiller')
    expect(statuses(db, id)).toEqual(['sqli/workflow:withdrawn'])
  })

  test('active -> superseded when another version is approved', async () => {
    const a = await proposeParts(alice, 'sqli', { workflow: 'A' })
    const b = await proposeParts(alice, 'sqli', { workflow: 'B' })
    await ov.approve(a, 'alice', H)
    await ov.approve(b, 'alice', H)
    expect(statuses(db, a)).toEqual(['sqli/workflow:superseded'])
    expect(statuses(db, b)).toEqual(['sqli/workflow:active'])
  })

  test('active -> stale -> active (factory changed, re-approved)', async () => {
    const id = await proposeParts(alice, 'sqli', { workflow: 'W' })
    await ov.approve(id, 'alice', H)
    expect(await ov.markStale(id, 'factory_changed')).toEqual([id])
    expect(statuses(db, id)).toEqual(['sqli/workflow:stale'])
    await ov.approve(id, 'alice', hashes('sqli', ['workflow'], 2))
    expect(statuses(db, id)).toEqual(['sqli/workflow:active'])
  })

  test('active -> cleared on reset', async () => {
    const id = await proposeParts(alice, 'sqli', { workflow: 'W' })
    await ov.approve(id, 'alice', H)
    await ov.reset(alice, 'skill.text', 'sqli', 'alice')
    expect(statuses(db, id)).toEqual(['sqli/workflow:cleared'])
  })

  test.each(['rejected', 'withdrawn', 'superseded', 'cleared', 'active'])(
    'a %s set cannot be approved',
    async (target) => {
      const id = await proposeParts(alice, 'sqli', { workflow: 'W' })
      if (target === 'rejected') await ov.reject(id, 'alice')
      if (target === 'withdrawn') await ov.withdraw(id, 'skiller')
      if (target !== 'rejected' && target !== 'withdrawn') await ov.approve(id, 'alice', H)
      if (target === 'superseded') await ov.approve(await proposeParts(alice, 'sqli', { workflow: 'X' }), 'alice', H)
      if (target === 'cleared') await ov.reset(alice, 'skill.text', 'sqli', 'alice')
      const before = statuses(db, id)
      expect(await code(ov.approve(id, 'alice', H))).toBe('wrong_state')
      expect(statuses(db, id)).toEqual(before)
    },
  )

  test('only a proposed set can be rejected or withdrawn', async () => {
    const id = await proposeParts(alice, 'sqli', { workflow: 'W' })
    await ov.approve(id, 'alice', H)
    expect(await code(ov.reject(id, 'alice'))).toBe('wrong_state')
    expect(await code(ov.withdraw(id, 'skiller'))).toBe('wrong_state')
  })

  test('a set stale because a part was removed cannot be re-approved', async () => {
    const id = await proposeParts(alice, 'sqli', { workflow: 'W' })
    await ov.approve(id, 'alice', H)
    await ov.markStale(id, 'part_removed')
    expect(await code(ov.approve(id, 'alice', H))).toBe('wrong_state')
  })

  test('markStale leaves a set that is not active alone', async () => {
    const id = await proposeParts(alice, 'sqli', { workflow: 'W' })
    expect(await ov.markStale([id], 'factory_changed')).toEqual([])
    expect(statuses(db, id)).toEqual(['sqli/workflow:proposed'])
  })

  test('unknown change sets', async () => {
    expect(await code(ov.approve('nope', 'alice', H))).toBe('not_found')
    expect(await code(ov.reject('nope', 'alice'))).toBe('not_found')
    expect(await code(ov.withdraw('nope', 'skiller'))).toBe('not_found')
    expect(await code(ov.deleteChangeSet('nope'))).toBe('not_found')
    expect(await ov.markStale('nope', 'factory_changed')).toEqual([])
    expect(await ov.getChangeSet('nope')).toBeNull()
  })

  test('a stale-proposal refusal is its own error class, naming the parts', async () => {
    const id = await proposeParts(alice, 'sqli', { workflow: 'W', payloads: 'P' })
    const e = await ov.approve(id, 'alice', hashes('sqli', ['workflow', 'payloads'], 9)).catch((x) => x)
    expect(e).toBeInstanceOf(PluginStaleProposalError)
    expect(e.targetKeys).toEqual(['sqli/payloads', 'sqli/workflow'])
  })
})
