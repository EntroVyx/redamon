import dns from 'node:dns'
import https from 'node:https'
import net from 'node:net'
import type { ClientRequest, IncomingMessage, RequestOptions } from 'node:http'
import { isPublicIp } from '@/lib/llm-url-guard'

/**
 * The plugin platform's only outbound fetch: the signed catalog and plugin archives
 * (README.PLUGINS.md §6.2, §10). A catalog entry decides the archive URL, so every rule
 * here is what stops it from pointing the webapp at an internal address:
 *
 * - `https:` only, on the default port, with no credentials in the URL;
 * - the host is in PLUGINS_DOWNLOAD_HOSTS on EVERY hop; redirects (at most five) are
 *   followed by hand, never by the client;
 * - the address is checked by the socket's own `lookup` hook, so the address checked is
 *   the address connected to: there is no resolve-then-connect window for DNS rebinding.
 *   A literal IP never goes through `lookup`, so it is checked before connecting;
 * - one deadline over all hops, and a size cap counted while streaming (a declared
 *   length over the cap is refused before reading).
 *
 * `assertSafeLlmBaseUrl` is not used: it allows loopback and private addresses on purpose,
 * for self-hosted models (RV-12).
 */

export const DEFAULT_DOWNLOAD_HOSTS = [
  'github.com',
  'objects.githubusercontent.com',
  'release-assets.githubusercontent.com',
  'raw.githubusercontent.com',
]
export const MAX_REDIRECTS = 5
const DEFAULT_ARCHIVE_MAX_BYTES = 20_971_520
const HOST_RE = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/
const USER_AGENT = 'RedAmon-plugin-manager/1'

export const FETCH_DEFAULTS = {
  catalog: { maxBytes: 1_048_576, timeoutMs: 15_000 },
  archive: () => ({ maxBytes: archiveMaxBytes(), timeoutMs: 60_000 }),
}

export function archiveMaxBytes(): number {
  const raw = (process.env.PLUGIN_ARCHIVE_MAX_BYTES ?? '').trim()
  const n = /^[0-9]+$/.test(raw) ? Number(raw) : NaN
  return Number.isSafeInteger(n) && n > 0 ? n : DEFAULT_ARCHIVE_MAX_BYTES
}

export type FetchRefusal =
  | 'bad_url'
  | 'not_https'
  | 'host_not_allowed'
  | 'address_not_public'
  | 'too_many_redirects'
  | 'bad_redirect'
  | 'http_error'
  | 'too_large'
  | 'timeout'
  | 'network_error'

export class FetchRemoteError extends Error {
  constructor(
    readonly code: FetchRefusal,
    message: string,
    /** The URL of the hop that failed, without its query (signed asset URLs carry tokens). */
    readonly url: string,
    readonly status?: number,
  ) {
    super(message)
    this.name = 'FetchRemoteError'
  }
}

/**
 * Host names only: an entry with a scheme, port, path or wildcard is dropped, so a typo
 * can narrow the list but never widen it. Nothing usable left keeps the default.
 */
export function downloadHosts(): string[] {
  const raw = process.env.PLUGINS_DOWNLOAD_HOSTS ?? ''
  const hosts = [...new Set(raw.split(',').map((h) => h.trim().toLowerCase()).filter((h) => HOST_RE.test(h) || net.isIP(h)))]
  return hosts.length ? hosts : [...DEFAULT_DOWNLOAD_HOSTS]
}

// Addresses `isPublicIp` lets through that are not a public server either (IANA
// special-purpose registries). Node's BlockList applies the IPv4 rules to IPv4-mapped
// IPv6 addresses in any spelling, which a dotted-only unmapping would miss, so the
// private ranges are repeated here. Documentation ranges (RFC 5737, RFC 3849) are left
// out: they are not internal, and the tests use them as public answers.
const NOT_PUBLIC = new net.BlockList()
for (const [addr, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
  ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) NOT_PUBLIC.addSubnet(addr, prefix, 'ipv4')
for (const [addr, prefix] of [
  ['::', 96], ['64:ff9b::', 96], ['64:ff9b:1::', 48], ['100::', 64], ['2001::', 32], ['2001:10::', 28],
  ['2001:20::', 28], ['2002::', 16], ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8],
] as const) NOT_PUBLIC.addSubnet(addr, prefix, 'ipv6')

