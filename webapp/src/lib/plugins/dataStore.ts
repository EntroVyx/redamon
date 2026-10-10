import { createHash } from 'crypto'
import { Prisma, type PluginData } from '@prisma/client'
import prisma from '@/lib/prisma'
import { now } from './clock'
import { isValidPluginId } from './ids'
import { dataLimits } from './settings'
import { isStorableText } from './storableText'

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
 * - `query` pages with a keyset cursor (TD-28): the cursor holds the last row's sort
 *   value and id, so inserts and deletes between pages never skip or repeat a row, plus a
 *   hash of the whole query, so a cursor never moves to another query. A write moves a row
 *   in the `updated` orders: in `-updated` it moves behind the cursor and is not returned
 *   again; a walk in `updated` order is bounded by its newest row when it began, so one
 *   that writes rows back as it reads them ends, and a row written during it is not
 *   returned. The hash is no secret, so the position a cursor names is checked like any
 *   input. `where` compares top-level JSON fields by jsonb equality through Prisma's JSON
 *   path filter, never raw SQL.
 * - A row past its `expiresAt` is invisible to every read. It still holds quota until it
 *   is deleted (otherwise short-lived rows could grow storage without bound before
 *   reconciliation deletes them), but a write that would exceed a quota first deletes
 *   the plugin's expired rows, so expired data never blocks a write.
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
const COPY_PAGE_ROWS = 500
// A full quota (10,000 rows, 50 MB) takes longer to copy than Prisma's 5 s default for an
// interactive transaction; measured on Postgres 16: the default timed out at 5.2 s.
const MIGRATION_TRANSACTION = { maxWait: 10_000, timeout: 120_000 }
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
  | 'invalid_plugin'
  | 'invalid_query'
  | 'invalid_cursor'

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

// Before any query: Prisma drops a `where` key whose value is undefined, so a missing
// plugin id would otherwise reach every plugin's rows.
function checkPluginId(pluginId: unknown) {
  if (!isValidPluginId(pluginId)) throw new PluginDataError('invalid_plugin', `invalid plugin id ${String(pluginId)}`)
}

function prepareCollection(scope: DataScope, owner: PluginOwner, collection: string) {
  checkPluginId(scope?.pluginId)
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
  let nul = false
  try {
    // Postgres jsonb refuses the NUL character, in a string or a key; look at the real
    // strings, since the JSON text of an innocent backslash-u0000 contains the same six
    // characters as an escaped NUL.
    text = JSON.stringify(value, (key, v) => {
      if (key.includes('\u0000') || (typeof v === 'string' && v.includes('\u0000'))) nul = true
      return v
    })
  } catch {
    throw new PluginDataError('invalid_value', 'the value cannot be written as JSON')
  }
  if (text === undefined) throw new PluginDataError('invalid_value', 'the value cannot be written as JSON')
  if (nul) throw new PluginDataError('invalid_value', 'the value contains a NUL character')
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
    AND: [{ pluginId: id.pluginId, namespace: id.namespace }, notReserved],
  }
  const measure = async () => {
    const [usage, ownerRows, existing] = await Promise.all([
      db.pluginData.aggregate({ where: counted, _count: { _all: true }, _sum: { sizeBytes: true } }),
      db.pluginData.count({ where: { AND: [counted, { ownerType: id.ownerType, ownerId: id.ownerId }] } }),
      db.pluginData.findUnique({ where: unique, select: { sizeBytes: true } }),
    ])
    const added = existing ? 0 : 1
    const rows = usage._count._all + added
    const bytes = (usage._sum.sizeBytes ?? 0) - (existing?.sizeBytes ?? 0) + sizeBytes
    const owner = ownerRows + added
    if (rows > limits.maxRows) {
      return new PluginDataError('rows_exceeded', `this plugin's data is limited to ${limits.maxRows} rows`, limits.maxRows)
    }
    if (bytes > limits.maxBytes) {
      return new PluginDataError('bytes_exceeded', `this plugin's data is limited to ${limits.maxBytes} bytes`, limits.maxBytes)
    }
    if (owner > limits.maxRowsPerOwner) {
      return new PluginDataError(
        'owner_rows_exceeded',
        `one user or project may keep at most ${limits.maxRowsPerOwner} rows of this plugin`,
        limits.maxRowsPerOwner,
      )
    }
    return null
  }
  let refusal = await measure()
  if (refusal) {
    const { count } = await db.pluginData.deleteMany({ where: { AND: [counted, { expiresAt: { lte: now() } }] } })
    if (count > 0) refusal = await measure()
  }
  if (refusal) throw refusal
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

