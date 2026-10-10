/**
 * The six install checks of README.PLUGINS.md §9.3, in order, each with its own refusal
 * code so the Plugins page can say what was wrong. Every check fails here on a fixture
 * built for it alone; the good fixture is the real `echo` plugin.
 *
 * @vitest-environment node
 */
import { describe, test, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { echoArchive, echoManifest } from './__testing__/echoArchive'
import { INSTALL_CHECK_CODES, checkAndStage, runInstallChecks, type InstallCheckInput } from './installChecks'
import { stagingPath } from './staging'

const OP = '0f8b6c1e-2a3d-4e5f-8a9b-0c1d2e3f4a5b'
let root: string

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'plugins-checks-'))
  process.env.PLUGINS_DIR = root
})

afterEach(async () => {
  delete process.env.PLUGINS_DIR
  await fs.rm(root, { recursive: true, force: true })
})

function input(a = echoArchive(), extra: Partial<InstallCheckInput> = {}): InstallCheckInput {
  return { pluginId: 'echo', archiveBytes: a.bytes, release: a.release, platformVersion: '1.0.0', maxBytes: 5_000_000, ...extra }
}

function failsWith(code: string, i: InstallCheckInput) {
  const out = runInstallChecks(i)
  expect(out.ok, JSON.stringify(out)).toBe(false)
  if (out.ok) throw new Error('unreachable')
  expect(out.code).toBe(code)
  expect(out.message.length).toBeGreaterThan(0)
  return out
}

describe('the echo fixture passes', () => {
  test('every check passes, and the result carries the manifest, files and screens', () => {
    const out = runInstallChecks(input())
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.manifest.id).toBe('echo')
    expect(out.archive.files.map((f) => f.path)).toContain('engine/main.py')
    expect(Object.keys(out.screens)).toEqual(['ui/home.json'])
  })

  test('the codes are the six of the design, in order', () => {
    expect(INSTALL_CHECK_CODES).toEqual([
      'sha256_mismatch',
      'unsafe_archive',
      'manifest_mismatch',
      'schema_invalid',
      'platform_incompatible',
      'unknown_contribution',
    ])
  })
})

describe('1. sha256', () => {
  test('an archive whose hash is not the catalog entry', () => {
    const a = echoArchive()
    failsWith('sha256_mismatch', input(a, { release: { ...a.release, sha256: 'f'.repeat(64) } }))
  })
})

describe('2. safe to unpack', () => {
  test('a symlink inside a correctly hashed archive', () => {
    failsWith('unsafe_archive', input(echoArchive({ tar: { symlink: { name: 'echo/x', target: '/etc/shadow' } } })))
  })

  test('the wrong top folder', () => {
    failsWith('unsafe_archive', input(echoArchive({ top: 'skiller' })))
  })

  test('over the size cap', () => {
    failsWith('unsafe_archive', input(echoArchive(), { maxBytes: 4096 }))
  })
})

describe('3. plugin.json matches the catalog entry', () => {
  test.each<[string, Record<string, unknown>]>([
    ['another version', { version: '1.0.1' }],
    ['another platform range', { platform: '>=1.0.0 <1.5.0' }],
    ['another dataVersion', { dataVersion: 2 }],
    ['fewer permissions', { permissions: ['session:read'] }],
    ['another id', { id: 'echo2' }],
  ])('%s', (_name, patch) => {
    const a = echoArchive()
    const b = echoArchive({ manifest: patch, release: a.release })
    failsWith('manifest_mismatch', input({ ...b, release: { ...a.release, sha256: b.sha256 } }))
  })

  test('the same permissions in another order match', () => {
    const perms = [...(echoManifest().permissions as string[])].reverse()
    const a = echoArchive({ manifest: { permissions: perms } })
    expect(runInstallChecks(input(a, { release: { ...a.release, permissions: [...perms].reverse() } })).ok).toBe(true)
  })

  test('no plugin.json at all', () => {
    failsWith('manifest_mismatch', input(echoArchive({ drop: ['plugin.json'] })))
  })
})

