/**
 * The `echo` fixture plugin (services/plugin_runner/tests/fixtures/plugins/echo) as an
 * installable archive, with the catalog release that pins it. A test may patch the
 * manifest (another version, dataVersion or permission), add files (migrations) or drop
 * some, and still get a sha256 and release that match what it built.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { sha256Hex } from './catalogBuilder'
import { writeTarGz, type FileMap, type UstarOptions } from './ustarWriter'
import type { CatalogRelease } from '../schemas/catalog'

export const ECHO_DIR = join(__dirname, '../../../../../services/plugin_runner/tests/fixtures/plugins/echo')

function readTree(dir: string, prefix: string, out: FileMap) {
  for (const name of readdirSync(dir).sort()) {
    if (name === '__pycache__' || name.endsWith('.pyc')) continue
    const p = join(dir, name)
    if (statSync(p).isDirectory()) readTree(p, `${prefix}${name}/`, out)
    else out[`${prefix}${name}`] = readFileSync(p)
  }
}

export function echoManifest(patch: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...JSON.parse(readFileSync(join(ECHO_DIR, 'plugin.json'), 'utf8')), ...patch }
}

export interface EchoArchiveOptions {
  manifest?: Record<string, unknown>
  /** Paths relative to the plugin folder; a value replaces or adds a file. */
  files?: Record<string, string | Uint8Array>
  drop?: string[]
  /** The top folder name; `echo` by default. */
  top?: string
  tar?: UstarOptions
  /** The release's fields where they should differ from the manifest. */
  release?: Partial<CatalogRelease>
}

export interface EchoArchive {
  bytes: Buffer
  sha256: string
  manifest: Record<string, unknown>
  release: CatalogRelease
}

export function echoArchive(opts: EchoArchiveOptions = {}): EchoArchive {
  const top = opts.top ?? 'echo'
  const raw: FileMap = {}
  readTree(ECHO_DIR, '', raw)
  const manifest = echoManifest(opts.manifest)
  raw['plugin.json'] = JSON.stringify(manifest, null, 2)
  for (const [k, v] of Object.entries(opts.files ?? {})) raw[k] = v
  for (const d of opts.drop ?? []) delete raw[d]
  const files: FileMap = {}
  for (const [k, v] of Object.entries(raw)) files[`${top}/${k}`] = v
  const bytes = writeTarGz(files, opts.tar)
  const version = String(manifest.version)
  const release: CatalogRelease = {
    version,
    platform: String(manifest.platform),
    dataVersion: Number(manifest.dataVersion),
    url: `https://github.com/example/redamon-plugins/releases/download/echo-v${version}/echo-${version}.tar.gz`,
    sha256: sha256Hex(bytes),
    permissions: [...((manifest.permissions as string[]) ?? [])],
    ...opts.release,
  }
  return { bytes, sha256: sha256Hex(bytes), manifest, release }
}
