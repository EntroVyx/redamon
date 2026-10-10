/**
 * Reinstall after "keep" (README.PLUGINS.md §9.6): the normal install finds the kept row
 * and data. Old code never runs on newer data (`data_newer_than_release`, OQ-20); older
 * data needs a migration. The admin decides whether the plugin's previous overrides come
 * back, and a restored set whose factory text changed comes back `stale`, never `active`
 * (design L965-966, RV-30).
 *
 * @vitest-environment node
 */
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'

const h = vi.hoisted(() => ({ db: null as unknown as Record<string, unknown>, audit: [] as Record<string, unknown>[] }))
vi.mock('@/lib/prisma', () => ({ default: new Proxy({}, { get: (_t, k) => h.db[k as string] }) }))
vi.mock('@/lib/audit', () => ({ writeAudit: vi.fn(async (e: Record<string, unknown>) => void h.audit.push(e)) }))

import { createFakePrisma, type FakePrisma } from './__testing__/fakePrisma'
import { ADMIN, NOW, registryOf, startLifecycleWorld, type LifecycleWorld } from './__testing__/lifecycleHarness'
import { setNowForTests } from './clock'
import { LifecycleError, install, uninstall } from './lifecycle'
import * as ov from './overrides'

let db: FakePrisma
let w: LifecycleWorld
const PERMS = ['session:read', 'llm:invoke', 'override:skill.text']
const OLD = 'a'.repeat(64)
const NEW = 'b'.repeat(64)

beforeEach(async () => {
  db = createFakePrisma()
  h.db = db as unknown as Record<string, unknown>
  h.audit = []
  setNowForTests(() => NOW)
  for (const m of ['warn', 'error', 'log'] as const) vi.spyOn(console, m).mockImplementation(() => {})
  db.seed('user', [
    { id: ADMIN, email: 'admin@example.com', role: 'admin' },
    { id: 'user-alice', email: 'alice@example.com', role: 'standard' },
  ])
  db.seed('project', [{ id: 'project-alice', userId: 'user-alice', name: 'P' }])
  w = await startLifecycleWorld(() => db, [{}, { manifest: { version: '1.1.0', dataVersion: 2 } }])
})

afterEach(async () => {
  await w.close()
  setNowForTests(null)
  vi.restoreAllMocks()
})

const row = () => db.rows('pluginInstall').find((r) => r.pluginId === 'echo')!
const go = (version = '1.0.0', over: Record<string, unknown> = {}) =>
  install('echo', { version, acceptedPermissions: PERMS, ...over } as never, ADMIN, w.deps)

async function refusal(p: Promise<unknown>): Promise<LifecycleError> {
  const e = await p.then(
    () => {
      throw new Error('expected a refusal')
    },
    (err) => err,
  )
  expect(e).toBeInstanceOf(LifecycleError)
  return e as LifecycleError
}

async function activeSet(group: string, part: string, base = OLD) {
  const { changeSetId } = await ov.propose({
    pluginId: 'echo',
    point: 'skill.text',
    scope: { type: 'user', id: 'user-alice' },
    targetGroup: group,
    parts: [{ targetKey: `${group}/${part}`, value: `better ${group}`, baseSha256: base }],
    createdBy: 'user-alice',
  })
  await ov.approve(changeSetId, 'user-alice', { [`${group}/${part}`]: base })
  return changeSetId
}

const setStatus = (id: string) => db.rows('pluginOverride').find((r) => r.changeSetId === id)!

