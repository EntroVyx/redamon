/**
 * The Plugins page's detail model (pageModel.ts buildPluginDetail): an admin sees how many
 * proposals for people's own skills wait for review and how many were saved as new skills,
 * counted as change sets, of this plugin only; a standard user sees no admin block. On the
 * listing, an uninstalled plugin that left only decided user-skill rows is not kept listed.
 *
 * @vitest-environment node
 */
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'
import os from 'node:os'
import path from 'node:path'

const h = vi.hoisted(() => ({ db: null as unknown as Record<string, unknown>, plugins: [] as unknown[] }))
vi.mock('@/lib/prisma', () => ({ default: new Proxy({}, { get: (_t, k) => h.db[k as string] }) }))
vi.mock('@/lib/audit', () => ({ writeAudit: vi.fn() }))
vi.mock('./catalog', async (orig) => ({
  ...(await orig<typeof import('./catalog')>()),
  loadCatalog: async () => ({
    catalog: { catalogVersion: 1, serial: 1, plugins: h.plugins, revoked: [] },
    keyId: 'k',
    official: true,
    serial: 1,
    warnings: [],
  }),
}))

import { createFakePrisma, type FakePrisma, type Row } from './__testing__/fakePrisma'
import { buildPluginDetail, buildPluginsPage } from './pageModel'

let db: FakePrisma
let n = 0
const release = { version: '1.1.0', platform: '>=1.0.0 <2.0.0', dataVersion: 1, url: 'https://github.com/o/r/echo.tar.gz', sha256: 'b'.repeat(64), permissions: [] }

function sets(pluginId: string, extensionPoint: string, status: string, count: number, rowsEach = 1): Row[] {
  const out: Row[] = []
  for (let s = 0; s < count; s++) {
    const changeSetId = `cs-${++n}`
    for (let r = 0; r < rowsEach; r++) {
      out.push({
        pluginId, extensionPoint, scopeType: 'user', scopeId: 'user-alice', userId: 'user-alice', targetGroup: 'skflow',
        targetKey: `skflow/part${r}`, changeSetId, value: 'v', baseSha256: 'a'.repeat(64), status, createdBy: 'user-alice',
        revision: status === 'active' ? 2 : null,
      })
    }
  }
  return out
}

beforeEach(() => {
  db = createFakePrisma()
  h.db = db as unknown as Record<string, unknown>
  h.plugins = [{ id: 'echo', displayName: 'Echo', description: 'Echoes.', releases: [release] }]
  vi.stubEnv('PLUGINS_DIR', path.join(os.tmpdir(), `plugins-detail-${process.pid}-does-not-exist`))
  db.seed('pluginInstall', [
    { pluginId: 'echo', enabled: true, status: 'ready', activeVersion: '1.1.0', dataVersion: 1, grantedPermissions: ['override:skill.text', 'override:user_skill.text'], manifest: { id: 'echo', displayName: 'Echo' } },
    { pluginId: 'other', enabled: true, status: 'ready', activeVersion: '1.0.0', dataVersion: 1, grantedPermissions: [], manifest: { id: 'other', displayName: 'Other' } },
  ])
})
afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe('buildPluginDetail: userSkillProposals', () => {
  test('waiting and saved, counted as change sets of this plugin', async () => {
    db.seed('pluginOverride', [
      ...sets('echo', 'user_skill.text', 'proposed', 2),
      ...sets('echo', 'user_skill.text', 'proposed', 1, 2), // one set, two rows: counted once
      ...sets('echo', 'user_skill.text', 'adopted', 4),
      ...sets('echo', 'user_skill.text', 'rejected', 3),
      ...sets('echo', 'user_skill.text', 'withdrawn', 1),
      ...sets('echo', 'skill.text', 'proposed', 2),
      ...sets('echo', 'skill.text', 'active', 1),
      ...sets('other', 'user_skill.text', 'proposed', 5),
      ...sets('other', 'user_skill.text', 'adopted', 5),
    ])
    const detail = await buildPluginDetail('echo', true)
    expect(detail!.admin!.userSkillProposals).toEqual({ waiting: 3, saved: 4 })
    expect(detail!.admin!.activeVersions).toBe(1)
  })

  test('none: zeros', async () => {
    expect((await buildPluginDetail('echo', true))!.admin!.userSkillProposals).toEqual({ waiting: 0, saved: 0 })
  })

  test('a standard user gets no admin block', async () => {
    db.seed('pluginOverride', sets('echo', 'user_skill.text', 'proposed', 1))
    const detail = await buildPluginDetail('echo', false)
    expect(detail).not.toBeNull()
    expect(detail!.admin).toBeUndefined()
  })

  test('an uninstalled plugin the catalog no longer lists, with only saved proposals: still has a detail for its row', async () => {
    h.plugins = []
    await db.pluginInstall.update({ where: { pluginId: 'echo' }, data: { status: 'available', enabled: false, activeVersion: null } })
    db.seed('pluginOverride', sets('echo', 'user_skill.text', 'adopted', 2))
    const detail = await buildPluginDetail('echo', true)
    expect(detail!.admin!.userSkillProposals).toEqual({ waiting: 0, saved: 2 })
  })

  test('an unknown plugin: null', async () => {
    expect(await buildPluginDetail('nobody', true)).toBeNull()
  })
})

describe('buildPluginsPage: what keeps an uninstalled plugin listed', () => {
  beforeEach(async () => {
    h.plugins = []
    await db.pluginInstall.update({ where: { pluginId: 'echo' }, data: { status: 'available', enabled: false, activeVersion: null } })
  })

  test('only adopted, rejected or withdrawn user-skill rows: not listed', async () => {
    db.seed('pluginOverride', [
      ...sets('echo', 'user_skill.text', 'adopted', 2),
      ...sets('echo', 'user_skill.text', 'rejected', 1),
      ...sets('echo', 'user_skill.text', 'withdrawn', 1),
    ])
    expect((await buildPluginsPage(true)).plugins.map((p) => p.id)).toEqual(['other'])
  })

  test('a user-skill proposal still waiting: listed for the admin', async () => {
    db.seed('pluginOverride', sets('echo', 'user_skill.text', 'proposed', 1))
    const page = await buildPluginsPage(true)
    expect(page.plugins.find((p) => p.id === 'echo')).toMatchObject({ state: 'not_installed' })
    // A standard user never sees a plugin that is not installed and not in the catalog.
    expect((await buildPluginsPage(false)).plugins.map((p) => p.id)).toEqual(['other'])
  })

  test('in the catalog, uninstalled: keptData follows the same rule', async () => {
    h.plugins = [{ id: 'echo', displayName: 'Echo', description: 'Echoes.', releases: [release] }]
    db.seed('pluginOverride', sets('echo', 'user_skill.text', 'adopted', 1))
    expect((await buildPluginsPage(true)).plugins.find((p) => p.id === 'echo')!.keptData).toBeUndefined()
    db.seed('pluginOverride', sets('echo', 'user_skill.text', 'proposed', 1))
    expect((await buildPluginsPage(true)).plugins.find((p) => p.id === 'echo')!.keptData).toBe(true)
  })
})
