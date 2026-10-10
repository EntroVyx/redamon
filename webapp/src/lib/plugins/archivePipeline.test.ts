/**
 * Staging on the plugins volume (README.PLUGINS.md §9.2): one folder per operation under
 * `.staging/`, files 0644 and directories 0755 whatever the archive says, committed by a
 * single rename into `<id>/versions/<version>/`, discarded on any failure. A webapp
 * running as root (`./redamon.sh up dev`) hands every path it creates to uid 1001, so the
 * production webapp can still update or remove what it installed (R-80).
 *
 * @vitest-environment node
 */
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { writeTarGz } from './__testing__/ustarWriter'
import { readArchive, type ReadArchive } from './archive'
import {
  RUNTIME_UID,
  STAGING_DIR,
  commitVersion,
  discardStaging,
  listStaging,
  listVersions,
  pluginsDir,
  removePluginFolder,
  removeVersion,
  stageArchive,
  stagingPath,
  versionPath,
} from './staging'

const OP = '0f8b6c1e-2a3d-4e5f-8a9b-0c1d2e3f4a5b'
const OP2 = '1f8b6c1e-2a3d-4e5f-8a9b-0c1d2e3f4a5b'
let root: string

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'plugins-staging-'))
  process.env.PLUGINS_DIR = root
})

afterEach(async () => {
  vi.restoreAllMocks()
  delete process.env.PLUGINS_DIR
  await fs.rm(root, { recursive: true, force: true })
})

function archive(files: Record<string, string> = {}): ReadArchive {
  return readArchive(
    writeTarGz({
      'echo/plugin.json': '{"id":"echo"}',
      'echo/engine/main.py': 'print(1)\n',
      'echo/ui/home.json': '{}',
      ...files,
    }),
    { pluginId: 'echo', maxBytes: 1_000_000 },
  )
}

const modeOf = async (p: string) => (await fs.stat(p)).mode & 0o777

describe('paths', () => {
  test('PLUGINS_DIR defaults to /data/plugins (outside /app, which up dev bind-mounts)', () => {
    delete process.env.PLUGINS_DIR
    expect(pluginsDir()).toBe('/data/plugins')
  })

  test('staging and version paths are built only from valid ids', () => {
    expect(stagingPath(OP)).toBe(path.join(root, STAGING_DIR, OP))
    expect(versionPath('echo', '1.2.3')).toBe(path.join(root, 'echo', 'versions', '1.2.3'))
    for (const bad of ['../x', 'a/b', '', '..', 'x'.repeat(200)]) {
      expect(() => stagingPath(bad)).toThrow()
    }
    expect(() => versionPath('../etc', '1.0.0')).toThrow()
    expect(() => versionPath('echo', '../../1.0.0')).toThrow()
    expect(() => versionPath('staging', '1.0.0')).toThrow()
  })
})

