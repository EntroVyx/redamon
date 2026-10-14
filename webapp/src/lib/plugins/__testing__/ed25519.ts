/**
 * Ephemeral Ed25519 keys for tests (TD-11: catalog signatures are Ed25519,
 * verified with Node's built-in crypto). Never use these for anything real:
 * a fresh pair is generated per call and lives only in memory.
 */
import { generateKeyPairSync, randomBytes, sign as cryptoSign, type KeyObject } from 'crypto'

export interface TestKeyPair {
  keyId: string
  publicKey: KeyObject
  privateKey: KeyObject
  /** SPKI PEM, the shape a keyring entry can carry. */
  publicKeyPem: string
  /** The 32 raw public-key bytes, base64. */
  publicKeyRawB64: string
}

export function makeKeyPair(keyId = `test-${randomBytes(4).toString('hex')}`): TestKeyPair {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const jwk = publicKey.export({ format: 'jwk' }) as { x: string }
  return {
    keyId,
    publicKey,
    privateKey,
    publicKeyPem: publicKey.export({ format: 'pem', type: 'spki' }).toString(),
    publicKeyRawB64: Buffer.from(jwk.x, 'base64url').toString('base64'),
  }
}

/** Ed25519 takes no digest: the algorithm argument must be null. */
export function sign(bytes: Uint8Array, privateKey: KeyObject): Buffer {
  return cryptoSign(null, bytes, privateKey)
}
