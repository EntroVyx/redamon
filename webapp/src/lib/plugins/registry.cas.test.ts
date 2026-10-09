/**
 * Compare-and-swap and leases on the install registry, against the in-memory Prisma
 * double (whose updateMany counts like Postgres). tests/plugins_db_test.sh runs the
 * same race between two real Postgres sessions.
 *
 * @vitest-environment node
 */
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'
import { createFakePrisma, type FakePrisma } from './__testing__/fakePrisma'
import { setNowForTests } from './clock'

const h = vi.hoisted(() => ({ db: null as unknown as Record<string, unknown> }))
vi.mock('@/lib/prisma', () => ({ default: new Proxy({}, { get: (_t, k) => h.db[k as string] }) }))

import {
  LEASE_MS,
  PluginConflictError,
  beginOperation,
  createForInstall,
  endOperation,
  findInstall,
  heartbeat,
  takeOverOperation,
  transition,
} from './registry'

let db: FakePrisma
let t: number
const at = (ms: number) => (t = ms)
beforeEach(() => {
  db = createFakePrisma()
  h.db = db as unknown as Record<string, unknown>
  t = Date.parse('2026-10-09T12:00:00Z')
  setNowForTests(() => new Date(t))
})
afterEach(() => setNowForTests(null))

const row = () => db.rows('pluginInstall')[0]

describe('two operations at once', () => {
  test('exactly one of two concurrent installs from available wins', async () => {
    db.seed('pluginInstall', [{ pluginId: 'demo', status: 'available' }])
    const results = await Promise.allSettled([
      beginOperation('demo', ['available'], 'installing', 'install'),
      beginOperation('demo', ['available'], 'installing', 'install'),
    ])
    const won = results.filter((r) => r.status === 'fulfilled')
    const lost = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[]
    expect(won).toHaveLength(1)
    expect(lost).toHaveLength(1)
    expect(lost[0].reason).toBeInstanceOf(PluginConflictError)
    expect(row().operationId).toBe((won[0] as PromiseFulfilledResult<{ operationId: string }>).value.operationId)
  })

  test('two first installs of an unknown plugin: the second insert is refused', async () => {
    const [a, b] = await Promise.allSettled([createForInstall('skiller'), createForInstall('skiller')])
    expect([a.status, b.status].sort()).toEqual(['fulfilled', 'rejected'])
    expect(((a.status === 'rejected' ? a : b) as PromiseRejectedResult).reason).toBeInstanceOf(PluginConflictError)
    expect(db.rows('pluginInstall')).toHaveLength(1)
  })

  test('createForInstall refuses an invalid or reserved id', async () => {
    await expect(createForInstall('Bad Id')).rejects.toThrow(/Invalid plugin id/)
    await expect(createForInstall('plugins')).rejects.toThrow(/Invalid plugin id/)
  })
})

