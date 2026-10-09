import { Prisma, type PluginData } from '@prisma/client'
import prisma from '@/lib/prisma'
import { now } from './clock'
import { dataLimits } from './settings'

/**
 * The generic data store (README.PLUGINS.md §7.4): everything a plugin keeps, as JSON,
 * keyed by (plugin, namespace, owner, collection, key). Install never changes the
 * schema because every plugin shares this one table.
 *
 * - The owner is a user or a project and always sets the matching foreign key, so the
 *   row dies with its owner.
 * - Collections starting with `__` belong to the platform (jobs, LLM counters): only a
 *   caller passing `{platform: true}` may touch them, and they never count toward the
 *   quotas, so a full store never blocks a job or a counter.
 * - Quotas are checked by counting before writing; two concurrent writes can overshoot
 *   by one row each, which is accepted for a quota.
 * - A row past its `expiresAt` is invisible to every read and holds no quota;
 *   reconciliation deletes it later.
 */
export type OwnerType = 'user' | 'project'

export interface PluginOwner {
  type: OwnerType
  id: string
}

export interface DataScope {
  pluginId: string
  /** `live`, or `migrating:<operationId>` while a data migration runs on a copy. */
  namespace?: string
  platform?: boolean
}

export interface DataRecord {
  collection: string
  key: string
  value: unknown
  sizeBytes: number
  updatedAt: Date
  expiresAt: Date | null
}

export const LIVE_NAMESPACE = 'live'
export const QUERY_LIMIT_DEFAULT = 50
export const QUERY_LIMIT_MAX = 200
export const KEY_MAX_CHARS = 512
export const TTL_MAX_SECONDS = 10 * 365 * 24 * 3600
const COLLECTION_RE = /^[A-Za-z0-9_][A-Za-z0-9_.:-]{0,63}$/
const NAMESPACE_RE = /^(live|migrating:[A-Za-z0-9-]{1,64})$/
const RESERVED_PREFIX = '__'

export type PluginDataErrorCode =
  | 'value_too_large'
  | 'rows_exceeded'
  | 'bytes_exceeded'
  | 'owner_rows_exceeded'
  | 'reserved_collection'
  | 'invalid_owner'
  | 'invalid_collection'
  | 'invalid_key'
  | 'invalid_value'
  | 'invalid_ttl'
  | 'invalid_namespace'

export class PluginDataError extends Error {
  constructor(
    readonly code: PluginDataErrorCode,
    message: string,
    readonly limit?: number,
  ) {
    super(message)
    this.name = 'PluginDataError'
  }
}

type Db = Pick<typeof prisma, 'pluginData' | '$transaction'>

/**
 * Prisma 6 sends `startsWith` to Postgres as `LIKE '<value>%'` without escaping, so `_`
 * and `%` in the value are wildcards: `startsWith: '__'` matches every name of two
 * characters or more. Every pattern this module builds goes through here.
 * tests/plugins_db_test.sh pins that Prisma behaviour on the real database.
 */
export function likePrefix(prefix: string): string {
  return prefix.replace(/[\\%_]/g, (c) => `\\${c}`)
}

const isReserved = (collection: string) => collection.startsWith(RESERVED_PREFIX)
const notReserved: Prisma.PluginDataWhereInput = {
  NOT: { collection: { startsWith: likePrefix(RESERVED_PREFIX) } },
}
const liveRows = (): Prisma.PluginDataWhereInput => ({
  OR: [{ expiresAt: null }, { expiresAt: { gt: now() } }],
})
const isLive = (row: Pick<PluginData, 'expiresAt'>) => row.expiresAt === null || row.expiresAt > now()

function checkNamespace(ns: string): string {
  if (!NAMESPACE_RE.test(ns)) {
    throw new PluginDataError('invalid_namespace', `namespace must be "live" or "migrating:<id>", got "${ns}"`)
  }
  return ns
}

function checkOwner(owner: PluginOwner) {
  if (
    !owner ||
    (owner.type !== 'user' && owner.type !== 'project') ||
    typeof owner.id !== 'string' ||
    owner.id.length === 0 ||
    owner.id.length > 128
  ) {
    throw new PluginDataError('invalid_owner', 'the owner must be a user or a project with an id')
  }
}

function checkCollection(scope: DataScope, collection: string) {
  if (typeof collection !== 'string' || !COLLECTION_RE.test(collection)) {
    throw new PluginDataError(
      'invalid_collection',
      'a collection name is 1-64 characters: letters, digits, _ . : -',
    )
  }
  if (isReserved(collection) && !scope.platform) {
    throw new PluginDataError('reserved_collection', `collections starting with "${RESERVED_PREFIX}" are reserved`)
  }
}

