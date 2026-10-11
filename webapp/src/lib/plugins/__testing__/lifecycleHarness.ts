/**
 * The world of the lifecycle tests: a temporary plugins volume (PLUGINS_DIR), a fake
 * runner that converges on the database's run list at each reload as the supervisor
 * does, and a catalog and archive download injected through the lifecycle's deps. Each
 * test file still mocks `@/lib/prisma` (and the session) itself: vi.mock must.
 */
import fs from 'node:fs/promises'
import { readdirSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { FakePrisma, Row } from './fakePrisma'
import { startFakeRunner, type FakeRunner, type FakeWorker } from './fakeRunner'
import { echoArchive, type EchoArchive, type EchoArchiveOptions } from './echoArchive'
import { ECHO_MIGRATIONS } from './echoMigrations'
import type { LoadedCatalog } from '../catalog'
import type { LifecycleDeps } from '../lifecycle'
import type { RegistrySkill } from '../skillPartsRegistry'

export const ADMIN = 'user-admin'
export const RUNNER_KEY = 'k'.repeat(64)
export const NOW = new Date('2026-10-10T09:00:00Z')

export interface LifecycleWorld {
  root: string
  runner: FakeRunner
  archives: Map<string, EchoArchive>
  /** Plugin versions whose worker the fake runner reports `failed`. */
  failing: Set<string>
  /** Called on each reload, after the workers are set: what the volume looked like then. */
  reloadSpy: Array<{ folders: string[] }>
  deps: LifecycleDeps
  catalog: { revoked: { id: string; version: string; reason: string }[]; unavailable: Error | null }
  downloads: string[]
  close(): Promise<void>
}

/** A catalog listing the given archives' releases, as loadCatalog would return it. */
export function catalogOf(archives: EchoArchive[], revoked: LifecycleWorld['catalog']['revoked'] = []): LoadedCatalog {
  return {
    catalog: {
      catalogVersion: 1,
      serial: 1,
      plugins: archives.length
        ? [{ id: 'echo', displayName: 'Echo', description: 'Test fixture', releases: archives.map((a) => a.release) }]
        : [],
      revoked,
    },
    keyId: 'test',
    official: true,
    serial: 1,
    warnings: [],
  }
}

async function listFolders(root: string): Promise<string[]> {
  const out: string[] = []
  const walk = async (dir: string, rel: string) => {
    let names: string[]
    try {
      names = await fs.readdir(dir)
    } catch {
      return
    }
    for (const n of names) {
      const p = path.join(dir, n)
      if ((await fs.stat(p)).isDirectory()) {
        out.push(path.join(rel, n))
        if (rel.split(path.sep).length < 3) await walk(p, path.join(rel, n))
      }
    }
  }
  await walk(root, '')
  return out.sort()
}

export async function startLifecycleWorld(db: () => FakePrisma, releases: EchoArchiveOptions[] = [{}]): Promise<LifecycleWorld> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'plugins-lifecycle-'))
  process.env.PLUGINS_DIR = root
  const archives = new Map<string, EchoArchive>()
  for (const r of releases) {
    const a = echoArchive(r)
    archives.set(a.release.version, a)
  }
  const failing = new Set<string>()
  const reloadSpy: LifecycleWorld['reloadSpy'] = []
  const runner = await startFakeRunner({
    runnerKey: RUNNER_KEY,
    actions: { 'echo/echo': () => ({ result: {} }) },
    migrations: { ...ECHO_MIGRATIONS },
    // The supervisor migrates with a version folder that is on the volume, running or not.
    diskVersions: (pluginId) => {
      try {
        return readdirSync(path.join(root, pluginId, 'versions'))
      } catch {
        return []
      }
    },
    // The supervisor converges on the run list: enabled, not revoked, ready or updating.
    onReload: async (options) => {
      const rows = db().rows('pluginInstall').filter(
        (r: Row) => r.enabled && r.revokedReason == null && (r.status === 'ready' || r.status === 'updating') && r.activeVersion,
      )
      options.workers = rows.map((r: Row, i: number): FakeWorker => ({
        id: String(r.pluginId),
        version: String(r.activeVersion),
        pid: 100 + i,
        uid: 20000 + i,
        inFlight: 0,
        startedAt: NOW.toISOString(),
        restarts: 0,
        state: failing.has(`${r.pluginId}@${r.activeVersion}`) ? 'failed' : 'ready',
      }))
      reloadSpy.push({ folders: await listFolders(root) })
    },
  })
  process.env.PLUGIN_RUNNER_URL = runner.baseUrl
  process.env.PLUGIN_RUNNER_KEY = RUNNER_KEY

  const downloads: string[] = []
  const world: LifecycleWorld = {
    root,
    runner,
    archives,
    failing,
    reloadSpy,
    downloads,
    catalog: { revoked: [], unavailable: null },
    deps: {},
    async close() {
      await runner.close()
      delete process.env.PLUGINS_DIR
      delete process.env.PLUGIN_RUNNER_URL
      delete process.env.PLUGIN_RUNNER_KEY
      await fs.rm(root, { recursive: true, force: true })
    },
  }
  world.deps = {
    loadCatalog: async () => {
      if (world.catalog.unavailable) throw world.catalog.unavailable
      return catalogOf([...archives.values()], world.catalog.revoked)
    },
    fetchArchive: async (url: string) => {
      downloads.push(url)
      const a = [...archives.values()].find((x) => x.release.url === url)
      if (!a) throw new Error(`no archive at ${url}`)
      return a.bytes
    },
    registrySkill: async () => null,
  }
  return world
}

/** A registry for the restore and stale checks: skill -> part -> sha256. */
export function registryOf(skills: Record<string, Record<string, string>>): (id: string) => Promise<RegistrySkill | null> {
  return async (id) => {
    const parts = skills[id]
    if (!parts) return null
    return {
      id,
      maxChars: 100_000,
      parts: Object.entries(parts).map(([partId, sha256], order) => ({
        partId,
        constant: partId.toUpperCase(),
        kind: 'workflow',
        placeholders: [],
        sha256,
        chars: 10,
        maxChars: 1000,
        order,
        gate: '',
        text: 'factory',
      })),
    }
  }
}

export const exists = async (p: string) => fs.stat(p).then(() => true, () => false)
