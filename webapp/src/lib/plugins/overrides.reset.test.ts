/**
 * @vitest-environment node
 */
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'
import { createFakePrisma, type FakePrisma } from './__testing__/fakePrisma'
import { setNowForTests } from './clock'

const h = vi.hoisted(() => ({ db: null as unknown as Record<string, unknown> }))
vi.mock('@/lib/prisma', () => ({ default: new Proxy({}, { get: (_t, k) => h.db[k as string] }) }))
import * as ov from './overrides'
import { alice, p1, hashes, seedPlatform, proposeParts, statuses } from './__testing__/overrideFixtures'

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

const H = hashes('sqli', ['workflow'])

describe('reset to factory', () => {
  test('the active version becomes cleared and the factory text applies again', async () => {
    const id = await proposeParts(alice, 'sqli', { workflow: 'W' })
    await ov.approve(id, 'alice', H)
    expect(await ov.reset(alice, 'skill.text', 'sqli', 'alice')).toEqual({ changeSetId: id, revision: 2 })
    expect(statuses(db, id)).toEqual(['sqli/workflow:cleared'])
    expect(db.rows('pluginOverride')[0].decidedBy).toBe('alice')
    expect(await ov.resolveForProject('p1')).toEqual({})
  })

  test('nothing active: nothing to reset', async () => {
    await proposeParts(alice, 'sqli', { workflow: 'W' })
    expect(await ov.reset(alice, 'skill.text', 'sqli', 'alice')).toBeNull()
    expect(db.rows('pluginOverride')[0].status).toBe('proposed')
  })

  test.each([
    ['uninstalled with its data kept', { status: 'available', enabled: false }],
    ['disabled', { enabled: false }],
    ['revoked', { revokedReason: 'x' }],
  ])('works when the plugin is %s', async (_n, patch) => {
    const id = await proposeParts(alice, 'sqli', { workflow: 'W' })
    await ov.approve(id, 'alice', H)
    Object.assign(db.tables.pluginInstall.get('skiller')!, patch)
    expect(await ov.reset(alice, 'skill.text', 'sqli', 'alice')).not.toBeNull()
    expect(statuses(db, id)).toEqual(['sqli/workflow:cleared'])
  })

  test('a project reset leaves the user scope alone, and the reverse', async () => {
    const u = await proposeParts(alice, 'sqli', { workflow: 'U' })
    await ov.approve(u, 'alice', H)
    const p = await proposeParts(p1, 'sqli', { workflow: 'P' })
    await ov.approve(p, 'alice', H)
    await ov.reset(p1, 'skill.text', 'sqli', 'alice')
    expect(statuses(db, u)).toEqual(['sqli/workflow:active'])
    expect((await ov.resolveForProject('p1'))['sqli/workflow'].value).toBe('U')
  })

  test('another skill is untouched', async () => {
    const x = await proposeParts(alice, 'xss', { workflow: 'X' })
    await ov.approve(x, 'alice', hashes('xss', ['workflow']))
    expect(await ov.reset(alice, 'skill.text', 'sqli', 'alice')).toBeNull()
    expect(statuses(db, x)).toEqual(['xss/workflow:active'])
  })
})
