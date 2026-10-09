import prisma from '@/lib/prisma'
import { pluginFeatureId, type PluginFeatureId } from '@/lib/llmFeatures'
import { hasPermission, showsContributions } from './registry'
import { pluginsEnabled } from './switch'

/**
 * The plugins a user can choose a model for in Models by feature (TD-10): installed,
 * enabled, not revoked (ready, or updating: still installed), holding `llm:invoke`
 * granted by the admin and declared in the stored manifest, with the manifest's
 * `llmFeature` text to describe the choice. None while the platform is off, without a
 * database read, so routes that check plugin keys cost nothing then.
 */
export interface PluginLlmFeature {
  featureId: PluginFeatureId
  pluginId: string
  label: string
  description: string
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

export async function listPluginLlmFeatures(): Promise<PluginLlmFeature[]> {
  if (!pluginsEnabled()) return []
  const rows = await prisma.pluginInstall.findMany({
    where: { enabled: true, revokedReason: null, status: { in: ['ready', 'updating'] } },
    orderBy: { pluginId: 'asc' },
  })
  const out: PluginLlmFeature[] = []
  for (const row of rows) {
    const m = row.manifest
    if (!showsContributions(row) || !hasPermission(row, 'llm:invoke') || !isObj(m)) continue
    const declared = Array.isArray(m.permissions) && m.permissions.includes('llm:invoke')
    const description = isObj(m.llmFeature) ? m.llmFeature.description : undefined
    if (!declared || typeof description !== 'string' || !description) continue
    out.push({
      featureId: pluginFeatureId(row.pluginId),
      pluginId: row.pluginId,
      label: typeof m.displayName === 'string' && m.displayName ? m.displayName : row.pluginId,
      description,
    })
  }
  return out
}
