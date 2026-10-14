import { randomUUID } from 'crypto'
import { Prisma, type PluginInstall } from '@prisma/client'
import prisma from '@/lib/prisma'
import { now } from './clock'
import { isValidPluginId } from './ids'

/**
 * The install registry: one `PluginInstall` row per plugin, the source of truth the
 * plugins volume and the runner follow (README.PLUGINS.md §9.1). `enabled` is the
 * admin's wish; `status` is what the platform observed, and only the functions here
 * change it.
 *
 * Every status change is ONE conditional `updateMany` (compare-and-swap on the status
 * and the lease), so two admins, two webapp copies or a request racing reconciliation
 * can never both win. A lifecycle operation holds a lease (`operationId`,
 * `leaseExpiresAt`) instead of a lock: a pooled Prisma connection cannot hold a
 * session-level lock across requests, and an expired lease is how reconciliation
 * takes over from a crashed operation. Nothing here keeps state in memory.
 */
export const PLUGIN_STATUSES = [
  'available',
  'installing',
  'ready',
  'failed',
  'incompatible',
  'updating',
  'uninstalling',
] as const
export type PluginStatus = (typeof PLUGIN_STATUSES)[number]

export const OPERATION_KINDS = ['install', 'update', 'rollback', 'uninstall'] as const
export type OperationKind = (typeof OPERATION_KINDS)[number]

export const LEASE_MS = 10 * 60 * 1000

/**
 * The status machine of design §9.1. `ready`, `failed` and `incompatible` are the
 * substates of "Installed": each may start an update or an uninstall, and entering
 * "Installed" (after an install or an update) lands on `ready`.
 */
export const ALLOWED_TRANSITIONS: Readonly<Record<PluginStatus, readonly PluginStatus[]>> = {
  available: ['installing'],
  installing: ['available', 'ready'],
  ready: ['failed', 'incompatible', 'updating', 'uninstalling'],
  failed: ['ready', 'incompatible', 'updating', 'uninstalling'],
  incompatible: ['ready', 'updating', 'uninstalling'],
  updating: ['ready'],
  uninstalling: ['available'],
}

export function canTransition(from: PluginStatus, to: PluginStatus): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to)
}

/** Another operation holds the plugin, or the row is not in the expected state. */
export class PluginConflictError extends Error {
  readonly code = 'plugin_busy'
  constructor(readonly pluginId: string, detail = 'another operation is in progress') {
    super(`Plugin ${pluginId}: ${detail}`)
    this.name = 'PluginConflictError'
  }
}

/** A status change the machine does not allow; a programming error, never a race. */
export class PluginTransitionError extends Error {
  readonly code = 'transition_forbidden'
  constructor(readonly from: string, readonly to: string) {
    super(`Plugin status cannot change from ${from} to ${to}`)
    this.name = 'PluginTransitionError'
  }
}

export interface Operation {
  pluginId: string
  operationId: string
  kind: OperationKind
  /** The status the plugin holds while the operation runs. */
  status: PluginStatus
}

type Db = Pick<typeof prisma, 'pluginInstall'>

const leaseEnd = () => new Date(now().getTime() + LEASE_MS)

// Before any write: Prisma drops a `where` key whose value is undefined, so a missing
// plugin id would let one updateMany move every plugin in the expected status.
function checkPluginId(pluginId: unknown) {
  if (!isValidPluginId(pluginId)) throw new Error(`Invalid plugin id: ${JSON.stringify(pluginId)}`)
}

function checkOperation(op: Operation) {
  checkPluginId(op?.pluginId)
  if (typeof op.operationId !== 'string' || op.operationId.length === 0) {
    throw new Error('An operation needs its operationId')
  }
}

export interface TransitionArgs {
  from: readonly PluginStatus[]
  to: PluginStatus
  patch?: Prisma.PluginInstallUpdateManyMutationInput
  /** The caller's own operation; without it only a free or expired lease matches. */
  operationId?: string
  /**
   * Further values the row must still hold (what the caller planned with). Explicit values
   * only, null for none: Prisma drops an undefined key, which would match any value.
   */
  expect?: Prisma.PluginInstallWhereInput
}