// ---------------------------------------------------------------------------
// Queries (TD-28)
// ---------------------------------------------------------------------------

export const QUERY_ORDERS = ['-updated', 'updated', 'key', '-key'] as const
export type QueryOrder = (typeof QUERY_ORDERS)[number]
export type WhereValue = string | number | boolean | null
export const WHERE_MAX_FIELDS = 5
export const WHERE_TEXT_MAX_CHARS = 512
const WHERE_FIELD_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/

export interface QueryOptions {
  keyPrefix?: string
  where?: Record<string, WhereValue>
  order?: QueryOrder
  limit?: number
  cursor?: string | null
}

export interface QueryPage {
  items: DataRecord[]
  /** Pass back as `cursor` for the next page; null on the last one. */
  next: string | null
}

const invalidQuery = (message: string) => new PluginDataError('invalid_query', message)

// The messages of the SDK client's own checks (redamon_plugin_sdk/client.py), so a
// plugin sees one wording whether its SDK or the Gateway refused the query.
function checkWhere(where: unknown): [string, WhereValue][] | null {
  if (where === undefined || where === null) return null
  if (typeof where !== 'object' || Array.isArray(where)) throw invalidQuery(`where takes 1 to ${WHERE_MAX_FIELDS} fields.`)
  const entries = Object.entries(where as Record<string, unknown>)
  if (entries.length < 1 || entries.length > WHERE_MAX_FIELDS) throw invalidQuery(`where takes 1 to ${WHERE_MAX_FIELDS} fields.`)
  for (const [name, value] of entries) {
    if (!WHERE_FIELD_RE.test(name)) throw invalidQuery(`where field '${name}' is not a valid name.`)
    const scalar =
      value === null ||
      typeof value === 'boolean' ||
      (typeof value === 'string' && value.length <= WHERE_TEXT_MAX_CHARS) ||
      (typeof value === 'number' && Number.isFinite(value))
    if (!scalar) {
      throw invalidQuery(
        `where value for '${name}' must be text of at most ${WHERE_TEXT_MAX_CHARS} characters, a finite number, true, false or null.`,
      )
    }
  }
  return entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)) as [string, WhereValue][]
}

function checkPrefix(prefix: unknown): string | null {
  if (prefix === undefined || prefix === null || prefix === '') return null
  if (typeof prefix !== 'string' || prefix.length > KEY_MAX_CHARS || prefix.includes('\u0000')) {
    throw invalidQuery(`prefix must be text of at most ${KEY_MAX_CHARS} characters.`)
  }
  return prefix
}

// A missing field never matches (`#>` gives SQL NULL); JsonNull, never AnyNull, so a
// Python None matches only a stored JSON null, not a missing field.
function filters(prefix: string | null, where: [string, WhereValue][] | null): Prisma.PluginDataWhereInput[] {
  const out: Prisma.PluginDataWhereInput[] = []
  if (prefix) out.push({ key: { startsWith: likePrefix(prefix) } })
  for (const [field, value] of where ?? []) {
    out.push({ value: { path: [field], equals: value === null ? Prisma.JsonNull : value } })
  }
  return out
}

interface CursorBody {
  o: QueryOrder
  v: string
  i: string
  h: string
  /** `updated` order only: the newest row's updatedAt when the walk began. */
  s?: string
}