describe('leases', () => {
  test('beginOperation records the operation, its kind, its arguments and a lease', async () => {
    db.seed('pluginInstall', [{ pluginId: 'demo', status: 'ready' }])
    const op = await beginOperation('demo', ['ready', 'failed', 'incompatible'], 'uninstalling', 'uninstall', { mode: 'purge' })
    expect(op).toMatchObject({ pluginId: 'demo', kind: 'uninstall', status: 'uninstalling' })
    expect(row()).toMatchObject({
      status: 'uninstalling',
      operationId: op.operationId,
      operationKind: 'uninstall',
      operationArgs: { mode: 'purge' },
    })
    expect((row().leaseExpiresAt as Date).getTime()).toBe(t + LEASE_MS)
  })

  test('a live lease blocks another operation even when the status matches', async () => {
    db.seed('pluginInstall', [
      { pluginId: 'demo', status: 'ready', operationId: 'held', leaseExpiresAt: new Date(t + 60_000) },
    ])
    await expect(beginOperation('demo', ['ready'], 'uninstalling', 'uninstall')).rejects.toBeInstanceOf(
      PluginConflictError,
    )
    await expect(transition('demo', { from: ['ready'], to: 'failed' })).rejects.toBeInstanceOf(PluginConflictError)
    expect(row()).toMatchObject({ status: 'ready', operationId: 'held' })
  })

  test('the same plugin after the lease expired: the new operation wins', async () => {
    db.seed('pluginInstall', [
      { pluginId: 'demo', status: 'ready', operationId: 'held', leaseExpiresAt: new Date(t + 60_000) },
    ])
    at(t + 60_001)
    const op = await beginOperation('demo', ['ready'], 'uninstalling', 'uninstall')
    expect(row()).toMatchObject({ status: 'uninstalling', operationId: op.operationId })
  })

  test('an expired lease lets reconciliation take over; the crashed operation cannot end it', async () => {
    db.seed('pluginInstall', [{ pluginId: 'demo', status: 'ready' }])
    const crashed = await beginOperation('demo', ['ready'], 'updating', 'update')
    at(t + LEASE_MS + 1)
    // Reconciliation keeps the old version: updating -> ready, lease cleared.
    await transition('demo', { from: ['updating'], to: 'ready', patch: { operationId: null, leaseExpiresAt: null } })
    expect(row()).toMatchObject({ status: 'ready', operationId: null })
    // A new operation starts; the crashed one can neither extend nor end anything.
    const next = await beginOperation('demo', ['ready'], 'uninstalling', 'uninstall')
    await expect(heartbeat(crashed)).rejects.toBeInstanceOf(PluginConflictError)
    await expect(endOperation(crashed, 'ready')).rejects.toBeInstanceOf(PluginConflictError)
    expect(row()).toMatchObject({ status: 'uninstalling', operationId: next.operationId })
  })

  test('a running operation blocks a plain transition until it ends', async () => {
    db.seed('pluginInstall', [{ pluginId: 'demo', status: 'ready' }])
    const op = await beginOperation('demo', ['ready'], 'updating', 'update')
    await expect(transition('demo', { from: ['updating'], to: 'ready' })).rejects.toBeInstanceOf(PluginConflictError)
    await endOperation(op, 'ready')
    await transition('demo', { from: ['ready'], to: 'failed' })
    expect(row().status).toBe('failed')
  })

  test('heartbeat keeps a long operation alive', async () => {
    db.seed('pluginInstall', [{ pluginId: 'demo', status: 'ready' }])
    const op = await beginOperation('demo', ['ready'], 'updating', 'update')
    at(t + LEASE_MS - 1000)
    await heartbeat(op)
    at(t + LEASE_MS - 1000)
    await expect(transition('demo', { from: ['updating'], to: 'ready' })).rejects.toBeInstanceOf(PluginConflictError)
    await endOperation(op, 'ready')
    expect(row().status).toBe('ready')
  })

  test('endOperation sets the final status and patch and clears the four lease fields', async () => {
    const op = await createForInstall('skiller', { url: 'https://example.org/a.tar.gz' })
    await endOperation(op, 'ready', { activeVersion: '1.0.0', installedBy: 'admin-1', enabled: true })
    expect(row()).toMatchObject({
      status: 'ready',
      activeVersion: '1.0.0',
      installedBy: 'admin-1',
      enabled: true,
      operationId: null,
      operationKind: null,
      operationArgs: null,
      leaseExpiresAt: null,
    })
  })

  test('endOperation of an operation that does not hold the row fails and changes nothing', async () => {
    db.seed('pluginInstall', [{ pluginId: 'demo', status: 'ready' }])
    const op = await beginOperation('demo', ['ready'], 'updating', 'update')
    const impostor = { ...op, operationId: 'someone-else' }
    await expect(endOperation(impostor, 'ready')).rejects.toBeInstanceOf(PluginConflictError)
    expect(row()).toMatchObject({ status: 'updating', operationId: op.operationId })
  })

  test('a disabled plugin can be updated: the lease does not look at enabled', async () => {
    db.seed('pluginInstall', [{ pluginId: 'demo', status: 'ready', enabled: false }])
    const op = await beginOperation('demo', ['ready'], 'updating', 'update')
    await endOperation(op, 'ready', { activeVersion: '1.1.0' })
    expect(row()).toMatchObject({ status: 'ready', enabled: false, activeVersion: '1.1.0' })
  })

  test('an expired lease cannot be revived by its own heartbeat', async () => {
    db.seed('pluginInstall', [{ pluginId: 'demo', status: 'ready' }])
    const op = await beginOperation('demo', ['ready'], 'updating', 'update')
    at(t + LEASE_MS + 1)
    await expect(heartbeat(op)).rejects.toBeInstanceOf(PluginConflictError)
  })

  test('takeOverOperation claims an expired lease without changing the status', async () => {
    db.seed('pluginInstall', [{ pluginId: 'demo', status: 'ready' }])
    const crashed = await beginOperation('demo', ['ready'], 'updating', 'update', { to: '1.1.0' })
    await expect(takeOverOperation('demo', 'updating', 'rollback')).rejects.toBeInstanceOf(PluginConflictError)
    at(t + LEASE_MS + 1)
    const recovery = await takeOverOperation('demo', 'updating', 'rollback', { reason: 'lease expired' })
    expect(recovery).toMatchObject({ pluginId: 'demo', kind: 'rollback', status: 'updating' })
    expect(row()).toMatchObject({
      status: 'updating',
      operationId: recovery.operationId,
      operationKind: 'rollback',
      operationArgs: { reason: 'lease expired' },
    })
    await expect(heartbeat(crashed)).rejects.toBeInstanceOf(PluginConflictError)
    await expect(endOperation(crashed, 'ready')).rejects.toBeInstanceOf(PluginConflictError)
    await heartbeat(recovery)
    await endOperation(recovery, 'ready', { activeVersion: '1.0.0' })
    expect(row()).toMatchObject({ status: 'ready', operationId: null, activeVersion: '1.0.0' })
  })

  test('takeOverOperation needs the expected status and a free or expired lease, once', async () => {
    db.seed('pluginInstall', [{ pluginId: 'demo', status: 'ready' }])
    await expect(takeOverOperation('demo', 'updating', 'update')).rejects.toBeInstanceOf(PluginConflictError)
    const [a, b] = await Promise.allSettled([
      takeOverOperation('demo', 'ready', 'update'),
      takeOverOperation('demo', 'ready', 'update'),
    ])
    expect([a.status, b.status].sort()).toEqual(['fulfilled', 'rejected'])
    await expect(takeOverOperation(undefined as unknown as string, 'ready', 'update')).rejects.toThrow(/Invalid plugin id/)
  })

  test('findInstall reads one row', async () => {
    db.seed('pluginInstall', [{ pluginId: 'demo', status: 'ready' }])
    expect((await findInstall('demo'))?.status).toBe('ready')
    expect(await findInstall('other')).toBeNull()
  })
})
