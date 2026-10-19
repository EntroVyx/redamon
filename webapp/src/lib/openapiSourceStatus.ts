/**
 * Per-source status of the OpenAPI documents a project configures.
 *
 * Recon writes one string per configured document on the Domain it ran for:
 * "<source id>|<sha256(public url)[:12]>|<code>|<ISO time>". It holds no URL,
 * since a document URL can carry a token. The form shows a status only while
 * the row's current URL hashes to the stored one; an edited URL reads
 * "Not fetched yet" until the next run.
 */
import { resolveProjectRoots, underAnyRoot, type ProjectTargetFields } from './partialReconScope'

export interface OpenApiSourceStatus {
  hash: string
  code: string
  at: string
}

export interface OpenApiSourceRow {
  id?: string
  url?: string
  enabled?: boolean
}

export const NOT_FETCHED = 'Not fetched yet'

export function parseOpenApiSourceStatus(entries: unknown): Map<string, OpenApiSourceStatus> {
  const out = new Map<string, OpenApiSourceStatus>()
  if (!Array.isArray(entries)) return out
  for (const entry of entries) {
    if (typeof entry !== 'string') continue
    const [id, hash, code, at] = entry.split('|')
    if (id && hash && code) out.set(id, { hash, code, at: at ?? '' })
  }
  return out
}

/** What recon hashes: scheme, host, non-default port and path; never the query. */
export function publicDocumentUrl(url: string): string | null {
  try {
    const parsed = new URL(url.trim())
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
    const host = parsed.host.replace(/\.(?=$|:)/, '')
    return `${parsed.protocol}//${host}${parsed.pathname || '/'}`
  } catch {
    return null
  }
}

/** The 12-hex-digit hash recon stores, or null where the browser cannot hash (plain HTTP). */
export async function documentUrlHash(url: string): Promise<string | null> {
  const location = publicDocumentUrl(url)
  if (!location || typeof crypto === 'undefined' || !crypto.subtle) return null
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(location))
  return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 12)
}

export function openApiStatusLabel(code: string): string {
  if (code === 'ok') return 'Imported'
  if (code === 'out_of_scope') return 'Outside scope'
  if (code === 'blocked_address') return 'Internal address blocked'
  if (/^http_\d+$/.test(code)) return `HTTP ${code.slice(5)}`
  if (code === 'invalid_document') return 'Invalid document'
  if (code === 'unsupported_version') return 'Unsupported version'
  if (code === 'host_down') return 'Host down'
  if (code === 'transport_error') return 'Unreachable'
  if (code === 'limit_reached') return 'Limit reached'
  return 'Unknown'
}

/**
 * The label for one row: its status while its URL is the one fetched,
 * NOT_FETCHED otherwise, or null when it cannot be told (status unread, or no
 * hashing in this browser).
 */
export function rowStatusLabel(
  row: OpenApiSourceRow,
  statuses: Map<string, OpenApiSourceStatus> | null,
  rowHash: string | null | undefined,
): string | null {
  if (!statuses || rowHash === null) return null
  const status = row.id ? statuses.get(row.id) : undefined
  if (!status || rowHash === undefined || status.hash !== rowHash) return NOT_FETCHED
  return openApiStatusLabel(status.code)
}

function ipv4ToInt(value: string): number | null {
  const parts = value.split('.')
  if (parts.length !== 4) return null
  let n = 0
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part) || Number(part) > 255) return null
    n = n * 256 + Number(part)
  }
  return n
}

function inIpv4Target(host: string, target: string): boolean | null {
  const [base, bits] = target.trim().split('/')
  const ip = ipv4ToInt(host)
  const net = ipv4ToInt(base)
  if (ip === null || net === null) return null
  const prefix = bits === undefined ? 32 : Number(bits)
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) return null
  const size = 2 ** (32 - prefix)
  return Math.floor(ip / size) === Math.floor(net / size)
}

/**
 * Whether a document URL sits inside the project scope, as far as the form
 * can tell: under a root in domain mode, inside a target IP or CIDR in IP mode.
 * null when it cannot tell (an IPv6 target, an unparseable URL). Advisory only:
 * recon decides, and the save is never blocked on it.
 */
export function documentInProjectScope(
  url: string,
  project: ProjectTargetFields & { targetIps?: unknown },
): boolean | null {
  let host: string
  try {
    host = new URL(url.trim()).hostname.toLowerCase().replace(/\.$/, '')
  } catch {
    return null
  }
  if (!host) return null
  if (project.ipMode) {
    // IP mode scans target IPs only: a name is outside it, an IPv6 literal is not judged here.
    if (host.startsWith('[')) return null
    if (ipv4ToInt(host) === null) return false
    const targets = Array.isArray(project.targetIps) ? project.targetIps.filter(t => typeof t === 'string') : []
    let unknown = false
    for (const target of targets as string[]) {
      const inside = inIpv4Target(host, target)
      if (inside) return true
      if (inside === null) unknown = true
    }
    return unknown ? null : false
  }
  const roots = resolveProjectRoots(project, '').roots
  return roots.length ? underAnyRoot(host, roots) : null
}
