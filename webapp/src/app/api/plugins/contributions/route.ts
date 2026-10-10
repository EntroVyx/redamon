import { NextResponse } from 'next/server'
import { requireEffectiveUser } from '@/lib/access'
import { listContributions } from '@/lib/plugins/contributions'
import { pluginsDisabledResponse, pluginsEnabled } from '@/lib/plugins/switch'

/**
 * GET /api/plugins/contributions: the UI every enabled plugin contributes (design §6). Any
 * signed-in user reads it; a 404 while the platform is off, so the host shows no plugin UI.
 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET() {
  if (!pluginsEnabled()) return pluginsDisabledResponse()
  const eff = await requireEffectiveUser()
  if (eff instanceof NextResponse) return eff
  return NextResponse.json(await listContributions(), { headers: { 'Cache-Control': 'no-store' } })
}
