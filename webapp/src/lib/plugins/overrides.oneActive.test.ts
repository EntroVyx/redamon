/**
 * @vitest-environment node
 */
import { test, expect, beforeEach, afterEach, vi } from 'vitest'
import { createFakePrisma, type FakePrisma } from './__testing__/fakePrisma'
import { setNowForTests } from './clock'

const h = vi.hoisted(() => ({ db: null as unknown as Record<string, unknown> }))
vi.mock('@/lib/prisma', () => ({ default: new Proxy({}, { get: (_t, k) => h.db[k as string] }) }))
import * as ov from './overrides'
import { alice, bob, p1, hashes, seedPlatform, proposeParts, activeKeys } from './__testing__/overrideFixtures'

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

/**
 * The invariant the partial unique index guards in the database, held by the store's
 * own code: at most one active row per point, scope and target, at most one active
 * set per scope and skill, and every set in one status. A seeded random walk over
 * every operation, checked after each step.
 */
function rng(seed: number) {
  let s = seed >>> 0
  return () => (s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32
}

function checkInvariant(step: string) {
  const keys = activeKeys(db)
  expect(new Set(keys).size, step).toBe(keys.length)
  const rows = db.rows('pluginOverride')
  const activeSets = new Map<string, Set<string>>()
  const setStatus = new Map<string, Set<string>>()
  for (const r of rows) {
    setStatus.set(r.changeSetId as string, (setStatus.get(r.changeSetId as string) ?? new Set()).add(r.status as string))
    if (r.status !== 'active') continue
    const k = `${r.scopeType}|${r.scopeId}|${r.targetGroup}`
    activeSets.set(k, (activeSets.get(k) ?? new Set()).add(r.changeSetId as string))
  }
  for (const [k, sets] of activeSets) expect(sets.size, `${step}: ${k}`).toBe(1)
  for (const [id, s] of setStatus) expect(s.size, `${step}: set ${id}`).toBe(1)
}

test.each([1, 2, 3, 4, 5])('random walk %i keeps one active version per scope and skill', async (seed) => {
  const r = rng(seed)
  const pick = <T,>(xs: T[]) => xs[Math.floor(r() * xs.length)]
  const scopes = [alice, bob, p1]
  const groups = ['sqli', 'xss']
  const parts = ['workflow', 'payloads', 'notes']
  const ids: string[] = []
  for (let step = 0; step < 150; step++) {
    t += 1000
    const op = pick(['propose', 'propose', 'approve', 'approve', 'reject', 'reset', 'delete', 'stale', 'reapprove'])
    const scope = pick(scopes)
    const group = pick(groups)
    try {
      if (op === 'propose') {
        const chosen = parts.filter(() => r() < 0.6)
        if (!chosen.length) chosen.push('workflow')
        ids.push(
          await proposeParts(scope, group, Object.fromEntries(chosen.map((p) => [p, `${op}${step}`])), {
            pluginId: pick(['skiller', 'echo']),
          }),
        )
      } else if (ids.length) {
        const id = pick(ids)
        const set = await ov.getChangeSet(id)
        const h = set ? hashes(set.targetGroup, parts) : {}
        if (op === 'approve' || op === 'reapprove') await ov.approve(id, 'alice', h)
        if (op === 'reject') await ov.reject(id, 'alice')
        if (op === 'reset') await ov.reset(scope, 'skill.text', group, 'alice')
        if (op === 'delete') await ov.deleteChangeSet(id)
        if (op === 'stale') await ov.markStale(id, pick(['factory_changed', 'part_removed'] as const))
      }
    } catch (e) {
      // Refusals are part of the walk; anything else is a bug.
      expect(e).toBeInstanceOf(ov.PluginOverrideError)
    }
    checkInvariant(`seed ${seed} step ${step} ${op}`)
  }
  expect(ids.length).toBeGreaterThan(20)
})
