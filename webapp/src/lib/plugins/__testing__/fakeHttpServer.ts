/**
 * A real HTTP server on 127.0.0.1 and an ephemeral port, driven by a route map,
 * so plugin code is tested through its real fetch path without touching the
 * network (rule T6). Every server started here is registered; call
 * `closeAllFakeServers()` in `afterEach`.
 */
import { createServer, type IncomingHttpHeaders, type IncomingMessage, type Server, type ServerResponse } from 'http'
import type { AddressInfo } from 'net'

export interface FakeResponse {
  status?: number
  headers?: Record<string, string>
  /** An object is sent as JSON; a string or Buffer as is. */
  body?: string | Uint8Array | object
  /** Answers 302 (or `status` when it is a 3xx) with this Location. */
  redirect?: string
  /** Waits this long before answering (timeout tests). */
  delayMs?: number
}

export interface FakeRequest {
  method: string
  /** Path and query, exactly as received. */
  url: string
  path: string
  query: URLSearchParams
  headers: IncomingHttpHeaders
  body: Buffer
}

export type FakeHandler = (req: FakeRequest) => FakeResponse | Promise<FakeResponse>

/** Keys are `'GET /path'` (one method) or `'/path'` (any method); the path excludes the query. */
export type RouteMap = Record<string, FakeResponse | FakeHandler>

export interface FakeServer {
  baseUrl: string
  port: number
  calls: FakeRequest[]
  setRoute(key: string, route: FakeResponse | FakeHandler): void
  close(): Promise<void>
}

export interface FakeServerOptions {
  /** Answers every request no route matches; the default is 404 `{error: 'no route'}`. */
  fallback?: FakeHandler
}

const open = new Set<FakeServer>()

function send(res: ServerResponse, r: FakeResponse): void {
  const headers: Record<string, string> = { ...(r.headers ?? {}) }
  let status = r.status ?? 200
  let body: Buffer = Buffer.alloc(0)
  if (r.redirect !== undefined) {
    status = r.status && r.status >= 300 && r.status < 400 ? r.status : 302
    headers.Location = r.redirect
  }
  if (r.body !== undefined) {
    if (typeof r.body === 'string') body = Buffer.from(r.body, 'utf8')
    else if (r.body instanceof Uint8Array) body = Buffer.from(r.body)
    else {
      body = Buffer.from(JSON.stringify(r.body), 'utf8')
      headers['Content-Type'] ??= 'application/json'
    }
  }
  headers['Content-Length'] = String(body.length)
  res.writeHead(status, headers)
  res.end(body)
}

export async function startFakeServer(routes: RouteMap = {}, opts: FakeServerOptions = {}): Promise<FakeServer> {
  const table = new Map(Object.entries(routes))
  const calls: FakeRequest[] = []

  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', async () => {
      const u = new URL(req.url ?? '/', 'http://127.0.0.1')
      const fr: FakeRequest = {
        method: req.method ?? 'GET',
        url: req.url ?? '/',
        path: u.pathname,
        query: u.searchParams,
        headers: req.headers,
        body: Buffer.concat(chunks),
      }
      calls.push(fr)
      const route = table.get(`${fr.method} ${fr.path}`) ?? table.get(fr.path)
      try {
        const r: FakeResponse = route === undefined
          ? (opts.fallback ? await opts.fallback(fr) : { status: 404, body: { error: 'no route' } })
          : typeof route === 'function' ? await route(fr) : route
        if (r.delayMs) await new Promise(resolve => setTimeout(resolve, r.delayMs))
        if (!res.destroyed) send(res, r)
      } catch (e) {
        if (!res.destroyed) send(res, { status: 500, body: { error: String(e) } })
      }
    })
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const port = (server.address() as AddressInfo).port

  const fake: FakeServer = {
    baseUrl: `http://127.0.0.1:${port}`,
    port,
    calls,
    setRoute(key, route) {
      table.set(key, route)
    },
    close() {
      open.delete(fake)
      return new Promise<void>(resolve => {
        server.closeAllConnections()
        server.close(() => resolve())
      })
    },
  }
  open.add(fake)
  return fake
}

export async function closeAllFakeServers(): Promise<void> {
  await Promise.all([...open].map(s => s.close()))
}
