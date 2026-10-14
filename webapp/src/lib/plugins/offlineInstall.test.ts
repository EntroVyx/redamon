/**
 * Offline install (README.PLUGINS.md §9.7): an admin uploads an archive with a catalog and
 * its signature that cover it, and it goes through exactly the checks of a download (the
 * signature against the keyring, the serial, the expiry, the pinned sha256, the six
 * checks, consent). The body is size-checked from Content-Length BEFORE it is parsed
 * (route handlers have no body limit), and the archive's real size is what counts.
 *
 * @vitest-environment node
 */
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'
import { NextRequest } from 'next/server'

const h = vi.hoisted(() => ({
  db: null as unknown as Record<string, unknown>,
  audit: [] as Record<string, unknown>[],
  session: { userId: 'user-admin', role: 'admin' } as { userId: string; role: string } | null,
}))
vi.mock('@/lib/prisma', () => ({ default: new Proxy({}, { get: (_t, k) => h.db[k as string] }) }))
vi.mock('@/lib/audit', () => ({ writeAudit: vi.fn(async (e: Record<string, unknown>) => void h.audit.push(e)) }))
vi.mock('@/lib/session', async (orig) => ({ ...((await orig()) as Record<string, unknown>), getSession: async () => h.session }))

import { createFakePrisma, type FakePrisma } from './__testing__/fakePrisma'
import { buildCatalog } from './__testing__/catalogBuilder'
import { makeKeyPair } from './__testing__/ed25519'
import { echoArchive, type EchoArchive } from './__testing__/echoArchive'
import { ADMIN, NOW, startLifecycleWorld, type LifecycleWorld } from './__testing__/lifecycleHarness'
import { clearCatalogCache } from './catalog'
import { setNowForTests } from './clock'
import { POST as offlineInstall } from '@/app/api/plugins/offline-install/route'

let db: FakePrisma
let w: LifecycleWorld
const dev = makeKeyPair('dev-offline')
const PERMS = ['session:read', 'llm:invoke', 'override:skill.text']

beforeEach(async () => {
  db = createFakePrisma()
  h.db = db as unknown as Record<string, unknown>
  h.audit = []
  h.session = { userId: ADMIN, role: 'admin' }
  setNowForTests(() => NOW)
  clearCatalogCache()
  for (const m of ['warn', 'error', 'log'] as const) vi.spyOn(console, m).mockImplementation(() => {})
  db.seed('user', [
    { id: ADMIN, email: 'admin@example.com', role: 'admin' },
    { id: 'user-a', email: 'a@example.com', role: 'standard' },
  ])
  w = await startLifecycleWorld(() => db)
  vi.stubEnv('PLUGINS_EXTRA_TRUSTED_KEYS', JSON.stringify([{ keyId: dev.keyId, publicKey: dev.publicKeyRawB64 }]))
})

