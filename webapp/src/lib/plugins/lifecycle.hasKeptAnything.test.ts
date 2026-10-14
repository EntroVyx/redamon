/**
 * hasKeptAnything (lifecycle.ts): whether an uninstalled plugin left something an admin can
 * still manage. A `user_skill.text` row that is no longer waiting (adopted, rejected,
 * withdrawn) is only the provenance of a decision and keeps nothing; a proposal still waiting
 * does, and so does any built-in (`skill.text`) row and any live data row.
 *
 * @vitest-environment node
 */
import { describe, test, expect, beforeEach, vi } from 'vitest'

const h = vi.hoisted(() => ({ db: null as unknown as Record<string, unknown> }))
vi.mock('@/lib/prisma', () => ({ default: new Proxy({}, { get: (_t, k) => h.db[k as string] }) }))
vi.mock('@/lib/audit', () => ({ writeAudit: vi.fn() }))

import { createFakePrisma, type FakePrisma, type Row } from './__testing__/fakePrisma'
import { hasKeptAnything } from './lifecycle'

let db: FakePrisma
let n = 0

const override = (extensionPoint: string, status: string, pluginId = 'echo'): Row => {
  n++
  const group = extensionPoint === 'skill.text' ? 'sqli' : 'skflow'
  return {
    pluginId, extensionPoint, scopeType: 'user', scopeId: 'user-alice', userId: 'user-alice', targetGroup: group,
    targetKey: `${group}/${extensionPoint === 'skill.text' ? 'workflow' : 'body'}`, changeSetId: `cs-${n}`, value: 'v',
    baseSha256: 'a'.repeat(64), status, createdBy: 'user-alice',
  }
}

beforeEach(() => {
  db = createFakePrisma()
  h.db = db as unknown as Record<string, unknown>
  db.seed('pluginInstall', [{ pluginId: 'echo', status: 'available', enabled: false }])
})

describe('hasKeptAnything', () => {
  test('nothing at all: false', async () => {
    expect(await hasKeptAnything('echo')).toBe(false)
  })

  test('only decided user-skill rows (adopted, rejected, withdrawn): false', async () => {
    db.seed('pluginOverride', [override('user_skill.text', 'adopted'), override('user_skill.text', 'rejected'), override('user_skill.text', 'withdrawn')])
    expect(await hasKeptAnything('echo')).toBe(false)
  })

  test('a user-skill proposal still waiting: true', async () => {
    db.seed('pluginOverride', [override('user_skill.text', 'adopted'), override('user_skill.text', 'proposed')])
    expect(await hasKeptAnything('echo')).toBe(true)
  })

  test.each(['proposed', 'active', 'rejected', 'withdrawn', 'superseded', 'stale', 'cleared'])('a skill.text row (%s): true', async (status) => {
    db.seed('pluginOverride', [override('skill.text', status)])
    expect(await hasKeptAnything('echo')).toBe(true)
  })

  test("another plugin's rows count for nothing", async () => {
    db.seed('pluginOverride', [override('skill.text', 'active', 'other'), override('user_skill.text', 'proposed', 'other')])
    expect(await hasKeptAnything('echo')).toBe(false)
  })

  test('a live data row keeps it; a platform row (__jobs) does not', async () => {
    db.seed('pluginData', [{ pluginId: 'echo', ownerType: 'user', ownerId: 'user-alice', userId: 'user-alice', collection: '__jobs', key: 'j', value: {}, sizeBytes: 2 }])
    expect(await hasKeptAnything('echo')).toBe(false)
    db.seed('pluginData', [{ pluginId: 'echo', ownerType: 'user', ownerId: 'user-alice', userId: 'user-alice', collection: 'items', key: 'a', value: {}, sizeBytes: 2 }])
    expect(await hasKeptAnything('echo')).toBe(true)
  })
})
