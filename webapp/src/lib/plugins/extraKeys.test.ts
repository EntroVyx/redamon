/**
 * The catalog keyring (TD-11): the official keys shipped with the platform, plus extra
 * keys an admin opts into with PLUGINS_EXTRA_TRUSTED_KEYS (a custom catalog, shown with
 * a warning). A bad value never widens trust: it is ignored with a warning.
 *
 * @vitest-environment node
 */
import { describe, test, expect, afterEach, vi } from 'vitest'
import { makeKeyPair } from './__testing__/ed25519'
import { setNowForTests } from './clock'
import { OFFICIAL_KEYS, extraKeys, findTrustedKey, type TrustedKey } from './keyring'

afterEach(() => {
  delete process.env.PLUGINS_EXTRA_TRUSTED_KEYS
  setNowForTests(null)
  vi.restoreAllMocks()
})

const entry = (kp = makeKeyPair(), extra: Partial<TrustedKey> = {}): TrustedKey => ({
  keyId: kp.keyId,
  publicKey: kp.publicKeyRawB64,
  ...extra,
})

describe('extraKeys', () => {
  test('the official keyring is empty until the production key is published (phase 08)', () => {
    expect(OFFICIAL_KEYS).toEqual([])
  })

  test('unset or blank: no extra key and no warning', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(extraKeys()).toEqual([])
    process.env.PLUGINS_EXTRA_TRUSTED_KEYS = '   '
    expect(extraKeys()).toEqual([])
    expect(warn).not.toHaveBeenCalled()
  })

  test('a JSON array of keys is read', () => {
    const a = entry()
    const b = entry(makeKeyPair('dev-2'), { notAfter: '2030-01-01T00:00:00Z' })
    process.env.PLUGINS_EXTRA_TRUSTED_KEYS = JSON.stringify([a, b])
    expect(extraKeys()).toEqual([a, b])
  })

  test.each(['not json', '{"keyId":"x"}', '42', 'null'])('an invalid value (%s) is ignored with a warning', (v) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    process.env.PLUGINS_EXTRA_TRUSTED_KEYS = v
    expect(extraKeys()).toEqual([])
    expect(warn.mock.calls[0][0]).toMatch(/^\[plugins\] PLUGINS_EXTRA_TRUSTED_KEYS/)
  })

  test('a bad entry is skipped with a warning, the good ones are kept', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const good = entry()
    process.env.PLUGINS_EXTRA_TRUSTED_KEYS = JSON.stringify([
      { keyId: 'short', publicKey: Buffer.alloc(16).toString('base64') },
      { keyId: 'bad id with spaces', publicKey: good.publicKey },
      { keyId: 'nokey' },
      { ...entry(), notAfter: 'tomorrow' },
      { ...entry(), extra: 'field' },
      good,
    ])
    expect(extraKeys()).toEqual([good])
    expect(warn).toHaveBeenCalledTimes(5)
  })

  test('an extra key may not reuse an official key id', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const official = entry(makeKeyPair('redamon-2026'))
    process.env.PLUGINS_EXTRA_TRUSTED_KEYS = JSON.stringify([entry(makeKeyPair('redamon-2026'))])
    expect(extraKeys([official])).toEqual([])
    expect(warn.mock.calls[0][0]).toMatch(/official/)
  })

  test('two extra keys with one id: the first wins', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const a = entry(makeKeyPair('dup'))
    const b = entry(makeKeyPair('dup'))
    process.env.PLUGINS_EXTRA_TRUSTED_KEYS = JSON.stringify([a, b])
    expect(extraKeys()).toEqual([a])
  })
})

describe('findTrustedKey', () => {
  test('finds an official key first and says so', () => {
    const kp = makeKeyPair('redamon-2026')
    const found = findTrustedKey('redamon-2026', [entry(kp)])
    expect(found?.official).toBe(true)
    expect(found?.key.asymmetricKeyType).toBe('ed25519')
  })

  test('finds an extra key, not official', () => {
    const kp = makeKeyPair('dev')
    process.env.PLUGINS_EXTRA_TRUSTED_KEYS = JSON.stringify([entry(kp)])
    expect(findTrustedKey('dev', [])?.official).toBe(false)
  })

  test('an unknown id is null', () => {
    expect(findTrustedKey('nobody', [])).toBeNull()
  })

  test('a key past its notAfter is no longer trusted (rotation)', () => {
    const kp = makeKeyPair('old')
    const keys = [entry(kp, { notAfter: '2026-06-01T00:00:00Z' })]
    setNowForTests(() => new Date('2026-05-31T23:59:59Z'))
    expect(findTrustedKey('old', keys)).not.toBeNull()
    setNowForTests(() => new Date('2026-06-01T00:00:00Z'))
    expect(findTrustedKey('old', keys)).toBeNull()
  })
})