const ROW_ID_RE = /^[A-Za-z0-9_-]{1,64}$/
const ISO_MS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

/** A date as the store writes it, in years 1 to 9999: Postgres holds no year 0 and no sign. */
function isCursorDate(v: string): boolean {
  if (!ISO_MS_RE.test(v) || v.startsWith('0000')) return false
  const at = new Date(v)
  return !Number.isNaN(at.getTime()) && at.toISOString() === v
}

function queryHash(base: ReturnType<typeof prepareCollection>, prefix: string | null, where: unknown, order: QueryOrder) {
  return [base.pluginId, base.namespace, base.ownerType, base.ownerId, base.collection, prefix, where, order]
}

// Not a secret: it only stops a cursor from being used with another query, or after an
// edit; whatever a cursor says, a query never leaves its plugin, owner and collection.
function cursorHash(query: unknown[], o: string, v: string, i: string, s?: string): string {
  return createHash('sha256')
    .update(JSON.stringify([...query, o, v, i, ...(s === undefined ? [] : [s])]))
    .digest('base64url')
    .slice(0, 32)
}

function encodeCursor(query: unknown[], order: QueryOrder, row: PluginData, s?: string): string {
  const v = order.endsWith('updated') ? row.updatedAt.toISOString() : row.key
  const body: CursorBody = { o: order, v, i: row.id, h: cursorHash(query, order, v, row.id, s), ...(s === undefined ? {} : { s }) }
  return Buffer.from(JSON.stringify(body), 'utf8').toString('base64url')
}

function decodeCursor(cursor: string, query: unknown[], order: QueryOrder): CursorBody {
  let body: Partial<CursorBody> | null = null
  try {
    body = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))
  } catch {
    body = null
  }
  if (
    !body ||
    typeof body !== 'object' ||
    typeof body.o !== 'string' ||
    typeof body.v !== 'string' ||
    typeof body.i !== 'string' ||
    typeof body.h !== 'string' ||
    (body.s !== undefined && typeof body.s !== 'string')
  ) {
    throw new PluginDataError('invalid_cursor', 'This cursor is not valid.')
  }
  if (body.o !== order || body.h !== cursorHash(query, body.o, body.v, body.i, body.s)) {
    throw new PluginDataError('invalid_cursor', 'This cursor belongs to another query.')
  }
  // Positions Postgres could not compare would fail the query as a 500.
  const position = order.endsWith('updated') ? isCursorDate(body.v) : isStorableText(body.v)
  if (!position || !ROW_ID_RE.test(body.i) || (body.s !== undefined && !isCursorDate(body.s))) {
    throw new PluginDataError('invalid_cursor', 'This cursor is not valid.')
  }
  return body as CursorBody
}

const ORDER_BY: Record<QueryOrder, Prisma.PluginDataOrderByWithRelationInput[]> = {
  '-updated': [{ updatedAt: 'desc' }, { id: 'desc' }],
  updated: [{ updatedAt: 'asc' }, { id: 'asc' }],
  key: [{ key: 'asc' }, { id: 'asc' }],
  '-key': [{ key: 'desc' }, { id: 'desc' }],
}

function after(order: QueryOrder, c: CursorBody): Prisma.PluginDataWhereInput {
  const dir = order.startsWith('-') ? 'lt' : 'gt'
  if (order.endsWith('updated')) {
    const at = new Date(c.v)
    return { OR: [{ updatedAt: { [dir]: at } }, { updatedAt: at, id: { [dir]: c.i } }] }
  }
  return { OR: [{ key: { [dir]: c.v } }, { key: c.v, id: { [dir]: c.i } }] }
}

