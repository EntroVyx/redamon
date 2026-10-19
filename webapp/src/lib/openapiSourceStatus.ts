/**
 * Per-source status of the OpenAPI documents a project configures.
 *
 * Recon writes one string per configured document on the Domain it ran for:
 * "<source id>|<sha256(public url)[:12]>|<code>|<ISO time>". It holds no URL,
 * since a document URL can carry a token. The form shows a status only while
 * the row's current URL hashes to the stored one; an edited URL reads
 * "Not fetched yet" until the next run.
 */
import { groupHostsByRootDomain } from './domainBatch'
import type { ProjectTargetFields } from './partialReconScope'

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

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []
}

/** recon's _normalize_host: lower case, without scheme, port, IPv6 brackets or trailing dot. */
function normalizeHost(value: string): string {
  let host = value.trim()
  if (host.includes('://')) {
    try {
      host = new URL(host).hostname
    } catch {
      return ''
    }
  }
  if (host.startsWith('[')) host = host.slice(1).split(']')[0]
  else if (host.split(':').length === 2) host = host.split(':')[0]
  return host.trim().replace(/\.+$/, '').toLowerCase()
}

/** recon's _normalize_scope_entry: `*.domain` and CIDRs keep their shape. */
function normalizeScopeEntry(value: string): string {
  const entry = value.trim()
  if (entry.startsWith('*.')) return `*.${normalizeHost(entry.slice(2))}`
  if (entry.includes('/') && !entry.includes('://')) return entry.toLowerCase()
  return normalizeHost(entry)
}

/**
 * The hosts one target root admits, as recon's OpenAPI scope builds them
 * (scope_payload in recon/helpers/openapi/discovery.py): each listed prefix as
 * an exact host, the apex only through the "." prefix, and every subdomain
 * (`*.root`) through "*" or, outside a Domain batch, an empty prefix list.
 */
function rootScopeEntries(rootValue: unknown, prefixValues: unknown, batch: boolean): string[] {
  const root = typeof rootValue === 'string' ? normalizeHost(rootValue) : ''
  if (!root) return []
  const prefixes = strings(prefixValues).map(p => p.trim())
  const listed = prefixes
    .filter(p => p !== '*' && p.replace(/\.+$/, ''))
    .map(p => `${p.replace(/\.+$/, '').toLowerCase()}.${root}`)
  const entries = [...listed]
  if (prefixes.some(p => !p.replace(/\.+$/, ''))) entries.push(root)
  if (prefixes.includes('*') || (!listed.length && !batch)) entries.push(`*.${root}`)
  return entries
}

/** recon's host_in_scope: an exact host, `*.suffix` (subdomains, not the apex), or a CIDR. */
function hostInScope(host: string, entries: readonly string[]): boolean {
  return entries.some(entry => {
    if (entry.startsWith('*.')) return host.endsWith(entry.slice(1))
    if (entry.includes('/')) return inIpv4Target(host, entry) === true
    return host === entry
  })
}

/**
 * recon's _is_roe_excluded: an exact host or IP; a domain, with its subdomains;
 * `*.domain`, its subdomains only; or a CIDR.
 */
function roeExcluded(host: string, excluded: unknown): boolean {
  const isIp = ipv4ToInt(host) !== null
  return strings(excluded).some(value => {
    const entry = normalizeScopeEntry(value)
    if (!entry) return false
    if (entry.startsWith('*.')) return host.endsWith(entry.slice(1))
    if (entry.includes('/') || isIp) return isIp && inIpv4Target(host, entry) === true
    return host === entry || host.endsWith(`.${entry}`)
  })
}

/**
 * The Domain batch groups the next scan runs: grouped from the hostnames being
 * edited, as the project routes group them on save, else the stored groups.
 */
function batchGroups(project: DocumentScopeFields): unknown[] {
  const hosts = strings(project.domainBatchHosts).filter(h => h.trim())
  if (hosts.length) return groupHostsByRootDomain(hosts).groups
  return Array.isArray(project.domainBatchGroups) ? project.domainBatchGroups : []
}

export type DocumentScopeFields = ProjectTargetFields & {
  targetIps?: unknown
  subdomainList?: unknown
  domainBatchHosts?: unknown
  roeExcludedHosts?: unknown
}

/**
 * Whether recon will fetch a document URL, as far as the form can tell. It
 * mirrors recon's OpenAPI scope: the target IPs and CIDRs in IP mode; the
 * target's subdomains, or only the listed ones, in domain mode; the hosts a
 * group lists, or its whole domain with "*", in a Domain batch; minus the Rules
 * of Engagement exclusions. null when it cannot tell: an unparseable URL, no
 * target yet, an IPv6 address. Advisory only: recon decides, and the save is
 * never blocked on it.
 */
export function documentInProjectScope(url: string, project: DocumentScopeFields): boolean | null {
  let host: string
  try {
    host = normalizeHost(new URL(url.trim()).hostname)
  } catch {
    return null
  }
  if (!host || host.includes(':')) return null
  if (project.ipMode) {
    if (ipv4ToInt(host) === null) return false
    const verdicts = strings(project.targetIps).map(target => inIpv4Target(host, target))
    if (!verdicts.includes(true)) return verdicts.includes(null) ? null : false
  } else {
    const entries = project.domainBatchMode
      ? batchGroups(project).flatMap(group => (group && typeof group === 'object'
        ? rootScopeEntries((group as Record<string, unknown>).rootDomain, (group as Record<string, unknown>).prefixes, true)
        : []))
      : rootScopeEntries(project.targetDomain, strings(project.subdomainList).filter(s => s.trim()), false)
    if (!entries.length) return null
    if (!hostInScope(host, entries)) return false
  }
  return !roeExcluded(host, project.roeExcludedHosts)
}
