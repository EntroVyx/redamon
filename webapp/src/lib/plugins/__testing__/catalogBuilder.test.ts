/**
 * @vitest-environment node
 */
import { describe, test, expect } from 'vitest'
import { verify } from 'crypto'
import { buildCatalog, sha256Hex } from './catalogBuilder'
import { makeKeyPair } from './ed25519'

const key = makeKeyPair('k1')

describe('buildCatalog', () => {
  test('groups a flat release list into plugin entries, keeping order', () => {
    const { catalog } = buildCatalog({
      releases: [
        { pluginId: 'skiller', version: '1.0.0' },
        { pluginId: 'echo', version: '0.1.0', permissions: ['session:read'] },
        { pluginId: 'skiller', version: '1.1.0', platform: '>=1.1.0 <2.0.0', dataVersion: 2 },
      ],
      serial: 7,
      expires: new Date('2026-12-31T00:00:00Z'),
      key,
    })
    expect(catalog).toMatchObject({
      catalogVersion: 1,
      serial: 7,
      expires: '2026-12-31T00:00:00.000Z',
      revoked: [],
    })
    const plugins = catalog.plugins as Array<{ id: string; releases: Array<Record<string, unknown>> }>
    expect(plugins.map(p => p.id)).toEqual(['skiller', 'echo'])
    expect(plugins[0].releases.map(r => r.version)).toEqual(['1.0.0', '1.1.0'])
    expect(plugins[0].releases[1]).toMatchObject({ platform: '>=1.1.0 <2.0.0', dataVersion: 2 })
    expect(plugins[1].releases[0]).toMatchObject({ permissions: ['session:read'] })
    expect(plugins[0].releases[0].url).toMatch(/^https:\/\/github\.com\/.+\/skiller-1\.0\.0\.tar\.gz$/)
  })

  test('the bytes are the JSON of the catalog, and the signature file is {keyId, sig}', () => {
    const built = buildCatalog({ releases: [{ pluginId: 'a', version: '1.0.0' }], serial: 1, expires: '2026-06-01T00:00:00Z', key })
    expect(JSON.parse(built.bytes.toString('utf8'))).toEqual(built.catalog)
    const sigFile = JSON.parse(built.sigBytes.toString('utf8'))
    expect(sigFile).toEqual({ keyId: 'k1', sig: built.sigB64 })
  })

  test('the signature verifies over the exact bytes with crypto.verify', () => {
    const built = buildCatalog({ releases: [{ pluginId: 'a', version: '1.0.0' }], serial: 3, expires: '2026-06-01T00:00:00Z', key })
    const sig = Buffer.from(built.sigB64, 'base64')
    expect(verify(null, built.bytes, key.publicKey, sig)).toBe(true)
  })

  test('one flipped byte in the catalog breaks the signature', () => {
    const built = buildCatalog({ releases: [{ pluginId: 'a', version: '1.0.0' }], serial: 3, expires: '2026-06-01T00:00:00Z', key })
    const tampered = Buffer.from(built.bytes)
    tampered[tampered.length - 3] ^= 0x01
    expect(verify(null, tampered, key.publicKey, Buffer.from(built.sigB64, 'base64'))).toBe(false)
  })

  test('claimKeyId names a different key while signing with the given one', () => {
    const built = buildCatalog({ releases: [], serial: 1, expires: '2026-06-01T00:00:00Z', key, claimKeyId: 'unknown-key' })
    expect(JSON.parse(built.sigBytes.toString('utf8')).keyId).toBe('unknown-key')
  })

  test('revoked entries are carried as given', () => {
    const revoked = [{ id: 'skiller', version: '1.0.0', reason: 'test' }]
    const { catalog } = buildCatalog({ releases: [], serial: 2, expires: '2026-06-01T00:00:00Z', key, revoked })
    expect(catalog.revoked).toEqual(revoked)
  })
})

describe('sha256Hex', () => {
  test('matches the published vector for "abc"', () => {
    expect(sha256Hex(Buffer.from('abc'))).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  })
})
