import { lookup } from 'node:dns/promises'
import net from 'node:net'

/**
 * SSRF guard for user-supplied custom LLM `baseUrl` values (server-side only).
 *
 * Mirrors the agent's Python guard (agentic/orchestrator_helpers/llm_url_guard.py)
 * so the webapp preset generator (which fetches `${baseUrl}/chat/completions`
 * with the user's provider record) cannot be turned into an SSRF probe and
 * cannot disable TLS verification toward a public host.
 *
 * Preserves the self-hosted-model feature: localhost / LAN / Docker-service /
 * unresolvable hosts are allowed. Addresses STRIDE I15 + I16.
 */

const BLOCKED_IPS = new Set([
  '169.254.169.254', // AWS/GCP/Azure IMDS
  '169.254.170.2', // AWS ECS task metadata
  '100.100.100.200', // Alibaba Cloud metadata
  'fd00:ec2::254', // AWS IPv6 IMDS
])

const BLOCKED_HOSTNAMES = new Set(['metadata.google.internal', 'metadata.goog'])

export class BaseUrlValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BaseUrlValidationError'
  }
}

/** Unwrap an IPv4-mapped IPv6 address (::ffff:169.254.169.254) to its IPv4
 * form so it is judged on the v4 value rather than slipping through. */
function unmapV4(ip: string): string {
  const m = ip.toLowerCase().match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)
  return m ? m[1] : ip
}

function isLinkLocal(ip: string): boolean {
  if (net.isIPv4(ip)) return ip.startsWith('169.254.')
  const l = ip.toLowerCase()
  // fe80::/10 -> fe80..febf
  return /^fe[89ab]/.test(l)
}

function isBlockedIp(ip: string): boolean {
  const u = unmapV4(ip)
  return BLOCKED_IPS.has(u.toLowerCase()) || isLinkLocal(u)
}

/** True only for globally-routable (public) addresses. Conservative: anything
 * private/loopback/reserved/unique-local returns false. The plugin manager's
 * download guard (plugins/fetchRemote.ts) builds its stricter rule on it. */
export function isPublicIp(ipRaw: string): boolean {
  const ip = unmapV4(ipRaw)
  if (net.isIPv4(ip)) {
    const o = ip.split('.').map(Number)
    if (o[0] === 0 || o[0] === 10 || o[0] === 127) return false
    if (o[0] === 172 && o[1] >= 16 && o[1] <= 31) return false
    if (o[0] === 192 && o[1] === 168) return false
    if (o[0] === 169 && o[1] === 254) return false
    if (o[0] === 100 && o[1] >= 64 && o[1] <= 127) return false // CGNAT 100.64/10
    return true
  }
  const l = ip.toLowerCase()
  if (l === '::1' || l === '::') return false
  if (/^fe[89ab]/.test(l)) return false // link-local
  if (/^f[cd]/.test(l)) return false // unique-local fc00::/7
  return true
}

async function resolveIps(host: string): Promise<string[]> {
  // Literal IP: return as-is without a DNS round-trip.
  if (net.isIP(host)) return [host]
  try {
    const records = await lookup(host, { all: true })
    return records.map((r) => r.address)
  } catch {
    return [] // unresolvable cannot be an SSRF into metadata -> allowed
  }
}

/**
 * Validate a custom LLM baseUrl; throws BaseUrlValidationError if unsafe.
 * No-ops on empty input.
 */
export async function assertSafeLlmBaseUrl(
  baseUrl: string | null | undefined,
  opts: { sslVerify?: boolean } = {},
): Promise<void> {
  if (!baseUrl || !baseUrl.trim()) return

  let parsed: URL
  try {
    parsed = new URL(baseUrl.trim())
  } catch {
    throw new BaseUrlValidationError('Custom LLM baseUrl is not a valid URL.')
  }

  const scheme = parsed.protocol.replace(/:$/, '').toLowerCase()
  if (scheme !== 'http' && scheme !== 'https') {
    throw new BaseUrlValidationError(
      `Custom LLM baseUrl must use http or https (got '${scheme || 'no scheme'}').`,
    )
  }

  // URL wraps IPv6 hosts in brackets; strip them for classification.
  const host = parsed.hostname.replace(/^\[|\]$/g, '')
  if (!host) throw new BaseUrlValidationError('Custom LLM baseUrl has no host.')

  if (BLOCKED_HOSTNAMES.has(host.toLowerCase().replace(/\.$/, ''))) {
    throw new BaseUrlValidationError(
      'Custom LLM baseUrl points at a cloud metadata host, which is not allowed.',
    )
  }

  const ips = await resolveIps(host)
  for (const ip of ips) {
    if (isBlockedIp(ip)) {
      throw new BaseUrlValidationError(
        `Custom LLM baseUrl resolves to a blocked address (${ip}); ` +
          'cloud metadata and link-local endpoints are not allowed.',
      )
    }
  }

  if (opts.sslVerify === false && ips.some(isPublicIp)) {
    throw new BaseUrlValidationError(
      'TLS verification cannot be disabled (sslVerify=false) for a public LLM ' +
        'endpoint; it is only permitted for private/internal hosts.',
    )
  }
}