export async function query(
  scope: DataScope,
  owner: PluginOwner,
  collection: string,
  opts: QueryOptions = {},
  db: Db = prisma,
): Promise<QueryPage> {
  const base = prepareCollection(scope, owner, collection)
  const prefix = checkPrefix(opts.keyPrefix)
  const where = checkWhere(opts.where)
  const order = opts.order ?? '-updated'
  if (!(QUERY_ORDERS as readonly unknown[]).includes(order)) throw invalidQuery(`order is one of ${QUERY_ORDERS.join(', ')}.`)
  const limit = opts.limit ?? QUERY_LIMIT_DEFAULT
  if (!Number.isInteger(limit) || limit < 1 || limit > QUERY_LIMIT_MAX) {
    throw invalidQuery(`limit is a whole number from 1 to ${QUERY_LIMIT_MAX}.`)
  }
  if (opts.cursor !== undefined && opts.cursor !== null && typeof opts.cursor !== 'string') {
    throw invalidQuery('cursor must be the string a previous page returned.')
  }
  const identity = queryHash(base, prefix, where, order)
  const cursor = typeof opts.cursor === 'string' ? decodeCursor(opts.cursor, identity, order) : null
  const matching = [base, ...filters(prefix, where), liveRows()]

  let startBound: string | undefined
  if (order === 'updated') {
    startBound = cursor
      ? cursor.s
      : (await db.pluginData.findFirst({ where: { AND: matching }, orderBy: [{ updatedAt: 'desc' }] }))?.updatedAt.toISOString()
  }
  const bounded = startBound === undefined ? [] : [{ updatedAt: { lte: new Date(startBound) } }]

  // One row more than asked: whether it exists decides `next`, so the last page says so.
  const rows = await db.pluginData.findMany({
    where: { AND: [...matching, ...bounded, ...(cursor ? [after(order, cursor)] : [])] },
    orderBy: ORDER_BY[order],
    take: limit + 1,
  })
  const page = rows.slice(0, limit)
  const next = rows.length > limit ? encodeCursor(identity, order, page[page.length - 1], startBound) : null
  return { items: page.map(toRecord), next }
}