export function isAllowedAddress(ip: string): boolean {
  const family = net.isIP(ip)
  if (family === 0) return false
  return isPublicIp(ip) && !NOT_PUBLIC.check(ip, family === 6 ? 'ipv6' : 'ipv4')
}

export interface ResolvedAddress {
  address: string
  family: number
}
export type Resolver = (hostname: string) => Promise<ResolvedAddress[]>

const systemResolver: Resolver = async (hostname) => {
  const out = await dns.promises.lookup(hostname, { all: true, verbatim: true })
  return out.map((a) => ({ address: a.address, family: a.family }))
}

type LookupCallback = (err: NodeJS.ErrnoException | null, address?: unknown, family?: number) => void

/**
 * The `lookup` hook given to the socket. Every answer must be public, or the connection
 * is refused: a name with one private answer is not trusted with the others either.
 */
export function safeLookup(resolve: Resolver) {
  return (hostname: string, options: unknown, callback?: LookupCallback): void => {
    const cb = (typeof options === 'function' ? options : callback) as LookupCallback
    const all = !!(options && typeof options === 'object' && (options as { all?: boolean }).all)
    resolve(hostname).then(
      (addrs) => {
        if (!addrs.length) {
          cb(Object.assign(new Error(`${hostname} has no address`), { code: 'ENOTFOUND' }))
          return
        }
        const bad = addrs.find((a) => !isAllowedAddress(a.address))
        if (bad) {
          cb(Object.assign(new Error(`${hostname} resolves to a non-public address`), {
            code: 'ERR_PLUGIN_ADDRESS_NOT_PUBLIC',
          }))
          return
        }
        if (all) cb(null, addrs.map((a) => ({ address: a.address, family: a.family })))
        else cb(null, addrs[0].address, addrs[0].family)
      },
      (e: NodeJS.ErrnoException) => cb(e),
    )
  }
}

export type Transport = (options: RequestOptions, callback: (res: IncomingMessage) => void) => ClientRequest

/** Injected by tests only: the fake servers speak plain HTTP on 127.0.0.1. */
export interface FetchDeps {
  request?: Transport
  resolve?: Resolver
}

export interface FetchOptions {
  kind: 'catalog' | 'archive'
  maxBytes?: number
  timeoutMs?: number
}

export interface FetchResult {
  bytes: Buffer
  finalUrl: string
}

function display(u: URL): string {
  return `${u.protocol}//${u.host}${u.pathname}`
}

function checkHop(raw: string, base: URL | null, hosts: string[]): URL {
  let u: URL
  try {
    u = base ? new URL(raw, base) : new URL(raw)
  } catch {
    throw new FetchRemoteError('bad_url', 'The plugin download URL is not a valid URL.', base ? display(base) : '')
  }
  if (u.protocol !== 'https:') {
    throw new FetchRemoteError('not_https', `Plugin downloads must use https (got ${u.protocol}).`, display(u))
  }
  if (u.username || u.password || (u.port && u.port !== '443')) {
    throw new FetchRemoteError('bad_url', 'A plugin download URL may not carry credentials or a port.', display(u))
  }
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (!hosts.includes(host)) {
    throw new FetchRemoteError(
      'host_not_allowed',
      `${host} is not an allowed plugin download host (PLUGINS_DOWNLOAD_HOSTS).`,
      display(u),
    )
  }
  if (net.isIP(host) && !isAllowedAddress(host)) {
    throw new FetchRemoteError('address_not_public', `${host} is not a public address.`, display(u))
  }
  return u
}

interface HopAnswer {
  status: number
  location: string | null
  bytes: Buffer
}

