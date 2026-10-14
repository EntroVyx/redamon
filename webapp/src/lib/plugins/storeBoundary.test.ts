/**
 * Every store entry point refuses a missing or malformed id BEFORE it reaches Prisma.
 * Prisma drops a `where` key whose value is undefined, so an id that is undefined (a
 * JSON field a later gateway forgot) would otherwise match every row: withdraw every
 * plugin's proposals, read every user's versions, move every plugin's status.
 * Each case also checks that nothing changed.
 *
 * @vitest-environment node
 */
import { describe, test, expect, beforeEach, vi } from 'vitest'
import { createFakePrisma, type FakePrisma } from './__testing__/fakePrisma'

const h = vi.hoisted(() => ({ db: null as unknown as Record<string, unknown> }))
vi.mock('@/lib/prisma', () => ({ default: new Proxy({}, { get: (_t, k) => h.db[k as string] }) }))

import * as ov from './overrides'
import * as store from './dataStore'
import * as registry from './registry'
import { alice, bob, hashes, seedPlatform, proposeParts } from './__testing__/overrideFixtures'

let db: FakePrisma
const U = undefined as unknown as string
const snapshot = () => JSON.stringify([db.rows('pluginInstall'), db.rows('pluginData'), db.rows('pluginOverride')])

beforeEach(async () => {
  db = createFakePrisma()
  h.db = db as unknown as Record<string, unknown>
  seedPlatform(db)
  db.seed('pluginInstall', [{ pluginId: 'third', status: 'ready', enabled: true }])
  const a = await proposeParts(alice, 'sqli', { workflow: 'A' })
  await ov.approve(a, 'alice', hashes('sqli', ['workflow']))
  await proposeParts(alice, 'sqli', { workflow: 'pending' })
  await proposeParts(bob, 'sqli', { workflow: 'bob' }, { pluginId: 'echo' })
  await store.put({ pluginId: 'skiller' }, { type: 'user', id: 'alice' }, 'c', 'k', 1)
  await store.put({ pluginId: 'echo' }, { type: 'user', id: 'bob' }, 'c', 'k', 2)
})

async function refusedAndUnchanged(run: () => Promise<unknown>) {
  const before = snapshot()
  await expect(run()).rejects.toThrow()
  expect(snapshot()).toBe(before)
}

describe('override store', () => {
  test.each([
    ['approve(undefined)', () => ov.approve(U, 'alice', {})],
    ['approve(not a uuid)', () => ov.approve('x', 'alice', {})],
    ['approve without an actor', () => ov.approve('00000000-0000-4000-8000-000000000000', U, {})],
    ['reject(undefined)', () => ov.reject(U, 'alice')],
    ['withdraw(undefined)', () => ov.withdraw(U, 'skiller')],
    ['withdraw by an undefined plugin', () => ov.withdraw('00000000-0000-4000-8000-000000000000', U)],
    ['deleteChangeSet(undefined)', () => ov.deleteChangeSet(U)],
    ['reset with an undefined scope id', () => ov.reset({ type: 'user', id: U }, 'skill.text', 'sqli', 'alice')],
    ['reset with an undefined group', () => ov.reset(alice, 'skill.text', U, 'alice')],
    ['reset at an unknown point', () => ov.reset(alice, U, 'sqli', 'alice')],
    ['reset without an actor', () => ov.reset(alice, 'skill.text', 'sqli', U)],
  ])('%s is refused and changes nothing', async (_n, run) => {
    await refusedAndUnchanged(run)
  })

  test.each([
    ['listVersions', () => ov.listVersions({ type: 'user', id: U }, 'skill.text', 'sqli')],
    ['pendingCount', () => ov.pendingCount(alice, 'skill.text', U)],
    ['activeChangeSet', () => ov.activeChangeSet({ type: 'user', id: U }, 'skill.text', 'sqli')],
    ['lastRevision', () => ov.lastRevision(alice, U, 'sqli')],
  ])('%s with an undefined part of its key is refused', async (_n, run) => {
    await expect(run()).rejects.toMatchObject({ code: 'invalid_target' })
  })

  test('reads by change set id return nothing for an id that cannot exist', async () => {
    expect(await ov.getChangeSet(U)).toBeNull()
    expect(await ov.getChangeSet('')).toBeNull()
    expect(await ov.markStale([U, 'x'], 'factory_changed')).toEqual([])
  })

  test('resolution of an undefined project or skill is empty, never everything', async () => {
    expect(await ov.resolveForProject(U)).toEqual({})
    expect(await ov.resolveForProject('')).toEqual({})
    expect(await ov.effectiveForProject('p1', U)).toBeNull()
    expect(await ov.effectiveForProject(U, 'sqli')).toBeNull()
  })
})

describe('data store', () => {
  const owner = { type: 'user' as const, id: 'alice' }
  test.each([
    ['get', () => store.get({ pluginId: U }, owner, 'c', 'k')],
    ['put', () => store.put({ pluginId: U }, owner, 'c', 'k2', 1)],
    ['query', () => store.query({ pluginId: U }, owner, 'c')],
    ['remove', () => store.remove({ pluginId: U }, owner, 'c', 'k')],
    ['copyNamespace', () => store.copyNamespace(U, 'live', 'migrating:op-1')],
    ['swapNamespace', () => store.swapNamespace(U, 'migrating:op-1', 'live')],
    ['a missing scope', () => store.get(undefined as never, owner, 'c', 'k')],
  ])('%s with an undefined plugin id is refused and changes nothing', async (_n, run) => {
    const before = snapshot()
    await expect(run()).rejects.toMatchObject({ code: 'invalid_plugin' })
    expect(snapshot()).toBe(before)
  })
})

describe('install registry', () => {
  test.each([
    ['transition(undefined)', () => registry.transition(U, { from: ['ready'], to: 'failed' })],
    ['beginOperation(undefined)', () => registry.beginOperation(U, ['ready'], 'updating', 'update')],
    ['heartbeat of an operation without ids', () =>
      registry.heartbeat({ pluginId: U, operationId: U, kind: 'update', status: 'ready' })],
    ['endOperation of an operation without ids', () =>
      registry.endOperation({ pluginId: U, operationId: U, kind: 'update', status: 'ready' }, 'failed')],
    ['endOperation without an operation id', () =>
      registry.endOperation({ pluginId: 'skiller', operationId: U, kind: 'update', status: 'ready' }, 'failed')],
  ])('%s is refused and moves no plugin', async (_n, run) => {
    await refusedAndUnchanged(run)
  })
})
