/**
 * The keys shipped in OFFICIAL_KEYS (TD-11, R-27): only the production key of the official
 * plugin repository, never a development or test key, each a well-formed Ed25519 key whose id
 * is the one the repository's tools derive from it.
 *
 * @vitest-environment node
 */
import { createHash } from 'crypto'
import { describe, test, expect, afterEach } from 'vitest'
import { OFFICIAL_KEYS, findTrustedKey } from './keyring'

// The release environment's key of samugit83/redamon-plugins (README.PLUGINS.md §6.2, §6.4),
// pinned whole: a changed byte is a different key.
const PRODUCTION_KEYS = [{ keyId: 'ee4a2df9065d36b1', publicKey: 'RfUjPbeO+6ftsMNGkM5CnM46XIwQs+yRcPy4m5msyFg=' }]
// The Skiller development key (~/.config/redamon-plugins/dev): trusted by a local RedAmon only
// through PLUGINS_EXTRA_TRUSTED_KEYS, never shipped.
const DEV_KEY_ID = 'b04ccc133d998579'

afterEach(() => {
  delete process.env.PLUGINS_EXTRA_TRUSTED_KEYS
})

describe('OFFICIAL_KEYS', () => {
  test('lists the production key and nothing else', () => {
    expect(OFFICIAL_KEYS).toEqual(PRODUCTION_KEYS)
  })

  test('never lists the development key', () => {
    expect(OFFICIAL_KEYS.map((k) => k.keyId)).not.toContain(DEV_KEY_ID)
  })

  test.each(OFFICIAL_KEYS.map((k) => [k.keyId, k] as const))('%s is 32 raw bytes in canonical base64', (_id, k) => {
    const raw = Buffer.from(k.publicKey, 'base64')
    expect(raw).toHaveLength(32)
    expect(raw.toString('base64')).toBe(k.publicKey)
  })

  test.each(OFFICIAL_KEYS.map((k) => [k.keyId, k] as const))(
    '%s is the id redamon-plugins tools/sign.py derives (first 16 hex of the key sha256)',
    (_id, k) => {
      const raw = Buffer.from(k.publicKey, 'base64')
      expect(createHash('sha256').update(raw).digest('hex').slice(0, 16)).toBe(k.keyId)
    },
  )

  test.each(OFFICIAL_KEYS.map((k) => [k.keyId, k] as const))('%s is trusted as official, as an Ed25519 key', (_id, k) => {
    process.env.PLUGINS_EXTRA_TRUSTED_KEYS = ''
    const found = findTrustedKey(k.keyId)
    expect(found?.official).toBe(true)
    expect(found?.key.asymmetricKeyType).toBe('ed25519')
    const x = (found!.key.export({ format: 'jwk' }) as { x: string }).x
    expect(Buffer.from(x, 'base64url').toString('base64')).toBe(k.publicKey)
  })
})