export async function transition(pluginId: string, args: TransitionArgs, db: Db = prisma): Promise<void> {
  checkPluginId(pluginId)
  for (const f of args.from) if (!canTransition(f, args.to)) throw new PluginTransitionError(f, args.to)
  for (const [k, v] of Object.entries(args.expect ?? {})) {
    if (v === undefined) throw new Error(`transition of ${pluginId}: expect.${k} is undefined`)
  }
  // Built conditionally on purpose: Prisma drops a key whose value is undefined, so an
  // unconditional `{operationId: args.operationId}` would match EVERY row and let any
  // caller walk through a live lease.
  const leaseOpen: Prisma.PluginInstallWhereInput[] = [
    { operationId: null },
    { leaseExpiresAt: { lt: now() } },
  ]
  if (args.operationId) leaseOpen.push({ operationId: args.operationId })
  const { count } = await db.pluginInstall.updateMany({
    where: { ...args.expect, pluginId, status: { in: [...args.from] }, OR: leaseOpen },
    data: { ...args.patch, status: args.to },
  })
  if (count !== 1) {
    throw new PluginConflictError(pluginId, `not in ${args.from.join('|')}, or another operation holds it`)
  }
}

export async function beginOperation(
  pluginId: string,
  from: readonly PluginStatus[],
  to: PluginStatus,
  kind: OperationKind,
  args?: Prisma.InputJsonValue,
  db: Db = prisma,
  expect?: Prisma.PluginInstallWhereInput,
): Promise<Operation> {
  const operationId = randomUUID()
  await transition(
    pluginId,
    {
      from,
      to,
      expect,
      patch: {
        operationId,
        operationKind: kind,
        operationArgs: args ?? Prisma.DbNull,
        leaseExpiresAt: leaseEnd(),
        // The previous attempt's error; this operation writes its own if it fails.
        lastError: null,
      },
    },
    db,
  )
  return { pluginId, operationId, kind, status: to }
}

/** Inserts the row of a plugin never seen on this instance, already `installing`. */
export async function createForInstall(
  pluginId: string,
  args?: Prisma.InputJsonValue,
  db: Db = prisma,
): Promise<Operation> {
  checkPluginId(pluginId)
  const operationId = randomUUID()
  try {
    await db.pluginInstall.create({
      data: {
        pluginId,
        status: 'installing',
        operationId,
        operationKind: 'install',
        operationArgs: args ?? Prisma.DbNull,
        leaseExpiresAt: leaseEnd(),
      },
    })
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
      throw new PluginConflictError(pluginId, 'already known to this instance')
    }
    throw e
  }
  return { pluginId, operationId, kind: 'install', status: 'installing' }
}

/**
 * Claims the lease of a plugin that stays in `status`, when no live operation holds it:
 * how reconciliation takes over a crashed operation (finish or roll back an update,
 * heal a lost folder) before doing any work, so a second copy, or the crashed
 * operation coming back, cannot work on the same plugin at the same time.
 */
export async function takeOverOperation(
  pluginId: string,
  status: PluginStatus,
  kind: OperationKind,
  args?: Prisma.InputJsonValue,
  db: Db = prisma,
): Promise<Operation> {
  checkPluginId(pluginId)
  const operationId = randomUUID()
  const { count } = await db.pluginInstall.updateMany({
    where: { pluginId, status, OR: [{ operationId: null }, { leaseExpiresAt: { lt: now() } }] },
    data: { operationId, operationKind: kind, operationArgs: args ?? Prisma.DbNull, leaseExpiresAt: leaseEnd() },
  })
  if (count !== 1) throw new PluginConflictError(pluginId, `not ${status}, or another operation holds it`)
  return { pluginId, operationId, kind, status }
}

