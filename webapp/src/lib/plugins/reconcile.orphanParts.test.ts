/**
 * Stale overrides (TD-16, R-48, X28): every active `skill.text` version is compared with the
 * agent's part registry. A part the registry no longer lists makes the whole set `stale`
 * with `part_removed`; a part whose factory hash changed, `factory_changed`; both audited.
 * When the agent cannot be asked, nothing is guessed: the check is skipped and logged.
 *
 * @vitest-environment node
 */
import { test, expect, beforeEach, afterEach, vi } from 'vitest'

const h = vi.hoisted(() => ({ db: null as unknown as Record<string, unknown>, audit: [] as Record<string, unknown>[] }))
vi.mock('@/lib/prisma', () => ({ default: new Proxy({}, { get: (_t, k) => h.db[k as string] }) }))
vi.mock('@/lib/audit', () => ({ writeAudit: vi.fn(async (e: Record<string, unknown>) => void h.audit.push(e)) }))

import { createFakePrisma, type FakePrisma } from './__testing__/fakePrisma'
import { ADMIN, NOW, registryOf, startLifecycleWorld, type LifecycleWorld } from './__testing__/lifecycleHarness'
import { setNowForTests } from './clock'
import { install } from './lifecycle'
import * as ov from './overrides'
import { reconcile } from './reconcile'

/** A run that was not refused as busy (no other reconcile runs in these tests). */
async function reconcileNow(deps: Parameters<typeof reconcile>[0]) {
  const r = await reconcile(deps)
  if ('skipped' in r) throw new Error('reconcile was busy')
  return r
}
import { SkillPartsRegistryError } from './skillPartsRegistry'

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
    { id: 'user-a', email: 'a@example.com', role: 'standard' },
  ])
  w = await startLifecycleWorld(() => db)
  await install('echo', { version: '1.0.0', acceptedPermissions: PERMS }, ADMIN, w.deps)
})

afterEach(async () => {
  await w.close()
  setNowForTests(null)
  vi.restoreAllMocks()
})

async function active(group: string, parts: string[]) {
  const { changeSetId } = await ov.propose({
    pluginId: 'echo',
    point: 'skill.text',
    scope: { type: 'user', id: 'user-a' },
    targetGroup: group,
    parts: parts.map((p) => ({ targetKey: `${group}/${p}`, value: `better ${p}`, baseSha256: OLD })),
    createdBy: 'user-a',
  })
  await ov.approve(changeSetId, 'user-a', Object.fromEntries(parts.map((p) => [`${group}/${p}`, OLD])))
  return changeSetId
}

const stateOf = (id: string) => {
  const rows = db.rows('pluginOverride').filter((r) => r.changeSetId === id)
  return { statuses: [...new Set(rows.map((r) => r.status))], reason: (rows[0].meta as { staleReason?: string } | null)?.staleReason }
}

test('a removed part, a changed factory text, and a match', async () => {
  const removed = await active('ssrf', ['workflow', 'payloads'])
  const changed = await active('xss', ['workflow'])
  const same = await active('sqli', ['workflow'])
  w.deps.registrySkill = registryOf({ ssrf: { workflow: OLD }, xss: { workflow: NEW }, sqli: { workflow: OLD } })
  h.audit = []
  const report = await reconcileNow(w.deps)
  expect(stateOf(removed)).toEqual({ statuses: ['stale'], reason: 'part_removed' })
  expect(stateOf(changed)).toEqual({ statuses: ['stale'], reason: 'factory_changed' })
  expect(stateOf(same)).toEqual({ statuses: ['active'], reason: undefined })
  expect(report.staleSets.sort()).toEqual([changed, removed].sort())
  expect(report.registry).toBe('checked')
  const audits = h.audit.filter((e) => e.action === 'plugin.override.stale')
  expect(audits.map((a) => a.targetId).sort()).toEqual([changed, removed].sort())
  expect(audits.every((a) => a.source === 'system' && a.actorId === null)).toBe(true)
})

test('a skill the agent no longer has at all: every part is removed', async () => {
  const gone = await active('legacy', ['workflow'])
  w.deps.registrySkill = registryOf({})
  await reconcileNow(w.deps)
  expect(stateOf(gone)).toEqual({ statuses: ['stale'], reason: 'part_removed' })
})

test.each(['agent_unreachable', 'agent_outdated'] as const)('the agent %s: nothing changes, the check is skipped', async (code) => {
  const id = await active('xss', ['workflow'])
  w.deps.registrySkill = async () => {
    throw new SkillPartsRegistryError(code, 'no')
  }
  const report = await reconcileNow(w.deps)
  expect(stateOf(id).statuses).toEqual(['active'])
  expect(report.registry).toBe(`skipped: ${code}`)
})

test('dormant versions (plugin uninstalled) are checked too: staleness is about the factory text', async () => {
  const id = await active('xss', ['workflow'])
  db.tables.pluginInstall.set('echo', { ...db.tables.pluginInstall.get('echo')!, enabled: false })
  w.deps.registrySkill = registryOf({ xss: { workflow: NEW } })
  await reconcileNow(w.deps)
  expect(stateOf(id).statuses).toEqual(['stale'])
})