afterEach(async () => {
  await w.close()
  setNowForTests(null)
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

function trio(a: EchoArchive = w.archives.get('1.0.0')!, opts: { key?: typeof dev; serial?: number; release?: Record<string, unknown> } = {}) {
  const c = buildCatalog({
    releases: [{ pluginId: 'echo', ...a.release, ...opts.release }],
    serial: opts.serial ?? 5,
    key: opts.key ?? dev,
  })
  return { archive: a.bytes, catalog: c.bytes, signature: c.sigBytes }
}

function form(parts: { archive: Buffer; catalog: Buffer; signature: Buffer }, fields: Record<string, string> = {}) {
  const f = new FormData()
  f.set('archive', new Blob([new Uint8Array(parts.archive)]), 'echo-1.0.0.tar.gz')
  f.set('catalog', new Blob([new Uint8Array(parts.catalog)]), 'catalog.json')
  f.set('signature', new Blob([new Uint8Array(parts.signature)]), 'catalog.json.sig')
  f.set('acceptedPermissions', fields.acceptedPermissions ?? JSON.stringify(PERMS))
  for (const [k, v] of Object.entries(fields)) if (k !== 'acceptedPermissions') f.set(k, v)
  return f
}

async function request(body: FormData, headers: Record<string, string> = {}) {
  // Serialise as a browser would, so Content-Length is real.
  const r = new Request('http://localhost:3000/api/plugins/offline-install', { method: 'POST', body })
  const bytes = Buffer.from(await r.arrayBuffer())
  return new NextRequest('http://localhost:3000/api/plugins/offline-install', {
    method: 'POST',
    headers: { 'content-type': r.headers.get('content-type')!, 'content-length': String(bytes.length), host: 'localhost:3000', ...headers },
    body: bytes,
  })
}

const row = () => db.rows('pluginInstall').find((r) => r.pluginId === 'echo')

describe('offline install', () => {
  test('a valid trio installs the plugin, through the same checks as a download', async () => {
    const res = await offlineInstall(await request(form(trio())))
    expect(res.status).toBe(200)
    expect((await res.json()).plugin).toMatchObject({ pluginId: 'echo', status: 'ready', activeVersion: '1.0.0' })
    expect(row()).toMatchObject({ status: 'ready', installedBy: ADMIN })
    expect(db.rows('pluginPlatformState').find((s) => s.key === 'catalog.serial:extra:dev-offline')?.value).toMatchObject({ serial: 5, keyId: 'dev-offline' })
    expect(w.downloads).toEqual([])
  })

  test('an archive the uploaded catalog does not pin → 422 sha256_mismatch, nothing installed', async () => {
    const parts = trio(undefined, { release: { sha256: 'e'.repeat(64) } })
    const res = await offlineInstall(await request(form(parts)))
    expect(res.status).toBe(422)
    expect((await res.json()).code).toBe('sha256_mismatch')
    expect(row()).toBeUndefined()
  })

  test('a catalog signed by a key nobody trusts → 422 with the catalog code', async () => {
    const res = await offlineInstall(await request(form(trio(undefined, { key: makeKeyPair('stranger') }))))
    expect(res.status).toBe(422)
    expect(await res.json()).toMatchObject({ code: 'catalog_invalid', details: ['unknown_key'] })
  })

  test('an unsafe archive in a correctly signed catalog is refused by the install checks', async () => {
    const bad = echoArchive({ tar: { symlink: { name: 'echo/x', target: '/etc/passwd' } } })
    const res = await offlineInstall(await request(form(trio(bad))))
    expect(res.status).toBe(422)
    expect((await res.json()).code).toBe('unsafe_archive')
    expect(row()!.status).toBe('available')
  })

  test('consent still has to match the release', async () => {
    const res = await offlineInstall(await request(form(trio(), { acceptedPermissions: JSON.stringify(['session:read']) })))
    expect(res.status).toBe(400)
    expect((await res.json()).code).toBe('permissions_mismatch')
  })

  test('an installed plugin with a newer archive is updated', async () => {
    await offlineInstall(await request(form(trio())))
    const newer = echoArchive({ manifest: { version: '1.0.1' } })
    const res = await offlineInstall(await request(form(trio(newer, { serial: 6 }))))
    expect(res.status).toBe(200)
    expect(row()).toMatchObject({ activeVersion: '1.0.1', previousVersion: '1.0.0' })
  })
})

describe('the body', () => {
  test('a Content-Length over the cap is refused before the body is parsed', async () => {
    vi.stubEnv('PLUGIN_ARCHIVE_MAX_BYTES', '1000')
    const req = await request(form(trio()), { 'content-length': String(1000 + 2 * 1024 * 1024 + 1) })
    const parse = vi.spyOn(req, 'formData')
    const res = await offlineInstall(req)
    expect(res.status).toBe(413)
    expect((await res.json()).code).toBe('upload_too_large')
    expect(parse).not.toHaveBeenCalled()
  })

  test('over the 10 MiB the middleware passes: refused up front with that limit, not cut short', async () => {
    // The default archive cap is 20 MiB, but Next keeps only the first 10 MiB of a body
    // that goes through middleware; the route would then read a truncated form.
    const req = await request(form(trio()), { 'content-length': String(10 * 1024 * 1024 + 1) })
    const parse = vi.spyOn(req, 'formData')
    const res = await offlineInstall(req)
    expect(res.status).toBe(413)
    const body = await res.json()
    expect(body.code).toBe('upload_too_large')
    expect(body.error).toMatch(/10485760 bytes/)
    expect(parse).not.toHaveBeenCalled()
  })

  test('no Content-Length → 411, unparsed', async () => {
    const req = await request(form(trio()))
    req.headers.delete('content-length')
    const parse = vi.spyOn(req, 'formData')
    expect((await offlineInstall(req)).status).toBe(411)
    expect(parse).not.toHaveBeenCalled()
  })

  test('the archive real size counts, not the request total', async () => {
    vi.stubEnv('PLUGIN_ARCHIVE_MAX_BYTES', '1000')
    const res = await offlineInstall(await request(form(trio())))
    expect(res.status).toBe(413)
    expect((await res.json()).code).toBe('archive_too_large')
  })

  test('a missing part → 400', async () => {
    const f = form(trio())
    f.delete('signature')
    const res = await offlineInstall(await request(f))
    expect(res.status).toBe(400)
    expect((await res.json()).code).toBe('invalid_request')
  })

  test('not multipart → 415', async () => {
    const req = new NextRequest('http://localhost:3000/api/plugins/offline-install', {
      method: 'POST', headers: { 'content-type': 'application/json', 'content-length': '2', host: 'localhost:3000' }, body: '{}',
    })
    expect((await offlineInstall(req)).status).toBe(415)
  })
})

describe('who', () => {
  test('403 for a standard user; 403 cross-origin', async () => {
    h.session = { userId: 'user-a', role: 'standard' }
    expect((await offlineInstall(await request(form(trio())))).status).toBe(403)
    h.session = { userId: ADMIN, role: 'admin' }
    const res = await offlineInstall(await request(form(trio()), { origin: 'https://evil.example' }))
    expect(res.status).toBe(403)
    expect(row()).toBeUndefined()
  })
})
