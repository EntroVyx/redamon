import { NextRequest, NextResponse } from 'next/server'

/**
 * The same-origin check of every state-changing /api/plugins/** route (README.PLUGINS.md
 * §7.5, R-29). There are no CSRF tokens and the session cookie is SameSite=lax, so a page
 * on another site can still POST a form here; together with JSON-only bodies
 * (readJsonBody), an `Origin` from elsewhere is refused. Modelled on the MCP route's
 * `originAllowed`:
 * - no `Origin` passes (not a browser, which sends one with every cross-site POST);
 * - PLUGINS_ALLOWED_ORIGIN set: the whole origin (scheme, host, port) must equal it.
 *   nginx forwards `Host $host`, which drops a non-default port, so behind the
 *   single-host proxy the request's own host cannot be trusted; deploy.sh seeds it;
 * - otherwise the origin's host must equal the request's host.
 */
export function sameOrigin(request: NextRequest): boolean {
  const origin = request.headers.get('origin')
  if (!origin) return true
  let candidate: URL
  try {
    candidate = new URL(origin)
  } catch {
    return false
  }
  const configured = (process.env.PLUGINS_ALLOWED_ORIGIN || '').trim()
  if (configured) {
    let allowed: URL | null = null
    try {
      allowed = new URL(configured)
    } catch {
      allowed = null
    }
    // A host without a scheme ("example.com:8443") parses with a scheme of its own.
    if (!allowed || (allowed.protocol !== 'https:' && allowed.protocol !== 'http:')) {
      console.error(`[plugins] PLUGINS_ALLOWED_ORIGIN is not a valid URL: ${configured}`)
      return false
    }
    return candidate.origin === allowed.origin
  }
  try {
    return candidate.host === new URL(request.url).host
  } catch {
    return false
  }
}

export function crossOriginResponse(): NextResponse {
  return NextResponse.json({ error: 'Cross-origin request refused.', code: 'cross_origin' }, { status: 403 })
}
