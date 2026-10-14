/**
 * The platform's only outbound fetch (README.PLUGINS.md §6.2, TD-11): https only, an
 * allowlisted host on EVERY hop, an address check made by the socket's own `lookup`
 * (the address checked is the address connected to), size caps counted while
 * streaming, and an overall deadline.
 *
 * The fake servers speak plain HTTP on 127.0.0.1 (rule T6), so the tests inject a
 * transport that runs the module's `lookup` hook exactly as a socket would and, only
 * when the hook accepts, connects to the fake server instead of the resolved address.
 * The resolver answers documentation addresses (RFC 5737), which count as public.
 *
 * @vitest-environment node
 */
import { describe, test, expect, afterEach, vi } from 'vitest'
import http, { type ClientRequest, type IncomingMessage, type RequestOptions } from 'http'
import type { AddressInfo } from 'net'
import { closeAllFakeServers, startFakeServer, type FakeServer } from './__testing__/fakeHttpServer'
import {
  DEFAULT_DOWNLOAD_HOSTS,
  FetchRemoteError,
  downloadHosts,
  fetchRemote,
  isAllowedAddress,
  safeLookup,
  type FetchDeps,
  type Resolver,
} from './fetchRemote'

const PUBLIC_A = '203.0.113.10'
const PUBLIC_B = '198.51.100.7'

afterEach(async () => {
  await closeAllFakeServers()
  delete process.env.PLUGINS_DOWNLOAD_HOSTS
  vi.restoreAllMocks()
})

interface Seen {
  host: string | undefined
  address: string
}

/** A transport that behaves like a socket: it asks the module's lookup, then "connects". */
function viaFake(server: { port: number }, seen: Seen[] = []) {
  return (opts: RequestOptions, cb: (res: IncomingMessage) => void): ClientRequest => {
    const moduleLookup = opts.lookup
    if (typeof moduleLookup !== 'function') throw new Error('the module did not pass its lookup hook')
    return http.request(
      {
        ...opts,
        protocol: 'http:',
        port: server.port,
        lookup: ((hostname: string, o: { all?: boolean }, done: (...a: unknown[]) => void) => {
          moduleLookup(hostname, { ...o, all: true }, ((err: Error | null, addrs: { address: string }[]) => {
            if (err) return done(err)
            seen.push({ host: opts.hostname ?? undefined, address: addrs[0].address })
            if (o?.all) done(null, [{ address: '127.0.0.1', family: 4 }])
            else done(null, '127.0.0.1', 4)
          }) as never)
        }) as never,
      },
      cb,
    )
  }
}

function resolverOf(map: Record<string, string[] | string[][]>): Resolver & { calls: string[] } {
  const calls: string[] = []
  const counters: Record<string, number> = {}
  const fn = (async (hostname: string) => {
    calls.push(hostname)
    const entry = map[hostname]
    if (!entry) throw Object.assign(new Error(`ENOTFOUND ${hostname}`), { code: 'ENOTFOUND' })
    // A list of lists answers one list per call (DNS rebinding cases).
    const i = counters[hostname] ?? 0
    counters[hostname] = i + 1
    const answer = Array.isArray(entry[0]) ? (entry as string[][])[Math.min(i, entry.length - 1)] : (entry as string[])
    return answer.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }))
  }) as Resolver & { calls: string[] }
  fn.calls = calls
  return fn
}

async function setup(routes: Parameters<typeof startFakeServer>[0], dns: Record<string, string[] | string[][]> = {}) {
  const server = await startFakeServer(routes)
  const seen: Seen[] = []
  const resolve = resolverOf({ 'github.com': [PUBLIC_A], 'release-assets.githubusercontent.com': [PUBLIC_B], ...dns })
  const deps: FetchDeps = { request: viaFake(server, seen), resolve }
  return { server, seen, resolve, deps }
}

async function refusal(p: Promise<unknown>): Promise<FetchRemoteError> {
  const e = await p.then(
    () => {
      throw new Error('expected a refusal')
    },
    (err) => err,
  )
  expect(e).toBeInstanceOf(FetchRemoteError)
  return e as FetchRemoteError
}

