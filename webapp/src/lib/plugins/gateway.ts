import { NextRequest, NextResponse } from 'next/server'
import type { PluginInstall } from '@prisma/client'
import prisma from '@/lib/prisma'
import { isJsonContentType } from '@/lib/jsonBody'
import { CallTokenConfigError, verifyCallToken, type CallTokenClaims, type CallTokenKind } from './callToken'
import { now } from './clock'
import { PluginDataError, type PluginOwner } from './dataStore'
import { PluginOverrideError } from './overrides'
import type { PluginPermission } from './permissions'
import { hasPermission, servesActions } from './registry'
import { gatewayCallsPerToken } from './settings'
import { SkillPartsRegistryError } from './skillPartsRegistry'
import { pluginsDisabledResponse, pluginsEnabled } from './switch'

/**
 * The Gateway frame (README.PLUGINS.md §7.3, TD-06): every SDK call from plugin code
 * enters here, authenticated by its call token alone, and is re-authorised on every
 * call, because an admin may disable the plugin, revoke a permission or delete the user
 * while a 900 s action still holds a valid token.
 *
 * Per call: the switch; JSON only; the token; its call budget; the body (≤ 8 MB); the
 * install row (enabled, ready, not revoked, at the token's version); the permission,
 * granted by the admin AND declared by the stored manifest; the user; the project and
 * session, compared with the token's user directly. Strict on purpose: never through
 * requireProjectAccess, which only logs under ACCESS_ENFORCE=0 (RV-33). The frame never
 * reads cookies, the session, the effective user or X-Internal-Key: these routes are
 * cookie-less in middleware.ts and plugin code must not borrow a browser's identity.
 *
 * The budget is counted right after the token is verified, before any database read, so
 * a plugin that floods the Gateway with refused calls exhausts its token, not Postgres.
 */
export const GATEWAY_BODY_MAX_BYTES = 8 * 1024 * 1024
const DEFAULT_KINDS: readonly CallTokenKind[] = ['action', 'job']
const NO_STORE = { 'Cache-Control': 'no-store' }
const BUDGET_SWEEP_AT = 5_000

export class GatewayError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message)
    this.name = 'GatewayError'
  }
}

export interface GatewayConversation {
  id: string
  sessionId: string
  projectId: string
  userId: string
  title: string
  status: string
  currentPhase: string
  iterationCount: number
  agentRunning: boolean
  createdAt: Date
  updatedAt: Date
}

export interface GatewayContext {
  op: string
  claims: CallTokenClaims
  pluginId: string
  version: string
  plugin: PluginInstall
  manifest: Record<string, unknown>
  /** The effective user the action runs for. */
  userId: string
  /** The admin acting as `userId`, when one started the action. */
  actorId: string | null
  projectId: string | null
  sessionId: string | null
  conversation: GatewayConversation | null
  body: Record<string, unknown>
}

export interface GatewayOptions {
  op: string
  /**
   * The permission the call needs; a function when the body names it (the override
   * operations: `override:<point>`). It returns null for a point that does not exist.
   */
  permission?: PluginPermission | ((body: Record<string, unknown>) => PluginPermission | null)
  kinds?: readonly CallTokenKind[]
  /** False only for jobs/complete: a job that used its calls must still report its result. */
  budgeted?: boolean
}

type Handler = (ctx: GatewayContext) => Promise<Record<string, unknown> | NextResponse>

export function gatewayError(status: number, code: string, error: string, extra: Record<string, unknown> = {}) {
  return NextResponse.json({ error, code, ...extra }, { status, headers: NO_STORE })
}

// ---------------------------------------------------------------------------
// Call budget, per token id, in this process's memory (RV-39). Several webapp copies
// each count their own share; the bound is per copy, which is enough against a flood.
// ---------------------------------------------------------------------------

const budgets = new Map<string, { count: number; expiresAt: number }>()

function charge(claims: CallTokenClaims): number {
  const t = now().getTime()
  if (budgets.size >= BUDGET_SWEEP_AT) {
    for (const [jti, b] of budgets) if (b.expiresAt <= t) budgets.delete(jti)
  }
  const entry = budgets.get(claims.jti) ?? { count: 0, expiresAt: claims.exp * 1000 }
  entry.count += 1
  budgets.set(claims.jti, entry)
  return entry.count
}

/** Tests only: how many tokens are being counted. */
export function callBudgetEntries(): number {
  return budgets.size
}

