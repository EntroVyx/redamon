/**
 * @vitest-environment node
 */
import { describe, test, expect, afterEach } from 'vitest'
import { closeAllFakeServers, startFakeServer } from './fakeHttpServer'

afterEach(async () => {
  await closeAllFakeServers()
})

describe('fakeHttpServer', () => {
  test('binds 127.0.0.1 on an ephemeral port', async () => {
    const s = await startFakeServer()
    expect(s.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
    expect(s.port).toBeGreaterThan(0)
  })

  test('serves a JSON route with its status and headers', async () => {
    const s = await startFakeServer({ 'GET /catalog.json': { status: 201, headers: { 'X-Test': 'yes' }, body: { serial: 4 } } })
    const res = await fetch(`${s.baseUrl}/catalog.json`)
    expect(res.status).toBe(201)
    expect(res.headers.get('x-test')).toBe('yes')
    expect(res.headers.get('content-type')).toBe('application/json')
    expect(await res.json()).toEqual({ serial: 4 })
  })

  test('an explicit content-type wins over the JSON default, whatever its case', async () => {
    const s = await startFakeServer({ '/x': { headers: { 'content-type': 'application/vnd.test+json' }, body: { a: 1 } } })
    const res = await fetch(`${s.baseUrl}/x`)
    expect(res.headers.get('content-type')).toBe('application/vnd.test+json')
    expect(await res.json()).toEqual({ a: 1 })
  })

  test('serves bytes unchanged', async () => {
    const bytes = Buffer.from([0x1f, 0x8b, 0x00, 0xff])
    const s = await startFakeServer({ '/a.tar.gz': { body: bytes } })
    const res = await fetch(`${s.baseUrl}/a.tar.gz`)
    expect(Buffer.from(await res.arrayBuffer()).equals(bytes)).toBe(true)
  })

  test('a method-specific key does not match another method', async () => {
    const s = await startFakeServer({ 'POST /x': { body: 'post' } })
    expect((await fetch(`${s.baseUrl}/x`)).status).toBe(404)
    expect(await (await fetch(`${s.baseUrl}/x`, { method: 'POST' })).text()).toBe('post')
  })

  test('redirects with 302 by default, or the given 3xx', async () => {
    const s = await startFakeServer({
      '/r1': { redirect: 'https://objects.example.org/a' },
      '/r2': { redirect: '/final', status: 301 },
    })
    const r1 = await fetch(`${s.baseUrl}/r1`, { redirect: 'manual' })
    expect(r1.status).toBe(302)
    expect(r1.headers.get('location')).toBe('https://objects.example.org/a')
    const r2 = await fetch(`${s.baseUrl}/r2`, { redirect: 'manual' })
    expect(r2.status).toBe(301)
  })

  test('unmatched paths answer 404 unless a fallback handles them', async () => {
    const s = await startFakeServer({}, { fallback: req => ({ body: { echoed: req.path } }) })
    expect(await (await fetch(`${s.baseUrl}/any/where?x=1`)).json()).toEqual({ echoed: '/any/where' })
    const plain = await startFakeServer()
    const res = await fetch(`${plain.baseUrl}/nope`)
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'no route' })
  })

  test('records each call with method, url, query, headers and body', async () => {
    const s = await startFakeServer({ 'POST /p': { body: {} } })
    await fetch(`${s.baseUrl}/p?lines=5`, { method: 'POST', headers: { 'X-Key': 'k' }, body: '{"a":1}' })
    expect(s.calls).toHaveLength(1)
    const c = s.calls[0]
    expect(c.method).toBe('POST')
    expect(c.url).toBe('/p?lines=5')
    expect(c.query.get('lines')).toBe('5')
    expect(c.headers['x-key']).toBe('k')
    expect(c.body.toString()).toBe('{"a":1}')
  })

  test('handlers can answer per request, and routes can be replaced', async () => {
    let n = 0
    const s = await startFakeServer({ '/n': () => ({ body: { n: ++n } }) })
    expect(await (await fetch(`${s.baseUrl}/n`)).json()).toEqual({ n: 1 })
    s.setRoute('/n', { status: 503, body: 'down' })
    expect((await fetch(`${s.baseUrl}/n`)).status).toBe(503)
  })

  test('delayMs holds the answer, so a client timeout fires', async () => {
    const s = await startFakeServer({ '/slow': { delayMs: 500, body: 'late' } })
    await expect(fetch(`${s.baseUrl}/slow`, { signal: AbortSignal.timeout(50) })).rejects.toThrow()
  })

  test('after close the port refuses connections', async () => {
    const s = await startFakeServer({ '/': { body: 'x' } })
    await s.close()
    await expect(fetch(`${s.baseUrl}/`)).rejects.toThrow()
  })
})
