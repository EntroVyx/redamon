/**
 * @vitest-environment node
 */
import { describe, test, expect } from 'vitest'
import { createPublicKey, verify } from 'crypto'
import { makeKeyPair, sign } from './ed25519'

describe('ed25519 test keys', () => {
  test('a signature verifies with crypto.verify and the public key', () => {
    const k = makeKeyPair()
    const msg = Buffer.from('{"serial":1}\n')
    const sig = sign(msg, k.privateKey)
    expect(sig).toHaveLength(64)
    expect(verify(null, msg, k.publicKey, sig)).toBe(true)
  })

  test('one flipped byte fails verification', () => {
    const k = makeKeyPair()
    const msg = Buffer.from('catalog bytes')
    const sig = sign(msg, k.privateKey)
    const tampered = Buffer.from(msg)
    tampered[0] ^= 0x01
    expect(verify(null, tampered, k.publicKey, sig)).toBe(false)
  })

  test("another key's signature does not verify", () => {
    const a = makeKeyPair()
    const b = makeKeyPair()
    const msg = Buffer.from('x')
    expect(verify(null, msg, b.publicKey, sign(msg, a.privateKey))).toBe(false)
  })

  test('the exported public forms import back and verify', () => {
    const k = makeKeyPair('key-2026')
    expect(k.keyId).toBe('key-2026')
    const msg = Buffer.from('payload')
    const sig = sign(msg, k.privateKey)
    expect(verify(null, msg, createPublicKey(k.publicKeyPem), sig)).toBe(true)
    const raw = Buffer.from(k.publicKeyRawB64, 'base64')
    expect(raw).toHaveLength(32)
    const fromRaw = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: raw.toString('base64url') }, format: 'jwk' })
    expect(verify(null, msg, fromRaw, sig)).toBe(true)
  })

  test('every call makes a new pair and a distinct default key id', () => {
    const a = makeKeyPair()
    const b = makeKeyPair()
    expect(a.publicKeyRawB64).not.toBe(b.publicKeyRawB64)
    expect(a.keyId).not.toBe(b.keyId)
    expect(a.keyId).toMatch(/^test-[0-9a-f]{8}$/)
  })
})
