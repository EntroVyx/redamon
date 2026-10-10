/**
 * Which release the platform installs (README.PLUGINS.md §6.2): the newest whose
 * `platform` range includes the running platform version, not simply the newest; never
 * a revoked one, never one asking for a permission this platform does not know.
 *
 * @vitest-environment node
 */
import { describe, test, expect } from 'vitest'
import type { CatalogRelease, PluginCatalog } from './schemas/catalog'
import { chooseRelease, findCatalogPlugin, isRevoked } from './catalog'

const rel = (version: string, platform = '>=1.0.0 <2.0.0', permissions: string[] = []): CatalogRelease => ({
  version,
  platform,
  dataVersion: 1,
  url: `https://github.com/example/redamon-plugins/releases/download/echo-v${version}/echo-${version}.tar.gz`,
  sha256: 'a'.repeat(64),
  permissions,
})

const entry = (releases: CatalogRelease[]) => ({ id: 'echo', displayName: 'Echo', description: 'x', releases })

describe('chooseRelease', () => {
  test('the newest compatible release wins over a newer incompatible one', () => {
    const e = entry([rel('1.0.0'), rel('1.2.0'), rel('2.0.0', '>=2.0.0 <3.0.0'), rel('1.1.0')])
    expect(chooseRelease(e, '1.0.0')?.version).toBe('1.2.0')
    expect(chooseRelease(e, '2.1.0')?.version).toBe('2.0.0')
  })

  test('versions compare numerically, not as text', () => {
    expect(chooseRelease(entry([rel('1.9.0'), rel('1.10.0'), rel('1.2.0')]), '1.0.0')?.version).toBe('1.10.0')
  })

  test('no compatible release is null', () => {
    expect(chooseRelease(entry([rel('3.0.0', '>=3.0.0')]), '1.0.0')).toBeNull()
  })

  test('a revoked release is never chosen', () => {
    const e = entry([rel('1.0.0'), rel('1.1.0')])
    const revoked = [{ id: 'echo', version: '1.1.0', reason: 'leaks data' }]
    expect(chooseRelease(e, '1.0.0', revoked)?.version).toBe('1.0.0')
    expect(chooseRelease(e, '1.0.0', [{ id: 'other', version: '1.1.0', reason: 'x' }])?.version).toBe('1.1.0')
  })

  test('a release asking for a permission this platform does not know targets a newer platform', () => {
    const e = entry([rel('1.0.0', undefined, ['session:read']), rel('1.1.0', undefined, ['future:capability'])])
    expect(chooseRelease(e, '1.0.0')?.version).toBe('1.0.0')
  })
})

describe('lookups', () => {
  const catalog: PluginCatalog = {
    catalogVersion: 1,
    serial: 1,
    expires: '2027-01-01T00:00:00Z',
    plugins: [entry([rel('1.0.0')])],
    revoked: [{ id: 'echo', version: '0.9.0', reason: 'Exfiltrated transcripts.' }],
  }

  test('isRevoked returns the reason for a revoked version and null otherwise', () => {
    expect(isRevoked(catalog, 'echo', '0.9.0')).toBe('Exfiltrated transcripts.')
    expect(isRevoked(catalog, 'echo', '1.0.0')).toBeNull()
    expect(isRevoked(catalog, 'other', '0.9.0')).toBeNull()
  })

  test('findCatalogPlugin finds an entry by id', () => {
    expect(findCatalogPlugin(catalog, 'echo')?.displayName).toBe('Echo')
    expect(findCatalogPlugin(catalog, 'nope')).toBeNull()
  })
})
