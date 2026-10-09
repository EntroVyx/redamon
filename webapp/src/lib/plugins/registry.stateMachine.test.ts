/**
 * @vitest-environment node
 */
import { describe, test, expect, beforeEach, vi } from 'vitest'
import { readFileSync } from 'fs'
import path from 'path'
import { createFakePrisma, type FakePrisma } from './__testing__/fakePrisma'

const h = vi.hoisted(() => ({ db: null as unknown as Record<string, unknown> }))
vi.mock('@/lib/prisma', () => ({ default: new Proxy({}, { get: (_t, k) => h.db[k as string] }) }))

import {
  ALLOWED_TRANSITIONS,
  PLUGIN_STATUSES,
  PluginTransitionError,
  dormantReason,
  overridesQualify,
  servesActions,
  showsContributions,
  contributionsUpdating,
  transition,
  type PluginStatus,
} from './registry'

let db: FakePrisma
beforeEach(() => {
  db = createFakePrisma()
  h.db = db as unknown as Record<string, unknown>
})

test('the statuses match the CHECK constraint the database enforces', () => {
  const script = readFileSync(path.resolve(__dirname, '../../../scripts/apply-plugin-constraints.mjs'), 'utf8')
  const m = script.match(/const INSTALL_STATUSES = \[([^\]]*)\]/)
  expect(m).not.toBeNull()
  expect(m![1].match(/'[^']+'/g)!.map((s) => s.slice(1, -1))).toEqual([...PLUGIN_STATUSES])
})

describe('the status machine of design §9.1', () => {
  // The diagram, written out independently of the table in registry.ts.
  const DESIGN: [PluginStatus, PluginStatus][] = [
    ['available', 'installing'],
    ['installing', 'available'],
    ['installing', 'ready'],
    ['ready', 'failed'],
    ['failed', 'ready'],
    ['ready', 'incompatible'],
    ['incompatible', 'ready'],
    ...(['ready', 'failed', 'incompatible'] as PluginStatus[]).flatMap(
      (s): [PluginStatus, PluginStatus][] => [[s, 'updating'], [s, 'uninstalling']],
    ),
    ['updating', 'ready'],
    ['uninstalling', 'available'],
  ]
  const allowed = new Set(DESIGN.map(([a, b]) => `${a}>${b}`))
  const pairs = PLUGIN_STATUSES.flatMap((a) => PLUGIN_STATUSES.map((b) => [a, b] as const))

  test('the table holds exactly the design transitions', () => {
    const table = Object.entries(ALLOWED_TRANSITIONS).flatMap(([a, tos]) => tos.map((b) => `${a}>${b}`))
    expect(new Set(table)).toEqual(allowed)
  })

  test.each(pairs.filter(([a, b]) => allowed.has(`${a}>${b}`)))('%s -> %s is allowed', async (from, to) => {
    db.seed('pluginInstall', [{ pluginId: 'demo', status: from }])
    await transition('demo', { from: [from], to })
    expect(db.rows('pluginInstall')[0].status).toBe(to)
  })

  test.each(pairs.filter(([a, b]) => !allowed.has(`${a}>${b}`)))('%s -> %s raises', async (from, to) => {
    db.seed('pluginInstall', [{ pluginId: 'demo', status: from }])
    await expect(transition('demo', { from: [from], to })).rejects.toBeInstanceOf(PluginTransitionError)
    expect(db.rows('pluginInstall')[0].status).toBe(from)
  })

  test('a transition carries its patch in the same write', async () => {
    db.seed('pluginInstall', [{ pluginId: 'demo', status: 'ready' }])
    await transition('demo', { from: ['ready'], to: 'failed', patch: { lastError: 'worker_exited' } })
    expect(db.rows('pluginInstall')[0]).toMatchObject({ status: 'failed', lastError: 'worker_exited' })
  })
})

