import fs from 'node:fs/promises'
import path from 'node:path'
import { compareVersions, isValidVersion, parseVersion } from '@/lib/semver'
import type { ReadArchive } from './archive'
import { isValidPluginId } from './ids'

/**
 * The plugins volume (README.PLUGINS.md §9.2), of which the webapp is the only writer:
 *
 *   <PLUGINS_DIR>/.staging/<operationId>/      one folder per operation, never loaded
 *   <PLUGINS_DIR>/<pluginId>/versions/<v>/     a committed version (the active one is in the DB)
 *
 * Staging lives on the same volume, so a commit is one atomic rename. Files are written
 * 0644 and directories 0755 whatever the archive says (workers read them under other
 * UIDs and can change nothing), with O_EXCL so a write never follows or replaces an
 * existing path. Under `./redamon.sh up dev` the webapp runs as root, so every path it
 * creates is handed to the production webapp's uid (1001); otherwise a plugin installed
 * in dev mode could not be updated or removed later.
 */
export const STAGING_DIR = '.staging'
export const RUNTIME_UID = 1001
const DEFAULT_PLUGINS_DIR = '/data/plugins'
const OPERATION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

export function pluginsDir(): string {
  return (process.env.PLUGINS_DIR || '').trim() || DEFAULT_PLUGINS_DIR
}

function checkOperationId(id: string) {
  if (typeof id !== 'string' || !OPERATION_ID_RE.test(id)) throw new Error(`Invalid operation id ${JSON.stringify(id)}`)
}

function checkPlugin(pluginId: string) {
  if (!isValidPluginId(pluginId)) throw new Error(`Invalid plugin id ${JSON.stringify(pluginId)}`)
}

function checkVersion(version: string) {
  if (!isValidVersion(version)) throw new Error(`Invalid version ${JSON.stringify(version)}`)
}

export function stagingPath(operationId: string): string {
  checkOperationId(operationId)
  return path.join(pluginsDir(), STAGING_DIR, operationId)
}

export function pluginFolder(pluginId: string): string {
  checkPlugin(pluginId)
  return path.join(pluginsDir(), pluginId)
}

export function versionPath(pluginId: string, version: string): string {
  checkVersion(version)
  return path.join(pluginFolder(pluginId), 'versions', version)
}

const asRoot = () => typeof process.getuid === 'function' && process.getuid() === 0

async function own(p: string) {
  if (asRoot()) await fs.chown(p, RUNTIME_UID, RUNTIME_UID)
}

/** Creates the directory if missing (0755, owned as above); true when it was created. */
async function ensureDir(p: string): Promise<boolean> {
  try {
    await fs.mkdir(p, { mode: 0o755 })
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') return false
    throw e
  }
  await fs.chmod(p, 0o755)
  await own(p)
  return true
}

async function makeDir(p: string) {
  await fs.mkdir(p, { mode: 0o755 })
  await fs.chmod(p, 0o755)
  await own(p)
}

/** Writes the archive's files into `.staging/<operationId>/`; on any failure nothing is left. */
export async function stageArchive(operationId: string, archive: ReadArchive): Promise<string> {
  const dir = stagingPath(operationId)
  await fs.mkdir(pluginsDir(), { recursive: true })
  await ensureDir(path.dirname(dir))
  await makeDir(dir)
  try {
    const inside = (rel: string) => {
      const p = path.resolve(dir, rel)
      if (!p.startsWith(dir + path.sep)) throw new Error(`Refusing to write ${JSON.stringify(rel)}: outside the staging folder`)
      return p
    }
    const dirs = new Set<string>(archive.dirs)
    for (const f of archive.files) {
      const parts = f.path.split('/')
      for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/'))
    }
    for (const d of [...dirs].sort((a, b) => a.split('/').length - b.split('/').length)) {
      await makeDir(inside(d))
    }
    for (const f of archive.files) {
      const p = inside(f.path)
      await fs.writeFile(p, f.bytes, { mode: 0o644, flag: 'wx' })
      await fs.chmod(p, 0o644)
      await own(p)
    }
  } catch (e) {
    await fs.rm(dir, { recursive: true, force: true })
    throw e
  }
  return dir
}

/**
 * Moves a staged operation into place. The database write that follows is the commit:
 * until it lands, nothing loads this folder, and reconciliation removes it if it never
 * does. An existing version folder is never replaced.
 */
export async function commitVersion(operationId: string, pluginId: string, version: string): Promise<string> {
  const from = stagingPath(operationId)
  const dest = versionPath(pluginId, version)
  await ensureDir(pluginFolder(pluginId))
  await ensureDir(path.dirname(dest))
  try {
    await fs.stat(dest)
    throw new Error(`Version folder ${pluginId}/${version} already exists`)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
  }
  await fs.rename(from, dest)
  return dest
}

export async function discardStaging(operationId: string): Promise<void> {
  await fs.rm(stagingPath(operationId), { recursive: true, force: true })
}

export async function listVersions(pluginId: string): Promise<string[]> {
  let names: string[]
  try {
    names = await fs.readdir(path.join(pluginFolder(pluginId), 'versions'))
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw e
  }
  return names.filter(isValidVersion).sort((a, b) => compareVersions(parseVersion(a), parseVersion(b)))
}

export async function versionExists(pluginId: string, version: string): Promise<boolean> {
  try {
    return (await fs.stat(versionPath(pluginId, version))).isDirectory()
  } catch {
    return false
  }
}

export async function removeVersion(pluginId: string, version: string): Promise<void> {
  await fs.rm(versionPath(pluginId, version), { recursive: true, force: true })
}

export async function removePluginFolder(pluginId: string): Promise<void> {
  await fs.rm(pluginFolder(pluginId), { recursive: true, force: true })
}

/** The operation folders under `.staging/`, with their modification time. */
export async function listStaging(): Promise<{ operationId: string; mtimeMs: number }[]> {
  let names: string[]
  try {
    names = await fs.readdir(path.join(pluginsDir(), STAGING_DIR))
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw e
  }
  const out: { operationId: string; mtimeMs: number }[] = []
  for (const n of names) {
    try {
      const st = await fs.stat(path.join(pluginsDir(), STAGING_DIR, n))
      out.push({ operationId: n, mtimeMs: st.mtimeMs })
    } catch {
      // removed meanwhile
    }
  }
  return out
}

/** The top-level plugin folders on the volume, with their versions and modification times. */
export async function listPluginFolders(): Promise<{ pluginId: string; versions: { version: string; mtimeMs: number }[] }[]> {
  let names: string[]
  try {
    names = await fs.readdir(pluginsDir())
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw e
  }
  const out: { pluginId: string; versions: { version: string; mtimeMs: number }[] }[] = []
  for (const n of names.filter((x) => x !== STAGING_DIR && isValidPluginId(x))) {
    const versions: { version: string; mtimeMs: number }[] = []
    for (const v of await listVersions(n)) {
      try {
        versions.push({ version: v, mtimeMs: (await fs.stat(versionPath(n, v))).mtimeMs })
      } catch {
        // removed meanwhile
      }
    }
    out.push({ pluginId: n, versions })
  }
  return out
}