/** How many live rows `query` would page through with the same prefix and where. */
export async function count(
  scope: DataScope,
  owner: PluginOwner,
  collection: string,
  opts: Pick<QueryOptions, 'keyPrefix' | 'where'> = {},
  db: Db = prisma,
): Promise<number> {
  const base = prepareCollection(scope, owner, collection)
  const prefix = checkPrefix(opts.keyPrefix)
  const where = checkWhere(opts.where)
  return db.pluginData.count({ where: { AND: [base, ...filters(prefix, where), liveRows()] } })
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

function checkPair(pluginId: string, from: string, to: string) {
  checkPluginId(pluginId)
  checkNamespace(from)
  checkNamespace(to)
  if (from === to) throw new PluginDataError('invalid_namespace', 'source and target namespace are the same')
}

/**
 * Copies a plugin's live rows (never platform rows) into another namespace, replacing
 * what was there: the first half of a copy-and-swap data migration. Returns the count.
 */
export async function copyNamespace(pluginId: string, from: string, to: string, db: Db = prisma): Promise<number> {
  checkPair(pluginId, from, to)
  return db.$transaction(async (tx) => {
    await tx.pluginData.deleteMany({ where: { AND: [{ pluginId, namespace: to }, notReserved] } })
    // Page by id so a full quota never sits in memory at once.
    let copied = 0
    let after: string | null = null
    for (;;) {
      const rows: PluginData[] = await tx.pluginData.findMany({
        where: { AND: [{ pluginId, namespace: from }, notReserved, liveRows(), after ? { id: { gt: after } } : {}] },
        orderBy: { id: 'asc' },
        take: COPY_PAGE_ROWS,
      })
      if (rows.length === 0) break
      copied += await copyPage(tx, pluginId, to, rows)
      after = rows[rows.length - 1].id
      if (rows.length < COPY_PAGE_ROWS) break
    }
    return copied
  }, MIGRATION_TRANSACTION)
}

async function copyPage(tx: Prisma.TransactionClient, pluginId: string, to: string, rows: PluginData[]) {
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
}

/**
 * Replaces the plugin rows of `to` with those of `from`, in one transaction: a migrated
 * copy becomes live at once or not at all. Platform rows of `to` are left alone.
 * `inTx` runs in the same transaction (the install row's new version and data version),
 * so the data and the code that reads it change together; when it throws, nothing moves.
 */
export async function swapNamespace(
  pluginId: string,
  from: string,
  to: string,
  db: Db = prisma,
  inTx?: (tx: Prisma.TransactionClient) => Promise<void>,
): Promise<void> {
  checkPair(pluginId, from, to)
  await db.$transaction(async (tx) => {
    await tx.pluginData.deleteMany({ where: { AND: [{ pluginId, namespace: to }, notReserved] } })
    await tx.pluginData.updateMany({
      where: { AND: [{ pluginId, namespace: from }, notReserved] },
      data: { namespace: to },
    })
    await tx.pluginData.deleteMany({ where: { pluginId, namespace: from } })
    if (inTx) await inTx(tx)
  }, MIGRATION_TRANSACTION)
}

/**
 * A data migration's answer for one row of its copy (TD-28): the new value, with the
 * store's value checks, or the row's deletion. Only a `migrating:` namespace: live rows
 * change only through the swap.
 */
export async function applyMigrationAnswer(
  pluginId: string,
  namespace: string,
  rowId: string,
  answer: { value: unknown } | { delete: true },
  db: Db = prisma,
): Promise<{ sizeBytes: number }> {
  checkPluginId(pluginId)
  checkNamespace(namespace)
  if (namespace === LIVE_NAMESPACE) throw new PluginDataError('invalid_namespace', 'a migration writes only into its copy')
  const where = { id: rowId, pluginId, namespace }
  if ('delete' in answer) {
    const { count } = await db.pluginData.deleteMany({ where })
    if (count !== 1) throw new PluginDataError('invalid_value', `row ${rowId} is not in the migration's copy`)
    return { sizeBytes: 0 }
  }
  const { text, sizeBytes } = serialize(answer.value)
  const limits = dataLimits()
  if (sizeBytes > limits.maxValueBytes) {
    throw new PluginDataError(
      'value_too_large',
      `a value is limited to ${limits.maxValueBytes} bytes of JSON, the migrated row ${rowId} has ${sizeBytes}`,
      limits.maxValueBytes,
    )
  }
  const parsed = JSON.parse(text) as Prisma.InputJsonValue | null
  const { count } = await db.pluginData.updateMany({
    where,
    data: { value: parsed === null ? Prisma.JsonNull : parsed, sizeBytes },
  })
  if (count !== 1) throw new PluginDataError('invalid_value', `row ${rowId} is not in the migration's copy`)
  return { sizeBytes }
}

/** The plugin's quotas, checked on a whole namespace (a migrated copy before its swap). */
export async function checkNamespaceQuotas(pluginId: string, namespace: string, db: Db = prisma): Promise<void> {
  checkPluginId(pluginId)
  checkNamespace(namespace)
  const limits = dataLimits()
  const usage = await db.pluginData.aggregate({
    where: { AND: [{ pluginId, namespace }, notReserved] },
    _count: { _all: true },
    _sum: { sizeBytes: true },
  })
  if (usage._count._all > limits.maxRows) {
    throw new PluginDataError('rows_exceeded', `this plugin's data is limited to ${limits.maxRows} rows`, limits.maxRows)
  }
  if ((usage._sum.sizeBytes ?? 0) > limits.maxBytes) {
    throw new PluginDataError('bytes_exceeded', `this plugin's data is limited to ${limits.maxBytes} bytes`, limits.maxBytes)
  }
}

/** Where a migration reads its copy: the plugin's own rows, never the platform's. */
export const pluginRowsOf = (pluginId: string, namespace: string): Prisma.PluginDataWhereInput => ({
  AND: [{ pluginId, namespace }, notReserved],
})