describe('stage, commit, discard', () => {
  test('stages files 0644 and directories 0755, whatever the archive modes', async () => {
    const a = archive()
    for (const f of a.files) f.mode = 0o4777
    const dir = await stageArchive(OP, a)
    expect(dir).toBe(stagingPath(OP))
    expect(await fs.readFile(path.join(dir, 'engine/main.py'), 'utf8')).toBe('print(1)\n')
    expect(await modeOf(path.join(dir, 'engine/main.py'))).toBe(0o644)
    expect(await modeOf(path.join(dir, 'plugin.json'))).toBe(0o644)
    expect(await modeOf(path.join(dir, 'engine'))).toBe(0o755)
    expect(await modeOf(dir)).toBe(0o755)
  })

  test('modes hold under a strict umask', async (ctx) => {
    let previous: number | null = null
    try {
      previous = process.umask(0o077)
    } catch {
      ctx.skip('process.umask cannot be set in a worker thread')
    }
    try {
      const dir = await stageArchive(OP, archive())
      expect(await modeOf(path.join(dir, 'ui/home.json'))).toBe(0o644)
      expect(await modeOf(path.join(dir, 'ui'))).toBe(0o755)
    } finally {
      process.umask(previous!)
    }
  })

  test('commit is one rename into <id>/versions/<version>/, and the staging folder is gone', async () => {
    await stageArchive(OP, archive())
    const dest = await commitVersion(OP, 'echo', '1.0.0')
    expect(dest).toBe(versionPath('echo', '1.0.0'))
    expect(await fs.readFile(path.join(dest, 'plugin.json'), 'utf8')).toBe('{"id":"echo"}')
    await expect(fs.stat(stagingPath(OP))).rejects.toThrow()
    expect(await modeOf(path.join(root, 'echo'))).toBe(0o755)
    expect(await modeOf(path.join(root, 'echo', 'versions'))).toBe(0o755)
  })

  test('a commit never replaces an existing version folder', async () => {
    await stageArchive(OP, archive())
    await commitVersion(OP, 'echo', '1.0.0')
    await stageArchive(OP2, archive({ 'echo/plugin.json': '{"id":"echo","v":2}' }))
    await expect(commitVersion(OP2, 'echo', '1.0.0')).rejects.toThrow(/exists/)
    expect(await fs.readFile(path.join(versionPath('echo', '1.0.0'), 'plugin.json'), 'utf8')).toBe('{"id":"echo"}')
  })

  test('an operation id is staged once: a second stage of the same id is refused', async () => {
    await stageArchive(OP, archive())
    await expect(stageArchive(OP, archive())).rejects.toThrow()
  })

  test('a write failure part way discards the staging folder and rethrows', async () => {
    const real = fs.writeFile
    let n = 0
    vi.spyOn(fs, 'writeFile').mockImplementation(async (...args: Parameters<typeof fs.writeFile>) => {
      n += 1
      if (n === 2) throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' })
      return real(...args)
    })
    await expect(stageArchive(OP, archive())).rejects.toThrow(/ENOSPC/)
    await expect(fs.stat(stagingPath(OP))).rejects.toThrow()
  })

  test('a path that would leave the staging folder is refused even if the reader missed it', async () => {
    const a = archive()
    a.files.push({ path: '../../escape.txt', mode: 0o644, bytes: Buffer.from('x') })
    await expect(stageArchive(OP, a)).rejects.toThrow(/outside/)
    await expect(fs.stat(path.join(root, 'escape.txt'))).rejects.toThrow()
    await expect(fs.stat(stagingPath(OP))).rejects.toThrow()
  })

  test('discard removes the staging folder and is a no-op when there is none', async () => {
    await stageArchive(OP, archive())
    await discardStaging(OP)
    await expect(fs.stat(stagingPath(OP))).rejects.toThrow()
    await expect(discardStaging(OP2)).resolves.toBeUndefined()
  })

  test('listVersions, removeVersion, removePluginFolder', async () => {
    expect(await listVersions('echo')).toEqual([])
    await stageArchive(OP, archive())
    await commitVersion(OP, 'echo', '1.10.0')
    await stageArchive(OP2, archive())
    await commitVersion(OP2, 'echo', '1.2.0')
    expect(await listVersions('echo')).toEqual(['1.2.0', '1.10.0'])
    await removeVersion('echo', '1.2.0')
    expect(await listVersions('echo')).toEqual(['1.10.0'])
    await removePluginFolder('echo')
    await expect(fs.stat(path.join(root, 'echo'))).rejects.toThrow()
    await expect(removePluginFolder('echo')).resolves.toBeUndefined()
  })

  test('listStaging reports each operation folder with its age', async () => {
    await stageArchive(OP, archive())
    const list = await listStaging()
    expect(list.map((s) => s.operationId)).toEqual([OP])
    expect(typeof list[0].mtimeMs).toBe('number')
  })
})

describe('ownership when the webapp runs as root (up dev)', () => {
  test('every created path is chowned to 1001:1001', async () => {
    vi.spyOn(process, 'getuid').mockReturnValue(0)
    const chown = vi.spyOn(fs, 'chown').mockResolvedValue(undefined)
    await stageArchive(OP, archive())
    await commitVersion(OP, 'echo', '1.0.0')
    const chowned = new Set(chown.mock.calls.map((c) => path.relative(root, String(c[0]))))
    for (const p of [
      STAGING_DIR,
      path.join(STAGING_DIR, OP),
      path.join(STAGING_DIR, OP, 'plugin.json'),
      path.join(STAGING_DIR, OP, 'engine'),
      path.join(STAGING_DIR, OP, 'engine', 'main.py'),
      path.join(STAGING_DIR, OP, 'ui'),
      path.join(STAGING_DIR, OP, 'ui', 'home.json'),
      'echo',
      path.join('echo', 'versions'),
    ]) {
      expect(chowned, p).toContain(p)
    }
    expect(chown.mock.calls.every((c) => c[1] === RUNTIME_UID && c[2] === RUNTIME_UID)).toBe(true)
    expect(RUNTIME_UID).toBe(1001)
  })

  test('as uid 1001 nothing is chowned', async () => {
    vi.spyOn(process, 'getuid').mockReturnValue(1001)
    const chown = vi.spyOn(fs, 'chown').mockResolvedValue(undefined)
    await stageArchive(OP, archive())
    await commitVersion(OP, 'echo', '1.0.0')
    expect(chown).not.toHaveBeenCalled()
  })
})
