import { NextResponse } from 'next/server'
import { requireEffectiveUser } from '@/lib/access'
import { listPluginLlmFeatures } from '@/lib/plugins/pluginLlmFeatures'
import { pluginsDisabledResponse, pluginsEnabled } from '@/lib/plugins/switch'

/**
 * GET /api/plugins/llm-features: the plugin tiles of Models by feature,
 * `[{featureId, pluginId, label, description}]`. Any signed-in user: each saves the
 * choice for their own account.
 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET() {
  if (!pluginsEnabled()) return pluginsDisabledResponse()
  const eff = await requireEffectiveUser()
  if (eff instanceof NextResponse) return eff
  return NextResponse.json(await listPluginLlmFeatures(), { headers: { 'Cache-Control': 'no-store' } })
}
