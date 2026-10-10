import { createPublicKey, type KeyObject } from 'crypto'
import { now } from './clock'

/**
 * The keys a plugin catalog may be signed with (TD-11). The official keys ship with the
 * platform, so a key is rotated by publishing the next one in a RedAmon release before
 * the plugin repository signs with it. An admin may trust more keys (a custom catalog,
 * an offline install signed with a development key) only through
 * PLUGINS_EXTRA_TRUSTED_KEYS; the Plugins page warns while such a catalog is in use.
 */
export interface TrustedKey {
  keyId: string
  /** The 32 raw bytes of the Ed25519 public key, base64. */
  publicKey: string
  /** ISO 8601; a signature checked at or after this moment is not trusted. */
  notAfter?: string
}

export const OFFICIAL_KEYS: readonly TrustedKey[] = []

const KEY_ID_RE = /^[A-Za-z0-9._-]{1,64}$/
const ENTRY_FIELDS = new Set(['keyId', 'publicKey', 'notAfter'])

function warn(message: string) {
  console.warn(`[plugins] PLUGINS_EXTRA_TRUSTED_KEYS: ${message}`)
}

function rawKey(b64: unknown): Buffer | null {
  if (typeof b64 !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) return null
  const bytes = Buffer.from(b64, 'base64')
  return bytes.length === 32 ? bytes : null
}

function validEntry(e: unknown, index: number): TrustedKey | null {
  if (!e || typeof e !== 'object' || Array.isArray(e)) {
    warn(`entry ${index} is not an object; ignored`)
    return null
  }
  const o = e as Record<string, unknown>
  const unknown = Object.keys(o).filter((k) => !ENTRY_FIELDS.has(k))
  if (unknown.length) {
    warn(`entry ${index} has unknown fields (${unknown.join(', ')}); ignored`)
    return null
  }
  if (typeof o.keyId !== 'string' || !KEY_ID_RE.test(o.keyId)) {
    warn(`entry ${index} has no valid keyId; ignored`)
    return null
  }
  if (!rawKey(o.publicKey)) {
    warn(`key ${o.keyId} is not 32 base64 bytes of an Ed25519 public key; ignored`)
    return null
  }
  if (o.notAfter !== undefined && (typeof o.notAfter !== 'string' || Number.isNaN(Date.parse(o.notAfter)))) {
    warn(`key ${o.keyId} has an invalid notAfter; ignored`)
    return null
  }
  const out: TrustedKey = { keyId: o.keyId, publicKey: o.publicKey as string }
  if (o.notAfter !== undefined) out.notAfter = o.notAfter as string
  return out
}

/** The admin's extra keys; a value that cannot be read adds nothing. */
export function extraKeys(official: readonly TrustedKey[] = OFFICIAL_KEYS): TrustedKey[] {
  const raw = (process.env.PLUGINS_EXTRA_TRUSTED_KEYS ?? '').trim()
  if (!raw) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    warn('is not valid JSON; no extra key is trusted')
    return []
  }
  if (!Array.isArray(parsed)) {
    warn('must be a JSON array of {keyId, publicKey, notAfter?}; no extra key is trusted')
    return []
  }
  const officialIds = new Set(official.map((k) => k.keyId))
  const out: TrustedKey[] = []
  parsed.forEach((e, i) => {
    const k = validEntry(e, i)
    if (!k) return
    if (officialIds.has(k.keyId)) {
      warn(`key ${k.keyId} has the id of an official key; ignored`)
      return
    }
    if (out.some((x) => x.keyId === k.keyId)) {
      warn(`key ${k.keyId} is listed twice; the first is used`)
      return
    }
    out.push(k)
  })
  return out
}

function usable(k: TrustedKey): boolean {
  return k.notAfter === undefined || now().getTime() < Date.parse(k.notAfter)
}

function toKeyObject(k: TrustedKey): KeyObject | null {
  const raw = rawKey(k.publicKey)
  if (!raw) return null
  try {
    return createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: raw.toString('base64url') }, format: 'jwk' })
  } catch {
    return null
  }
}

export function findTrustedKey(
  keyId: string,
  official: readonly TrustedKey[] = OFFICIAL_KEYS,
): { key: KeyObject; official: boolean } | null {
  const o = official.find((k) => k.keyId === keyId)
  if (o) {
    const key = usable(o) ? toKeyObject(o) : null
    return key ? { key, official: true } : null
  }
  const e = extraKeys(official).find((k) => k.keyId === keyId)
  if (!e || !usable(e)) return null
  const key = toKeyObject(e)
  return key ? { key, official: false } : null
}