describe('data versions', () => {
  test('the same dataVersion: the kept data is there again, ready', async () => {
    await go()
    db.seed('pluginData', [{ pluginId: 'echo', ownerType: 'user', ownerId: 'user-alice', userId: 'user-alice', collection: 'items', key: 'a', value: 1, sizeBytes: 1 }])
    await uninstall('echo', { mode: 'keep', confirm: 'echo' }, ADMIN)
    expect((await go()).plugin.status).toBe('ready')
    expect(db.rows('pluginData')).toHaveLength(1)
  })

  test('kept data newer than the release → 409 data_newer_than_release, nothing changes', async () => {
    await go('1.1.0')
    db.seed('pluginData', [{ pluginId: 'echo', ownerType: 'user', ownerId: 'user-alice', userId: 'user-alice', collection: 'items', key: 'a', value: 1, sizeBytes: 1 }])
    await uninstall('echo', { mode: 'keep', confirm: 'echo' }, ADMIN)
    const before = JSON.stringify(row())
    const e = await refusal(go('1.0.0'))
    expect([e.status, e.code]).toEqual([409, 'data_newer_than_release'])
    expect(JSON.stringify(row())).toBe(before)
    expect(w.downloads.filter((u) => u.includes('echo-1.0.0'))).toEqual([])
  })

  test('newer data with no data row left is no obstacle', async () => {
    await go('1.1.0')
    await uninstall('echo', { mode: 'keep', confirm: 'echo' }, ADMIN)
    expect((await go('1.0.0')).plugin).toMatchObject({ status: 'ready', activeVersion: '1.0.0' })
    expect(row().dataVersion).toBe(1)
  })

  test('platform rows (jobs, usage) do not count as kept data', async () => {
    await go('1.1.0')
    db.seed('pluginData', [{ pluginId: 'echo', ownerType: 'user', ownerId: 'user-alice', userId: 'user-alice', collection: '__jobs', key: 'j', value: 1, sizeBytes: 1 }])
    await uninstall('echo', { mode: 'keep', confirm: 'echo' }, ADMIN)
    expect((await go('1.0.0')).plugin.status).toBe('ready')
  })
})

describe('overrides', () => {
  beforeEach(async () => {
    await go()
  })

  test('restoreOverrides is required when the plugin left active versions', async () => {
    await activeSet('sqli', 'workflow')
    await uninstall('echo', { mode: 'keep', confirm: 'echo' }, ADMIN)
    const e = await refusal(go())
    expect([e.status, e.code]).toEqual([400, 'restore_choice_required'])
    expect(e.details).toEqual(['1'])
    expect(row().status).toBe('available')
  })

  test('restoreOverrides true: unchanged sets stay active, changed ones come back stale with the reason', async () => {
    const same = await activeSet('sqli', 'workflow')
    const changed = await activeSet('xss', 'workflow')
    const removed = await activeSet('ssrf', 'payloads')
    await uninstall('echo', { mode: 'keep', confirm: 'echo' }, ADMIN)
    w.deps.registrySkill = registryOf({ sqli: { workflow: OLD }, xss: { workflow: NEW }, ssrf: { workflow: OLD } })
    h.audit = []
    expect((await go('1.0.0', { restoreOverrides: true })).plugin.status).toBe('ready')
    expect(setStatus(same).status).toBe('active')
    expect(setStatus(changed).status).toBe('stale')
    expect((setStatus(changed).meta as { staleReason: string }).staleReason).toBe('factory_changed')
    expect(setStatus(removed).status).toBe('stale')
    expect((setStatus(removed).meta as { staleReason: string }).staleReason).toBe('part_removed')
    expect(Object.keys(await ov.resolveForProject('project-alice'))).toEqual(['sqli/workflow'])
    expect(h.audit.filter((e) => e.action === 'plugin.override.stale')).toHaveLength(2)
  })

  test('restoreOverrides true with the agent unreachable: sets stay active, reconciliation checks them later', async () => {
    const id = await activeSet('sqli', 'workflow')
    await uninstall('echo', { mode: 'keep', confirm: 'echo' }, ADMIN)
    const { SkillPartsRegistryError } = await import('./skillPartsRegistry')
    w.deps.registrySkill = async () => {
      throw new SkillPartsRegistryError('agent_unreachable', "The agent service isn't running")
    }
    expect((await go('1.0.0', { restoreOverrides: true })).plugin.status).toBe('ready')
    expect(setStatus(id).status).toBe('active')
  })

  test('restoreOverrides false: the previously active versions are cleared (factory text)', async () => {
    const id = await activeSet('sqli', 'workflow')
    await uninstall('echo', { mode: 'keep', confirm: 'echo' }, ADMIN)
    h.audit = []
    await go('1.0.0', { restoreOverrides: false })
    expect(setStatus(id)).toMatchObject({ status: 'cleared', decidedBy: ADMIN })
    expect(await ov.resolveForProject('project-alice')).toEqual({})
    expect(h.audit.find((e) => e.action === 'plugin.override.reset')).toMatchObject({ targetId: id, actorId: ADMIN })
  })

  test('restoreOverrides must be a boolean when given', async () => {
    const e = await refusal(go('1.0.0', { restoreOverrides: 'yes' }))
    expect([e.status, e.code]).toEqual([400, 'invalid_request'])
  })
})