// ---------------------------------------------------------------------------
// The body
// ---------------------------------------------------------------------------

async function readBounded(request: NextRequest, limit: number): Promise<string | null> {
  const declared = Number(request.headers.get('content-length') ?? '')
  if (Number.isFinite(declared) && declared > limit) return null
  const stream = request.body
  if (!stream) return ''
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > limit) {
        await reader.cancel().catch(() => {})
        return null
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  return Buffer.concat(chunks).toString('utf8')
}

function bearer(request: NextRequest): string | null {
  const m = /^Bearer ([A-Za-z0-9._~+/=-]+)$/.exec((request.headers.get('authorization') ?? '').trim())
  return m ? m[1] : null
}

// ---------------------------------------------------------------------------
// Error mapping: stable codes for every store refusal, the contract's messages where
// services/plugin_runner/sdk/contract_cases.json fixes one.
// ---------------------------------------------------------------------------

function dataErrorResponse(e: PluginDataError): NextResponse {
  switch (e.code) {
    case 'value_too_large':
      return gatewayError(413, e.code, e.message, { limit: e.limit })
    case 'rows_exceeded':
    case 'bytes_exceeded':
    case 'owner_rows_exceeded':
      return gatewayError(413, 'quota_exceeded', e.message, { quota: e.code.replace('_exceeded', ''), limit: e.limit })
    case 'reserved_collection':
      return gatewayError(400, e.code, 'collections starting with __ are reserved for the platform')
    default:
      return gatewayError(400, e.code, e.message)
  }
}

const OVERRIDE_STATUS: Record<string, number> = {
  not_found: 404,
  invalid_proposal: 422,
  invalid_target: 400,
  too_many_pending: 409,
  stale_proposal: 409,
  wrong_state: 409,
  active_not_deletable: 409,
}

function errorResponse(e: unknown, op: string, pluginId: string): NextResponse {
  if (e instanceof GatewayError) return gatewayError(e.status, e.code, e.message, e.extra)
  if (e instanceof SkillPartsRegistryError) {
    return e.code === 'unknown_skill' ? gatewayError(404, 'invalid_target', e.message) : gatewayError(503, e.code, e.message)
  }
  if (e instanceof PluginDataError) return dataErrorResponse(e)
  if (e instanceof PluginOverrideError) return gatewayError(OVERRIDE_STATUS[e.code] ?? 400, e.code, e.message)
  console.error(`[plugins] gateway ${op} plugin=${pluginId} failed:`, e)
  return gatewayError(500, 'internal_error', 'The Gateway failed; the webapp log has the details.')
}

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

function declaredPermissions(manifest: unknown): string[] {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) return []
  const p = (manifest as Record<string, unknown>).permissions
  return Array.isArray(p) ? p.filter((x): x is string => typeof x === 'string') : []
}

async function checkPlugin(claims: CallTokenClaims): Promise<PluginInstall> {
  const plugin = await prisma.pluginInstall.findUnique({ where: { pluginId: claims.pid } })
  if (!plugin || !servesActions(plugin)) {
    throw new GatewayError(403, 'plugin_unavailable', `Plugin ${claims.pid} is not installed, enabled and ready.`)
  }
  if (plugin.activeVersion !== claims.ver) {
    throw new GatewayError(403, 'plugin_unavailable', `Plugin ${claims.pid} ${claims.ver} is no longer the active version.`)
  }
  return plugin
}

function checkPermission(plugin: PluginInstall, permission: PluginPermission) {
  if (!hasPermission(plugin, permission) || !declaredPermissions(plugin.manifest).includes(permission)) {
    throw new GatewayError(403, 'permission_denied', `This plugin was not granted ${permission}.`)
  }
}

const NOT_FOUND = () => new GatewayError(404, 'not_found', 'Not found')

async function checkTenancy(claims: CallTokenClaims): Promise<GatewayConversation | null> {
  const user = await prisma.user.findUnique({ where: { id: claims.sub }, select: { id: true } })
  if (!user) throw new GatewayError(401, 'invalid_token', 'The user this call token acts for no longer exists.')
  if (claims.prj) {
    const project = await prisma.project.findUnique({ where: { id: claims.prj }, select: { userId: true } })
    if (!project || project.userId !== claims.sub) throw NOT_FOUND()
  }
  if (!claims.ses) return null
  if (!claims.prj) throw NOT_FOUND()
  const conversation = await prisma.conversation.findUnique({
    where: { sessionId: claims.ses },
    select: {
      id: true,
      sessionId: true,
      projectId: true,
      userId: true,
      title: true,
      status: true,
      currentPhase: true,
      iterationCount: true,
      agentRunning: true,
      createdAt: true,
      updatedAt: true,
    },
  })
  if (
    !conversation ||
    conversation.userId !== claims.sub ||
    conversation.projectId !== claims.prj ||
    (claims.conv !== undefined && conversation.id !== claims.conv)
  ) {
    throw NOT_FOUND()
  }
  return conversation
}

