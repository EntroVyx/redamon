import type { NextRequest } from 'next/server'
import { enable } from '@/lib/plugins/lifecycle'
import { lifecyclePost } from '@/lib/plugins/lifecycleRoutes'

/** POST /api/plugins/[pluginId]/enable (admin); also the Retry of a failed plugin. */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(request: NextRequest, { params }: { params: Promise<{ pluginId: string }> }) {
  const { pluginId } = await params
  return lifecyclePost(request, `enable ${pluginId}`, (_body, adminId) => enable(pluginId, adminId))
}
