import { randomUUID } from 'crypto'
import { Prisma, type PluginInstall, type PluginOverride } from '@prisma/client'
import prisma from '@/lib/prisma'
import { now } from './clock'
import { BEHAVIOUR_EXTENSION_POINTS, type BehaviourExtensionPoint } from './extensionPoints'
import { isValidPluginId } from './ids'
import { overridesQualify } from './registry'

/**
 * The override store: values proposed at the `skill.text` behaviour point
 * (README.PLUGINS.md §7.6), as change sets and versions.
 *
 * - A change set is the rows proposed together (one per part of one skill, the
 *   `targetGroup`), decided together, and always in one status: a version is never half
 *   active, half stale.
 * - A version is a COMPLETE snapshot: approving one makes exactly its rows active for
 *   that scope and skill and supersedes whatever was active before, whichever plugin
 *   proposed it, so a version never depends on another (deleting old ones changes
 *   nothing that runs).
 * - Version numbers come from a counter in PluginPlatformState, raised in the approval
 *   transaction and never lowered: v1 is the factory text and is never stored, and a
 *   deleted number never comes back.
 * - Every change to a scope and skill runs in a transaction that first takes
 *   `pg_advisory_xact_lock` on that scope and skill, so two approvals (or an approval and
 *   a delete) serialize; the partial unique index of apply-plugin-constraints.mjs is the
 *   second wall.
 * - Reads for the agent resolve PER SKILL: a project's own version of a skill replaces
 *   the owner's user-scope version of that skill as a whole, never part by part.
 */
export const OVERRIDE_STATUSES = [
  'proposed',
  'active',
  'rejected',
  'withdrawn',
  'superseded',
  'stale',
  'cleared',
] as const
export type OverrideStatus = (typeof OVERRIDE_STATUSES)[number]

export const STALE_REASONS = ['factory_changed', 'part_removed'] as const
export type StaleReason = (typeof STALE_REASONS)[number]

export const FACTORY_REVISION = 1
export const MAX_PENDING_CHANGE_SETS = 5
export const MAX_PARTS_PER_CHANGE_SET = 50
export const PART_VALUE_MAX_CHARS = 100_000
export const NOTE_MAX_CHARS = 4_000
export const META_MAX_BYTES = 65_536
// Keys of `meta` the platform writes itself; a plugin's values for them are dropped.
// fromRevision and baseFactoryText come with the proposal (TD-19), staleReason later.
const PLATFORM_META_KEYS = ['staleReason', 'fromRevision', 'baseFactoryText', 'basedOn']

const GROUP_RE = /^[a-z][a-z0-9_]{0,63}$/
// Change set ids are crypto.randomUUID() values.
const CHANGE_SET_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const PART_RE = /^[a-z][a-z0-9_]{0,63}$/
const SHA256_RE = /^[0-9a-f]{64}$/

export type ScopeType = 'user' | 'project'

export interface OverrideScope {
  type: ScopeType
  id: string
}

export type OverrideErrorCode =
  | 'not_found'
  | 'invalid_proposal'
  | 'too_many_pending'
  | 'stale_proposal'
  | 'wrong_state'
  | 'active_not_deletable'
  | 'invalid_target'

export class PluginOverrideError extends Error {
  constructor(
    readonly code: OverrideErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'PluginOverrideError'
  }
}

/** A part's factory text changed (or the part is gone) since the proposal was made. */
export class PluginStaleProposalError extends PluginOverrideError {
  constructor(readonly targetKeys: string[]) {
    super('stale_proposal', `The factory text changed since this proposal was made: ${targetKeys.join(', ')}`)
    this.name = 'PluginStaleProposalError'
  }
}

export interface ChangeSetPart {
  overrideId: string
  targetKey: string
  partId: string
  value: string
  baseSha256: string
}

export interface ChangeSet {
  changeSetId: string
  pluginId: string
  point: string
  scope: OverrideScope
  targetGroup: string
  status: OverrideStatus
  revision: number | null
  staleReason: StaleReason | null
  note: string | null
  meta: Prisma.JsonValue | null
  createdBy: string
  createdAt: Date
  decidedBy: string | null
  decidedAt: Date | null
  parts: ChangeSetPart[]
}

