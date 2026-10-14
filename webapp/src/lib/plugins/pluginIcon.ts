import { createHash } from 'crypto'
import { CatalogError, loadCatalog, type LoadedCatalog } from './catalog'
import { now } from './clock'
import { FetchRemoteError, fetchRemote, type FetchResult } from './fetchRemote'
import type { ICON_TYPES, PluginCatalog } from './schemas/catalog'

/**
 * A plugin's avatar on the Plugins page (README.PLUGINS.md §6.2, §7.1). The plugin pages' CSP
 * allows same-origin images only, so the webapp fetches the icon the signed catalog names,
 * through the same download guard as an archive, and serves it itself. Only bytes whose sha256
 * the catalog signed are served, and only as the type their first bytes prove: the URL is a
 * branch file that can change after signing, and its server's Content-Type is not trusted.
 */
export type IconType = (typeof ICON_TYPES)[number]
type CatalogIcon = NonNullable<PluginCatalog['plugins'][number]['icon']>

export interface PluginIcon {
  bytes: Buffer
  type: IconType
  sha256: string
}

export interface IconDeps {
  catalog?: () => Promise<LoadedCatalog>
  fetch?: (url: string, opts: { kind: 'icon' }) => Promise<FetchResult>
}

const CACHE_MAX = 64
// The page asks for every card's icon on each visit; a host that failed is not asked again for
// each of them.
const RETRY_AFTER_MS = 5 * 60_000
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

const cache = new Map<string, PluginIcon>()
const failedAt = new Map<string, number>()
const inFlight = new Map<string, Promise<PluginIcon | null>>()

export function clearIconCache(): void {
  cache.clear()
  failedAt.clear()
  inFlight.clear()
}

/** The hash in the query changes with the image, so the browser may keep each URL for good. */
export function pluginIconPath(pluginId: string, sha256: string): string {
  return `/api/plugins/${pluginId}/icon?v=${sha256.slice(0, 16)}`
}

export function sniffImageType(bytes: Buffer): IconType | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(PNG_MAGIC)) return 'image/png'
  if (bytes.length >= 12 && bytes.toString('latin1', 0, 4) === 'RIFF' && bytes.toString('latin1', 8, 12) === 'WEBP') {
    return 'image/webp'
  }
  return null
}

/** The plugin's icon, or null when the catalog names none or it cannot be served. Never throws a fetch error. */
export async function loadPluginIcon(pluginId: string, deps: IconDeps = {}): Promise<PluginIcon | null> {
  let loaded: LoadedCatalog
  try {
    loaded = await (deps.catalog ?? (() => loadCatalog({ source: 'official' })))()
  } catch (e) {
    if (e instanceof CatalogError) return null
    throw e
  }
  const icon = loaded.catalog.plugins.find((p) => p.id === pluginId)?.icon
  if (!icon) return null
  const hit = cache.get(icon.sha256)
  if (hit) return hit
  const failed = failedAt.get(icon.sha256)
  if (failed !== undefined && now().getTime() - failed < RETRY_AFTER_MS) return null
  let pending = inFlight.get(icon.sha256)
  if (!pending) {
    pending = fetchIcon(pluginId, icon, deps.fetch ?? fetchRemote).finally(() => inFlight.delete(icon.sha256))
    inFlight.set(icon.sha256, pending)
  }
  return pending
}

async function fetchIcon(pluginId: string, icon: CatalogIcon, fetch: NonNullable<IconDeps['fetch']>): Promise<PluginIcon | null> {
  const refuse = (why: string) => {
    console.warn(`[plugins] icon of ${pluginId} not served: ${why}`)
    failedAt.set(icon.sha256, now().getTime())
    return null
  }
  let bytes: Buffer
  try {
    bytes = (await fetch(icon.url, { kind: 'icon' })).bytes
  } catch (e) {
    if (!(e instanceof FetchRemoteError)) throw e
    return refuse(`${e.code} (${e.url})`)
  }
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  if (sha256 !== icon.sha256) return refuse('its sha256 is not the one the catalog signed')
  const type = sniffImageType(bytes)
  if (type !== icon.type) return refuse(`it is ${type ?? 'not a supported image'}, the catalog says ${icon.type}`)
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value!)
  const out: PluginIcon = { bytes, type, sha256 }
  cache.set(sha256, out)
  failedAt.delete(sha256)
  return out
}