describe('migrations', () => {
  test('kept data older than the release is migrated by the release, as an update would', async () => {
    await go('1.0.0')
    db.seed('pluginData', [{ pluginId: 'echo', ownerType: 'user', ownerId: 'user-alice', userId: 'user-alice', collection: 'items', key: 'a', value: 1, sizeBytes: 1 }])
    await uninstall('echo', { mode: 'keep', confirm: 'echo' }, ADMIN)
    const out = await go('1.1.0')
    expect(out.plugin).toMatchObject({ status: 'ready', activeVersion: '1.1.0', dataVersion: 2 })
    expect(db.rows('pluginData').map((r) => r.value)).toEqual([{ v: 2, data: 1 }])
    expect(w.runner.migrateCalls.at(-1)!.body).toMatchObject({ version: '1.1.0', step: 2, direction: 'up' })
  })

  test.each([
    [false, { restoreOverrides: false }, 'plugin.override.reset'],
    [true, { restoreOverrides: true }, 'plugin.override.stale'],
  ])('a refused reinstall leaves the kept skill versions as they were (restore %s)', async (_restore, over, action) => {
    await go('1.0.0')
    const id = await activeSet('sqli', 'workflow')
    db.seed('pluginData', [{ pluginId: 'echo', ownerType: 'user', ownerId: 'user-alice', userId: 'user-alice', collection: 'items', key: 'a', value: { raise: true }, sizeBytes: 14 }])
    await uninstall('echo', { mode: 'keep', confirm: 'echo' }, ADMIN)
    h.audit = []
    // The factory text changed: a restore would mark the set stale, a "no" would clear it.
    const deps = { ...w.deps, registrySkill: registryOf({ sqli: { workflow: NEW } }) }
    const e = await refusal(install('echo', { version: '1.1.0', acceptedPermissions: PERMS, ...over }, ADMIN, deps))
    expect(e.code).toBe('migration_failed')
    expect(setStatus(id).status).toBe('active')
    expect(h.audit.some((a) => a.action === action)).toBe(false)
  })

  test('a failing migration at reinstall leaves the row available with the old data and no folder', async () => {
    await go('1.0.0')
    db.seed('pluginData', [{ pluginId: 'echo', ownerType: 'user', ownerId: 'user-alice', userId: 'user-alice', collection: 'items', key: 'a', value: { raise: true }, sizeBytes: 14 }])
    await uninstall('echo', { mode: 'keep', confirm: 'echo' }, ADMIN)
    const e = await refusal(go('1.1.0'))
    expect([e.status, e.code]).toEqual([422, 'migration_failed'])
    expect(row()).toMatchObject({ status: 'available', dataVersion: 1, activeVersion: null })
    expect(db.rows('pluginData').map((r) => [r.namespace, r.value])).toEqual([['live', { raise: true }]])
    const { exists } = await import('./__testing__/lifecycleHarness')
    const { versionPath } = await import('./staging')
    expect(await exists(versionPath('echo', '1.1.0'))).toBe(false)
  })
})
