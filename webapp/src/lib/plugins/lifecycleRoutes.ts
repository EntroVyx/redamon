import { NextRequest, NextResponse } from 'next/server'
import prisma from '@/lib/prisma'
import { readJsonBody } from '@/lib/jsonBody'
import { getSession } from '@/lib/session'
import { LifecycleError } from './lifecycleCommon'
import { PluginConflictError } from './registry'
import { crossOriginResponse, sameOrigin } from './sameOrigin'

/**
 * The guard of every plugin lifecycle route. These routes put code on the host, so the
 * admin role is read from the database on each request: the role inside the login JWT
 * lasts seven days after a demotion (RV-11). The login session is the real admin's even
 * while they act as another user (`getSession` ignores the act-as cookie), so acting as a
 * standard user neither removes nor lends these rights, and the admin is the actor.
 */
const NO_STORE = { 'Cache-Control': 'no-store' }

export function errorResponse(status: number, code: string, error: string, details?: string[]): NextResponse {
  return NextResponse.json({ error, code, ...(details?.length ? { details } : {}) }, { status, headers: NO_STORE })
}

export async function requirePluginAdmin(): Promise<{ userId: string } | NextResponse> {
  const session = await getSession()
  if (!session) return errorResponse(401, 'unauthorized', 'Sign in first.')
  const user = await prisma.user.findUnique({ where: { id: session.userId }, select: { id: true, role: true } })
  if (!user || user.role !== 'admin') {
    return errorResponse(403, 'admin_required', 'Only an administrator can manage plugins.')
  }
  return { userId: user.id }
}

export function lifecycleErrorResponse(e: unknown, what: string): NextResponse {
  if (e instanceof LifecycleError) return errorResponse(e.status, e.code, e.message, e.details)
  if (e instanceof PluginConflictError) return errorResponse(409, 'plugin_busy', e.message)
  console.error(`[plugins] ${what} failed: ${(e as Error)?.stack ?? String(e)}`)
  return errorResponse(500, 'internal_error', 'The plugin operation failed; see the webapp log.')
}

/** A state-changing route: admin, same origin, a JSON object body, then `run`. */
export async function lifecyclePost(
  request: NextRequest,
  what: string,
  run: (body: Record<string, unknown>, adminId: string) => Promise<unknown>,
): Promise<NextResponse> {
  const admin = await requirePluginAdmin()
  if (admin instanceof NextResponse) return admin
  if (!sameOrigin(request)) return crossOriginResponse()
  const parsed = await readJsonBody(request)
  if (parsed instanceof NextResponse) return parsed
  const started = Date.now()
  try {
    const out = await run(parsed.body, admin.userId)
    console.log(`[plugins] ${what} by ${admin.userId}: ok in ${Date.now() - started} ms`)
    return NextResponse.json(out, { headers: NO_STORE })
  } catch (e) {
    const res = lifecycleErrorResponse(e, what)
    console.warn(`[plugins] ${what} by ${admin.userId}: ${res.status} in ${Date.now() - started} ms`)
    return res
  }
}

/** A read-only admin route: admin, then `run`. */
export async function lifecycleGet(what: string, run: (adminId: string) => Promise<NextResponse>): Promise<NextResponse> {
  const admin = await requirePluginAdmin()
  if (admin instanceof NextResponse) return admin
  try {
    return await run(admin.userId)
  } catch (e) {
    return lifecycleErrorResponse(e, what)
  }
}