describe('allowed hosts', () => {
  test('the default is the hosts E4 observed for a GitHub release download, plus raw', () => {
    expect(DEFAULT_DOWNLOAD_HOSTS).toEqual([
      'github.com',
      'objects.githubusercontent.com',
      'release-assets.githubusercontent.com',
      'raw.githubusercontent.com',
    ])
    expect(downloadHosts()).toEqual(DEFAULT_DOWNLOAD_HOSTS)
  })

  test('PLUGINS_DOWNLOAD_HOSTS replaces the default, lower-cased, trimmed and deduplicated', () => {
    process.env.PLUGINS_DOWNLOAD_HOSTS = ' Example.COM, cdn.example.org ,example.com,'
    expect(downloadHosts()).toEqual(['example.com', 'cdn.example.org'])
  })

  test.each(['', '   ', ',,', 'not a host, ***'])('an empty or unusable value (%j) keeps the default', (v) => {
    process.env.PLUGINS_DOWNLOAD_HOSTS = v
    expect(downloadHosts()).toEqual(DEFAULT_DOWNLOAD_HOSTS)
  })

  test('an entry with a scheme, port, path or wildcard is dropped, never widened', () => {
    process.env.PLUGINS_DOWNLOAD_HOSTS = 'https://evil.example,github.com:443,a.example/x,*.example.com,ok.example'
    expect(downloadHosts()).toEqual(['ok.example'])
  })
})

describe('the address rule', () => {
  test.each([
    '127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0',
    '224.0.0.1', '239.255.255.250', '240.0.0.1', '255.255.255.255', '192.0.0.8', '198.18.0.1',
    '::1', '::', 'fe80::1', 'fc00::1', 'fd12:3456::1', 'ff02::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1',
    // The hex spelling of a mapped loopback, which a dotted-only unmapping misses.
    '::ffff:7f00:1', 'not-an-ip',
    '64:ff9b::a00:1', '2002:a00:1::1', '2001:0:a00:1::1', '::a00:1', '100::1',
  ])('%s is refused', (ip) => {
    expect(isAllowedAddress(ip)).toBe(false)
  })

  test.each([PUBLIC_A, PUBLIC_B, '140.82.112.3', '2606:50c0:8000::153', '2001:db8::1'])('%s is allowed', (ip) => {
    expect(isAllowedAddress(ip)).toBe(true)
  })

  test('the lookup hook refuses a name with ANY non-public answer, in both callback shapes', async () => {
    const lookup = safeLookup(resolverOf({ 'mixed.example': [PUBLIC_A, '10.0.0.5'], 'ok.example': [PUBLIC_A] }))
    const one = (host: string, all: boolean) =>
      new Promise<{ err: NodeJS.ErrnoException | null; out: unknown[] }>((resolve) =>
        lookup(host, { all }, ((err: NodeJS.ErrnoException | null, ...out: unknown[]) => resolve({ err, out })) as never),
      )
    const mixed = await one('mixed.example', true)
    expect(mixed.err?.code).toBe('ERR_PLUGIN_ADDRESS_NOT_PUBLIC')
    expect((await one('ok.example', true)).out).toEqual([[{ address: PUBLIC_A, family: 4 }]])
    expect((await one('ok.example', false)).out).toEqual([PUBLIC_A, 4])
  })
})

