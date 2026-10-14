/**
 * The strict Content-Security-Policy on plugin pages (design §6 `nav` point): set by the
 * middleware on /plugins and /plugins/* only, so the rest of the app is unchanged. Next.js
 * dev mode needs 'unsafe-eval'; production never gets it.
 *
 * @vitest-environment node
 */
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import { NextRequest } from 'next/server'
import { SignJWT } from 'jose'

vi.stubEnv('AUTH_SECRET', 'b'.repeat(64))

import { middleware, pluginPagesCsp } from './middleware'

async function token(): Promise<string> {
  return new SignJWT({ sub: 'user-1', role: 'standard' })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(new TextEncoder().encode('b'.repeat(64)))
}

async function csp(path: string): Promise<string | null> {
  const headers = new Headers({ cookie: `redamon-auth=${await token()}` })
  const res = await middleware(new NextRequest(`http://localhost:3000${path}`, { headers }))
  return res.headers.get('content-security-policy')
}

beforeEach(() => {
  vi.stubEnv('AUTH_SECRET', 'b'.repeat(64))
  vi.stubEnv('NODE_ENV', 'production')
})
afterEach(() => vi.unstubAllEnvs())

describe('where the header goes', () => {
  test.each(['/plugins', '/plugins/echo', '/plugins/echo/forms/new-item', '/plugins/external-link'])(
    'present on %s',
    async (path) => {
      expect(await csp(path)).toBe(pluginPagesCsp())
    },
  )

  test.each(['/graph', '/projects', '/settings', '/pluginsx', '/api/plugins/contributions', '/'])(
    'absent on %s',
    async (path) => {
      expect(await csp(path)).toBeNull()
    },
  )
})

describe('the policy', () => {
  test('production: the strict policy, no unsafe-eval', () => {
    expect(pluginPagesCsp()).toBe(
      "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; " +
        "img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; " +
        "form-action 'self'",
    )
  })

  test('outside production, script-src also allows unsafe-eval (Next.js dev), and nothing else changes', () => {
    vi.stubEnv('NODE_ENV', 'development')
    const dev = pluginPagesCsp()
    expect(dev).toContain("script-src 'self' 'unsafe-inline' 'unsafe-eval';")
    vi.stubEnv('NODE_ENV', 'production')
    expect(dev.replace(" 'unsafe-eval'", '')).toBe(pluginPagesCsp())
  })
})