describe('4. schemas', () => {
  test('plugin.json that is not JSON', () => {
    failsWith('schema_invalid', input(echoArchive({ files: { 'plugin.json': '{ not json' } })))
  })

  test('a manifest field out of range', () => {
    const actions = (echoManifest().actions as Record<string, unknown>[]).map((x, i) => (i === 0 ? { ...x, timeoutSeconds: 0 } : x))
    const out = failsWith('schema_invalid', input(echoArchive({ manifest: { actions } })))
    expect(out.details?.join('\n')).toMatch(/timeoutSeconds/)
  })

  test('a screen description that breaks the screen schema', () => {
    const out = failsWith('schema_invalid', input(echoArchive({ files: { 'ui/home.json': '{"type":"page"}' } })))
    expect(out.details?.join('\n')).toMatch(/ui\/home\.json/)
  })

  test('a listed screen missing from the archive', () => {
    failsWith('schema_invalid', input(echoArchive({ drop: ['ui/home.json'] })))
  })

  test('an action whose entry file is missing', () => {
    const out = failsWith('schema_invalid', input(echoArchive({ drop: ['engine/items.py'] })))
    expect(out.details?.join('\n')).toMatch(/engine\/items\.py/)
  })

  test('a screen that calls an undeclared action', () => {
    const screen = { type: 'page', children: [{ type: 'button', label: 'Go', action: 'nowhere' }] }
    const out = failsWith('schema_invalid', input(echoArchive({ files: { 'ui/home.json': JSON.stringify(screen) } })))
    expect(out.details?.join('\n')).toMatch(/nowhere/)
  })

  test('a screen that opens a screen the manifest does not list', () => {
    const screen = { type: 'page', children: [{ type: 'button', label: 'Go', screen: 'ui/other.json' }] }
    const out = failsWith(
      'schema_invalid',
      input(echoArchive({ files: { 'ui/home.json': JSON.stringify(screen), 'ui/other.json': '{"type":"page","children":[]}' } })),
    )
    expect(out.details?.join('\n')).toMatch(/ui\/other\.json/)
  })
})

describe('5. platform range', () => {
  test('a range that excludes the running platform', () => {
    failsWith('platform_incompatible', input(echoArchive({ manifest: { platform: '>=2.0.0 <3.0.0' } })))
  })

  test('checked before unknown contributions (a newer plugin says "needs a newer platform")', () => {
    const contributes = { ...(echoManifest().contributes as object), 'future.point': [] }
    failsWith(
      'platform_incompatible',
      input(echoArchive({ manifest: { platform: '>=1.1.0 <2.0.0', contributes } })),
    )
  })
})

describe('6. every contribution exists on this platform', () => {
  test('an unknown extension point', () => {
    const contributes = { ...(echoManifest().contributes as object), 'future.point': [{ label: 'x' }] }
    const out = failsWith('unknown_contribution', input(echoArchive({ manifest: { contributes } })))
    expect(out.message).toMatch(/future\.point/)
  })

  test('an unknown UI primitive in a screen', () => {
    const screen = { type: 'page', children: [{ type: 'chart', series: [] }] }
    const out = failsWith('unknown_contribution', input(echoArchive({ files: { 'ui/home.json': JSON.stringify(screen) } })))
    expect(out.message).toMatch(/chart/)
  })

  test('an unknown permission (listed by the catalog too)', () => {
    const perms = [...(echoManifest().permissions as string[]), 'future:capability']
    const out = failsWith('unknown_contribution', input(echoArchive({ manifest: { permissions: perms } })))
    expect(out.message).toMatch(/future:capability/)
  })

  test('an unknown core screen and an unknown icon', () => {
    const contributes = {
      ...(echoManifest().contributes as object),
      'chat.session.actions': [
        { label: 'A', coreScreen: 'skill.text.history' },
        { label: 'B', icon: 'rocket', action: 'echo' },
      ],
    }
    const out = failsWith('unknown_contribution', input(echoArchive({ manifest: { contributes } })))
    expect(out.message).toMatch(/skill\.text\.history/)
    expect(out.message).toMatch(/rocket/)
  })
})

describe('checkAndStage', () => {
  test('a passing archive is staged under .staging/<operationId>/', async () => {
    const out = await checkAndStage(OP, input())
    expect(out.ok).toBe(true)
    expect(await fs.readFile(path.join(stagingPath(OP), 'engine/main.py'), 'utf8')).toMatch(/async def echo/)
  })

  test('a failing check writes nothing', async () => {
    const a = echoArchive()
    const out = await checkAndStage(OP, input(a, { release: { ...a.release, sha256: '0'.repeat(64) } }))
    expect(out).toMatchObject({ ok: false, code: 'sha256_mismatch' })
    await expect(fs.stat(stagingPath(OP))).rejects.toThrow()
    expect(await fs.readdir(root)).toEqual([])
  })
})
