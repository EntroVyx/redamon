/**
 * Builds a signed plugin catalog for tests: the exact `catalog.json` bytes and the
 * `catalog.json.sig` file (TD-11: JSON `{keyId, sig}` with a base64 Ed25519
 * signature over those exact bytes). Shapes follow README.PLUGINS.md §6.2.
 */
import { createHash } from 'crypto'
import { sign, type TestKeyPair } from './ed25519'

export interface CatalogRelease {
  version: string
  platform: string
  dataVersion: number
  url: string
  sha256: string
  permissions: string[]
}

/** One release in the flat input list; releases sharing a pluginId become one plugin entry. */
export interface ReleaseInput extends Partial<CatalogRelease> {
  pluginId: string
  version: string
  displayName?: string
  description?: string
}

export interface RevokedEntry {
  id: string
  version: string
  reason: string
}

export interface BuildCatalogInput {
  releases: ReleaseInput[]
  serial: number
  expires: Date | string
  key: TestKeyPair
  revoked?: RevokedEntry[]
  catalogVersion?: number
  /** Signs with this key id instead of key.keyId (an "unknown key" case). */
  claimKeyId?: string
}

export interface BuiltCatalog {
  catalog: Record<string, unknown>
  bytes: Buffer
  sigBytes: Buffer
  sigB64: string
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

export function buildCatalog(input: BuildCatalogInput): BuiltCatalog {
  const plugins: Array<{ id: string; displayName: string; description: string; releases: CatalogRelease[] }> = []
  for (const r of input.releases) {
    let p = plugins.find(x => x.id === r.pluginId)
    if (!p) {
      p = {
        id: r.pluginId,
        displayName: r.displayName ?? r.pluginId,
        description: r.description ?? `Test plugin ${r.pluginId}`,
        releases: [],
      }
      plugins.push(p)
    }
    p.releases.push({
      version: r.version,
      platform: r.platform ?? '>=1.0.0 <2.0.0',
      dataVersion: r.dataVersion ?? 1,
      url: r.url ?? `https://github.com/example/redamon-plugins/releases/download/${r.pluginId}-v${r.version}/${r.pluginId}-${r.version}.tar.gz`,
      sha256: r.sha256 ?? '0'.repeat(64),
      permissions: r.permissions ?? [],
    })
  }
  const catalog = {
    catalogVersion: input.catalogVersion ?? 1,
    serial: input.serial,
    expires: typeof input.expires === 'string' ? input.expires : input.expires.toISOString(),
    plugins,
    revoked: input.revoked ?? [],
  }
  const bytes = Buffer.from(JSON.stringify(catalog, null, 2) + '\n', 'utf8')
  const sigB64 = sign(bytes, input.key.privateKey).toString('base64')
  const sigBytes = Buffer.from(JSON.stringify({ keyId: input.claimKeyId ?? input.key.keyId, sig: sigB64 }) + '\n', 'utf8')
  return { catalog, bytes, sigBytes, sigB64 }
}
