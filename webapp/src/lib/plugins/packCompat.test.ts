/**
 * An archive made by the plugin repository's `tools/pack.py` passes the real strict reader and
 * the install checks (TD-12), so the two sides cannot drift apart unnoticed.
 *
 * The base repository holds no plugin code, so this runs only when REDAMON_PLUGINS_DIR names a
 * packed archive, or a folder whose `dist/` holds some (a `redamon-plugins` checkout after
 * `tools/pack.py <plugin>`); otherwise it is skipped.
 *
 * @vitest-environment node
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { describe, test, expect } from 'vitest'
import { readArchive } from './archive'
import { runInstallChecks } from './installChecks'
import { PLUGIN_PLATFORM_VERSION } from './platformVersion'
import { parseManifest } from './schemas/manifest'

const MAX_BYTES = 20 * 1024 * 1024
const ARCHIVE_NAME = /^([a-z][a-z0-9-]{1,39})-(\d+\.\d+\.\d+)\.tar\.gz$/

function packedArchives(): string[] {
  const where = process.env.REDAMON_PLUGINS_DIR
  if (!where || !existsSync(where)) return []
  if (statSync(where).isFile()) return [where]
  const dist = path.join(where, 'dist')
  if (!existsSync(dist)) return []
  return readdirSync(dist)
    .filter((f) => ARCHIVE_NAME.test(f))
    .sort()
    .map((f) => path.join(dist, f))
}

const archives = packedArchives()

describe.skipIf(archives.length === 0)('archives packed by redamon-plugins tools/pack.py', () => {
  test.each(archives)('%s is accepted by archive.ts and the install checks', (file) => {
    const name = ARCHIVE_NAME.exec(path.basename(file))
    expect(name, `${file} is not named <id>-<version>.tar.gz`).not.toBeNull()
    const [, pluginId, version] = name!
    const bytes = readFileSync(file)

    const archive = readArchive(bytes, { pluginId, maxBytes: MAX_BYTES })
    const paths = archive.files.map((f) => f.path)
    expect(paths).toContain('plugin.json')
    expect(paths.filter((p) => /^(tests|eval)\//.test(p) || p.includes('__pycache__') || p.endsWith('.pyc'))).toEqual([])

    const manifest = parseManifest(JSON.parse(archive.files.find((f) => f.path === 'plugin.json')!.bytes.toString('utf8')))
    expect(manifest.ok ? [] : manifest.errors).toEqual([])
    if (!manifest.ok) return
    expect(manifest.value.version).toBe(version)

    const out = runInstallChecks({
      pluginId,
      archiveBytes: bytes,
      release: {
        version,
        platform: manifest.value.platform,
        dataVersion: manifest.value.dataVersion,
        url: `https://github.com/example/redamon-plugins/releases/download/${pluginId}-v${version}/${pluginId}-${version}.tar.gz`,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        size: bytes.length,
        permissions: manifest.value.permissions,
      },
      platformVersion: PLUGIN_PLATFORM_VERSION,
      maxBytes: MAX_BYTES,
    })
    expect(out.ok, JSON.stringify(out)).toBe(true)
  })
})
