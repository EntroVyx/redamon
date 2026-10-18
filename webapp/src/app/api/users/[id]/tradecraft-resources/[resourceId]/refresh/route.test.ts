/**
 * Tests for POST /api/users/[id]/tradecraft-resources/[resourceId]/refresh.
 *
 * The route proxies to the agent's /tradecraft/verify with force=true. That
 * agent route requires the internal key (CVE-2026-111323), so a refresh that
 * forgets the header fails with 401 instead of refreshing.
 *
 * @vitest-environment node
 */
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'

const mockFindFirst = vi.fn()
const mockUpdate = vi.fn()
const mockUserSettingsFindUnique = vi.fn()

vi.mock('@/lib/session', () => ({ requireUserAccess: vi.fn().mockResolvedValue(null) }))

vi.mock('@/lib/prisma', () => ({
  default: {
    userTradecraftResource: {
      findFirst: (...a: unknown[]) => mockFindFirst(...a),
      update: (...a: unknown[]) => mockUpdate(...a),
    },
    userSettings: {
      findUnique: (...a: unknown[]) => mockUserSettingsFindUnique(...a),
    },
  },
}))

import { NextRequest } from 'next/server'
import * as route from './route'

const PARAMS = { params: Promise.resolve({ id: 'user-1', resourceId: 'res-1' }) }

const EXISTING = {
  id: 'res-1', userId: 'user-1', slug: 'hacktricks',
  name: 'HackTricks', url: 'https://book.hacktricks.wiki',
  llmModel: 'gpt-4o', githubTokenOverride: '',
  resourceType: 'mkdocs-wiki', enabled: true, lastError: '',
}

let capturedFetch: { url: string; init: RequestInit } | null = null

beforeEach(() => {
  mockFindFirst.mockReset().mockResolvedValue(EXISTING)
  mockUpdate.mockReset().mockImplementation(async (args: unknown) => {
    const { where, data } = args as { where: { id: string }; data: Record<string, unknown> }
    return { id: where.id, ...data }
  })
  mockUserSettingsFindUnique.mockReset().mockResolvedValue(null)
  capturedFetch = null
  global.fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    capturedFetch = { url: String(url), init: init ?? {} }
    return new Response(JSON.stringify({
      summary: 's', resource_type: 'mkdocs-wiki', sitemap: {},
      crawl_stopped_because: '', crawl_stats: {}, last_error: '',
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }) as typeof fetch
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

describe('refresh route calls the agent verify endpoint', () => {
  test('sends the internal key and force=true', async () => {
    vi.stubEnv('INTERNAL_API_KEY', 'test-internal-key')
    const req = new NextRequest(
      'http://webapp.test/api/users/user-1/tradecraft-resources/res-1/refresh',
      { method: 'POST' },
    )
    const r = await route.POST(req as never, PARAMS as never)
    expect(r.status).toBe(200)
    expect(capturedFetch!.url).toContain('/tradecraft/verify')
    const headers = capturedFetch!.init.headers as Record<string, string>
    expect(headers['x-internal-key']).toBe('test-internal-key')
    expect(JSON.parse(String(capturedFetch!.init.body)).force).toBe(true)
  })
})