function checkKey(key: string) {
  if (typeof key !== 'string' || key.length === 0 || key.length > KEY_MAX_CHARS || key.includes('\u0000')) {
    throw new PluginDataError('invalid_key', `a key is 1-${KEY_MAX_CHARS} characters, without NUL`)
  }
}

function prepareCollection(scope: DataScope, owner: PluginOwner, collection: string) {
  checkOwner(owner)
  checkCollection(scope, collection)
  const namespace = checkNamespace(scope.namespace ?? LIVE_NAMESPACE)
  return { pluginId: scope.pluginId, namespace, ownerType: owner.type, ownerId: owner.id, collection }
}

function prepare(scope: DataScope, owner: PluginOwner, collection: string, key: string) {
  const base = prepareCollection(scope, owner, collection)
  checkKey(key)
  const id = { ...base, key }
  return { id, unique: { pluginId_namespace_ownerType_ownerId_collection_key: id } }
}

function toRecord(row: PluginData): DataRecord {
  return {
    collection: row.collection,
    key: row.key,
    value: row.value,
    sizeBytes: row.sizeBytes,
    updatedAt: row.updatedAt,
    expiresAt: row.expiresAt,
  }
}

function serialize(value: unknown): { text: string; sizeBytes: number } {
  let text: string | undefined
  try {
    text = JSON.stringify(value)
  } catch {
    throw new PluginDataError('invalid_value', 'the value cannot be written as JSON')
  }
  if (text === undefined) throw new PluginDataError('invalid_value', 'the value cannot be written as JSON')
  // Postgres jsonb refuses the NUL character; refuse it here with a clear message.
  if (text.includes('\\u0000')) throw new PluginDataError('invalid_value', 'the value contains a NUL character')
  return { text, sizeBytes: Buffer.byteLength(text, 'utf8') }
}

function expiryFor(ttlSeconds: number | undefined): Date | null {
  if (ttlSeconds === undefined) return null
  if (!Number.isInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > TTL_MAX_SECONDS) {
    throw new PluginDataError('invalid_ttl', `ttlSeconds must be a whole number from 1 to ${TTL_MAX_SECONDS}`)
  }
  return new Date(now().getTime() + ttlSeconds * 1000)
}

async function checkQuotas(
  db: Db,
  id: { pluginId: string; namespace: string; ownerType: string; ownerId: string },
  unique: Prisma.PluginDataWhereUniqueInput,
  sizeBytes: number,
) {
  const limits = dataLimits()
  const counted: Prisma.PluginDataWhereInput = {
    AND: [{ pluginId: id.pluginId, namespace: id.namespace }, notReserved, liveRows()],
  }
  const [usage, ownerRows, existing] = await Promise.all([
    db.pluginData.aggregate({ where: counted, _count: { _all: true }, _sum: { sizeBytes: true } }),
    db.pluginData.count({ where: { AND: [counted, { ownerType: id.ownerType, ownerId: id.ownerId }] } }),
    db.pluginData.findUnique({ where: unique, select: { sizeBytes: true, expiresAt: true } }),
  ])
  const replaced = existing && isLive(existing) ? existing.sizeBytes : null
  const added = replaced === null ? 1 : 0
  if (usage._count._all + added > limits.maxRows) {
    throw new PluginDataError('rows_exceeded', `this plugin's data is limited to ${limits.maxRows} rows`, limits.maxRows)
  }
  if ((usage._sum.sizeBytes ?? 0) - (replaced ?? 0) + sizeBytes > limits.maxBytes) {
    throw new PluginDataError('bytes_exceeded', `this plugin's data is limited to ${limits.maxBytes} bytes`, limits.maxBytes)
  }
  if (ownerRows + added > limits.maxRowsPerOwner) {
    throw new PluginDataError(
      'owner_rows_exceeded',
      `one user or project may keep at most ${limits.maxRowsPerOwner} rows of this plugin`,
      limits.maxRowsPerOwner,
    )
  }
}

export async function get(
  scope: DataScope,
  owner: PluginOwner,
  collection: string,
  key: string,
  db: Db = prisma,
): Promise<DataRecord | null> {
  const { unique } = prepare(scope, owner, collection, key)
  const row = await db.pluginData.findUnique({ where: unique })
  return row && isLive(row) ? toRecord(row) : null
}

