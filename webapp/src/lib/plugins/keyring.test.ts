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

// The release environment's key of samugit83/redamon-plugins (README.PLUGINS.md §6.2).
const PRODUCTION_KEY_IDS = ['ee4a2df9065d36b1']
// The Skiller development key (~/.config/redamon-plugins/dev, phase 07) and the prefix of the
// throwaway keys testing/e2e/scripts/make-plugin-fixtures.mjs generates: trusted only through
// PLUGINS_EXTRA_TRUSTED_KEYS, never shipped.
const DEV_KEY_ID = 'b04ccc133d998579'
const NOT_SHIPPED_PREFIXES = ['e2e-', 'test-', 'dev']

afterEach(() => {
  delete process.env.PLUGINS_EXTRA_TRUSTED_KEYS
})

describe('OFFICIAL_KEYS', () => {
  test('lists the production key and nothing else', () => {
    expect(OFFICIAL_KEYS.map((k) => k.keyId)).toEqual(PRODUCTION_KEY_IDS)
  })

  test('never lists a development or test key', () => {
    const ids = OFFICIAL_KEYS.map((k) => k.keyId)
    expect(ids).not.toContain(DEV_KEY_ID)
    expect(ids.filter((id) => NOT_SHIPPED_PREFIXES.some((p) => id.startsWith(p)))).toEqual([])
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
