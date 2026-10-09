/**
 * The same-origin check of every state-changing /api/plugins/** route (R-29, R-45, D-52):
 * the session cookie is SameSite=lax, so a cross-site page can still POST; an `Origin`
 * from elsewhere is refused. Behind the single-host nginx `Host $host` drops the port, so
 * the deployment's own origin comes from PLUGINS_ALLOWED_ORIGIN (seeded by deploy.sh).
 *
 * @vitest-environment node
 */
import { describe, test, expect, afterEach, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { sameOrigin, crossOriginResponse } from './sameOrigin'

const req = (url: string, origin?: string | null) =>
  new NextRequest(url, { method: 'POST', headers: origin === undefined || origin === null ? {} : { origin } })

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe('without PLUGINS_ALLOWED_ORIGIN', () => {
  test('no Origin header passes (a non-browser client, or a same-origin GET-like navigation)', () => {
    expect(sameOrigin(req('http://localhost:3000/api/plugins/echo/actions/run'))).toBe(true)
  })

  test("an Origin with the request's host passes", () => {
    expect(sameOrigin(req('http://localhost:3000/api/plugins/x', 'http://localhost:3000'))).toBe(true)
  })

  test.each(['http://evil.example', 'http://localhost:3001', 'http://localhost', 'null', 'not a url'])(
    'Origin %s is refused',
    (origin) => {
      expect(sameOrigin(req('http://localhost:3000/api/plugins/x', origin))).toBe(false)
    },
  )
})

describe('with PLUGINS_ALLOWED_ORIGIN (behind nginx)', () => {
  test('a Host without the port, an Origin equal to the configured one: passes', () => {
    vi.stubEnv('PLUGINS_ALLOWED_ORIGIN', 'https://redamon.example.com:8443')
    expect(sameOrigin(req('http://redamon.example.com/api/plugins/x', 'https://redamon.example.com:8443'))).toBe(true)
  })

  test.each(['http://redamon.example.com:8443', 'https://redamon.example.com', 'https://redamon.example.com:9443', 'https://evil.example:8443'])(
    'Origin %s is refused (scheme, host and port must all match)',
    (origin) => {
      vi.stubEnv('PLUGINS_ALLOWED_ORIGIN', 'https://redamon.example.com:8443')
      expect(sameOrigin(req('http://redamon.example.com/api/plugins/x', origin))).toBe(false)
    },
  )

  test('a trailing slash in the setting is the same origin', () => {
    vi.stubEnv('PLUGINS_ALLOWED_ORIGIN', ' https://redamon.example.com/ ')
    expect(sameOrigin(req('http://webapp:3000/api/plugins/x', 'https://redamon.example.com'))).toBe(true)
  })

  test.each(['redamon.example.com:8443', 'not a url', 'ftp://redamon.example.com'])(
    'an invalid setting (%s) refuses everything with an Origin, and says why in the log',
    (value) => {
      vi.stubEnv('PLUGINS_ALLOWED_ORIGIN', value)
      const err = vi.spyOn(console, 'error').mockImplementation(() => {})
      expect(sameOrigin(req('http://localhost:3000/api/plugins/x', 'http://localhost:3000'))).toBe(false)
      expect(err.mock.calls.flat().join(' ')).toContain('[plugins] PLUGINS_ALLOWED_ORIGIN is not a valid URL')
    },
  )
})

test('the refusal: 403 cross_origin', async () => {
  const res = crossOriginResponse()
  expect(res.status).toBe(403)
  expect(await res.json()).toEqual({ error: 'Cross-origin request refused.', code: 'cross_origin' })
})
