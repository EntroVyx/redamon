/**
 * POST /api/internal/plugins/reconcile (TD-20): driven by the recon orchestrator's reaper
 * with the master internal key, the only credential it honours (re-checked in the route;
 * the middleware allowlist is not the control). 202 `{skipped: 'busy'}` while another
 * reconcile holds the lease, 200 with the report.
 *
 * @vitest-environment node
 */
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'
import { NextRequest } from 'next/server'

const h = vi.hoisted(() => ({ result: null as unknown, calls: 0 }))
vi.mock('@/lib/plugins/reconcile', () => ({
  reconcile: vi.fn(async () => {
    h.calls++
    return h.result
  }),
}))

import { POST } from '@/app/api/internal/plugins/reconcile/route'
import { internalKeyRouteAllowed } from '@/middleware'

const KEY = 'i'.repeat(64)
const call = (key?: string) =>
  POST(new NextRequest('http://webapp:3000/api/internal/plugins/reconcile', {
    method: 'POST',
    headers: key ? { 'x-internal-key': key } : {},
  }))

beforeEach(() => {
  h.calls = 0
  h.result = { recovered: [], healed: [] }
  vi.stubEnv('INTERNAL_API_KEY', KEY)
  vi.spyOn(console, 'log').mockImplementation(() => {})
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe('the reconcile route', () => {
  test.each([undefined, 'wrong', 'changeme'])('401 without the master key (%s)', async (key) => {
    expect((await call(key)).status).toBe(401)
    expect(h.calls).toBe(0)
  })

  test('the scanner key is not enough', async () => {
    vi.stubEnv('SCANNER_API_KEY', 's'.repeat(64))
    expect((await call('s'.repeat(64))).status).toBe(401)
  })

  test('200 with the report', async () => {
    const res = await call(KEY)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, report: { recovered: [], healed: [] } })
    expect(h.calls).toBe(1)
  })

  test('202 skipped busy while another reconcile runs', async () => {
    h.result = { skipped: 'busy' }
    const res = await call(KEY)
    expect(res.status).toBe(202)
    expect(await res.json()).toEqual({ skipped: 'busy' })
  })

  test('the middleware allowlist has exactly this route, POST only', () => {
    expect(internalKeyRouteAllowed('POST', '/api/internal/plugins/reconcile')).toBe(true)
    expect(internalKeyRouteAllowed('GET', '/api/internal/plugins/reconcile')).toBe(false)
    expect(internalKeyRouteAllowed('POST', '/api/internal/plugins/reconcile/x')).toBe(false)
    expect(internalKeyRouteAllowed('POST', '/api/internal/plugins')).toBe(false)
  })
})