type Db = Pick<typeof prisma, 'pluginOverride' | 'pluginPlatformState' | 'project' | '$transaction' | '$executeRaw'>
type Tx = Prisma.TransactionClient

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const scopeWhere = (point: string, scope: OverrideScope, group: string) => ({
  extensionPoint: point,
  scopeType: scope.type,
  scopeId: scope.id,
  targetGroup: group,
})

export function revisionCounterKey(point: string, scope: OverrideScope, group: string): string {
  return `override.revision:${point}:${scope.type}:${scope.id}:${group}`
}

async function lockScope(tx: Tx, point: string, scope: OverrideScope, group: string) {
  const key = `override:${point}:${scope.type}:${scope.id}:${group}`
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${key}))`
}

function staleReasonOf(meta: Prisma.JsonValue | null): StaleReason | null {
  if (meta && typeof meta === 'object' && !Array.isArray(meta)) {
    const r = (meta as Record<string, unknown>).staleReason
    if (r === 'factory_changed' || r === 'part_removed') return r
  }
  return null
}

function toChangeSet(rows: PluginOverride[]): ChangeSet {
  const sorted = [...rows].sort((a, b) => a.targetKey.localeCompare(b.targetKey))
  const first = sorted[0]
  return {
    changeSetId: first.changeSetId,
    pluginId: first.pluginId,
    point: first.extensionPoint,
    scope: { type: first.scopeType as ScopeType, id: first.scopeId },
    targetGroup: first.targetGroup,
    status: first.status as OverrideStatus,
    revision: first.revision,
    staleReason: first.status === 'stale' ? staleReasonOf(first.meta) : null,
    note: first.note,
    meta: first.meta,
    createdBy: first.createdBy,
    createdAt: first.createdAt,
    decidedBy: first.decidedBy,
    decidedAt: first.decidedAt,
    parts: sorted.map((r) => ({
      overrideId: r.id,
      targetKey: r.targetKey,
      partId: r.targetKey.slice(r.targetGroup.length + 1),
      value: r.value,
      baseSha256: r.baseSha256,
    })),
  }
}

function groupBySet<T extends PluginOverride>(rows: T[]): T[][] {
  const sets = new Map<string, T[]>()
  for (const r of rows) {
    const list = sets.get(r.changeSetId) ?? []
    list.push(r)
    sets.set(r.changeSetId, list)
  }
  return [...sets.values()]
}

/** Reads a set inside a transaction, after taking the lock of its scope and skill. */
async function lockedSet(tx: Tx, changeSetId: string): Promise<PluginOverride[]> {
  const first = await tx.pluginOverride.findFirst({ where: { changeSetId } })
  if (!first) throw new PluginOverrideError('not_found', `No change set ${changeSetId}`)
  await lockScope(tx, first.extensionPoint, { type: first.scopeType as ScopeType, id: first.scopeId }, first.targetGroup)
  // Re-read under the lock: the set may have changed while we waited for it.
  const rows = await tx.pluginOverride.findMany({ where: { changeSetId } })
  if (rows.length === 0) throw new PluginOverrideError('not_found', `No change set ${changeSetId}`)
  return rows
}

const setStatus = (rows: PluginOverride[]) => rows[0].status as OverrideStatus

// Every entry point checks its ids before any query: Prisma drops a `where` key whose
// value is undefined, so a missing id would otherwise select every row.
const isChangeSetId = (id: unknown): id is string => typeof id === 'string' && CHANGE_SET_ID_RE.test(id)

function checkChangeSetId(id: unknown) {
  if (!isChangeSetId(id)) throw new PluginOverrideError('not_found', `No change set ${String(id)}`)
}

function checkActor(actor: unknown) {
  if (typeof actor !== 'string' || actor.length === 0) {
    throw new PluginOverrideError('invalid_target', 'the user deciding is required')
  }
}

/** The key of every scope-and-skill query: point, scope and target group. */
function checkTarget(point: unknown, scope: OverrideScope, group: unknown) {
  if (!(BEHAVIOUR_EXTENSION_POINTS as readonly unknown[]).includes(point)) {
    throw new PluginOverrideError('invalid_target', `unknown behaviour point ${String(point)}`)
  }
  if (!scope || (scope.type !== 'user' && scope.type !== 'project') || typeof scope.id !== 'string' || !scope.id) {
    throw new PluginOverrideError('invalid_target', 'the scope must be a user or a project with an id')
  }
  if (typeof group !== 'string' || !GROUP_RE.test(group)) {
    throw new PluginOverrideError('invalid_target', `invalid target group ${String(group)}`)
  }
}

function checkScope(scope: OverrideScope) {
  if (!scope || (scope.type !== 'user' && scope.type !== 'project') || typeof scope.id !== 'string' || !scope.id) {
    throw new PluginOverrideError('invalid_proposal', 'the scope must be a user or a project with an id')
  }
}

function invalid(message: string): never {
  throw new PluginOverrideError('invalid_proposal', message)
}

// ---------------------------------------------------------------------------
// Proposals and decisions
// ---------------------------------------------------------------------------

export interface ProposedPart {
  targetKey: string
  value: string
  baseSha256: string
}

export interface ProposeInput {
  pluginId: string
  point: BehaviourExtensionPoint
  scope: OverrideScope
  targetGroup: string
  parts: ProposedPart[]
  note?: string | null
  /** The plugin's own meta: a plain object of at most META_MAX_BYTES. */
  meta?: Prisma.InputJsonValue
  /** What the platform records with the proposal; not counted toward the plugin's bytes. */
  platformMeta?: {
    fromRevision?: number
    baseFactoryText?: Record<string, string>
    /** What the plugin was shown, when it is not its scope's active version (null: factory text). */
    basedOn?: { scope: ScopeType; changeSetId: string; revision: number | null } | null
  }
  createdBy: string
}

export async function propose(input: ProposeInput, db: Db = prisma): Promise<{ changeSetId: string }> {
  const { pluginId, point, scope, targetGroup, parts } = input
  if (!isValidPluginId(pluginId)) invalid(`invalid plugin id ${JSON.stringify(pluginId)}`)
  if (!(BEHAVIOUR_EXTENSION_POINTS as readonly string[]).includes(point)) invalid(`unknown behaviour point ${point}`)
  checkScope(scope)
  if (!GROUP_RE.test(targetGroup)) invalid(`invalid target group ${JSON.stringify(targetGroup)}`)
  if (!Array.isArray(parts) || parts.length === 0) invalid('a proposal changes at least one part')
  if (parts.length > MAX_PARTS_PER_CHANGE_SET) invalid(`a proposal changes at most ${MAX_PARTS_PER_CHANGE_SET} parts`)
  const seen = new Set<string>()
  for (const p of parts) {
    const prefix = `${targetGroup}/`
    if (typeof p.targetKey !== 'string' || !p.targetKey.startsWith(prefix) || !PART_RE.test(p.targetKey.slice(prefix.length))) {
      invalid(`target ${JSON.stringify(p.targetKey)} is not a part of ${targetGroup}`)
    }
    if (seen.has(p.targetKey)) invalid(`target ${p.targetKey} appears twice`)
    seen.add(p.targetKey)
    if (typeof p.value !== 'string' || p.value.length > PART_VALUE_MAX_CHARS) {
      invalid(`the text of ${p.targetKey} must be a string of at most ${PART_VALUE_MAX_CHARS} characters`)
    }
    if (typeof p.baseSha256 !== 'string' || !SHA256_RE.test(p.baseSha256)) invalid(`invalid baseSha256 for ${p.targetKey}`)
  }
  if (input.note != null && (typeof input.note !== 'string' || input.note.length > NOTE_MAX_CHARS)) {
    invalid(`the note is at most ${NOTE_MAX_CHARS} characters`)
  }
  if (typeof input.createdBy !== 'string' || !input.createdBy) invalid('createdBy is required')
  let meta: Record<string, unknown> | undefined
  if (input.meta !== undefined && input.meta !== null) {
    if (typeof input.meta !== 'object' || Array.isArray(input.meta)) invalid('meta must be an object')
    const own = Object.fromEntries(Object.entries(input.meta).filter(([k]) => !PLATFORM_META_KEYS.includes(k)))
    if (Buffer.byteLength(JSON.stringify(own), 'utf8') > META_MAX_BYTES) invalid(`meta is at most ${META_MAX_BYTES} bytes of JSON`)
    meta = own
  }
  if (input.platformMeta) {
    const { fromRevision, baseFactoryText, basedOn } = input.platformMeta
    meta = {
      ...meta,
      ...(fromRevision !== undefined ? { fromRevision } : {}),
      ...(baseFactoryText !== undefined ? { baseFactoryText } : {}),
      ...(basedOn !== undefined ? { basedOn } : {}),
    }
  }

  const changeSetId = randomUUID()
  await db.$transaction(async (tx) => {
    // Under the lock, so two proposals cannot both take the last pending slot.
    await lockScope(tx, point, scope, targetGroup)
    if ((await countPending(tx, scope, point, targetGroup)) >= MAX_PENDING_CHANGE_SETS) {
      throw new PluginOverrideError(
        'too_many_pending',
        `There are already ${MAX_PENDING_CHANGE_SETS} proposals waiting for a decision on ${targetGroup}`,
      )
    }
    await tx.pluginOverride.createMany({
      data: parts.map((p) => ({
        pluginId,
        extensionPoint: point,
        scopeType: scope.type,
        scopeId: scope.id,
        userId: scope.type === 'user' ? scope.id : null,
        projectId: scope.type === 'project' ? scope.id : null,
        targetGroup,
        targetKey: p.targetKey,
        changeSetId,
        value: p.value,
        baseSha256: p.baseSha256,
        status: 'proposed',
        note: input.note ?? null,
        meta: meta ? (meta as Prisma.InputJsonValue) : Prisma.DbNull,
        createdBy: input.createdBy,
      })),
    })
  })
  return { changeSetId }
}

export interface ApproveResult {
  revision: number
  replaced: { changeSetId: string; revision: number | null; pluginId: string } | null
}

/**
 * Makes a proposed set the active version of its scope and skill. `currentHashes` maps
 * each part's target key to the SHA-256 of its factory text now (from the agent's
 * registry). A proposal built on another factory text is refused; a set made stale by a
 * factory change can be re-approved, keeping its number and re-basing on the new hashes.
 */
export async function approve(
  changeSetId: string,
  decidedBy: string,
  currentHashes: Record<string, string>,
  db: Db = prisma,
): Promise<ApproveResult> {
  checkChangeSetId(changeSetId)
  checkActor(decidedBy)
  if (!currentHashes || typeof currentHashes !== 'object') currentHashes = {}
  return db.$transaction(async (tx) => {
    const rows = await lockedSet(tx, changeSetId)
    const status = setStatus(rows)
    const first = rows[0]
    const reapproval = status === 'stale'
    if (reapproval && staleReasonOf(first.meta) !== 'factory_changed') {
      throw new PluginOverrideError('wrong_state', 'A version whose part was removed cannot be approved again; delete it')
    }
    if (status !== 'proposed' && !reapproval) {
      throw new PluginOverrideError('wrong_state', `This change set is ${status}, not waiting for a decision`)
    }
    const stale = rows
      .filter((r) => !currentHashes[r.targetKey] || (!reapproval && currentHashes[r.targetKey] !== r.baseSha256))
      .map((r) => r.targetKey)
      .sort()
    if (stale.length) throw new PluginStaleProposalError(stale)

    const where = scopeWhere(first.extensionPoint, { type: first.scopeType as ScopeType, id: first.scopeId }, first.targetGroup)
    const active = await tx.pluginOverride.findMany({ where: { ...where, status: 'active' } })
    const replaced = active.length
      ? { changeSetId: active[0].changeSetId, revision: active[0].revision, pluginId: active[0].pluginId }
      : null
    if (active.length) {
      await tx.pluginOverride.updateMany({
        where: { id: { in: active.map((a) => a.id) } },
        data: { status: 'superseded' },
      })
    }

    const decidedAt = now()
    let revision: number
    if (reapproval) {
      revision = first.revision ?? FACTORY_REVISION + 1
      const meta = { ...((first.meta as Record<string, unknown> | null) ?? {}) }
      delete meta.staleReason
      for (const r of rows) {
        await tx.pluginOverride.update({
          where: { id: r.id },
          data: {
            status: 'active',
            baseSha256: currentHashes[r.targetKey],
            meta: meta as Prisma.InputJsonValue,
            decidedBy,
            decidedAt,
          },
        })
      }
    } else {
      revision = await nextRevision(tx, first)
      const { count } = await tx.pluginOverride.updateMany({
        where: { changeSetId, status: 'proposed' },
        data: { status: 'active', revision, decidedBy, decidedAt },
      })
      if (count !== rows.length) throw new PluginOverrideError('wrong_state', 'This change set changed during approval')
    }
    return { revision, replaced }
  })
}

/** counter + 1, where the counter is never lowered; also above any number still stored. */
async function nextRevision(tx: Tx, first: PluginOverride): Promise<number> {
  const scope = { type: first.scopeType as ScopeType, id: first.scopeId }
  const key = revisionCounterKey(first.extensionPoint, scope, first.targetGroup)
  const [state, highest] = await Promise.all([
    tx.pluginPlatformState.findUnique({ where: { key } }),
    tx.pluginOverride.findFirst({
      where: { ...scopeWhere(first.extensionPoint, scope, first.targetGroup), revision: { not: null } },
      orderBy: { revision: 'desc' },
      select: { revision: true },
    }),
  ])
  const last = Math.max(readCounter(state?.value), highest?.revision ?? FACTORY_REVISION)
  const revision = last + 1
  await tx.pluginPlatformState.upsert({
    where: { key },
    create: { key, value: { last: revision } },
    update: { value: { last: revision } },
  })
  return revision
}

function readCounter(value: Prisma.JsonValue | undefined): number {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const last = (value as Record<string, unknown>).last
    if (typeof last === 'number' && Number.isInteger(last) && last >= FACTORY_REVISION) return last
  }
  return FACTORY_REVISION
}

async function decideProposed(
  db: Db,
  changeSetId: string,
  to: 'rejected' | 'withdrawn',
  decidedBy: string | null,
  pluginId?: string,
) {
  checkChangeSetId(changeSetId)
  if (pluginId !== undefined && !isValidPluginId(pluginId)) {
    throw new PluginOverrideError('not_found', `No change set ${changeSetId}`)
  }
  await db.$transaction(async (tx) => {
    const rows = await lockedSet(tx, changeSetId)
    // A plugin may only withdraw its own proposals; another plugin's set does not exist for it.
    if (pluginId !== undefined && rows[0].pluginId !== pluginId) {
      throw new PluginOverrideError('not_found', `No change set ${changeSetId}`)
    }
    if (setStatus(rows) !== 'proposed') {
      throw new PluginOverrideError('wrong_state', `This change set is ${setStatus(rows)}, not waiting for a decision`)
    }
    await tx.pluginOverride.updateMany({
      where: { changeSetId, status: 'proposed' },
      data: { status: to, decidedBy, decidedAt: now() },
    })
  })
}

export async function reject(changeSetId: string, decidedBy: string, db: Db = prisma): Promise<void> {
  checkActor(decidedBy)
  await decideProposed(db, changeSetId, 'rejected', decidedBy)
}

export async function withdraw(changeSetId: string, pluginId: string, db: Db = prisma): Promise<void> {
  // An undefined plugin must not read as "no plugin check".
  await decideProposed(db, changeSetId, 'withdrawn', null, pluginId ?? '')
}

/**
 * Reset to factory: the scope's active version of the skill becomes `cleared`. Core UI,
 * so it works whatever state the plugin is in (disabled, uninstalled with data kept).
 */
export async function reset(
  scope: OverrideScope,
  point: string,
  group: string,
  decidedBy: string,
  db: Db = prisma,
): Promise<{ changeSetId: string; revision: number | null } | null> {
  checkTarget(point, scope, group)
  checkActor(decidedBy)
  return db.$transaction(async (tx) => {
    await lockScope(tx, point, scope, group)
    const active = await tx.pluginOverride.findFirst({ where: { ...scopeWhere(point, scope, group), status: 'active' } })
    if (!active) return null
    await tx.pluginOverride.updateMany({
      where: { ...scopeWhere(point, scope, group), status: 'active' },
      data: { status: 'cleared', decidedBy, decidedAt: now() },
    })
    return { changeSetId: active.changeSetId, revision: active.revision }
  })
}

/** Deletes a whole change set. The active version cannot be deleted: reset it first. */
export async function deleteChangeSet(changeSetId: string, db: Db = prisma): Promise<{ deleted: number }> {
  checkChangeSetId(changeSetId)
  return db.$transaction(async (tx) => {
    const rows = await lockedSet(tx, changeSetId)
    if (rows.some((r) => r.status === 'active')) {
      throw new PluginOverrideError('active_not_deletable', 'The active version cannot be deleted; reset it to factory first')
    }
    const { count } = await tx.pluginOverride.deleteMany({ where: { changeSetId } })
    return { deleted: count }
  })
}

/**
 * Marks active sets stale, whole sets only (reconciliation found their factory text
 * changed, or a part they change removed). Returns the ids actually marked.
 */
export async function markStale(
  changeSetIds: string | string[],
  reason: StaleReason,
  db: Db = prisma,
): Promise<string[]> {
  if (!(STALE_REASONS as readonly string[]).includes(reason)) throw new Error(`Unknown stale reason ${reason}`)
  const marked: string[] = []
  for (const id of (Array.isArray(changeSetIds) ? changeSetIds : [changeSetIds]).filter(isChangeSetId)) {
    const done = await db.$transaction(async (tx) => {
      let rows: PluginOverride[]
      try {
        rows = await lockedSet(tx, id)
      } catch (e) {
        if (e instanceof PluginOverrideError && e.code === 'not_found') return false
        throw e
      }
      if (setStatus(rows) !== 'active') return false
      const meta = { ...((rows[0].meta as Record<string, unknown> | null) ?? {}), staleReason: reason }
      await tx.pluginOverride.updateMany({
        where: { changeSetId: id, status: 'active' },
        data: { status: 'stale', meta: meta as Prisma.InputJsonValue },
      })
      return true
    })
    if (done) marked.push(id)
  }
  return marked
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

async function countPending(tx: Pick<Tx, 'pluginOverride'>, scope: OverrideScope, point: string, group: string) {
  const rows = await tx.pluginOverride.findMany({
    where: { ...scopeWhere(point, scope, group), status: 'proposed' },
    select: { changeSetId: true },
  })
  return new Set(rows.map((r) => r.changeSetId)).size
}

/** Pending change sets (not rows) for a scope and skill. */
export async function pendingCount(scope: OverrideScope, point: string, group: string, db: Db = prisma): Promise<number> {
  checkTarget(point, scope, group)
  return countPending(db, scope, point, group)
}

export async function getChangeSet(changeSetId: string, db: Db = prisma): Promise<ChangeSet | null> {
  if (!isChangeSetId(changeSetId)) return null
  const rows = await db.pluginOverride.findMany({ where: { changeSetId } })
  return rows.length ? toChangeSet(rows) : null
}

export async function activeChangeSet(
  scope: OverrideScope,
  point: string,
  group: string,
  db: Db = prisma,
): Promise<ChangeSet | null> {
  checkTarget(point, scope, group)
  const rows = await db.pluginOverride.findMany({ where: { ...scopeWhere(point, scope, group), status: 'active' } })
  return rows.length ? toChangeSet(rows) : null
}

/** The highest version number handed out for this scope and skill (1 = factory only). */
export async function lastRevision(scope: OverrideScope, point: string, group: string, db: Db = prisma): Promise<number> {
  checkTarget(point, scope, group)
  const state = await db.pluginPlatformState.findUnique({ where: { key: revisionCounterKey(point, scope, group) } })
  return readCounter(state?.value)
}

export interface VersionList {
  /** v1, never stored; in use when no version is active. */
  factory: { revision: typeof FACTORY_REVISION; inUse: boolean }
  /** Every change set of this scope and skill, newest first. */
  sets: ChangeSet[]
}

export async function listVersions(
  scope: OverrideScope,
  point: string,
  group: string,
  db: Db = prisma,
): Promise<VersionList> {
  checkTarget(point, scope, group)
  const rows = await db.pluginOverride.findMany({ where: scopeWhere(point, scope, group) })
  const sets = groupBySet(rows)
    .map(toChangeSet)
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.changeSetId.localeCompare(a.changeSetId))
  return { factory: { revision: FACTORY_REVISION, inUse: !sets.some((s) => s.status === 'active') }, sets }
}

export interface ResolvedPart {
  value: string
  baseSha256: string
  overrideId: string
  changeSetId: string
  revision: number | null
  pluginId: string
}

export interface EffectiveSet extends ChangeSet {
  /**
   * False when the set is stale (factory text runs until it is reviewed again) or its
   * plugin is disabled, not ready, revoked or lacks the permission.
   */
  applies: boolean
  plugin: Pick<PluginInstall, 'pluginId' | 'status' | 'enabled' | 'revokedReason' | 'grantedPermissions'>
}

type RowWithPlugin = PluginOverride & { plugin: PluginInstall }

/**
 * The set that governs each skill of a project: the project's own version if it has
 * one (active, else stale), otherwise the active user-scope version of the project's
 * OWNER (read from the project row, never from the caller). Chosen per skill, before
 * the plugin check: a project version that is stale, or whose plugin is disabled,
 * leaves that skill on factory text rather than falling back to a user version nobody
 * chose for this project. A project version that was reset (cleared) no longer
 * governs, so the skill follows the owner's user scope again (TD-18).
 */
async function governingSets(projectId: string, db: Db, group?: string): Promise<EffectiveSet[]> {
  if (typeof projectId !== 'string' || projectId.length === 0 || projectId.length > 128) return []
  const project = await db.project.findUnique({ where: { id: projectId }, select: { userId: true } })
  if (!project) return []
  const rows = (await db.pluginOverride.findMany({
    where: {
      extensionPoint: 'skill.text',
      ...(group ? { targetGroup: group } : {}),
      OR: [
        { scopeType: 'project', scopeId: projectId, status: { in: ['active', 'stale'] } },
        { scopeType: 'user', scopeId: project.userId, status: 'active' },
      ],
    },
    include: { plugin: true },
  })) as RowWithPlugin[]

  const byGroup = new Map<string, RowWithPlugin[]>()
  for (const r of rows) byGroup.set(r.targetGroup, [...(byGroup.get(r.targetGroup) ?? []), r])

  const out: EffectiveSet[] = []
  for (const groupRows of byGroup.values()) {
    const projectActive = groupRows.filter((r) => r.scopeType === 'project' && r.status === 'active')
    const projectStale = groupRows.filter((r) => r.scopeType === 'project' && r.status === 'stale')
    const chosenScope = projectActive.length
      ? projectActive
      : projectStale.length
        ? projectStale
        : groupRows.filter((r) => r.scopeType === 'user')
    // One active set per scope and skill is the invariant; if it was ever broken, take the
    // newest version whole rather than mixing parts of two.
    const sets = groupBySet(chosenScope).sort((a, b) => (b[0].revision ?? 0) - (a[0].revision ?? 0))
    const set = sets[0]
    const plugin = set[0].plugin
    out.push({
      ...toChangeSet(set),
      applies: set[0].status === 'active' && overridesQualify(plugin),
      plugin: {
        pluginId: plugin.pluginId,
        status: plugin.status,
        enabled: plugin.enabled,
        revokedReason: plugin.revokedReason,
        grantedPermissions: plugin.grantedPermissions,
      },
    })
  }
  return out
}

/** What the agent receives for a project: `{[targetKey]: part}` of every set that applies. */
export async function resolveForProject(projectId: string, db: Db = prisma): Promise<Record<string, ResolvedPart>> {
  const result: Record<string, ResolvedPart> = {}
  for (const set of await governingSets(projectId, db)) {
    if (!set.applies) continue
    for (const p of set.parts) {
      result[p.targetKey] = {
        value: p.value,
        baseSha256: p.baseSha256,
        overrideId: p.overrideId,
        changeSetId: set.changeSetId,
        revision: set.revision,
        pluginId: set.pluginId,
      }
    }
  }
  return result
}

/** The set governing one skill of a project, applied or dormant, with its scope. */
export async function effectiveForProject(
  projectId: string,
  group: string,
  db: Db = prisma,
): Promise<EffectiveSet | null> {
  if (typeof group !== 'string' || !GROUP_RE.test(group)) return null
  const [set] = await governingSets(projectId, db, group)
  return set ?? null
}
