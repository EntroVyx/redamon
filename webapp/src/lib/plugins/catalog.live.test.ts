/**
 * The GitHub half of the catalog contract (T3): the published catalog, loaded through the
 * production path and verified with the shipped keyring (signature, schema, serial),
 * and one of its release archives downloaded through fetchRemote's host allowlist and checked
 * exactly as an install checks it.
 *
 * Network, so opt-in: PLUGINS_LIVE=1. PLUGINS_LIVE_EXPECT=<pluginId>@<version> names a release
 * that must be listed; without it the newest release this platform can run of the first
 * listed plugin is used. The test names no plugin itself (the base repository carries no
 * plugin-specific code).
 *
 * @vitest-environment node
 */
import { createHash } from 'node:crypto'
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'
import { createFakePrisma } from './__testing__/fakePrisma'

const h = vi.hoisted(() => ({ db: null as unknown as Record<string, unknown> }))
vi.mock('@/lib/prisma', () => ({ default: new Proxy({}, { get: (_t, k) => h.db[k as string] }) }))

import { catalogUrl, chooseRelease, clearCatalogCache, findCatalogPlugin, isRevoked, loadCatalog } from './catalog'
import { downloadHosts, fetchRemote } from './fetchRemote'
import { runInstallChecks } from './installChecks'
import { OFFICIAL_KEYS } from './keyring'
import { PLUGIN_PLATFORM_VERSION } from './platformVersion'
import type { CatalogRelease, PluginCatalog } from './schemas/catalog'

const LIVE = process.env.PLUGINS_LIVE === '1'
const NETWORK_TIMEOUT_MS = 120_000

let savedExtraKeys: string | undefined

beforeEach(() => {
  h.db = createFakePrisma() as unknown as Record<string, unknown>
  clearCatalogCache()
  // Only the shipped keys may vouch for the official catalog.
  savedExtraKeys = process.env.PLUGINS_EXTRA_TRUSTED_KEYS
  delete process.env.PLUGINS_EXTRA_TRUSTED_KEYS
})

afterEach(() => {
  if (savedExtraKeys !== undefined) process.env.PLUGINS_EXTRA_TRUSTED_KEYS = savedExtraKeys
})

function expectedRelease(catalog: PluginCatalog): { pluginId: string; release: CatalogRelease } {
  const want = (process.env.PLUGINS_LIVE_EXPECT ?? '').trim()
  if (want) {
    const m = /^([a-z][a-z0-9-]{1,39})@(\d+\.\d+\.\d+)$/.exec(want)
    if (!m) throw new Error(`PLUGINS_LIVE_EXPECT must be <pluginId>@<x.y.z>, got "${want}"`)
    const entry = findCatalogPlugin(catalog, m[1])
    expect(entry, `${m[1]} is not in the catalog`).not.toBeNull()
    const release = entry!.releases.find((r) => r.version === m[2])
    expect(release, `${want} is not in the catalog`).toBeDefined()
    return { pluginId: m[1], release: release! }
  }
  expect(catalog.plugins.length, 'the catalog lists no plugin').toBeGreaterThan(0)
  const entry = catalog.plugins[0]
  const release = chooseRelease(entry, PLUGIN_PLATFORM_VERSION, catalog.revoked)
  expect(release, `${entry.id} has no release platform ${PLUGIN_PLATFORM_VERSION} can run`).not.toBeNull()
  return { pluginId: entry.id, release: release! }
}

describe.skipIf(!LIVE)('the official plugin catalog on GitHub (set PLUGINS_LIVE=1 to run)', () => {
  test(
    'is signed by a shipped official key, with a serial',
    async () => {
      const loaded = await loadCatalog({ source: 'official' }, { noCache: true })
      console.info(`[plugins live] ${catalogUrl()}: serial ${loaded.serial}, key ${loaded.keyId}`)
      expect(loaded.official).toBe(true)
      expect(OFFICIAL_KEYS.map((k) => k.keyId)).toContain(loaded.keyId)
      expect(loaded.warnings).not.toContain('extra_key')
      expect(Number.isSafeInteger(loaded.serial) && loaded.serial >= 1).toBe(true)
      expect(loaded.warnings).toEqual([])
    },
    NETWORK_TIMEOUT_MS,
  )

  test(
    'a listed release downloads from an allowed host and passes the install checks',
    async () => {
      const { catalog } = await loadCatalog({ source: 'official' }, { noCache: true })
      const { pluginId, release } = expectedRelease(catalog)
      expect(isRevoked(catalog, pluginId, release.version)).toBeNull()

      const got = await fetchRemote(release.url, { kind: 'archive' })
      const finalHost = new URL(got.finalUrl).hostname
      console.info(`[plugins live] ${pluginId}@${release.version}: ${got.bytes.length} bytes, served by ${finalHost}`)
      expect(downloadHosts()).toContain(finalHost)
      expect(createHash('sha256').update(got.bytes).digest('hex')).toBe(release.sha256)
      if (release.size !== undefined) expect(got.bytes.length).toBe(release.size)

      const out = runInstallChecks({ pluginId, archiveBytes: got.bytes, release, platformVersion: PLUGIN_PLATFORM_VERSION })
      expect(out.ok, JSON.stringify(out)).toBe(true)
    },
    NETWORK_TIMEOUT_MS,
  )
})
