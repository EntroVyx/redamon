/**
 * Uninstall (README.PLUGINS.md §9.6): the runner is told first (the worker stops), then
 * the code leaves the volume. "Keep" leaves the row `available` with its data and
 * overrides dormant; "purge" deletes them for every user and project, only after an export
 * and a typed confirmation, and strips the plugin's model choice from every user (TD-10).
 *
 * @vitest-environment node
 */
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'
import path from 'node:path'

const h = vi.hoisted(() => ({ db: null as unknown as Record<string, unknown>, audit: [] as Record<string, unknown>[] }))
vi.mock('@/lib/prisma', () => ({ default: new Proxy({}, { get: (_t, k) => h.db[k as string] }) }))
vi.mock('@/lib/audit', () => ({ writeAudit: vi.fn(async (e: Record<string, unknown>) => void h.audit.push(e)) }))

import { createFakePrisma, type FakePrisma } from './__testing__/fakePrisma'
import { ADMIN, NOW, exists, startLifecycleWorld, type LifecycleWorld } from './__testing__/lifecycleHarness'
import { setNowForTests } from './clock'
import { exportPluginData } from './exportData'
import { EXPORT_FRESH_MS, LifecycleError, install, uninstall } from './lifecycle'
import * as ov from './overrides'

let db: FakePrisma
let w: LifecycleWorld
let clock: Date
const PERMS = ['session:read', 'llm:invoke', 'override:skill.text']
const SHA = 'a'.repeat(64)

beforeEach(async () => {
  db = createFakePrisma()
  h.db = db as unknown as Record<string, unknown>
  h.audit = []
  clock = NOW
  setNowForTests(() => clock)
  for (const m of ['warn', 'error', 'log'] as const) vi.spyOn(console, m).mockImplementation(() => {})
  db.seed('user', [
    { id: ADMIN, email: 'admin@example.com', role: 'admin' },
    { id: 'user-alice', email: 'alice@example.com', role: 'standard' },
    { id: 'user-bob', email: 'bob@example.com', role: 'standard' },
  ])
  db.seed('project', [{ id: 'project-alice', userId: 'user-alice', name: 'P' }])
  db.seed('userSettings', [
    { userId: 'user-alice', featureModels: { 'plugin:echo': 'openai/gpt-x', skiller: 'anthropic/claude' } },
    { userId: 'user-bob', featureModels: { 'plugin:other': 'm' } },
  ])
  w = await startLifecycleWorld(() => db)
  await install('echo', { version: '1.0.0', acceptedPermissions: PERMS }, ADMIN, w.deps)
  db.seed('pluginData', [
    { pluginId: 'echo', ownerType: 'user', ownerId: 'user-alice', userId: 'user-alice', collection: 'items', key: 'a', value: 1, sizeBytes: 1 },
    { pluginId: 'echo', ownerType: 'project', ownerId: 'project-alice', projectId: 'project-alice', collection: 'items', key: 'b', value: 2, sizeBytes: 1 },
  ])
  const { changeSetId } = await ov.propose({
    pluginId: 'echo',
    point: 'skill.text',
    scope: { type: 'user', id: 'user-alice' },
    targetGroup: 'sqli',
    parts: [{ targetKey: 'sqli/workflow', value: 'better', baseSha256: SHA }],
    createdBy: 'user-alice',
  })
  await ov.approve(changeSetId, 'user-alice', { 'sqli/workflow': SHA })
  h.audit = []
})

afterEach(async () => {
  await w.close()
  setNowForTests(null)
  vi.restoreAllMocks()
})

const row = () => db.rows('pluginInstall').find((r) => r.pluginId === 'echo')
const go = (mode: 'keep' | 'purge', confirm = 'echo') => uninstall('echo', { mode, confirm }, ADMIN)

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

describe('keep', () => {
  test('code gone, row available, data and overrides kept but dormant, audited', async () => {
    const out = await go('keep')
    expect(out.plugin).toMatchObject({ status: 'available', enabled: false, activeVersion: null })
    expect(await exists(path.join(w.root, 'echo'))).toBe(false)
    expect(db.rows('pluginData')).toHaveLength(2)
    expect(db.rows('pluginOverride').map((r) => r.status)).toEqual(['active'])
    expect(await ov.resolveForProject('project-alice')).toEqual({})
    expect(row()!.dataVersion).toBe(1)
    expect(row()!.operationId).toBeNull()
    const a = h.audit.find((e) => e.action === 'plugin.uninstall')!
    expect(a).toMatchObject({ actorId: ADMIN, targetId: 'echo' })
    expect(a.after).toMatchObject({ mode: 'keep', status: 'available' })
  })

  test('the runner is reloaded BEFORE the folder is removed (the worker stops first)', async () => {
    const before = w.reloadSpy.length
    await go('keep')
    expect(w.reloadSpy.length).toBe(before + 1)
    expect(w.reloadSpy.at(-1)!.folders).toContain(path.join('echo', 'versions', '1.0.0'))
    expect(w.runner.options.workers).toEqual([])
  })

  test('with the runner down the folder is removed anyway', async () => {
    await w.runner.close()
    expect((await go('keep')).plugin?.status).toBe('available')
    expect(await exists(path.join(w.root, 'echo'))).toBe(false)
  })
})

