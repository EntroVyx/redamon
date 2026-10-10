import type { PluginData, PluginOverride } from '@prisma/client'
import prisma from '@/lib/prisma'
import { auditPlugin } from './audit'
import { now } from './clock'
import { isValidPluginId } from './ids'
import { LifecycleError, exportMarkerKey } from './lifecycleCommon'

/**
 * A JSON copy of everything one plugin left in the database, for every user and project:
 * its install row, its data rows (all namespaces, platform rows included) and its
 * overrides. Offered before a purge (which it unlocks) and before a downgrade of RedAmon,
 * whose `db push --accept-data-loss` would drop the plugin tables (R-17).
 */
export const EXPORT_FORMAT = 'redamon-plugin-export'
export const EXPORT_VERSION = 1
const PAGE = 1000

async function pagedById<T extends { id: string }>(fetch: (after: string | null) => Promise<T[]>): Promise<T[]> {
  const out: T[] = []
  let after: string | null = null
  for (;;) {
    const page = await fetch(after)
    out.push(...page)
    if (page.length < PAGE) return out
    after = page[page.length - 1].id
  }
}

export async function buildExport(pluginId: string) {
  if (!isValidPluginId(pluginId)) throw new LifecycleError(400, 'invalid_plugin_id', 'Invalid plugin id.')
  const install = await prisma.pluginInstall.findUnique({ where: { pluginId } })
  if (!install) throw new LifecycleError(404, 'not_found', `Plugin ${pluginId} is not known to this RedAmon.`)
  const data = await pagedById<PluginData>((after) =>
    prisma.pluginData.findMany({ where: { pluginId, ...(after ? { id: { gt: after } } : {}) }, orderBy: { id: 'asc' }, take: PAGE }),
  )
  const overrides = await pagedById<PluginOverride>((after) =>
    prisma.pluginOverride.findMany({ where: { pluginId, ...(after ? { id: { gt: after } } : {}) }, orderBy: { id: 'asc' }, take: PAGE }),
  )
  return {
    format: EXPORT_FORMAT,
    exportVersion: EXPORT_VERSION,
    exportedAt: now().toISOString(),
    pluginId,
    install,
    data,
    overrides,
  }
}

export async function exportPluginData(pluginId: string, actorId: string) {
  const doc = await buildExport(pluginId)
  const at = now()
  await prisma.pluginPlatformState.upsert({
    where: { key: exportMarkerKey(pluginId) },
    create: { key: exportMarkerKey(pluginId), value: { at: at.toISOString(), by: actorId } },
    update: { value: { at: at.toISOString(), by: actorId } },
  })
  const counts = { dataRows: doc.data.length, overrideRows: doc.overrides.length }
  await auditPlugin('plugin.export', { actorId, pluginId, after: counts, source: 'ui' })
  const stamp = at.toISOString().replace(/[:.]/g, '-')
  return { filename: `redamon-plugin-${pluginId}-${stamp}.json`, body: JSON.stringify(doc), counts }
}

/** When an export of this plugin was last downloaded, or null. */
export async function lastExportAt(pluginId: string): Promise<Date | null> {
  const row = await prisma.pluginPlatformState.findUnique({ where: { key: exportMarkerKey(pluginId) } })
  const at = row?.value && typeof row.value === 'object' && !Array.isArray(row.value) ? (row.value as { at?: unknown }).at : null
  const t = typeof at === 'string' ? Date.parse(at) : NaN
  return Number.isFinite(t) ? new Date(t) : null
}