export async function put(
  scope: DataScope,
  owner: PluginOwner,
  collection: string,
  key: string,
  value: unknown,
  opts: { ttlSeconds?: number } = {},
  db: Db = prisma,
): Promise<DataRecord> {
  const { id, unique } = prepare(scope, owner, collection, key)
  const { text, sizeBytes } = serialize(value)
  const limits = dataLimits()
  if (sizeBytes > limits.maxValueBytes) {
    throw new PluginDataError(
      'value_too_large',
      `a value is limited to ${limits.maxValueBytes} bytes of JSON, this one has ${sizeBytes}`,
      limits.maxValueBytes,
    )
  }
  const expiresAt = expiryFor(opts.ttlSeconds)
  if (!isReserved(collection)) await checkQuotas(db, id, unique, sizeBytes)

  // Store what JSON keeps (undefined fields dropped, dates as strings), so the size
  // counted is the size stored.
  const parsed = JSON.parse(text) as Prisma.InputJsonValue | null
  const stored = parsed === null ? Prisma.JsonNull : parsed
  const row = await db.pluginData.upsert({
    where: unique,
    create: {
      ...id,
      userId: owner.type === 'user' ? owner.id : null,
      projectId: owner.type === 'project' ? owner.id : null,
      value: stored,
      sizeBytes,
      expiresAt,
    },
    update: { value: stored, sizeBytes, expiresAt },
  })
  return toRecord(row)
}

export async function query(
  scope: DataScope,
  owner: PluginOwner,
  collection: string,
  opts: { keyPrefix?: string; limit?: number } = {},
  db: Db = prisma,
): Promise<DataRecord[]> {
  const where = prepareCollection(scope, owner, collection)
  const take = Math.min(QUERY_LIMIT_MAX, Math.max(1, Math.floor(opts.limit ?? QUERY_LIMIT_DEFAULT) || 1))
  const rows = await db.pluginData.findMany({
    where: {
      AND: [
        where,
        opts.keyPrefix ? { key: { startsWith: likePrefix(opts.keyPrefix) } } : {},
        liveRows(),
      ],
    },
    orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
    take,
  })
  return rows.map(toRecord)
}

export async function remove(
  scope: DataScope,
  owner: PluginOwner,
  collection: string,
  key: string,
  db: Db = prisma,
): Promise<boolean> {
  const { id } = prepare(scope, owner, collection, key)
  const { count } = await db.pluginData.deleteMany({ where: id })
  return count > 0
}

export { remove as delete }

function checkPair(from: string, to: string) {
  checkNamespace(from)
  checkNamespace(to)
  if (from === to) throw new PluginDataError('invalid_namespace', 'source and target namespace are the same')
}

/**
 * Copies a plugin's live rows (never platform rows) into another namespace, replacing
 * what was there: the first half of a copy-and-swap data migration. Returns the count.
 */
export async function copyNamespace(pluginId: string, from: string, to: string, db: Db = prisma): Promise<number> {
  checkPair(from, to)
  return db.$transaction(async (tx) => {
    await tx.pluginData.deleteMany({ where: { AND: [{ pluginId, namespace: to }, notReserved] } })
    const rows = await tx.pluginData.findMany({
      where: { AND: [{ pluginId, namespace: from }, notReserved, liveRows()] },
    })
    if (rows.length === 0) return 0
    const { count } = await tx.pluginData.createMany({
      data: rows.map((r) => ({
        pluginId,
        namespace: to,
        ownerType: r.ownerType,
        ownerId: r.ownerId,
        userId: r.userId,
        projectId: r.projectId,
        collection: r.collection,
        key: r.key,
        value: r.value === null ? Prisma.JsonNull : (r.value as Prisma.InputJsonValue),
        sizeBytes: r.sizeBytes,
        expiresAt: r.expiresAt,
      })),
    })
    return count
  })
}

/**
 * Replaces the plugin rows of `to` with those of `from`, in one transaction: a migrated
 * copy becomes live at once or not at all. Platform rows of `to` are left alone.
 */
export async function swapNamespace(pluginId: string, from: string, to: string, db: Db = prisma): Promise<void> {
  checkPair(from, to)
  await db.$transaction(async (tx) => {
    await tx.pluginData.deleteMany({ where: { AND: [{ pluginId, namespace: to }, notReserved] } })
    await tx.pluginData.updateMany({
      where: { AND: [{ pluginId, namespace: from }, notReserved] },
      data: { namespace: to },
    })
    await tx.pluginData.deleteMany({ where: { pluginId, namespace: from } })
  })
}
