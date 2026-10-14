/**
 * The Plugins page model carries the catalog's listing to the card: the avatar as a same-origin
 * URL that changes with the image, and the documentation link.
 *
 * @vitest-environment node
 */
import { test, expect, beforeEach, vi } from 'vitest'

const h = vi.hoisted(() => ({ db: null as unknown as Record<string, unknown>, plugins: [] as unknown[] }))
vi.mock('@/lib/prisma', () => ({ default: new Proxy({}, { get: (_t, k) => h.db[k as string] }) }))
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

import { createFakePrisma } from './__testing__/fakePrisma'
import { buildPluginsPage } from './pageModel'

const release = { version: '1.0.0', platform: '>=1.0.0 <2.0.0', dataVersion: 1, url: 'https://github.com/o/r/a.tar.gz', sha256: 'b'.repeat(64), permissions: [] }

beforeEach(() => {
  h.db = createFakePrisma() as unknown as Record<string, unknown>
})

test('a listed plugin gets its icon URL and docs link; an unlisted one gets neither', async () => {
  const sha256 = 'c'.repeat(64)
  h.plugins = [
    {
      id: 'echo',
      displayName: 'Echo',
      description: 'Echoes.',
      icon: { url: 'https://raw.githubusercontent.com/o/r/master/echo/icon.jpg', sha256, size: 10, type: 'image/jpeg' },
      docsUrl: 'https://github.com/o/r/wiki/Plugin-Echo',
      releases: [release],
    },
    { id: 'plain', displayName: 'Plain', description: 'No listing.', releases: [release] },
  ]
  const page = await buildPluginsPage(false)
  const echo = page.plugins.find((p) => p.id === 'echo')!
  expect(echo.icon).toBe(`/api/plugins/echo/icon?v=${sha256.slice(0, 16)}`)
  expect(echo.docsUrl).toBe('https://github.com/o/r/wiki/Plugin-Echo')
  const plain = page.plugins.find((p) => p.id === 'plain')!
  expect('icon' in plain).toBe(false)
  expect('docsUrl' in plain).toBe(false)
})