function oneHop(
  u: URL,
  transport: Transport,
  lookup: ReturnType<typeof safeLookup>,
  maxBytes: number,
  deadline: number,
): Promise<HopAnswer> {
  return new Promise((resolve, reject) => {
    const fail = (code: FetchRefusal, message: string, status?: number) =>
      reject(new FetchRemoteError(code, message, display(u), status))
    const left = deadline - Date.now()
    if (left <= 0) return fail('timeout', 'The plugin download did not finish in time.')

    let req: ClientRequest
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      req?.destroy()
      fail('timeout', 'The plugin download did not finish in time.')
    }, left)
    const done = (fn: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      fn()
    }

    try {
      req = transport(
        {
          protocol: 'https:',
          hostname: u.hostname.replace(/^\[|\]$/g, ''),
          port: 443,
          path: `${u.pathname}${u.search}`,
          method: 'GET',
          headers: { 'User-Agent': USER_AGENT, Accept: '*/*', 'Accept-Encoding': 'identity' },
          // A fresh agent: a pooled socket could have been opened without this lookup.
          agent: false,
          lookup: lookup as RequestOptions['lookup'],
        },
        (res) => {
          const status = res.statusCode ?? 0
          if (status >= 300 && status < 400) {
            const location = res.headers.location ?? null
            res.resume()
            done(() => resolve({ status, location, bytes: Buffer.alloc(0) }))
            return
          }
          if (status < 200 || status >= 300) {
            res.resume()
            done(() => fail('http_error', `The plugin download answered HTTP ${status}.`, status))
            return
          }
          const declared = Number(res.headers['content-length'])
          if (Number.isFinite(declared) && declared > maxBytes) {
            res.destroy()
            done(() => fail('too_large', `The plugin download is larger than ${maxBytes} bytes.`))
            return
          }
          const chunks: Buffer[] = []
          let size = 0
          res.on('data', (c: Buffer) => {
            size += c.length
            if (size > maxBytes) {
              res.destroy()
              done(() => fail('too_large', `The plugin download is larger than ${maxBytes} bytes.`))
              return
            }
            chunks.push(c)
          })
          res.on('end', () => done(() => resolve({ status, location: null, bytes: Buffer.concat(chunks) })))
          res.on('error', () => done(() => fail('network_error', 'The plugin download was interrupted.')))
        },
      )
    } catch (e) {
      done(() => fail('network_error', `The plugin download could not start: ${(e as Error).message}`))
      return
    }
    req.on('error', (e: NodeJS.ErrnoException) => {
      if (e?.code === 'ERR_PLUGIN_ADDRESS_NOT_PUBLIC') {
        done(() => fail('address_not_public', `${u.hostname} resolves to a non-public address.`))
      } else {
        done(() => fail('network_error', `The plugin download host could not be reached (${e?.code ?? 'error'}).`))
      }
    })
    req.end()
  })
}

export async function fetchRemote(url: string, opts: FetchOptions, deps: FetchDeps = {}): Promise<FetchResult> {
  const defaults = opts.kind === 'catalog' ? FETCH_DEFAULTS.catalog : FETCH_DEFAULTS.archive()
  const maxBytes = opts.maxBytes ?? defaults.maxBytes
  const deadline = Date.now() + (opts.timeoutMs ?? defaults.timeoutMs)
  const transport = deps.request ?? (https.request as Transport)
  const lookup = safeLookup(deps.resolve ?? systemResolver)
  const hosts = downloadHosts()

  let current = checkHop(url, null, hosts)
  for (let redirects = 0; ; redirects++) {
    const answer = await oneHop(current, transport, lookup, maxBytes, deadline)
    if (answer.location === null && answer.status >= 200 && answer.status < 300) {
      return { bytes: answer.bytes, finalUrl: current.href }
    }
    if (!answer.location) {
      throw new FetchRemoteError('bad_redirect', `HTTP ${answer.status} without a Location.`, display(current), answer.status)
    }
    if (redirects >= MAX_REDIRECTS) {
      throw new FetchRemoteError('too_many_redirects', `More than ${MAX_REDIRECTS} redirects.`, display(current))
    }
    current = checkHop(answer.location, current, hosts)
  }
}
