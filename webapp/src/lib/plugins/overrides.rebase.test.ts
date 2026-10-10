/**
 * Re-approving a factory-changed version re-bases meta.baseFactoryText on the current
 * factory text, not only the hashes (phase-04 review, RV-54): otherwise a later "Review
 * again" would show the factory change the person already saw when they approved as is.
 *
 * @vitest-environment node
 */
import { describe, test, expect, beforeEach, vi } from 'vitest'

const h = vi.hoisted(() => ({ db: null as unknown as Record<string, unknown> }))
vi.mock('@/lib/prisma', () => ({ default: new Proxy({}, { get: (_t, k) => h.db[k as string] }) }))

import * as ov from './overrides'
import { createFakePrisma, type FakePrisma } from './__testing__/fakePrisma'
import { alice, sha, seedPlatform, proposeParts } from './__testing__/overrideFixtures'

let db: FakePrisma
const H = (n: number) => ({ 'ssrf/workflow': sha(n) })
const meta = (db: FakePrisma, changeSetId: string) =>
  db.rows('pluginOverride').find((r) => r.changeSetId === changeSetId)!.meta as Record<string, unknown>

/** Set the proposal's baseFactoryText the way propose() would from the agent registry. */
async function setBaseFactoryText(changeSetId: string, text: Record<string, string>) {
  const current = (meta(db, changeSetId) ?? {}) as Record<string, unknown>
  await db.pluginOverride.updateMany({ where: { changeSetId }, data: { meta: { ...current, baseFactoryText: text } } })
}

beforeEach(() => {
  db = createFakePrisma()
  h.db = db as unknown as Record<string, unknown>
  seedPlatform(db)
})

describe('re-approval re-base', () => {
  test('a first approval keeps the proposal baseFactoryText; currentTexts is ignored', async () => {
    const cs = await proposeParts(alice, 'ssrf', { workflow: 'better' }, { meta: { fromRevision: 1 } })
    // propose() set baseFactoryText from the agent; simulate it.
    await setBaseFactoryText(cs, { workflow: 'ORIGINAL FACTORY' })
    await ov.approve(cs, 'alice', H(1), db, { 'ssrf/workflow': 'IGNORED ON FIRST APPROVAL' })
    expect((meta(db, cs).baseFactoryText as Record<string, string>).workflow).toBe('ORIGINAL FACTORY')
  })

  test('a factory change makes it stale; re-approve as is re-bases baseFactoryText to the new factory', async () => {
    const cs = await proposeParts(alice, 'ssrf', { workflow: 'better' })
    await setBaseFactoryText(cs, { workflow: 'OLD FACTORY' })
    await ov.approve(cs, 'alice', H(1), db)

    // RedAmon's factory text for ssrf/workflow changed (hash sha(2)); reconcile marks it stale.
    await ov.markStale(cs, 'factory_changed', db)
    expect(db.rows('pluginOverride').find((r) => r.changeSetId === cs)!.status).toBe('stale')

    // Approve as is on the new factory, re-basing hash AND text.
    await ov.approve(cs, 'alice', H(2), db, { 'ssrf/workflow': 'NEW FACTORY' })
    const m = meta(db, cs)
    expect((m.baseFactoryText as Record<string, string>).workflow).toBe('NEW FACTORY')
    expect(m.staleReason).toBeUndefined()
    const re = db.rows('pluginOverride').find((r) => r.changeSetId === cs)!
    expect(re.status).toBe('active')
    expect(re.baseSha256).toBe(sha(2))
  })

  test('without currentTexts the re-approval leaves baseFactoryText as it was', async () => {
    const cs = await proposeParts(alice, 'ssrf', { workflow: 'better' })
    await setBaseFactoryText(cs, { workflow: 'OLD FACTORY' })
    await ov.approve(cs, 'alice', H(1), db)
    await ov.markStale(cs, 'factory_changed', db)
    await ov.approve(cs, 'alice', H(2), db)
    expect((meta(db, cs).baseFactoryText as Record<string, string>).workflow).toBe('OLD FACTORY')
  })
})