describe('purge', () => {
  test('refused until an export was made in the last hour', async () => {
    const e = await refusal(go('purge'))
    expect([e.status, e.code]).toEqual([409, 'export_required'])
    expect(row()!.status).toBe('ready')
    await exportPluginData('echo', ADMIN)
    clock = new Date(NOW.getTime() + EXPORT_FRESH_MS + 1)
    expect((await refusal(go('purge'))).code).toBe('export_required')
  })

  test('after an export: rows gone for every owner, model choice stripped from every user, audited', async () => {
    await exportPluginData('echo', ADMIN)
    const out = await go('purge')
    expect(out.plugin).toBeNull()
    expect(row()).toBeUndefined()
    expect(db.rows('pluginData')).toEqual([])
    expect(db.rows('pluginOverride')).toEqual([])
    expect(await exists(path.join(w.root, 'echo'))).toBe(false)
    const fm = Object.fromEntries(db.rows('userSettings').map((s) => [s.userId, s.featureModels]))
    expect(fm['user-alice']).toEqual({ skiller: 'anthropic/claude' })
    expect(fm['user-bob']).toEqual({ 'plugin:other': 'm' })
    expect(db.rawCalls.some((c) => /feature_models/.test(c.sql) && c.values[0] === 'plugin:echo')).toBe(true)
    const a = h.audit.find((e) => e.action === 'plugin.purge')!
    expect(a.after).toMatchObject({ mode: 'purge', dataRows: 2, overrideRows: 1 })
    expect(db.rows('pluginPlatformState').some((s) => String(s.key).startsWith('export:echo'))).toBe(false)
  })

  test('the typed confirmation must be the plugin id', async () => {
    await exportPluginData('echo', ADMIN)
    const e = await refusal(go('purge', 'ech'))
    expect([e.status, e.code]).toEqual([400, 'confirm_mismatch'])
    expect(row()!.status).toBe('ready')
  })
})

describe('delete kept data (purge of a plugin uninstalled with "keep")', () => {
  beforeEach(async () => {
    await go('keep')
    h.audit = []
  })

  test('after an export: rows, versions, model choice and the row gone, audited as kept', async () => {
    await exportPluginData('echo', ADMIN)
    const out = await go('purge')
    expect(out.plugin).toBeNull()
    expect(row()).toBeUndefined()
    expect(db.rows('pluginData')).toEqual([])
    expect(db.rows('pluginOverride')).toEqual([])
    expect(db.rows('userSettings').find((s) => s.userId === 'user-alice')!.featureModels).toEqual({ skiller: 'anthropic/claude' })
    expect(db.rows('pluginPlatformState').some((s) => String(s.key).startsWith('export:echo'))).toBe(false)
    expect(h.audit.find((e) => e.action === 'plugin.purge')!.after).toMatchObject({ mode: 'purge', kept: true, dataRows: 2, overrideRows: 1 })
  })

  test('the same gates: a fresh export and the typed id', async () => {
    expect((await refusal(go('purge'))).code).toBe('export_required')
    await exportPluginData('echo', ADMIN)
    expect((await refusal(go('purge', 'ech'))).code).toBe('confirm_mismatch')
    expect(row()!.status).toBe('available')
    expect(db.rows('pluginData')).toHaveLength(2)
  })

  test('an install holding the row (a live lease): 409, nothing deleted', async () => {
    await exportPluginData('echo', ADMIN)
    db.tables.pluginInstall.set('echo', { ...row()!, status: 'installing', operationId: 'op-1', leaseExpiresAt: new Date(NOW.getTime() + 60_000) })
    const e = await refusal(go('purge'))
    expect(e.status).toBe(409)
    expect(db.rows('pluginData')).toHaveLength(2)
    expect(db.rows('pluginOverride')).toHaveLength(1)
  })

  test('"keep" again is still not_installed; a plugin never seen is not_installed too', async () => {
    expect((await refusal(go('keep'))).code).toBe('not_installed')
    expect((await refusal(uninstall('other', { mode: 'purge', confirm: 'other' }, ADMIN))).code).toBe('not_installed')
  })
})

describe('refusals', () => {
  test('an unknown mode → 400', async () => {
    const e = await refusal(uninstall('echo', { mode: 'wipe' as never, confirm: 'echo' }, ADMIN))
    expect([e.status, e.code]).toEqual([400, 'invalid_request'])
  })

  test('not installed → 409', async () => {
    await go('keep')
    expect((await refusal(go('keep'))).code).toBe('not_installed')
  })

  test('two uninstalls at once: one wins', async () => {
    const results = await Promise.allSettled([go('keep'), go('keep')])
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    const bad = results.find((r): r is PromiseRejectedResult => r.status === 'rejected')!
    expect((bad.reason as LifecycleError).status).toBe(409)
  })
})
