/**
 * A plugin's avatar (README.PLUGINS.md §6.2): served only when the fetched bytes are the ones
 * the signed catalog pinned, as the type their magic bytes prove, and fetched once per image.
 *
 * @vitest-environment node
 */
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'
import { createHash } from 'crypto'
import { CatalogError, type LoadedCatalog } from './catalog'
import { setNowForTests } from './clock'
import { FetchRemoteError } from './fetchRemote'
import { clearIconCache, loadPluginIcon, pluginIconPath, sniffImageType } from './pluginIcon'

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 7)])
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 7)])
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), Buffer.alloc(64, 7)])
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex')
const URL_ = 'https://raw.githubusercontent.com/o/r/master/echo/icon.jpg'

function catalog(icon?: Record<string, unknown>): () => Promise<LoadedCatalog> {
  const plugin = { id: 'echo', displayName: 'Echo', description: 'Echoes.', releases: [], ...(icon ? { icon } : {}) }
  return async () =>
    ({ catalog: { catalogVersion: 1, serial: 1, plugins: [plugin], revoked: [] }, keyId: 'k', official: true, serial: 1, warnings: [] }) as unknown as LoadedCatalog
}
const jpegIcon = { url: URL_, sha256: sha(JPEG), size: JPEG.length, type: 'image/jpeg' }

let clock = new Date('2026-10-12T10:00:00Z')
beforeEach(() => {
  clearIconCache()
  clock = new Date('2026-10-12T10:00:00Z')
  setNowForTests(() => clock)
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => {
  setNowForTests(null)
  vi.restoreAllMocks()
})

describe('sniffImageType', () => {
  test('knows JPEG, PNG and WebP by their first bytes', () => {
    expect(sniffImageType(JPEG)).toBe('image/jpeg')
    expect(sniffImageType(PNG)).toBe('image/png')
    expect(sniffImageType(WEBP)).toBe('image/webp')
  })
  test('anything else, an SVG included, is not an image it serves', () => {
    expect(sniffImageType(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeNull()
    expect(sniffImageType(Buffer.from('GIF89a'))).toBeNull()
    expect(sniffImageType(Buffer.alloc(0))).toBeNull()
  })
})

test('the page URL carries the start of the hash, so it changes with the image', () => {
  expect(pluginIconPath('echo', 'ab'.repeat(32))).toBe(`/api/plugins/echo/icon?v=${'ab'.repeat(8)}`)
})

describe('loadPluginIcon', () => {
  test('serves the bytes the catalog pinned, fetched as an icon from the catalog URL', async () => {
    const fetch = vi.fn(async () => ({ bytes: JPEG, finalUrl: URL_ }))
    const icon = await loadPluginIcon('echo', { catalog: catalog(jpegIcon), fetch })
    expect(icon).toEqual({ bytes: JPEG, type: 'image/jpeg', sha256: sha(JPEG) })
    expect(fetch).toHaveBeenCalledWith(URL_, { kind: 'icon' })
  })

  test('no icon in the catalog, another plugin, or no catalog at all: nothing, and nothing fetched', async () => {
    const fetch = vi.fn()
    expect(await loadPluginIcon('echo', { catalog: catalog(), fetch })).toBeNull()
    expect(await loadPluginIcon('other', { catalog: catalog(jpegIcon), fetch })).toBeNull()
    const unreachable = async () => {
      throw new CatalogError('catalog_unreachable', 'down')
    }
    expect(await loadPluginIcon('echo', { catalog: unreachable, fetch })).toBeNull()
    expect(fetch).not.toHaveBeenCalled()
  })

  test('bytes the catalog did not sign (the branch file changed) are not served', async () => {
    const other = Buffer.concat([JPEG, Buffer.from([1])])
    const fetch = vi.fn(async () => ({ bytes: other, finalUrl: URL_ }))
    expect(await loadPluginIcon('echo', { catalog: catalog(jpegIcon), fetch })).toBeNull()
    expect(console.warn).toHaveBeenCalledWith(expect.stringMatching(/icon of echo not served: its sha256/))
  })

  test('signed bytes of another type than the catalog says are not served', async () => {
    const icon = { ...jpegIcon, sha256: sha(PNG), size: PNG.length }
    const fetch = vi.fn(async () => ({ bytes: PNG, finalUrl: URL_ }))
    expect(await loadPluginIcon('echo', { catalog: catalog(icon), fetch })).toBeNull()
    expect(console.warn).toHaveBeenCalledWith(expect.stringMatching(/it is image\/png, the catalog says image\/jpeg/))
  })

  test('a refused download is no icon, not an error', async () => {
    const fetch = vi.fn(async () => {
      throw new FetchRemoteError('host_not_allowed', 'no', 'https://evil.example/x.jpg')
    })
    expect(await loadPluginIcon('echo', { catalog: catalog(jpegIcon), fetch })).toBeNull()
  })

  test('fetched once, then served from memory', async () => {
    const fetch = vi.fn(async () => ({ bytes: JPEG, finalUrl: URL_ }))
    await loadPluginIcon('echo', { catalog: catalog(jpegIcon), fetch })
    await loadPluginIcon('echo', { catalog: catalog(jpegIcon), fetch })
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  test('requests that arrive together share one download', async () => {
    let release: (v: { bytes: Buffer; finalUrl: string }) => void = () => {}
    const fetch = vi.fn(() => new Promise<{ bytes: Buffer; finalUrl: string }>((r) => (release = r)))
    const both = Promise.all([
      loadPluginIcon('echo', { catalog: catalog(jpegIcon), fetch }),
      loadPluginIcon('echo', { catalog: catalog(jpegIcon), fetch }),
    ])
    await vi.waitFor(() => expect(fetch).toHaveBeenCalled())
    release({ bytes: JPEG, finalUrl: URL_ })
    const [a, b] = await both
    expect(a?.sha256).toBe(sha(JPEG))
    expect(b).toBe(a)
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  test('a failed image is not fetched again for five minutes', async () => {
    const fetch = vi.fn(async () => {
      throw new FetchRemoteError('timeout', 'slow', URL_)
    })
    await loadPluginIcon('echo', { catalog: catalog(jpegIcon), fetch })
    clock = new Date(clock.getTime() + 4 * 60_000)
    await loadPluginIcon('echo', { catalog: catalog(jpegIcon), fetch })
    expect(fetch).toHaveBeenCalledTimes(1)
    clock = new Date(clock.getTime() + 2 * 60_000)
    fetch.mockImplementationOnce(async () => ({ bytes: JPEG, finalUrl: URL_ }) as never)
    expect((await loadPluginIcon('echo', { catalog: catalog(jpegIcon), fetch }))?.type).toBe('image/jpeg')
    expect(fetch).toHaveBeenCalledTimes(2)
  })
})
