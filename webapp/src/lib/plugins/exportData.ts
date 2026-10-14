import { createHash } from 'crypto'
import type { PluginData, PluginOverride, Prisma } from '@prisma/client'
import prisma from '@/lib/prisma'
import { auditPlugin } from './audit'
import { now } from './clock'
import { isValidPluginId } from './ids'
import { JOBS_COLLECTION } from './jobs'
import { LifecycleError, exportMarkerKey } from './lifecycleCommon'
import { POINT_PERMISSION } from './extensionPoints'
import { USER_SKILL_POINT } from './overrides'

/**
 * A JSON copy of everything one plugin left in the database, for every user and project:
 * its install row, its data rows (all namespaces, platform rows included) and its
 * overrides. Offered before a purge (which it unlocks) and before a downgrade of RedAmon,
 * whose `db push --accept-data-loss` would drop the plugin tables (R-17).
 *
 * An admin downloads it, so the text proposed for people's OWN skills is not in it: for a
 * `user_skill.text` row the value, the note, the plugin's own meta and the platform's
 * copies of the source text and names are each replaced by `{redacted, sha256, chars}`.
 * Which plugin version proposed it, from which conversation and job, and which skill it
 * became stay, so the record of what happened is whole (version 2 of the format). A job row
 * that worked, or may have worked, on a person's own skill gets the same: the picked name, and
 * everything the plugin wrote into the job (its progress, its result message and fields, its
 * error message), which can name or quote the skill. That is a job whose pick was an own
 * skill, or one started without a pick (an older client, a direct call) by a plugin allowed to
 * read own skills, which then chose a skill itself. Its status, timings, error code and the
 * change set it reported stay.
 */
export const EXPORT_FORMAT = 'redamon-plugin-export'
export const EXPORT_VERSION = 2
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

// Platform meta that says what happened, not what anyone wrote: kept in the export.
const KEPT_USER_SKILL_META = new Set(['pluginVersion', 'conversationId', 'jobId', 'adoptedSkillId', 'withdrawReason'])

function redacted(value: unknown) {
  const text = typeof value === 'string' ? value : JSON.stringify(value) ?? ''
  return { redacted: true, sha256: createHash('sha256').update(text, 'utf8').digest('hex'), chars: text.length }
}

export function redactUserSkillRow(row: PluginOverride): PluginOverride {
  if (row.extensionPoint !== USER_SKILL_POINT) return row
  const meta = row.meta && typeof row.meta === 'object' && !Array.isArray(row.meta)
    ? Object.fromEntries(Object.entries(row.meta).map(([k, v]) => [k, KEPT_USER_SKILL_META.has(k) ? v : redacted(v)]))
    : row.meta
  return {
    ...row,
    value: redacted(row.value) as unknown as string,
    note: row.note === null ? null : (redacted(row.note) as unknown as string),
    meta: meta as Prisma.JsonValue,
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

export function redactJobPick(row: PluginData, readsOwnSkills = false): PluginData {
  const value = row.value
  if (row.collection !== JOBS_COLLECTION || !isRecord(value)) return row
  const pick = value.pick
  const result = value.result
  const reported = isRecord(result) && isRecord(result.reviewProposal) ? result.reviewProposal.extensionPoint : null
  const ownSkill = isRecord(pick)
    ? pick.point === USER_SKILL_POINT
    : readsOwnSkills || reported === USER_SKILL_POINT
  if (!ownSkill) return row
  const error = value.error
  return {
    ...row,
    value: {
      ...value,
      pick: isRecord(pick) ? { ...pick, name: pick.name === null || pick.name === undefined ? pick.name : redacted(pick.name) } : pick,
      progress: value.progress === null || value.progress === undefined ? value.progress : redacted(value.progress),
      result: isRecord(result)
        ? Object.fromEntries(Object.entries(result).map(([k, v]) => [k, k === 'reviewProposal' || k === 'status' ? v : redacted(v)]))
        : result === null || result === undefined ? result : redacted(result),
      error: isRecord(error) ? { ...error, message: redacted(error.message) } : error,
    } as Prisma.JsonValue,
  }
}

export async function buildExport(pluginId: string) {
  if (!isValidPluginId(pluginId)) throw new LifecycleError(400, 'invalid_plugin_id', 'Invalid plugin id.')
  const install = await prisma.pluginInstall.findUnique({ where: { pluginId } })
  if (!install) throw new LifecycleError(404, 'not_found', `Plugin ${pluginId} is not known to this RedAmon.`)
  const granted = install.grantedPermissions
  const readsOwnSkills = Array.isArray(granted) && granted.includes(POINT_PERMISSION[USER_SKILL_POINT])
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
    data: data.map((row) => redactJobPick(row, readsOwnSkills)),
    overrides: overrides.map(redactUserSkillRow),
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