describe('the behaviour table of design §9.1, row by row', () => {
  type Row = { status: PluginStatus; enabled: boolean; revokedReason: string | null; grantedPermissions: string[] }
  const row = (status: PluginStatus, enabled: boolean, extra: Partial<Row> = {}): Row => ({
    status,
    enabled,
    revokedReason: null,
    grantedPermissions: ['override:skill.text'],
    ...extra,
  })

  // [status, enabled] -> [actions served, contributions shown, overrides apply]
  const TABLE: [PluginStatus, boolean, boolean, boolean, boolean][] = [
    ['ready', true, true, true, true],
    ['ready', false, false, false, false],
    ['updating', true, false, true, true],
    // The design leaves enabled out for updating; a disabled plugin stays hidden (RV-18).
    ['updating', false, false, false, false],
    ['failed', true, false, false, false],
    ['failed', false, false, false, false],
    ['incompatible', true, false, false, false],
    ['incompatible', false, false, false, false],
    ['installing', true, false, false, false],
    ['uninstalling', true, false, false, false],
    ['available', true, false, false, false],
    ['available', false, false, false, false],
  ]

  test.each(TABLE)('%s, enabled=%s -> actions %s, contributions %s, overrides %s', (s, e, a, c, o) => {
    const r = row(s, e)
    expect([servesActions(r as never), showsContributions(r as never), overridesQualify(r as never)]).toEqual([a, c, o])
  })

  test('only an enabled updating plugin is marked "updating"', () => {
    expect(contributionsUpdating(row('updating', true) as never)).toBe(true)
    expect(contributionsUpdating(row('updating', false) as never)).toBe(false)
    expect(contributionsUpdating(row('ready', true) as never)).toBe(false)
  })

  test.each(PLUGIN_STATUSES)('a revoked version serves nothing in %s, and enabled is left alone', (s) => {
    const r = row(s, true, { revokedReason: 'leaked data' })
    expect([servesActions(r as never), showsContributions(r as never), overridesQualify(r as never)]).toEqual([
      false,
      false,
      false,
    ])
    expect(r.enabled).toBe(true)
  })

  test('an empty revokedReason still counts as revoked (fail safe)', () => {
    const r = row('ready', true, { revokedReason: '' })
    expect([servesActions(r as never), showsContributions(r as never), overridesQualify(r as never)]).toEqual([
      false,
      false,
      false,
    ])
    expect(dormantReason(r as never, { switchOn: true, agentSupportsSeam: true })).toBe('revoked')
  })

  test('overrides need the override:skill.text permission granted', () => {
    expect(overridesQualify(row('ready', true, { grantedPermissions: ['session:read'] }) as never)).toBe(false)
    expect(overridesQualify(row('ready', true, { grantedPermissions: [] }) as never)).toBe(false)
  })
})

describe('dormantReason', () => {
  const on = { switchOn: true, agentSupportsSeam: true }
  const base = { status: 'ready', enabled: true, revokedReason: null, grantedPermissions: ['override:skill.text'] }

  test.each([
    ['switch_off', base, { ...on, switchOn: false }],
    ['uninstalled', null, on],
    ['uninstalled', { ...base, status: 'available' }, on],
    ['uninstalled', { ...base, status: 'uninstalling' }, on],
    ['revoked', { ...base, revokedReason: 'x' }, on],
    ['disabled', { ...base, enabled: false }, on],
    ['not_ready', { ...base, status: 'failed' }, on],
    ['not_ready', { ...base, status: 'incompatible' }, on],
    ['not_ready', { ...base, status: 'installing' }, on],
    ['permission_missing', { ...base, grantedPermissions: [] }, on],
    ['agent_outdated', base, { ...on, agentSupportsSeam: false }],
  ])('%s', (reason, r, env) => {
    expect(dormantReason(r as never, env)).toBe(reason)
  })

  test('null when the override reaches the agent, also while updating', () => {
    expect(dormantReason(base as never, on)).toBeNull()
    expect(dormantReason({ ...base, status: 'updating' } as never, on)).toBeNull()
  })

  test('null exactly when the switch is on, the agent has the seam and overrides qualify', () => {
    for (const status of PLUGIN_STATUSES) {
      for (const enabled of [true, false]) {
        for (const revokedReason of [null, 'x']) {
          for (const grantedPermissions of [[], ['override:skill.text']]) {
            for (const switchOn of [true, false]) {
              for (const agentSupportsSeam of [true, false]) {
                const r = { status, enabled, revokedReason, grantedPermissions }
                const env = { switchOn, agentSupportsSeam }
                expect(dormantReason(r as never, env) === null).toBe(
                  switchOn && agentSupportsSeam && overridesQualify(r as never),
                )
              }
            }
          }
        }
      }
    }
  })
})
