import type { PluginData, Prisma } from '@prisma/client'
import prisma from '@/lib/prisma'
import {
  LIVE_NAMESPACE,
  PluginDataError,
  applyMigrationAnswer,
  checkNamespaceQuotas,
  copyNamespace,
  pluginRowsOf,
  swapNamespace,
} from './dataStore'
import { heartbeat, PluginConflictError, type Operation } from './registry'
import { RunnerError, RunnerUnavailableError, runMigration, type MigrationAnswer, type MigrationRow } from './runnerClient'

/**
 * Data migrations, copy and swap (README.PLUGINS.md §9.5, TD-28). The live rows are copied
 * to `migrating:<operationId>`; for each step every row of the copy, for every owner, goes
 * to the runner in batches, where a temporary worker of the version that ships the step
 * runs the plugin's `migrate_row`; the answers are written into the copy with the store's
 * value checks and the quotas are checked after each step. The swap and the install row's
 * new version are one transaction, so the code that reads the data and the data change
 * together. Any failure (an exception in `migrate_row`, a bad or oversized answer, a missing
 * or unknown row, a timeout, the runner down) discards the copy: the old data is untouched.
 * Migration code has no call token, so it cannot reach the Gateway (D-48).
 */
export const MIGRATION_BATCH_ROWS = 200
export const MIGRATION_BATCH_BYTES = 512 * 1024

export type Direction = 'up' | 'down'

export class MigrationFailure extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number = 422,
  ) {
    super(message)
    this.name = 'MigrationFailure'
  }
}

/** The steps from one data version to another: NNNN_up moves N-1 → N, NNNN_down moves N → N-1. */
export function migrationSteps(from: number, to: number): { step: number; direction: Direction }[] {
  const out: { step: number; direction: Direction }[] = []
  if (to > from) for (let n = from + 1; n <= to; n++) out.push({ step: n, direction: 'up' })
  else for (let n = from; n > to; n--) out.push({ step: n, direction: 'down' })
  return out
}

export interface MigrationPlan {
  operation: Operation
  /** The version whose migrations/ run: the new one up, the newer (current) one down. */
  version: string
  from: number
  to: number
}

export interface MigrationDeps {
  migrate?: typeof runMigration
}

export interface MigrationStats {
  steps: number
  batches: number
  rows: number
  deleted: number
}

type Db = Pick<typeof prisma, 'pluginData' | 'pluginInstall' | '$transaction'>

const wire = (r: PluginData): MigrationRow => ({
  id: r.id,
  collection: r.collection,
  key: r.key,
  ownerType: r.ownerType as 'user' | 'project',
  value: r.value,
})

function batches(rows: PluginData[]): PluginData[][] {
  const out: PluginData[][] = []
  let current: PluginData[] = []
  let bytes = 0
  for (const r of rows) {
    if (current.length && (current.length >= MIGRATION_BATCH_ROWS || bytes + r.sizeBytes > MIGRATION_BATCH_BYTES)) {
      out.push(current)
      current = []
      bytes = 0
    }
    current.push(r)
    bytes += r.sizeBytes
  }
  if (current.length) out.push(current)
  return out
}

function failure(e: unknown): MigrationFailure {
  if (e instanceof MigrationFailure) return e
  if (e instanceof RunnerError) {
    return new MigrationFailure(e.code, `The plugin's migration failed: ${e.message}`, e.status === 504 ? 504 : 422)
  }
  if (e instanceof RunnerUnavailableError) {
    return new MigrationFailure('runner_unavailable', 'The plugin runner is unavailable, so the data could not be migrated.', 503)
  }
  if (e instanceof PluginDataError) return new MigrationFailure(e.code, `A migrated row was refused: ${e.message}`)
  if (e instanceof PluginConflictError) return new MigrationFailure('plugin_busy', e.message, 409)
  return new MigrationFailure('migration_failed', `The data migration failed: ${(e as Error)?.message ?? String(e)}`, 500)
}

export async function runMigrations(
  plan: MigrationPlan,
  commit: (tx: Prisma.TransactionClient) => Promise<void>,
  deps: MigrationDeps = {},
  db: Db = prisma,
): Promise<MigrationStats> {
  const { pluginId, operationId } = plan.operation
  const migrate = deps.migrate ?? runMigration
  const ns = `migrating:${operationId}`
  const stats: MigrationStats = { steps: 0, batches: 0, rows: 0, deleted: 0 }

  const send = async (step: number, direction: Direction, rows: PluginData[]): Promise<MigrationAnswer[]> => {
    try {
      stats.batches++
      return await migrate(pluginId, { version: plan.version, step, direction, rows: rows.map(wire) })
    } catch (e) {
      // Too large for one answer: halve it, down to one row (whose own value the store limits).
      if (e instanceof RunnerError && e.code === 'result_too_large' && rows.length > 1) {
        const mid = Math.ceil(rows.length / 2)
        return [...(await send(step, direction, rows.slice(0, mid))), ...(await send(step, direction, rows.slice(mid)))]
      }
      throw e
    }
  }

  try {
    await copyNamespace(pluginId, LIVE_NAMESPACE, ns, db)
    for (const { step, direction } of migrationSteps(plan.from, plan.to)) {
      let after: string | null = null
      for (;;) {
        const page: PluginData[] = await db.pluginData.findMany({
          where: { AND: [pluginRowsOf(pluginId, ns), after ? { id: { gt: after } } : {}] },
          orderBy: { id: 'asc' },
          take: MIGRATION_BATCH_ROWS * 5,
        })
        if (!page.length) break
        for (const batch of batches(page)) {
          const answers = await send(step, direction, batch)
          const byId = new Map(batch.map((r) => [r.id, r]))
          const ids = new Set(byId.keys())
          if (answers.length !== batch.length || new Set(answers.map((a) => a?.id)).size !== batch.length ||
              !answers.every((a) => a && ids.has(a.id))) {
            throw new MigrationFailure('invalid_result', `The migration answered a batch of ${batch.length} rows with ${answers.length} answers that do not match its rows.`)
          }
          for (const a of answers) {
            if ('delete' in a && a.delete === true) {
              await applyMigrationAnswer(pluginId, ns, a.id, { delete: true }, db)
              stats.deleted++
            } else if ('value' in a) {
              await applyMigrationAnswer(pluginId, ns, a.id, { value: a.value }, db, byId.get(a.id)!.updatedAt)
            } else {
              throw new MigrationFailure('invalid_result', `The migration's answer for row ${a.id} has neither a value nor delete.`)
            }
          }
          stats.rows += batch.length
          // A batch may take its full runner timeout, and a page holds several: a long
          // migration keeps its lease per batch; one that lost it stops (reconciliation took over).
          await heartbeat(plan.operation, db)
        }
        after = page[page.length - 1].id
      }
      await checkNamespaceQuotas(pluginId, ns, db)
      stats.steps++
    }
    await swapNamespace(pluginId, ns, LIVE_NAMESPACE, db, commit)
    return stats
  } catch (e) {
    await db.pluginData.deleteMany({ where: { pluginId, namespace: ns } }).catch(() => {})
    const f = failure(e)
    console.warn(`[plugins] migration of ${pluginId} ${plan.from} → ${plan.to} with ${plan.version} failed: ${f.code}`)
    throw f
  }
}
