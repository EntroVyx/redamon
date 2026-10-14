import { z } from 'zod'
import { RANGE_PATTERN, VERSION_PATTERN } from '@/lib/semver'
import { PLUGIN_ID_RE } from '../ids'
import { parseWith } from './common'

/**
 * `catalog.json` of the plugin repository (README.PLUGINS.md §6.2), signed by its CI.
 * The schema checks shape only: https, the download host allowlist, the signature and
 * the serial are the catalog client's checks. A catalog has no expiry: an `expires`
 * field written by older CI is dropped like any other unknown field.
 *
 * Objects here are NOT strict, unlike the manifest: a field the CI adds later must not
 * make every older platform refuse the whole catalog. `catalogVersion` is the lever
 * for an incompatible change. Release permissions are plain names for the same
 * reason; a release asking for one this platform does not know targets a newer
 * platform and is refused at install.
 */
const sha256 = z.string().regex(/^[0-9a-f]{64}$/, 'must be 64 lower-case hex characters')
const version = z.string().regex(new RegExp(VERSION_PATTERN), 'must be a version x.y.z')
const pluginId = z.string().regex(PLUGIN_ID_RE, 'must be a plugin id')

const release = z.object({
  version,
  platform: z.string().regex(new RegExp(RANGE_PATTERN), 'must be a version range'),
  dataVersion: z.number().int().min(1).max(2_147_483_647),
  // The regex repeats the protocol rule so the exported JSON Schema carries it.
  url: z.url({ protocol: /^https?$/, error: 'must be an http(s) URL' }).regex(/^https?:\/\//, 'must be an http(s) URL'),
  sha256,
  size: z.number().int().min(0).optional(),
  permissions: z.array(z.string().regex(/^[a-z][a-z0-9.:_-]{0,63}$/)).max(20),
})

export const ICON_MAX_BYTES = 262_144
export const ICON_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const
const httpsUrl = z.url({ protocol: /^https$/, error: 'must be an https URL' }).regex(/^https:\/\//, 'must be an https URL')

/**
 * The plugin's listing (the plugin repository's `listing.json`): presentation only, never part of
 * the manifest, so a catalog carrying it still installs on a platform that predates it. The icon
 * is fetched by the webapp and shown only when its bytes match `sha256`; the URL is a branch file
 * that can change after signing.
 */
const icon = z.object({
  url: httpsUrl,
  sha256,
  size: z.number().int().min(1).max(ICON_MAX_BYTES),
  type: z.enum(ICON_TYPES),
})

const plugin = z
  .object({
    id: pluginId,
    displayName: z.string().min(1).max(60),
    description: z.string().min(1).max(500),
    icon: icon.optional(),
    docsUrl: httpsUrl.max(500).optional(),
    releases: z.array(release).min(1).max(200),
  })
  .refine((p) => new Set(p.releases.map((r) => r.version)).size === p.releases.length, {
    message: 'lists a release version twice',
    path: ['releases'],
  })

export const catalogSchema = z
  .object({
    catalogVersion: z.literal(1),
    serial: z.number().int().min(1),
    plugins: z.array(plugin).max(500),
    revoked: z
      .array(z.object({ id: pluginId, version, reason: z.string().min(1).max(500) }))
      .max(1000)
      .default([]),
  })
  .refine((c) => new Set(c.plugins.map((p) => p.id)).size === c.plugins.length, {
    message: 'lists a plugin twice',
    path: ['plugins'],
  })

export type PluginCatalog = z.infer<typeof catalogSchema>
export type CatalogRelease = z.infer<typeof release>

export function parseCatalog(input: unknown) {
  return parseWith(catalogSchema, input)
}
