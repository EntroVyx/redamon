/**
 * Enable and disable (README.PLUGINS.md §9.4): `enabled` is the admin's wish, code and data
 * stay either way. Disabling stops actions, contributions and the overrides from
 * qualifying; enabling checks the platform range first, then the runner starts the worker
 * (Retry for a failed plugin is the same call). Each is one compare-and-set that a live
 * operation refuses.
 *
 * @vitest-environment node
 */
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'

const h = vi.hoisted(() => ({ db: null as unknown as Record<string, unknown>, audit: [] as Record<string, unknown>[] }))
vi.mock('@/lib/prisma', () => ({ default: new Proxy({}, { get: (_t, k) => h.db[k as string] }) }))
vi.mock('@/lib/audit', () => ({ writeAudit: vi.fn(async (e: Record<string, unknown>) => void h.audit.push(e)) }))

import { createFakePrisma, type FakePrisma } from './__testing__/fakePrisma'
import { ADMIN, NOW, startLifecycleWorld, type LifecycleWorld } from './__testing__/lifecycleHarness'
import { setNowForTests } from './clock'
import { LifecycleError, disable, enable, install } from './lifecycle'
import { beginOperation, servesActions } from './registry'
import * as ov from './overrides'

let db: FakePrisma
let w: LifecycleWorld
const PERMS = ['session:read', 'llm:invoke', 'override:skill.text', 'override:user_skill.text']
const SHA = 'a'.repeat(64)

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
  w = await startLifecycleWorld(() => db)
  await install('echo', { version: '1.0.0', acceptedPermissions: PERMS }, ADMIN, w.deps)
  h.audit = []
})

afterEach(async () => {
  await w.close()
  setNowForTests(null)
  vi.restoreAllMocks()
})

const row = () => db.rows('pluginInstall').find((r) => r.pluginId === 'echo')!
const patch = (p: Record<string, unknown>) => db.tables.pluginInstall.set('echo', { ...row(), ...p })

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

async function approvedOverride() {
  const { changeSetId } = await ov.propose({
    pluginId: 'echo',
    point: 'skill.text',
    scope: { type: 'user', id: 'user-alice' },
    targetGroup: 'sqli',
    parts: [{ targetKey: 'sqli/workflow', value: 'better text', baseSha256: SHA }],
    createdBy: 'user-alice',
  })
  await ov.approve(changeSetId, 'user-alice', { 'sqli/workflow': SHA })
  return changeSetId
}

describe('disable', () => {
  test('stops actions, the worker and the overrides; keeps code and data; audited', async () => {
    db.seed('pluginData', [
      { pluginId: 'echo', ownerType: 'user', ownerId: 'user-alice', userId: 'user-alice', collection: 'items', key: 'a', value: { x: 1 }, sizeBytes: 7 },
    ])
    await approvedOverride()
    expect(Object.keys(await ov.resolveForProject('project-alice'))).not.toEqual([])

    const out = await disable('echo', ADMIN)
    expect(out.plugin).toMatchObject({ enabled: false, status: 'ready', activeVersion: '1.0.0' })
    expect(servesActions(row() as never)).toBe(false)
    expect(w.runner.options.workers).toEqual([])
    expect(db.rows('pluginData')).toHaveLength(1)
    expect(await ov.resolveForProject('project-alice')).toEqual({})
    const a = h.audit.find((e) => e.action === 'plugin.disable')!
    expect(a).toMatchObject({ actorId: ADMIN, targetId: 'echo' })
    expect(a.before).toMatchObject({ enabled: true })
    expect(a.after).toMatchObject({ enabled: false })
  })

  test('with the runner down the plugin is still disabled (its worker goes at the next sync)', async () => {
    await w.runner.close()
    expect((await disable('echo', ADMIN)).plugin.enabled).toBe(false)
  })

  test('a failed plugin can be disabled', async () => {
    patch({ status: 'failed', lastError: 'worker_failed: x' })
    expect((await disable('echo', ADMIN)).plugin).toMatchObject({ enabled: false, status: 'failed' })
  })
})

describe('enable', () => {
  test('starts the worker again and restores everything', async () => {
    await approvedOverride()
    await disable('echo', ADMIN)
    const out = await enable('echo', ADMIN)
    expect(out.plugin).toMatchObject({ enabled: true, status: 'ready' })
    expect(w.runner.options.workers?.map((x) => x.id)).toEqual(['echo'])
    expect(Object.keys(await ov.resolveForProject('project-alice'))).toEqual(['sqli/workflow'])
    expect(h.audit.map((e) => e.action)).toContain('plugin.enable')
  })

  test('Retry: a failed plugin whose worker starts now becomes ready, lastError cleared', async () => {
    patch({ status: 'failed', lastError: 'runner_unavailable' })
    const out = await enable('echo', ADMIN)
    expect(out.plugin).toMatchObject({ status: 'ready', lastError: null, enabled: true })
  })

  test('a worker that cannot start leaves it failed, with the reason', async () => {
    await disable('echo', ADMIN)
    w.failing.add('echo@1.0.0')
    const out = await enable('echo', ADMIN)
    expect(out.plugin.status).toBe('failed')
    expect(String(out.plugin.lastError)).toMatch(/^worker_failed/)
  })

  test('the platform range is checked first: out of range → 409 and incompatible', async () => {
    await disable('echo', ADMIN)
    patch({ manifest: { ...(row().manifest as object), platform: '>=2.0.0 <3.0.0' } })
    const reloads = w.runner.reloads
    const e = await refusal(enable('echo', ADMIN))
    expect([e.status, e.code]).toEqual([409, 'platform_incompatible'])
    expect(row().status).toBe('incompatible')
    expect(row().enabled).toBe(false)
    expect(w.runner.reloads).toBe(reloads)
  })

  test('an incompatible plugin back in range becomes ready', async () => {
    patch({ status: 'incompatible' })
    expect((await enable('echo', ADMIN)).plugin.status).toBe('ready')
  })

  test('a revoked plugin cannot be enabled', async () => {
    await disable('echo', ADMIN)
    patch({ revokedReason: 'Leaks data.' })
    const e = await refusal(enable('echo', ADMIN))
    expect([e.status, e.code]).toEqual([409, 'plugin_revoked'])
    expect(row().enabled).toBe(false)
  })
})

describe('both', () => {
  test('a live operation refuses them with plugin_busy', async () => {
    await beginOperation('echo', ['ready'], 'updating', 'update')
    expect((await refusal(disable('echo', ADMIN))).code).toBe('plugin_busy')
    expect((await refusal(enable('echo', ADMIN))).code).toBe('plugin_busy')
    expect(row().enabled).toBe(true)
  })

  test('a plugin that is not installed → 409 not_installed', async () => {
    patch({ status: 'available', activeVersion: null })
    expect((await refusal(enable('echo', ADMIN))).code).toBe('not_installed')
    expect((await refusal(disable('echo', ADMIN))).code).toBe('not_installed')
    expect((await refusal(enable('nobody', ADMIN))).code).toBe('not_installed')
  })
})