/** The owner of a data call: the token's user, or the token's project. Never the body's ids. */
export function dataOwner(ctx: GatewayContext): PluginOwner {
  const owner = ctx.body.owner
  if (owner === 'user') return { type: 'user', id: ctx.userId }
  if (owner === 'project') {
    if (!ctx.projectId) throw new GatewayError(400, 'invalid_owner', 'This action was not started from a project.')
    return { type: 'project', id: ctx.projectId }
  }
  throw new GatewayError(400, 'invalid_owner', 'owner is "user" or "project".')
}

// ---------------------------------------------------------------------------
// The frame
// ---------------------------------------------------------------------------

export async function withGateway(request: NextRequest, opts: GatewayOptions, handler: Handler): Promise<NextResponse> {
  const started = Date.now()
  let pluginId = '-'
  let res: NextResponse
  try {
    res = await run(request, opts, handler, (id) => (pluginId = id))
  } catch (e) {
    res = errorResponse(e, opts.op, pluginId)
  }
  const line = `[plugins] gateway ${opts.op} plugin=${pluginId} status=${res.status} ms=${Date.now() - started}`
  if (res.status >= 400) console.warn(line)
  else console.log(line)
  return res
}

async function run(
  request: NextRequest,
  opts: GatewayOptions,
  handler: Handler,
  identify: (pluginId: string) => void,
): Promise<NextResponse> {
  if (!pluginsEnabled()) return pluginsDisabledResponse()
  if (!isJsonContentType(request.headers.get('content-type'))) {
    return gatewayError(415, 'unsupported_media_type', 'Content-Type must be application/json')
  }

  const raw = bearer(request)
  let claims: CallTokenClaims | null
  try {
    claims = raw ? await verifyCallToken(raw, { kinds: opts.kinds ?? DEFAULT_KINDS }) : null
  } catch (e) {
    if (e instanceof CallTokenConfigError) {
      console.error(`[plugins] gateway ${opts.op} refused: ${e.message}`)
      return gatewayError(503, e.code, 'The plugin platform is not configured on this deployment.')
    }
    throw e
  }
  if (!claims) return gatewayError(401, 'invalid_token', 'Invalid or expired call token.')
  identify(claims.pid)

  const limit = gatewayCallsPerToken()
  if (opts.budgeted !== false && charge(claims) > limit) {
    return gatewayError(429, 'call_budget_exceeded', `This call token has made its ${limit} calls.`)
  }

  const text = await readBounded(request, GATEWAY_BODY_MAX_BYTES)
  if (text === null) return gatewayError(413, 'body_too_large', `The body is limited to ${GATEWAY_BODY_MAX_BYTES} bytes.`)
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    return gatewayError(400, 'invalid_json', 'The body is not valid JSON.')
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return gatewayError(400, 'invalid_json', 'The body must be a JSON object.')
  }

  const plugin = await checkPlugin(claims)
  if (opts.permission) {
    const permission = typeof opts.permission === 'function' ? opts.permission(body as Record<string, unknown>) : opts.permission
    if (!permission) throw new GatewayError(400, 'invalid_target', `unknown extension point ${JSON.stringify((body as Record<string, unknown>).point)}`)
    checkPermission(plugin, permission)
  }
  const conversation = await checkTenancy(claims)

  const out = await handler({
    op: opts.op,
    claims,
    pluginId: claims.pid,
    version: claims.ver,
    plugin,
    manifest: plugin.manifest as Record<string, unknown>,
    userId: claims.sub,
    actorId: claims.act ?? null,
    projectId: claims.prj ?? null,
    sessionId: claims.ses ?? null,
    conversation,
    body: body as Record<string, unknown>,
  })
  if (out instanceof NextResponse) {
    out.headers.set('Cache-Control', 'no-store')
    return out
  }
  return NextResponse.json(out, { headers: NO_STORE })
}