describe('fetching', () => {
  test('a good fetch returns the exact bytes, through the module lookup', async () => {
    const body = Buffer.from([0, 1, 2, 250, 251, 252])
    const { deps, seen, server } = await setup({ 'GET /a/catalog.json': { body } })
    const out = await fetchRemote('https://github.com/a/catalog.json', { kind: 'catalog' }, deps)
    expect(out.bytes.equals(body)).toBe(true)
    expect(out.finalUrl).toBe('https://github.com/a/catalog.json')
    expect(seen).toEqual([{ host: 'github.com', address: PUBLIC_A }])
    expect(server.calls[0].headers['user-agent']).toMatch(/^RedAmon-plugin-manager/)
    // No cookie, no credential of any kind leaves the webapp.
    expect(server.calls[0].headers.cookie).toBeUndefined()
    expect(server.calls[0].headers.authorization).toBeUndefined()
  })

  test('production passes its lookup to https.request with a fresh agent, never the shared pool', async () => {
    let captured: RequestOptions | null = null
    const spy = ((opts: RequestOptions) => {
      captured = opts
      throw new Error('stop here')
    }) as unknown as FetchDeps['request']
    await refusal(fetchRemote('https://github.com/x', { kind: 'catalog' }, { request: spy, resolve: resolverOf({}) }))
    expect(captured).not.toBeNull()
    expect(typeof captured!.lookup).toBe('function')
    expect(captured!.agent).toBe(false)
    expect(captured!.hostname).toBe('github.com')
  })

  test.each([
    ['http://github.com/catalog.json', 'not_https'],
    ['ftp://github.com/catalog.json', 'not_https'],
    ['https://evil.example/catalog.json', 'host_not_allowed'],
    ['https://user:pw@github.com/catalog.json', 'bad_url'],
    ['https://github.com:8443/catalog.json', 'bad_url'],
    ['not a url', 'bad_url'],
  ])('%s is refused before any request (%s)', async (url, code) => {
    const { deps, server } = await setup({})
    const e = await refusal(fetchRemote(url, { kind: 'catalog' }, deps))
    expect(e.code).toBe(code)
    expect(server.calls).toHaveLength(0)
  })

  test('a redirect chain inside the allowlist is followed, each hop checked', async () => {
    const { deps, seen } = await setup({
      'GET /rel/x.tar.gz': { redirect: 'https://release-assets.githubusercontent.com/blob/1?sig=abc' },
      'GET /blob/1': { body: 'archive-bytes' },
    })
    const out = await fetchRemote('https://github.com/rel/x.tar.gz', { kind: 'archive' }, deps)
    expect(out.bytes.toString()).toBe('archive-bytes')
    expect(out.finalUrl).toBe('https://release-assets.githubusercontent.com/blob/1?sig=abc')
    expect(seen.map((s) => s.host)).toEqual(['github.com', 'release-assets.githubusercontent.com'])
  })

  test('a relative redirect resolves against the current hop', async () => {
    const { deps } = await setup({ 'GET /a': { redirect: '/b' }, 'GET /b': { body: 'ok' } })
    expect((await fetchRemote('https://github.com/a', { kind: 'catalog' }, deps)).bytes.toString()).toBe('ok')
  })

  test.each([
    ['https://evil.example/x', 'host_not_allowed'],
    ['http://release-assets.githubusercontent.com/x', 'not_https'],
    ['https://127.0.0.1/x', 'host_not_allowed'],
  ])('a redirect to %s is refused (%s) and never requested', async (location, code) => {
    const { deps, server } = await setup({ 'GET /a': { redirect: location } })
    const e = await refusal(fetchRemote('https://github.com/a', { kind: 'archive' }, deps))
    expect(e.code).toBe(code)
    expect(server.calls).toHaveLength(1)
  })

  test('an allowlisted IP literal is still refused when it is not public (no lookup runs for a literal)', async () => {
    process.env.PLUGINS_DOWNLOAD_HOSTS = 'github.com,127.0.0.1'
    const { deps, server } = await setup({ 'GET /a': { redirect: 'https://127.0.0.1/x' } })
    const e = await refusal(fetchRemote('https://github.com/a', { kind: 'archive' }, deps))
    expect(e.code).toBe('address_not_public')
    expect(server.calls).toHaveLength(1)
  })

  test('an allowlisted host that resolves to a private address is refused at connection time', async () => {
    const { deps, server } = await setup({ 'GET /a': { body: 'x' } }, { 'github.com': ['10.0.0.8'] })
    const e = await refusal(fetchRemote('https://github.com/a', { kind: 'catalog' }, deps))
    expect(e.code).toBe('address_not_public')
    expect(server.calls).toHaveLength(0)
  })

  test('DNS rebinding: a public answer then a private one; each connection checks its own answer', async () => {
    const { deps, server, resolve } = await setup({ 'GET /a': { body: 'x' } }, { 'github.com': [[PUBLIC_A], ['127.0.0.1']] })
    await fetchRemote('https://github.com/a', { kind: 'catalog' }, deps)
    const e = await refusal(fetchRemote('https://github.com/a', { kind: 'catalog' }, deps))
    expect(e.code).toBe('address_not_public')
    expect(server.calls).toHaveLength(1)
    // One resolution per connection: nothing resolves first and connects later.
    expect(resolve.calls).toEqual(['github.com', 'github.com'])
  })

  test('a redirect hop to a host resolving privately is refused', async () => {
    const { deps, server } = await setup(
      { 'GET /a': { redirect: 'https://release-assets.githubusercontent.com/b' }, 'GET /b': { body: 'x' } },
      { 'release-assets.githubusercontent.com': ['192.168.0.4'] },
    )
    const e = await refusal(fetchRemote('https://github.com/a', { kind: 'archive' }, deps))
    expect(e.code).toBe('address_not_public')
    expect(server.calls.map((c) => c.path)).toEqual(['/a'])
  })

  test('more than five redirects is refused', async () => {
    const routes: Record<string, { redirect: string }> = {}
    for (let i = 0; i < 6; i++) routes[`GET /r${i}`] = { redirect: `/r${i + 1}` }
    const { deps, server } = await setup({ ...routes, 'GET /r6': { redirect: '/done' } })
    const e = await refusal(fetchRemote('https://github.com/r0', { kind: 'catalog' }, deps))
    expect(e.code).toBe('too_many_redirects')
    expect(server.calls).toHaveLength(6)
  })

  test('five redirects are followed', async () => {
    const routes: Record<string, { redirect: string } | { body: string }> = {}
    for (let i = 0; i < 5; i++) routes[`GET /r${i}`] = { redirect: `/r${i + 1}` }
    const { deps } = await setup({ ...routes, 'GET /r5': { body: 'end' } })
    expect((await fetchRemote('https://github.com/r0', { kind: 'catalog' }, deps)).bytes.toString()).toBe('end')
  })

  test('a redirect without a Location, and an error status, are refused with the status', async () => {
    const { deps } = await setup({ 'GET /a': { status: 302 }, 'GET /b': { status: 404, body: 'gone' } })
    expect((await refusal(fetchRemote('https://github.com/a', { kind: 'catalog' }, deps))).code).toBe('bad_redirect')
    const e = await refusal(fetchRemote('https://github.com/b', { kind: 'catalog' }, deps))
    expect(e.code).toBe('http_error')
    expect(e.status).toBe(404)
  })

  test('a declared length over the cap is refused before reading', async () => {
    const { deps } = await setup({ 'GET /big': { body: Buffer.alloc(2048) } })
    const e = await refusal(fetchRemote('https://github.com/big', { kind: 'catalog', maxBytes: 1024 }, deps))
    expect(e.code).toBe('too_large')
  })

  test('a body with no declared length is counted while streaming and cut at the cap', async () => {
    const raw = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/octet-stream' })
      let sent = 0
      const tick = () => {
        if (sent >= 64 * 1024 || res.destroyed) return res.end()
        res.write(Buffer.alloc(4096))
        sent += 4096
        setImmediate(tick)
      }
      tick()
    })
    await new Promise<void>((r) => raw.listen(0, '127.0.0.1', () => r()))
    try {
      const server = { port: (raw.address() as AddressInfo).port }
      const deps: FetchDeps = { request: viaFake(server), resolve: resolverOf({ 'github.com': [PUBLIC_A] }) }
      const e = await refusal(fetchRemote('https://github.com/s', { kind: 'archive', maxBytes: 10_000 }, deps))
      expect(e.code).toBe('too_large')
    } finally {
      raw.closeAllConnections()
      await new Promise<void>((r) => raw.close(() => r()))
    }
  })

  test('the default caps: catalog 1 MB and 15 s, archive PLUGIN_ARCHIVE_MAX_BYTES and 60 s', async () => {
    const { FETCH_DEFAULTS } = await import('./fetchRemote')
    expect(FETCH_DEFAULTS.catalog).toEqual({ maxBytes: 1_048_576, timeoutMs: 15_000 })
    expect(FETCH_DEFAULTS.archive().timeoutMs).toBe(60_000)
    expect(FETCH_DEFAULTS.archive().maxBytes).toBe(20_971_520)
    process.env.PLUGIN_ARCHIVE_MAX_BYTES = '1000'
    try {
      expect(FETCH_DEFAULTS.archive().maxBytes).toBe(1000)
    } finally {
      delete process.env.PLUGIN_ARCHIVE_MAX_BYTES
    }
  })

  test('a server slower than the deadline is a timeout, across all hops', async () => {
    const { deps } = await setup({ 'GET /a': { redirect: '/b', delayMs: 150 }, 'GET /b': { body: 'x', delayMs: 150 } })
    const started = Date.now()
    const e = await refusal(fetchRemote('https://github.com/a', { kind: 'catalog', timeoutMs: 200 }, deps))
    expect(e.code).toBe('timeout')
    expect(Date.now() - started).toBeLessThan(2_000)
  })

  test('an unresolvable host is a network error, with no request made', async () => {
    const server: FakeServer = await startFakeServer({})
    const deps: FetchDeps = { request: viaFake(server), resolve: resolverOf({}) }
    const e = await refusal(fetchRemote('https://github.com/a', { kind: 'catalog' }, deps))
    expect(e.code).toBe('network_error')
    expect(server.calls).toHaveLength(0)
  })

  test('the refusal names the URL without its query (signed asset URLs carry tokens)', async () => {
    const { deps } = await setup({ 'GET /a': { redirect: 'https://evil.example/blob?sig=SECRETSIG&jwt=SECRETJWT' } })
    const e = await refusal(fetchRemote('https://github.com/a', { kind: 'archive' }, deps))
    expect(e.message).not.toMatch(/SECRET/)
    expect(e.url).toBe('https://evil.example/blob')
  })
})