/**
 * Extends the lease of a long operation. Fails once the lease was lost, and also once
 * it merely expired: by then reconciliation may have started recovering the plugin.
 */
export async function heartbeat(op: Operation, db: Db = prisma): Promise<void> {
  checkOperation(op)
  const { count } = await db.pluginInstall.updateMany({
    where: { pluginId: op.pluginId, operationId: op.operationId, status: op.status, leaseExpiresAt: { gt: now() } },
    data: { leaseExpiresAt: leaseEnd() },
  })
  if (count !== 1) throw new PluginConflictError(op.pluginId, 'the operation lost its lease')
}

export async function endOperation(
  op: Operation,
  to: PluginStatus,
  patch: Prisma.PluginInstallUpdateManyMutationInput = {},
  db: Db = prisma,
): Promise<void> {
  checkOperation(op)
  await transition(
    op.pluginId,
    {
      from: [op.status],
      to,
      operationId: op.operationId,
      patch: {
        ...patch,
        operationId: null,
        operationKind: null,
        operationArgs: Prisma.DbNull,
        leaseExpiresAt: null,
      },
    },
    db,
  )
}

export async function findInstall(pluginId: string, db: Db = prisma): Promise<PluginInstall | null> {
  return db.pluginInstall.findUnique({ where: { pluginId } })
}

// ---------------------------------------------------------------------------
// What a row means (the behaviour table of design §9.1). Every predicate is false
// while `revokedReason` is set (even to an empty string): revocation stops a version
// without touching the admin's `enabled`.
// ---------------------------------------------------------------------------

const isRevoked = (row: Pick<PluginInstall, 'revokedReason'>) => row.revokedReason != null

type RowFacts = Pick<PluginInstall, 'status' | 'enabled' | 'revokedReason' | 'grantedPermissions'>

export function servesActions(row: RowFacts): boolean {
  return !isRevoked(row) && row.enabled && row.status === 'ready'
}

/**
 * Contributions stay visible during an update (marked "updating"), but only for an
 * enabled plugin: the design's table omits `enabled` for `updating`, which would bring
 * a disabled plugin's buttons back while it is updated.
 */
export function showsContributions(row: RowFacts): boolean {
  return !isRevoked(row) && row.enabled && (row.status === 'ready' || row.status === 'updating')
}

export function contributionsUpdating(row: RowFacts): boolean {
  return showsContributions(row) && row.status === 'updating'
}

export function hasPermission(row: Pick<PluginInstall, 'grantedPermissions'>, permission: string): boolean {
  return Array.isArray(row.grantedPermissions) && row.grantedPermissions.includes(permission)
}

/** Approved overrides are data, not code: they keep applying during an update. */
export function overridesQualify(row: RowFacts): boolean {
  return (
    !isRevoked(row) &&
    row.enabled &&
    (row.status === 'ready' || row.status === 'updating') &&
    hasPermission(row, 'override:skill.text')
  )
}

export const DORMANT_REASONS = [
  'uninstalled',
  'revoked',
  'disabled',
  'not_ready',
  'permission_missing',
  'agent_outdated',
] as const
export type DormantReason = (typeof DORMANT_REASONS)[number]

/**
 * Why an active override does not reach the agent, or null when it does: the UI
 * says "active but not applied" with this reason instead of a misleading "v3 active".
 */
export function dormantReason(
  row: RowFacts | null | undefined,
  env: { agentSupportsSeam: boolean },
): DormantReason | null {
  if (!row || row.status === 'available' || row.status === 'uninstalling') return 'uninstalled'
  if (isRevoked(row)) return 'revoked'
  if (!row.enabled) return 'disabled'
  if (row.status !== 'ready' && row.status !== 'updating') return 'not_ready'
  if (!hasPermission(row, 'override:skill.text')) return 'permission_missing'
  if (!env.agentSupportsSeam) return 'agent_outdated'
  return null
}
